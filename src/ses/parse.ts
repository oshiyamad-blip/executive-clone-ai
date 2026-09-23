// 添付・リンク展開。xlsx→テキスト化、Google スプレッドシートリンク検出→Sheets API 読取、
// PDFは base64 のまま次段(extract)へ渡す（Claudeのdocumentブロックで直接読解するため）。
// demoは fixture にあらかじめ埋めたテキストをそのまま返す（外部アクセスしない）。
// 添付は社外の誰からでも届くため、表計算の解析前に形式（先頭バイト）とサイズを確かめ、
// 解析は数式・スタイル・マクロ等を読まない設定で行い、行数と文字数に上限を設ける。
import { read as readXlsx, utils as xlsxUtils } from 'xlsx';
import { google, sheets_v4, drive_v3 } from 'googleapis';
import { getServiceAccountAuth } from '../collectors/googleAuth.js';
import { isDemo, sheetsDbSpreadsheetId, properMasterSpreadsheetId, properFolderId, ownDomains } from './config.js';
import { redactable, safeErr, SafeLogError } from './redact.js';
import { GOOGLE_REQUEST_TIMEOUT_MS } from '../database/sheetBook.js';
import type { SesRawMail, SesAttachment } from '../types/index.js';

export async function parseAttachments(mails: SesRawMail[]): Promise<SesRawMail[]> {
  if (isDemo()) return mails; // fixtureは attachments[].text 済み。展開処理をスキップ

  const parsed: SesRawMail[] = [];
  const linkStats: SheetLinkStats = { read: 0, skipped: 0, internal: 0 };
  for (const mail of mails) {
    try {
      const fileAttachments = await Promise.all(mail.attachments.map(parseAttachment));
      const sheetAttachments = await parseSheetLinks(mail, linkStats);
      parsed.push({ ...mail, attachments: [...fileAttachments, ...sheetAttachments] });
    } catch (err) {
      console.error(`SES展開: 添付展開に失敗 (mail ${mail.id}): ${safeErr(err)}`);
      parsed.push(mail); // 失敗しても本文だけで処理継続
    }
  }
  if (linkStats.read + linkStats.skipped > 0) {
    console.log(
      `SES展開: スプレッドシートのリンク 読取${linkStats.read}件・読めず${linkStats.skipped}件` +
        `${linkStats.internal > 0 ? `（うち社内のファイルのため読まなかった${linkStats.internal}件）` : ''}（サービスアカウントに共有された社外のものだけ読みます）`,
    );
  }
  return parsed;
}

async function parseAttachment(att: SesAttachment): Promise<SesAttachment> {
  if (att.text) return att; // 既にテキスト化済み
  if (!isExcelAttachment(att) || !att.data) return att; // PDFはbase64を温存しそのまま次段へ

  try {
    return { ...att, text: xlsxToText(att.data) };
  } catch (err) {
    console.warn(`SES展開: xlsx解析に失敗 (${redactable(att.filename)}): ${safeErr(err)}`);
    return att;
  }
}

// 日本のメーラーは .xlsx を application/octet-stream で送ることが多いため、MIMEに加え拡張子でも判定する
function isExcelAttachment(att: SesAttachment): boolean {
  return isExcelMime(att.mimeType) || /\.(xlsx|xls)$/i.test(att.filename);
}

function isExcelMime(mimeType: string): boolean {
  return (
    mimeType.includes('spreadsheet') || mimeType.includes('excel') || mimeType === 'application/vnd.ms-excel'
  );
}

function xlsxToText(base64Data: string): string {
  return spreadsheetBufferToText(Buffer.from(base64Data, 'base64'));
}

// 表計算の解析上限。これを超えるファイルは解析しない／以降の行・文字を読まない
export const SPREADSHEET_MAX_BYTES = 10 * 1024 * 1024;
const SPREADSHEET_MAX_ROWS = 2000;
const SPREADSHEET_MAX_TEXT_CHARS = 200_000;

// 先頭バイトで形式を判定する（拡張子・MIMEは送信者が自由に付けられるため）。
// xlsx は ZIP（PK\x03\x04）、旧形式の xls は OLE 複合文書（D0 CF 11 E0 A1 B1 1A E1）
export function spreadsheetKind(data: Buffer): 'xlsx' | 'xls' | null {
  if (data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) return 'xlsx';
  const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (data.length >= 8 && ole.every((b, i) => data[i] === b)) return 'xls';
  return null;
}

// Excel（.xlsx/.xls）の全シートをCSVテキストにする（プロパーのスキルシート読み取りでも使う）
export function spreadsheetBufferToText(data: Buffer): string {
  if (data.length > SPREADSHEET_MAX_BYTES) throw new SafeLogError('表計算ファイルが大きすぎるため解析しません（10MB超）');
  if (!spreadsheetKind(data)) throw new SafeLogError('Excel形式（xlsx/xls）ではないため解析しません');
  const workbook = readXlsx(data, {
    type: 'buffer',
    dense: true,
    sheetRows: SPREADSHEET_MAX_ROWS,
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    cellNF: false,
    bookVBA: false,
    bookFiles: false,
  });
  const parts: string[] = [];
  let total = 0;
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const part = `【シート: ${name}】\n${xlsxUtils.sheet_to_csv(sheet)}`;
    if (total + part.length > SPREADSHEET_MAX_TEXT_CHARS) {
      parts.push(`${part.slice(0, Math.max(0, SPREADSHEET_MAX_TEXT_CHARS - total))}\n…（長いため以降を省略）`);
      break;
    }
    parts.push(part);
    total += part.length;
  }
  return parts.join('\n\n');
}

const SHEETS_READONLY_SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

// リンク先のシート1件あたりに読むタブ数・文字数の上限（巨大な公開シートで1通のプロンプトが膨らまないように）
const LINK_MAX_TABS = 10;
const LINK_MAX_CHARS = 30_000;

interface SheetLinkStats {
  read: number;
  skipped: number;
  internal: number;
}

const DRIVE_METADATA_SCOPES = ['https://www.googleapis.com/auth/drive.metadata.readonly'];
// 親フォルダをたどる深さ（プロパーのスキルシートのフォルダは2階層下まで使う）
const PARENT_DEPTH = 3;

function domainOf(address: string | null | undefined): string {
  const a = (address ?? '').toLowerCase();
  return a.includes('@') ? a.slice(a.lastIndexOf('@') + 1) : '';
}

let warnedDriveCheck = false;

type FileOrigin = 'internal' | 'external' | 'unreadable';

function statusOf(err: unknown): number {
  const e = err as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  return Number(e.response?.status ?? e.status ?? (typeof e.code === 'number' ? e.code : NaN));
}

function reasonOf(err: unknown): string {
  const e = err as { errors?: Array<{ reason?: unknown }>; response?: { data?: { error?: { errors?: Array<{ reason?: unknown }> } } } };
  const r = e.response?.data?.error?.errors?.[0]?.reason ?? e.errors?.[0]?.reason;
  return typeof r === 'string' ? r : '';
}

// 社内のファイル（自社ドメインの人が所有する・共有ドライブにある・プロパーのスキルシートのフォルダ配下にある）か。
// サービスアカウントは社内の共有物（スキルシート等）も読めるため、社外から届いたメールにリンクを貼られただけで
// 社内の個人情報を抽出・保存しないよう、確かめられない場合も社内とみなして読まない。
// - 共有ドライブのファイルは所有者（owners）が空で返るため、社外のドメインの人が明示的に共有したもの以外は社内とみなす
// - サービスアカウントに共有されていないファイル（404・権限なし）は読めないだけなので「読めない」として数える
async function fileOrigin(drive: drive_v3.Drive, fileId: string): Promise<FileOrigin> {
  const own = ownDomains();
  const folder = properFolderId();
  let f: drive_v3.Schema$File;
  try {
    f = (
      await drive.files.get({ fileId, fields: 'owners(emailAddress), sharingUser(emailAddress), driveId, parents', supportsAllDrives: true })
    ).data;
  } catch (err) {
    const status = statusOf(err);
    if (status === 404 || (status === 403 && ['notFound', 'insufficientPermissions', 'insufficientFilePermissions'].includes(reasonOf(err)))) {
      return 'unreadable';
    }
    if (!warnedDriveCheck) {
      warnedDriveCheck = true;
      console.warn(`SES展開: リンク先のファイルの所有者を確かめられないため読みません（Drive APIの有効化を確認）: ${safeErr(err)}`);
    }
    return 'internal';
  }
  const ownerDomains = (f.owners ?? []).map((o) => domainOf(o.emailAddress)).filter(Boolean);
  if (ownerDomains.some((d) => own.includes(d))) return 'internal';
  const sharer = domainOf(f.sharingUser?.emailAddress);
  const sharedByOutsider = sharer !== '' && own.length > 0 && !own.includes(sharer);
  if (f.driveId) return sharedByOutsider ? 'external' : 'internal';
  if (ownerDomains.length === 0 && !sharer) return 'internal'; // 誰のファイルか分からない
  let parents = f.parents ?? [];
  for (let depth = 0; depth < PARENT_DEPTH && parents.length > 0 && folder; depth++) {
    if (parents.includes(folder)) return 'internal';
    const next: string[] = [];
    for (const parent of parents) {
      try {
        const r = await drive.files.get({ fileId: parent, fields: 'parents', supportsAllDrives: true });
        next.push(...(r.data.parents ?? []));
      } catch {
        // 親フォルダを見られない（社外の共有ファイルでは普通）
      }
    }
    parents = next;
  }
  return Boolean(folder) && parents.includes(folder) ? 'internal' : 'external';
}

// 本文中のGoogleスプレッドシートリンクをSheets APIで読み取り、疑似的な添付として返す。
// 社外から届いたリンクは、サービスアカウント自身（DWDで社員になりすまさない）で読む。
// つまり送り主がサービスアカウントに明示的に共有したシート（または一般公開のシート）だけが読める。
// 社内の人だけが開けるシート（自社の単価表やこのシステムのDB自体）を、リンクを貼られただけで読み出さないため。
// 読めない場合は件数だけ数えて静かにスキップする（大半のリンクは共有されていないのが普通のため）
async function parseSheetLinks(mail: SesRawMail, stats: SheetLinkStats): Promise<SesAttachment[]> {
  if (mail.sheetLinks.length === 0) return [];
  const auth = getServiceAccountAuth(SHEETS_READONLY_SCOPES);
  if (!auth) {
    stats.skipped += mail.sheetLinks.length;
    return [];
  }

  const ownSheets = new Set([sheetsDbSpreadsheetId(), properMasterSpreadsheetId()].filter(Boolean));
  const sheetsApi = google.sheets({ version: 'v4', auth, timeout: GOOGLE_REQUEST_TIMEOUT_MS });
  // 自社ドメイン・プロパーのフォルダが分からなければ社内かどうかを判定できないため、確かめない
  const checkInternal = ownDomains().length > 0 || Boolean(properFolderId());
  const driveAuth = checkInternal ? getServiceAccountAuth(DRIVE_METADATA_SCOPES) : null;
  const driveApi = driveAuth ? google.drive({ version: 'v3', auth: driveAuth, timeout: GOOGLE_REQUEST_TIMEOUT_MS }) : null;
  const results: SesAttachment[] = [];
  for (const link of mail.sheetLinks) {
    const spreadsheetId = extractSpreadsheetId(link);
    if (!spreadsheetId || ownSheets.has(spreadsheetId)) {
      stats.skipped += 1;
      continue;
    }
    const origin = driveApi ? await fileOrigin(driveApi, spreadsheetId) : 'external';
    if (origin !== 'external') {
      stats.skipped += 1;
      if (origin === 'internal') stats.internal += 1;
      continue;
    }
    try {
      const text = await readSheetAsText(sheetsApi, spreadsheetId);
      if (!text) {
        stats.skipped += 1;
        continue;
      }
      stats.read += 1;
      results.push({
        filename: `スプレッドシート_${spreadsheetId}`,
        mimeType: 'application/vnd.google-apps.spreadsheet',
        data: '',
        text,
      });
    } catch {
      stats.skipped += 1;
    }
  }
  return results;
}

// スプレッドシートのタブ（上限あり）を読み取り、タブ区切りのテキストにする（文字数上限あり）
async function readSheetAsText(sheetsApi: sheets_v4.Sheets, spreadsheetId: string): Promise<string> {
  const meta = await sheetsApi.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  const titles = (meta.data.sheets ?? [])
    .map((s) => s.properties?.title)
    .filter((t): t is string => Boolean(t))
    .slice(0, LINK_MAX_TABS);
  if (titles.length === 0) return '';

  const parts: string[] = [];
  let total = 0;
  for (const title of titles) {
    if (total >= LINK_MAX_CHARS) break;
    try {
      const resp = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range: `'${title.replace(/'/g, "''")}'` });
      const rows = resp.data.values ?? [];
      if (rows.length === 0) continue; // 空タブはスキップ
      const part = `【タブ: ${title}】\n${rows.map((row) => row.join('\t')).join('\n')}`;
      const clipped = part.slice(0, LINK_MAX_CHARS - total);
      parts.push(clipped.length < part.length ? `${clipped}\n…（長いため以降を省略）` : clipped);
      total += clipped.length;
    } catch (err) {
      console.warn(`SES展開: スプレッドシートのタブ読取に失敗 (${redactable(title)}): ${safeErr(err)}`);
    }
  }
  return parts.join('\n\n');
}

function extractSpreadsheetId(url: string): string | null {
  const m = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}
