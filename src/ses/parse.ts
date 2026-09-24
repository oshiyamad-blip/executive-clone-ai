// 添付・リンク展開。xlsx→テキスト化、Google スプレッドシートリンク検出→Sheets API 読取、
// PDFは base64 のまま次段(extract)へ渡す（Claudeのdocumentブロックで直接読解するため）。
// demoは fixture にあらかじめ埋めたテキストをそのまま返す（外部アクセスしない）。
// 添付は社外の誰からでも届くため、表計算の解析前に形式（先頭バイト）とサイズを確かめ、
// 解析は数式・スタイル・マクロ等を読まない設定で行い、行数と文字数に上限を設ける。
import { google, sheets_v4, drive_v3 } from 'googleapis';
import { sesMainAuth } from './googleCreds.js';
import { isDemo, sheetsDbSpreadsheetId, properMasterSpreadsheetId, properFolderId, ownDomains, internalFileDomains, logRedact } from './config.js';
import { redactable, safeErr, logId } from './redact.js';
import { GOOGLE_REQUEST_TIMEOUT_MS, withGoogleRetry } from '../database/sheetBook.js';
import { pastExtractDeadline } from './schedule.js';
import { spreadsheetBufferToTextIsolated } from './spreadsheetIsolated.js';
import type { SesRawMail, SesAttachment } from '../types/index.js';

export {
  SPREADSHEET_MAX_BYTES,
  SPREADSHEET_MAX_INFLATED_BYTES,
  spreadsheetKind,
  zipInflatesWithin,
  isPlainOoxmlWorkbook,
  withConsoleSilenced,
  spreadsheetBufferToText,
} from './spreadsheetText.js';

// 1通で解析する表計算の添付の上限（件数）。1件ごとの解析は小さなファイルでも秒単位かかり得るため、
// 何百件も添付したメール1通で実行時間を使い切らせない（上限を超えた分はテキスト化しない）
export const MAIL_MAX_SPREADSHEETS = 5;

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
      const fileAttachments: SesAttachment[] = [];
      let spreadsheets = 0;
      for (const att of mail.attachments) {
        const excel = !att.text && Boolean(att.data) && isExcelAttachment(att);
        if (excel && ++spreadsheets > MAIL_MAX_SPREADSHEETS) {
          fileAttachments.push(att);
          continue;
        }
        fileAttachments.push(await parseAttachment(att));
      }
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
    return { ...att, text: await spreadsheetBufferToTextIsolated(Buffer.from(att.data, 'base64')) };
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
// complete=false は、DB・管理表の所有者を確かめられなかった（404 以外の失敗）こと。そのときは自社ドメイン以外の人のファイルを
// 社内の人のものかどうか見分けられないため、社外とみなさない（読まない側に倒す）。失敗した結果は次のリンクで確かめ直す
export interface InternalPeople {
  people: Set<string>;
  complete: boolean;
}

let internalPeopleCache: InternalPeople | null = null;

async function internalPeople(drive: drive_v3.Drive): Promise<InternalPeople> {
  if (internalPeopleCache) return internalPeopleCache;
  const people = new Set<string>();
  let complete = true;
  for (const fileId of [sheetsDbSpreadsheetId(), properMasterSpreadsheetId()].filter(Boolean)) {
    try {
      const f = (
        await withGoogleRetry(() =>
          drive.files.get({ fileId, fields: 'owners(emailAddress), sharingUser(emailAddress)', supportsAllDrives: true }),
        )
      ).data;
      for (const a of [...(f.owners ?? []).map((o) => o.emailAddress), f.sharingUser?.emailAddress]) {
        if (a) people.add(a.toLowerCase());
      }
    } catch (err) {
      // 404 はそのファイルがサービスアカウントに共有されていないだけ（別テナントの管理表等）。それ以外は確かめられなかった
      if (statusOf(err) !== 404) complete = false;
    }
  }
  const result = { people, complete };
  if (complete) internalPeopleCache = result;
  return result;
}

async function fileOrigin(drive: drive_v3.Drive, fileId: string): Promise<FileOrigin> {
  const own = internalFileDomains();
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
  if (people.some((a) => a !== '' && internal.people.has(a))) return 'internal';
  if (!internal.complete) return 'internal';
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

// オフライン自己検証（npm run ses:flow:check）用の差し替え口（本番コードからは呼ばない）
let testLinkApis: { drive: drive_v3.Drive; sheets: sheets_v4.Sheets } | null = null;

export function __setLinkApisForTest(apis: { drive: drive_v3.Drive; sheets: sheets_v4.Sheets } | null): void {
  testLinkApis = apis;
  internalPeopleCache = null;
}

// 本文中のGoogleスプレッドシートリンクをSheets APIで読み取り、疑似的な添付として返す。
// 社外から届いたリンクは、サービスアカウント自身（DWDで社員になりすまさない）で読む。
// つまり送り主がサービスアカウントに明示的に共有したシート（または一般公開のシート）だけが読める。
// 社内の人だけが開けるシート（自社の単価表やこのシステムのDB自体）を、リンクを貼られただけで読み出さないため。
// 読めない場合は件数だけ数えて静かにスキップする（大半のリンクは共有されていないのが普通のため）
async function parseSheetLinks(mail: SesRawMail, stats: SheetLinkStats): Promise<SesAttachment[]> {
  if (mail.sheetLinks.length === 0) return [];
  const auth = sesMainAuth(SHEETS_READONLY_SCOPES);
  if (!auth) {
    stats.skipped += mail.sheetLinks.length;
    return [];
  }

  const ownSheets = new Set([sheetsDbSpreadsheetId(), properMasterSpreadsheetId()].filter(Boolean));
  const sheetsApi = testLinkApis?.sheets ?? google.sheets({ version: 'v4', auth, timeout: GOOGLE_REQUEST_TIMEOUT_MS });
  // 自社ドメインが分からなければ社内のファイルかを判定できないため、リンクは読まない（プロパーのフォルダだけでは、
  // フォルダの外にある社員のシートを社内と見分けられない。サービスアカウントに共有した社内のシートを、URLを知る社外の人に
  // 読み出させないため。確かめられないときは読まない側に倒す）
  const driveAuth = ownDomains().length > 0 ? sesMainAuth(DRIVE_METADATA_SCOPES) : null;
  if (!driveAuth) {
    stats.skipped += mail.sheetLinks.length;
    stats.unchecked += mail.sheetLinks.length;
    return [];
  }
  const driveApi = testLinkApis?.drive ?? google.drive({ version: 'v3', auth: driveAuth, timeout: GOOGLE_REQUEST_TIMEOUT_MS });
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
