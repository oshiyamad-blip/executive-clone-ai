// 添付・リンク展開。xlsx→テキスト化、Google スプレッドシートリンク検出→Sheets API 読取、
// PDFは base64 のまま次段(extract)へ渡す（Claudeのdocumentブロックで直接読解するため）。
// demoは fixture にあらかじめ埋めたテキストをそのまま返す（外部アクセスしない）。
// 添付は社外の誰からでも届くため、表計算の解析前に形式（先頭バイト）とサイズを確かめ、
// 解析は数式・スタイル・マクロ等を読まない設定で行い、行数と文字数に上限を設ける。
import { inflateRawSync } from 'zlib';
import { read as readXlsx, utils as xlsxUtils } from 'xlsx';
import { google, sheets_v4, drive_v3 } from 'googleapis';
import { getServiceAccountAuth } from '../collectors/googleAuth.js';
import { isDemo, sheetsDbSpreadsheetId, properMasterSpreadsheetId, properFolderId, ownDomains, logRedact } from './config.js';
import { redactable, safeErr, SafeLogError, logId } from './redact.js';
import { GOOGLE_REQUEST_TIMEOUT_MS } from '../database/sheetBook.js';
import { pastExtractDeadline } from './schedule.js';
import type { SesRawMail, SesAttachment } from '../types/index.js';

export async function parseAttachments(mails: SesRawMail[]): Promise<SesRawMail[]> {
  if (isDemo()) return mails; // fixtureは attachments[].text 済み。展開処理をスキップ

  const parsed: SesRawMail[] = [];
  const linkStats: SheetLinkStats = { read: 0, skipped: 0, internal: 0, unchecked: 0 };
  let deferred = 0;
  for (const mail of mails) {
    // 抽出の持ち時間を過ぎたら残りは展開しない（抽出も始めないため、処理済みにならず次回の実行で続きから処理する）
    if (pastExtractDeadline()) {
      deferred += 1;
      parsed.push(mail);
      continue;
    }
    try {
      const fileAttachments = await Promise.all(mail.attachments.map(parseAttachment));
      const sheetAttachments = await parseSheetLinks(mail, linkStats);
      parsed.push({ ...mail, attachments: [...fileAttachments, ...sheetAttachments] });
    } catch (err) {
      // 秘匿モードでは1通ごとの失敗を公開ログに出さない（送り主が自分の添付の扱いを確かめられないように）
      if (!logRedact()) console.error(`SES展開: 添付展開に失敗 (mail ${logId(mail.id)}): ${safeErr(err)}`);
      parsed.push(mail); // 失敗しても本文だけで処理継続
    }
  }
  if (deferred > 0) console.log(`SES展開: 実行時間の上限を過ぎたため${deferred}件の添付展開を次回に回します`);
  // リンクの件数は、送り主がファイルIDを入れたリンクを送って「サービスアカウントが読めるか・社内のファイルか」を
  // 公開ログから確かめられるため、秘匿モードでは件数を出さない
  if (linkStats.read + linkStats.skipped + linkStats.unchecked > 0) {
    if (logRedact()) {
      console.log('SES展開: メール本文のスプレッドシートのリンクを確認しました（件数は秘匿モードのため表示しません）');
    } else {
      console.log(
        `SES展開: スプレッドシートのリンク 読取${linkStats.read}件・読めず${linkStats.skipped}件` +
          `${linkStats.internal > 0 ? `（うち社内のファイルのため読まなかった${linkStats.internal}件）` : ''}（サービスアカウントに共有された社外のものだけ読みます）`,
      );
    }
  }
  if (linkStats.unchecked > 0) {
    console.warn(
      `SES展開: SES_OWN_DOMAINS（自社ドメイン）が未設定などで社内のファイルかを確かめられないため、スプレッドシートのリンク${logRedact() ? '' : `${linkStats.unchecked}件`}を読みませんでした`,
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
    if (!logRedact()) console.warn(`SES展開: xlsx解析に失敗 (${redactable(att.filename)}): ${safeErr(err)}`);
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
// xlsx（ZIP）を展開した後の合計の上限。圧縮後は10MB以内でも展開すると数GBになるファイル（zip bomb）は、
// SheetJS が全エントリを展開するため1通で数十秒・数GBのメモリを使い、実行時間の上限を超えて毎回同じメールで止まる
export const SPREADSHEET_MAX_INFLATED_BYTES = 64 * 1024 * 1024;
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

interface ZipEntry {
  name: string;
  method: number;
  start: number;
  compressedSize: number;
}

// ZIP の中央ディレクトリの各エントリ（名前・圧縮方式・ローカルヘッダの直後のデータ位置）。壊れていれば null
function zipEntries(data: Buffer): ZipEntry[] | null {
  const eocd = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || eocd + 22 > data.length) return null;
  const count = data.readUInt16LE(eocd + 8);
  let p = data.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > data.length) return null;
    const nameLen = data.readUInt16LE(p + 28);
    if (p + 46 + nameLen > data.length) return null;
    const name = data.toString('utf8', p + 46, p + 46 + nameLen);
    const compressedSize = data.readUInt32LE(p + 20);
    const offset = data.readUInt32LE(p + 42);
    p += 46 + nameLen + data.readUInt16LE(p + 30) + data.readUInt16LE(p + 32);
    if (offset + 30 > data.length) return null;
    const method = data.readUInt16LE(offset + 8);
    const start = offset + 30 + data.readUInt16LE(offset + 26) + data.readUInt16LE(offset + 28);
    if (start > data.length) return null;
    out.push({ name, method, start, compressedSize });
  }
  return out;
}

// xlsx（ZIP）の各エントリを SheetJS と同じ手順（中央ディレクトリの各エントリ→ローカルヘッダの直後のデータ）で、
// 合計 maxBytes まで実際に展開して確かめる（ヘッダの宣言サイズは偽れるため信用しない）。
// 上限を超える・壊れている・対応しない圧縮方式なら false（解析しない）
export function zipInflatesWithin(data: Buffer, maxBytes: number): boolean {
  const entries = zipEntries(data);
  if (!entries) return false;
  let remaining = maxBytes;
  for (const e of entries) {
    if (e.method === 0) continue; // 無圧縮（ファイルの大きさ以上にはならない）
    if (e.method !== 8) return false;
    try {
      remaining -= inflateRawSync(data.subarray(e.start), { maxOutputLength: remaining + 1 }).length;
    } catch {
      return false; // 上限超過（ERR_BUFFER_TOO_LARGE）・壊れたデータ
    }
    if (remaining < 0) return false;
  }
  return true;
}

// ZIP の1エントリの中身（XML等の小さなテキスト。1MBまで）。読めなければ null
function zipEntryText(data: Buffer, e: ZipEntry): string | null {
  try {
    const raw = e.method === 0 ? data.subarray(e.start, e.start + e.compressedSize) : inflateRawSync(data.subarray(e.start), { maxOutputLength: 1024 * 1024 });
    return raw.toString('utf8');
  } catch {
    return null;
  }
}

// 解析してよい .bin（SheetJS が読まない付属物: 印刷設定・埋め込みオブジェクト・マクロ）
const HARMLESS_BIN = /^xl\/(?:printersettings\/[^/]+|embeddings\/[^/]+|vbaproject[^/]*)\.bin$/;

// 通常の xlsx（OOXML の XML 形式のブック）か。ZIP の中身が XLSB（xl/workbook.bin 等のバイナリ形式）・ODS・Numbers だと、
// SheetJS はそれぞれ別の解析器に回し、その解析器は添付の中の文字列（定義名等）をそのままコンソールに出す。
// 公開の Actions ログに送り主の文字列が出ないよう、XML 形式のブック以外は解析しない
export function isPlainOoxmlWorkbook(data: Buffer): boolean {
  const entries = zipEntries(data);
  if (!entries) return false;
  const names = entries.map((e) => e.name.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase());
  const ctIndex = names.indexOf('[content_types].xml');
  if (ctIndex < 0) return false;
  const foreign = (n: string) =>
    n === 'meta-inf/manifest.xml' || n === 'objectdata.xml' || n.startsWith('index/') || n === 'index.zip' || n.endsWith('/index.zip');
  if (names.some((n) => foreign(n) || (n.endsWith('.bin') && !HARMLESS_BIN.test(n)))) return false;
  const text = zipEntryText(data, entries[ctIndex]);
  if (text === null) return false;
  // 部品の種類の個別登録（Override）で、XLSB のブックの種類や .bin の部品（ブック・シートとして読ませる）があれば解析しない
  // （拡張子ごとの既定（Default）の bin は通常の xlsx にもあり、SheetJS はブックの判定に使わない）
  const overrides = text.match(/<(?:[\w-]+:)?Override\b[^>]*>/gi) ?? [];
  // ブックからシート等への参照（xl/_rels/workbook.xml.rels）が .bin を指すものも、バイナリの解析器に回るため解析しない
  const relsIndex = names.indexOf('xl/_rels/workbook.xml.rels');
  const rels = relsIndex < 0 ? '' : zipEntryText(data, entries[relsIndex]);
  if (rels === null || /Target\s*=\s*["'][^"']*\.bin["']/i.test(rels)) return false;
  return !overrides.some((tag) => /sheet\.binary/i.test(tag) || /PartName\s*=\s*["'][^"']*\.bin["']/i.test(tag));
}

// SheetJS は解析できない部品に出会うと、添付の中の文字列を含むメッセージを console に直接書く（ログ秘匿を通らない）。
// 解析の間だけ console の出力を捨てる（同期処理のため、他の処理の出力を巻き込まない）
export function withConsoleSilenced<T>(fn: () => T): T {
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug, trace: console.trace };
  const drop = () => undefined;
  Object.assign(console, { log: drop, info: drop, warn: drop, error: drop, debug: drop, trace: drop });
  try {
    return fn();
  } finally {
    Object.assign(console, saved);
  }
}

// Excel（.xlsx/.xls）の全シートをCSVテキストにする（プロパーのスキルシート読み取りでも使う）
export function spreadsheetBufferToText(data: Buffer): string {
  if (data.length > SPREADSHEET_MAX_BYTES) throw new SafeLogError('表計算ファイルが大きすぎるため解析しません（10MB超）');
  const kind = spreadsheetKind(data);
  if (!kind) throw new SafeLogError('Excel形式（xlsx/xls）ではないため解析しません');
  if (kind === 'xlsx' && !zipInflatesWithin(data, SPREADSHEET_MAX_INFLATED_BYTES)) {
    throw new SafeLogError('表計算ファイルの展開後の大きさが上限を超えるか壊れているため解析しません');
  }
  if (kind === 'xlsx' && !isPlainOoxmlWorkbook(data)) {
    throw new SafeLogError('通常のxlsx（XML形式のブック）ではないため解析しません（xlsb・ods等）');
  }
  return withConsoleSilenced(() => workbookToText(data));
}

function workbookToText(data: Buffer): string {
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
  unchecked: number; // 自社ドメイン（SES_OWN_DOMAINS）等が未設定で社内のファイルかを確かめられず読まなかった件数
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
// このシステムのDB・プロパー管理表の所有者と、サービスアカウントに共有した人（社内の人のアドレス）。
// 個人のGoogleアカウント（@gmail.com 等）で社内のシートを持つ運用では、自社ドメインだけでは社内のファイルと分からないため、
// これらの人が所有する・共有したファイルも社内とみなす（1回の実行で1回だけ読む。読めなければ加えない）
let internalPeopleCache: Promise<Set<string>> | null = null;

function internalPeople(drive: drive_v3.Drive): Promise<Set<string>> {
  internalPeopleCache ??= (async () => {
    const out = new Set<string>();
    for (const fileId of [sheetsDbSpreadsheetId(), properMasterSpreadsheetId()].filter(Boolean)) {
      try {
        const f = (await drive.files.get({ fileId, fields: 'owners(emailAddress), sharingUser(emailAddress)', supportsAllDrives: true })).data;
        for (const a of [...(f.owners ?? []).map((o) => o.emailAddress), f.sharingUser?.emailAddress]) {
          if (a) out.add(a.toLowerCase());
        }
      } catch {
        // 読めない（Drive APIが無効等）。自社ドメイン・フォルダでの判定だけになる
      }
    }
    return out;
  })();
  return internalPeopleCache;
}

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
  const internal = await internalPeople(drive);
  const people = [...(f.owners ?? []).map((o) => o.emailAddress), f.sharingUser?.emailAddress].map((a) => (a ?? '').toLowerCase());
  if (people.some((a) => a !== '' && internal.has(a))) return 'internal';
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
  // 自社ドメイン・プロパーのフォルダが分からなければ社内のファイルかを判定できないため、リンクは読まない
  // （サービスアカウントに共有した社内のシートを、URLを知る社外の人に読み出させないため。確かめられないときは読まない側に倒す）
  const driveAuth = ownDomains().length > 0 || properFolderId() ? getServiceAccountAuth(DRIVE_METADATA_SCOPES) : null;
  if (!driveAuth) {
    stats.skipped += mail.sheetLinks.length;
    stats.unchecked += mail.sheetLinks.length;
    return [];
  }
  const driveApi = google.drive({ version: 'v3', auth: driveAuth, timeout: GOOGLE_REQUEST_TIMEOUT_MS });
  const results: SesAttachment[] = [];
  // 同じファイルへの別の書き方のURL（/edit・/htmlview・#gid 等）は1件として扱う
  const spreadsheetIds = [...new Set(mail.sheetLinks.map((link) => extractSpreadsheetId(link) ?? ''))];
  for (const spreadsheetId of spreadsheetIds) {
    if (!spreadsheetId || ownSheets.has(spreadsheetId)) {
      stats.skipped += 1;
      continue;
    }
    const origin = await fileOrigin(driveApi, spreadsheetId);
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
      if (!logRedact()) console.warn(`SES展開: スプレッドシートのタブ読取に失敗 (${redactable(title)}): ${safeErr(err)}`);
    }
  }
  return parts.join('\n\n');
}

function extractSpreadsheetId(url: string): string | null {
  const m = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}
