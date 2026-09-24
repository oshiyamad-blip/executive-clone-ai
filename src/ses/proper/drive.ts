// プロパーのスキルシート置き場（Driveフォルダ）の一覧取得とテキスト化。
// 対応形式: PDF（Claudeのdocumentブロックでそのまま読ませる）/ Excel（.xlsx/.xls）/ Word（.docx）/
// Googleドキュメント（テキストで書き出し）/ Googleスプレッドシート（xlsxで書き出して全タブを読む）。
// ファイル名・本文は個人情報を含むためログに出さない（ファイルIDと件数のみ）。
import { google, type drive_v3 } from 'googleapis';
import { properFolderId, properFollowShortcuts, properImpersonate, internalFileDomains } from '../config.js';
import { spreadsheetBufferToTextIsolated, docxBufferToTextIsolated } from '../spreadsheetIsolated.js';
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
  shortcut: 'application/vnd.google-apps.shortcut',
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
  viaShortcut?: boolean; // フォルダ内のショートカットからたどったファイル（名前をサマリに載せない）
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
// オフライン自己検証（npm run ses:flow:check）用の差し替え口（本番コードからは呼ばない）
let testDrive: drive_v3.Drive | null = null;

export function __setDriveForTest(drive: drive_v3.Drive | null): void {
  testDrive = drive;
}

function driveApi(): drive_v3.Drive {
  if (testDrive) return testDrive;
  if (client) return client;
  const auth = properGoogleAuth(DRIVE_SCOPES);
  if (!auth) {
    throw new SafeLogError(`プロパー: Google認証が未設定か使えない組み合わせのためスキルシートを読めません（${properAccessHint()}）`);
  }
  // スキルシートのダウンロード・書き出し（最大10MB）に足りる待ち時間。応答の無い接続で実行全体を止めない
  client = google.drive({ version: 'v3', auth, timeout: 120_000 });
  return client;
}

// ショートカットの参照先のファイル情報（更新日時・リンクは参照先のものを使う。読めなければ null）
async function shortcutTarget(drive: drive_v3.Drive, targetId: string): Promise<drive_v3.Schema$File | null> {
  try {
    const res = await withGoogleRetry(() =>
      drive.files.get({
        fileId: targetId,
        fields: 'id, name, mimeType, modifiedTime, webViewLink, size, trashed, owners(emailAddress), parents, driveId',
        supportsAllDrives: true,
      }),
    );
    return res.data.trashed ? null : res.data;
  } catch {
    return null;
  }
}

// 参照先を読んでよいか（純関数）。フォルダの外のファイル（人事の資料等）を、フォルダにショートカットを置くだけで
// プロパーの認証（なりすまし先のユーザーの権限）で読ませないため、次のどれかに当たるものだけを読む:
// - 参照先がスキルシートのフォルダ配下にある（inTree）
// - 参照先がフォルダと同じ共有ドライブにある
// - 参照先の所有者が全員社内のドメインで、ショートカットを置いた人（ショートカットの所有者）が参照先の所有者でもある
export function shortcutTargetAllowed(input: {
  inTree: boolean;
  rootDriveId: string;
  targetDriveId: string;
  targetOwners: string[];
  shortcutOwners: string[];
  internalDomains: string[];
}): boolean {
  if (input.inTree) return true;
  if (input.rootDriveId && input.targetDriveId === input.rootDriveId) return true;
  const owners = input.targetOwners.map((a) => a.toLowerCase()).filter(Boolean);
  if (owners.length === 0 || input.internalDomains.length === 0) return false;
  const internal = owners.every((a) => input.internalDomains.includes(a.slice(a.lastIndexOf('@') + 1)));
  const placedByOwner = input.shortcutOwners.some((a) => owners.includes(a.toLowerCase()));
  return internal && placedByOwner;
}

// 参照先がフォルダ（root）の配下か（親を最大 MAX_FOLDER_DEPTH+1 階層たどる。見られない親は配下でないとみなす）
async function underFolder(drive: drive_v3.Drive, parents: string[], root: string, known: Set<string>): Promise<boolean> {
  let level = parents;
  for (let depth = 0; depth <= MAX_FOLDER_DEPTH && level.length > 0; depth++) {
    if (level.some((p) => p === root || known.has(p))) return true;
    const next: string[] = [];
    for (const parent of level) {
      try {
        const r = await withGoogleRetry(() => drive.files.get({ fileId: parent, fields: 'parents', supportsAllDrives: true }));
        next.push(...(r.data.parents ?? []));
      } catch {
        // 見られない親フォルダ
      }
    }
    level = next;
  }
  return false;
}

async function folderDriveId(drive: drive_v3.Drive, folderId: string): Promise<string> {
  try {
    const r = await withGoogleRetry(() => drive.files.get({ fileId: folderId, fields: 'driveId', supportsAllDrives: true }));
    return r.data.driveId ?? '';
  } catch {
    return '';
  }
}

// フォルダ配下のファイル（フォルダ以外。ゴミ箱は除く）を列挙する。共有ドライブ上のフォルダにも対応。
// ショートカットは既定ではたどらない（フォルダにファイルを追加できる人が、プロパーの認証で読める任意のファイル・フォルダ
// （人事の資料等）へのショートカットを置くと、それを読み取って管理表・案件スプレッドシート・サマリへ書き出してしまうため）。
// PROPER_FOLLOW_SHORTCUTS=true のときだけ、ファイルへのショートカットの参照先を読む（フォルダへのショートカットはたどらない。
// 参照先がフォルダの外なら、所有者とショートカットを置いた人を確かめる: shortcutTargetAllowed）
export async function listSkillSheetFiles(): Promise<SkillSheetFile[]> {
  const root = properFolderId();
  if (!/^[A-Za-z0-9_-]+$/.test(root)) {
    throw new SafeLogError('プロパー: PROPER_SKILLSHEET_FOLDER_ID の形式が正しくありません（フォルダのURLまたはID）');
  }
  const drive = driveApi();
  // なりすまし（PROPER_GOOGLE_IMPERSONATE）中は、そのユーザーの権限で読める範囲が広いためショートカットをたどらない
  const followShortcuts = properFollowShortcuts() && !properImpersonate();
  const files: SkillSheetFile[] = [];
  const seenFolders = new Set<string>([root]);
  const seenFiles = new Set<string>();
  let skippedShortcuts = 0;
  let rejectedShortcuts = 0;
  let rootDriveId: string | null = null;
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
              fields:
                'nextPageToken, files(id, name, mimeType, modifiedTime, webViewLink, size, owners(emailAddress), shortcutDetails(targetId, targetMimeType))',
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
        for (const listed of res.data.files ?? []) {
          let f: drive_v3.Schema$File = listed;
          let viaShortcut = false;
          if (listed.mimeType === MIME.shortcut) {
            const targetId = listed.shortcutDetails?.targetId;
            if (!followShortcuts || !targetId || listed.shortcutDetails?.targetMimeType === MIME.folder) {
              skippedShortcuts += 1;
              continue;
            }
            const target = await shortcutTarget(drive, targetId);
            if (!target?.id || target.mimeType === MIME.folder) continue;
            rootDriveId ??= await folderDriveId(drive, root);
            const allowed = shortcutTargetAllowed({
              inTree: await underFolder(drive, target.parents ?? [], root, seenFolders),
              rootDriveId,
              targetDriveId: target.driveId ?? '',
              targetOwners: (target.owners ?? []).map((o) => o.emailAddress ?? ''),
              shortcutOwners: (listed.owners ?? []).map((o) => o.emailAddress ?? ''),
              internalDomains: internalFileDomains(),
            });
            if (!allowed) {
              rejectedShortcuts += 1;
              continue;
            }
            f = target;
            viaShortcut = true;
          }
          if (!f.id) continue;
          if (f.mimeType === MIME.folder) {
            if (!seenFolders.has(f.id)) next.push(f.id);
            seenFolders.add(f.id);
            continue;
          }
          if (seenFiles.has(f.id)) continue; // 原本とショートカットの両方がある等
          seenFiles.add(f.id);
          files.push({
            id: f.id,
            name: f.name ?? '',
            mimeType: f.mimeType ?? '',
            modifiedTime: f.modifiedTime ?? '',
            webViewLink: f.webViewLink ?? '',
            size: f.size ? Number(f.size) : null,
            ...(viaShortcut ? { viaShortcut } : {}),
          });
        }
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken);
    }
    level = next;
  }
  if (skippedShortcuts > 0) {
    console.log(
      `プロパー: スキルシートのフォルダ内のショートカット${skippedShortcuts}件は読みません（` +
        `${followShortcuts ? 'フォルダへのショートカットはたどりません' : '原本をフォルダに置くか、PROPER_FOLLOW_SHORTCUTS=true でファイルへのショートカットを読みます'}）`,
    );
  }
  if (rejectedShortcuts > 0) {
    console.log(
      `プロパー: フォルダの外のファイルを指すショートカット${rejectedShortcuts}件は読みません（所有者が社外、またはショートカットを置いた人が所有者でないため。` +
        '原本をフォルダに置いてください）',
    );
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
      return { kind: 'text', text: clipCsv(await spreadsheetBufferToTextIsolated(await download(file.id))) };
    case 'docx':
      // ZIP の検査（宣言サイズ・展開後の大きさ）を通ったものだけを、メモリ上限・時間切れつきのワーカーで読む
      return { kind: 'text', text: clip(await docxBufferToTextIsolated(await download(file.id))) };
    case 'gdoc':
      return { kind: 'text', text: clip((await exportAs(file.id, 'text/plain')).toString('utf-8')) };
    case 'gsheet':
      return { kind: 'text', text: clipCsv(await spreadsheetBufferToTextIsolated(await exportAs(file.id, MIME.xlsx))) };
    default:
      throw new SafeLogError('未対応の形式です');
  }
}
