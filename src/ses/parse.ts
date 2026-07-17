// 添付・リンク展開。xlsx→テキスト化、Google スプレッドシートリンク検出→Sheets API 読取、
// PDFは base64 のまま次段(extract)へ渡す（Claudeのdocumentブロックで直接読解するため）。
// demoは fixture にあらかじめ埋めたテキストをそのまま返す（外部アクセスしない）。
import { read as readXlsx, utils as xlsxUtils } from 'xlsx';
import { google, sheets_v4 } from 'googleapis';
import { getGoogleAuth } from '../collectors/googleAuth.js';
import { isDemo } from './config.js';
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
      console.error(`SES展開: 添付展開に失敗 (mail ${mail.id}): ${String(err)}`);
      parsed.push(mail); // 失敗しても本文だけで処理継続
    }
  }
  return parsed;
}

async function parseAttachment(att: SesAttachment): Promise<SesAttachment> {
  if (att.text) return att; // 既にテキスト化済み
  if (!isExcelMime(att.mimeType) || !att.data) return att; // PDFはbase64を温存しそのまま次段へ

  try {
    return { ...att, text: xlsxToText(att.data) };
  } catch (err) {
    console.warn(`SES展開: xlsx解析に失敗 (${att.filename}): ${String(err)}`);
    return att;
  }
}

function isExcelMime(mimeType: string): boolean {
  return (
    mimeType.includes('spreadsheet') || mimeType.includes('excel') || mimeType === 'application/vnd.ms-excel'
  );
}

function xlsxToText(base64Data: string): string {
  const workbook = readXlsx(Buffer.from(base64Data, 'base64'), { type: 'buffer' });
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const csv = xlsxUtils.sheet_to_csv(sheet);
    return `【シート: ${name}】\n${csv}`;
  }).join('\n\n');
}

// 本文中のGoogleスプレッドシートリンクをSheets APIで読み取り、疑似的な添付として返す
async function parseSheetLinks(mail: SesRawMail): Promise<SesAttachment[]> {
  if (mail.sheetLinks.length === 0) return [];
  const auth = getGoogleAuth();
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
      console.warn(`SES展開: スプレッドシート読取に失敗 (${link}): ${String(err)}`);
    }
  }
  return results;
}

async function readSheetAsText(sheetsApi: sheets_v4.Sheets, spreadsheetId: string): Promise<string> {
  const resp = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range: 'A1:Z200' });
  const rows = resp.data.values ?? [];
  return rows.map((row) => row.join('\t')).join('\n');
}

function extractSpreadsheetId(url: string): string | null {
  const m = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}
