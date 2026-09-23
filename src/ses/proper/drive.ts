// プロパーのスキルシート置き場（Driveフォルダ）の一覧取得とテキスト化。
// 対応形式: PDF（Claudeのdocumentブロックでそのまま読ませる）/ Excel（.xlsx/.xls）/ Word（.docx）/
// Googleドキュメント（テキストで書き出し）/ Googleスプレッドシート（xlsxで書き出して全タブを読む）。
// ファイル名・本文は個人情報を含むためログに出さない（ファイルIDと件数のみ）。
import { google, type drive_v3 } from 'googleapis';
import mammoth from 'mammoth';
import { properFolderId } from '../config.js';
import { spreadsheetBufferToText } from '../parse.js';
import { SafeLogError } from '../redact.js';
import { withGoogleRetry } from '../../database/sheetBook.js';
import { properGoogleAuth, properAccessHint } from './auth.js';

const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

export const SKILL_SHEET_MAX_BYTES = 10 * 1024 * 1024;
// 指定フォルダ直下に加え、2階層下のサブフォルダまで（社員別・部署別フォルダ程度を想定）
const MAX_FOLDER_DEPTH = 2;
// 抽出に渡すテキストの上限（Excelの空セルだらけのCSV等でトークンを浪費しないため）
const MAX_TEXT_CHARS = 60_000;

const MIME = {
  folder: 'application/vnd.google-apps.folder',
  gdoc: 'application/vnd.google-apps.document',
  gsheet: 'application/vnd.google-apps.spreadsheet',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
} as const;

export interface SkillSheetFile {
  id: string;
  name: string; // 個人名を含み得るためログに出さない
  mimeType: string;
  modifiedTime: string; // RFC 3339（変更検知のキー）
  webViewLink: string;
  size: number | null; // Googleドキュメント等は null
}

export type SkillSheetFormat = 'pdf' | 'excel' | 'docx' | 'gdoc' | 'gsheet';

export type SkillSheetContent = { kind: 'pdf'; base64: string } | { kind: 'text'; text: string };

// アップロード時に application/octet-stream になっていることがあるため、拡張子でも判定する
export function skillSheetFormat(file: Pick<SkillSheetFile, 'name' | 'mimeType'>): SkillSheetFormat | null {
  if (file.mimeType === MIME.gdoc) return 'gdoc';
  if (file.mimeType === MIME.gsheet) return 'gsheet';
  if (file.mimeType.startsWith('application/vnd.google-apps.')) return null; // ショートカット・フォーム等
  if (file.mimeType === MIME.pdf || /\.pdf$/i.test(file.name)) return 'pdf';
  if (file.mimeType === MIME.xlsx || file.mimeType === MIME.xls || /\.(xlsx|xlsm|xls)$/i.test(file.name)) return 'excel';
  if (file.mimeType === MIME.docx || /\.docx$/i.test(file.name)) return 'docx';
  return null;
}

let client: drive_v3.Drive | null = null;

function driveApi(): drive_v3.Drive {
  if (client) return client;
  const auth = properGoogleAuth(DRIVE_SCOPES);
  if (!auth) {
    throw new SafeLogError('プロパー: Google認証（GOOGLE_SA_KEY_JSON 等）が未設定のためスキルシートを読めません');
  }
  client = google.drive({ version: 'v3', auth });
  return client;
}

// フォルダ配下のファイル（フォルダ以外。ゴミ箱は除く）を列挙する。共有ドライブ上のフォルダにも対応
export async function listSkillSheetFiles(): Promise<SkillSheetFile[]> {
  const root = properFolderId();
  if (!/^[A-Za-z0-9_-]+$/.test(root)) {
    throw new SafeLogError('プロパー: PROPER_SKILLSHEET_FOLDER_ID の形式が正しくありません（フォルダのURLまたはID）');
  }
  const drive = driveApi();
  const files: SkillSheetFile[] = [];
  const seenFolders = new Set<string>([root]);
  let level = [root];
  for (let depth = 0; depth <= MAX_FOLDER_DEPTH && level.length > 0; depth++) {
    const next: string[] = [];
    for (const folderId of level) {
      let pageToken: string | undefined;
      do {
        let res: { data: drive_v3.Schema$FileList };
        try {
          res = await withGoogleRetry(() =>
            drive.files.list({
              q: `'${folderId}' in parents and trashed = false`,
              fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, webViewLink, size)',
              pageSize: 1000,
              pageToken,
              supportsAllDrives: true,
              includeItemsFromAllDrives: true,
            }),
          );
        } catch (err) {
          if (depth > 0) throw err;
          const status = (err as { response?: { status?: number } }).response?.status;
          throw new SafeLogError(
            `プロパー: スキルシートのフォルダを読めません（status=${status ?? '不明'}）。フォルダIDが正しいか、${properAccessHint()}`,
          );
        }
        for (const f of res.data.files ?? []) {
          if (!f.id) continue;
          if (f.mimeType === MIME.folder) {
            if (!seenFolders.has(f.id)) next.push(f.id);
            seenFolders.add(f.id);
            continue;
          }
          files.push({
            id: f.id,
            name: f.name ?? '',
            mimeType: f.mimeType ?? '',
            modifiedTime: f.modifiedTime ?? '',
            webViewLink: f.webViewLink ?? '',
            size: f.size ? Number(f.size) : null,
          });
        }
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken);
    }
    level = next;
  }
  return files;
}

function clip(text: string): string {
  const compact = text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
    .join('\n');
  return compact.length > MAX_TEXT_CHARS ? compact.slice(0, MAX_TEXT_CHARS) : compact;
}

// CSV化したスキルシート（Excel等）は罫線・結合セル由来の空セルが大半のため、行末のカンマと空行を詰める
function clipCsv(csv: string): string {
  return clip(
    csv
      .split('\n')
      .map((line) => (line.replace(/,/g, '').trim() === '' ? '' : line.replace(/,+$/, '')))
      .join('\n'),
  );
}

function tooLarge(): SafeLogError {
  return new SafeLogError(`ファイルサイズが${SKILL_SHEET_MAX_BYTES / 1024 / 1024}MBを超えるため読み取りません`);
}

async function download(fileId: string): Promise<Buffer> {
  const res = await withGoogleRetry(() =>
    driveApi().files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' }),
  );
  const buf = Buffer.from(res.data as unknown as ArrayBuffer);
  if (buf.length > SKILL_SHEET_MAX_BYTES) throw tooLarge();
  return buf;
}

// Googleドキュメント/スプレッドシートの書き出し（Drive APIの書き出し上限も10MB）
async function exportAs(fileId: string, mimeType: string): Promise<Buffer> {
  const res = await withGoogleRetry(() =>
    driveApi().files.export({ fileId, mimeType }, { responseType: 'arraybuffer' }),
  );
  return Buffer.from(res.data as unknown as ArrayBuffer);
}

// 読み取り前に弾けるもの（未対応形式・サイズ超過）の理由。問題なければ null
export function precheckSkillSheet(file: SkillSheetFile): string | null {
  if (!skillSheetFormat(file)) return '未対応の形式です（PDF・Excel・Word(.docx)・Googleドキュメント/スプレッドシートに対応）';
  if (file.size !== null && file.size > SKILL_SHEET_MAX_BYTES) return tooLarge().message;
  return null;
}

export async function loadSkillSheetContent(file: SkillSheetFile): Promise<SkillSheetContent> {
  switch (skillSheetFormat(file)) {
    case 'pdf':
      return { kind: 'pdf', base64: (await download(file.id)).toString('base64') };
    case 'excel':
      return { kind: 'text', text: clipCsv(spreadsheetBufferToText(await download(file.id))) };
    case 'docx': {
      const result = await mammoth.extractRawText({ buffer: await download(file.id) });
      return { kind: 'text', text: clip(result.value) };
    }
    case 'gdoc':
      return { kind: 'text', text: clip((await exportAs(file.id, 'text/plain')).toString('utf-8')) };
    case 'gsheet':
      return { kind: 'text', text: clipCsv(spreadsheetBufferToText(await exportAs(file.id, MIME.xlsx))) };
    default:
      throw new SafeLogError('未対応の形式です');
  }
}
