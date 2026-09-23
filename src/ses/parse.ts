// 添付・リンク展開。xlsx→テキスト化、Google スプレッドシートリンク検出→Sheets API 読取、
// PDFは base64 のまま次段(extract)へ渡す（Claudeのdocumentブロックで直接読解するため）。
// demoは fixture にあらかじめ埋めたテキストをそのまま返す（外部アクセスしない）。
import { read as readXlsx, utils as xlsxUtils } from 'xlsx';
import { google, sheets_v4 } from 'googleapis';
import { getServiceAccountAuth } from '../collectors/googleAuth.js';
import { isDemo, googleTargetEmail } from './config.js';
import { redactable, safeErr } from './redact.js';
import type { SesRawMail, SesAttachment } from '../types/index.js';

export async function parseAttachments(mails: SesRawMail[]): Promise<SesRawMail[]> {
  if (isDemo()) return mails; // fixtureは attachments[].text 済み。展開処理をスキップ

  const parsed: SesRawMail[] = [];
  for (const mail of mails) {
    try {
      const fileAttachments = await Promise.all(mail.attachments.map(parseAttachment));
      const sheetAttachments = await parseSheetLinks(mail);
      parsed.push({ ...mail, attachments: [...fileAttachments, ...sheetAttachments] });
    } catch (err) {
      console.error(`SES展開: 添付展開に失敗 (mail ${mail.id}): ${safeErr(err)}`);
      parsed.push(mail); // 失敗しても本文だけで処理継続
    }
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

// Excel（.xlsx/.xls）の全シートをCSVテキストにする（プロパーのスキルシート読み取りでも使う）
export function spreadsheetBufferToText(data: Buffer): string {
  const workbook = readXlsx(data, { type: 'buffer' });
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const csv = xlsxUtils.sheet_to_csv(sheet);
    return `【シート: ${name}】\n${csv}`;
  }).join('\n\n');
}

const SHEETS_READONLY_SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

// 本文中のGoogleスプレッドシートリンクをSheets APIで読み取り、疑似的な添付として返す。
// GOOGLE_TARGET_EMAIL があればDWDでそのユーザーとして（社内共有のシートも読める）、
// 無ければサービスアカウント単体で読む（リンク共有・SAへの共有のシートのみ）
async function parseSheetLinks(mail: SesRawMail): Promise<SesAttachment[]> {
  if (mail.sheetLinks.length === 0) return [];
  const auth = getServiceAccountAuth(SHEETS_READONLY_SCOPES, googleTargetEmail() || undefined);
  if (!auth) {
    console.warn(`SES展開: Google認証未設定のためスプレッドシートリンクをスキップ (mail ${mail.id})`);
    return [];
  }

  const sheetsApi = google.sheets({ version: 'v4', auth });
  const results: SesAttachment[] = [];
  for (const link of mail.sheetLinks) {
    const spreadsheetId = extractSpreadsheetId(link);
    if (!spreadsheetId) continue;
    try {
      const text = await readSheetAsText(sheetsApi, spreadsheetId);
      results.push({
        filename: `スプレッドシート_${spreadsheetId}`,
        mimeType: 'application/vnd.google-apps.spreadsheet',
        data: '',
        text,
      });
    } catch (err) {
      console.warn(`SES展開: スプレッドシート読取に失敗 (mail ${mail.id} ${redactable(link)}): ${safeErr(err)}`);
    }
  }
  return results;
}

// スプレッドシートの全タブを対象に、各タブの使用範囲すべてを読み取る。
// まず spreadsheets.get でタブ名一覧を取得し、range にタブ名のみを渡すことで
// そのタブの使用済みセル全域を取得する（旧実装の A1:Z200 固定による取りこぼしを解消）。
async function readSheetAsText(sheetsApi: sheets_v4.Sheets, spreadsheetId: string): Promise<string> {
  const meta = await sheetsApi.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  const titles = (meta.data.sheets ?? [])
    .map((s) => s.properties?.title)
    .filter((t): t is string => Boolean(t));
  if (titles.length === 0) return '';

  const parts: string[] = [];
  for (const title of titles) {
    try {
      // range にタブ名だけを指定すると、そのタブの使用範囲全体が返る（行・列上限なし）
      const resp = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range: title });
      const rows = resp.data.values ?? [];
      if (rows.length === 0) continue; // 空タブはスキップ
      parts.push(`【タブ: ${title}】\n${rows.map((row) => row.join('\t')).join('\n')}`);
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
