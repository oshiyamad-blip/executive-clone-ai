import { google, gmail_v1 } from 'googleapis';
import { getGoogleAuth } from './googleAuth.js';
import type { RawLog, SesRawMail, SesAttachment } from '../types/index.js';

// Gmail 収集 — 対象経営者の送受信メールを取得する（gmail.readonly）
export async function collectFromEmail(): Promise<RawLog[]> {
  const auth = getGoogleAuth();
  if (!auth) {
    console.warn('メール: Google サービスアカウント設定が未完了');
    return [];
  }

  const gmail = google.gmail({ version: 'v1', auth });
  const logs: RawLog[] = [];

  try {
    // 過去24時間の送受信メール（下書き・スパム・ゴミ箱は除外）
    // nextPageToken を辿り、100通を超える分も取りこぼさない。
    let pageToken: string | undefined;
    do {
      const list = await gmail.users.messages.list({
        userId: 'me',
        q: 'newer_than:1d -in:drafts -in:spam -in:trash',
        maxResults: 100,
        pageToken,
      });

      for (const ref of list.data.messages ?? []) {
        if (!ref.id) continue;
        const msg = await gmail.users.messages.get({ userId: 'me', id: ref.id, format: 'full' });
        const headers = msg.data.payload?.headers ?? [];
        const header = (name: string) =>
          headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';

        const subject = header('Subject');
        const from = header('From');
        const to = header('To');
        const body = extractBody(msg.data.payload);
        const dateMs = Number(msg.data.internalDate ?? Date.now());

        logs.push({
          id: `email_${ref.id}`,
          source: 'email',
          timestamp: new Date(dateMs),
          content: `件名: ${subject}\nFrom: ${from}\nTo: ${to}\n\n${body}`,
          participants: [from, to].filter(Boolean),
          metadata: { subject, threadId: msg.data.threadId ?? '' },
        });
      }

      pageToken = list.data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (err) {
    console.error(`メール: 収集中にエラー: ${String(err)}`);
  }

  console.log(`メール: ${logs.length}件を収集`);
  return logs;
}

// MIMEツリーから text/plain 本文を再帰的に抽出する（base64url デコード）
function extractBody(payload: unknown): string {
  const p = payload as {
    mimeType?: string;
    body?: { data?: string };
    parts?: unknown[];
  } | undefined;
  if (!p) return '';

  if (p.mimeType === 'text/plain' && p.body?.data) {
    return decodeBase64Url(p.body.data);
  }
  for (const part of p.parts ?? []) {
    const text = extractBody(part);
    if (text) return text;
  }
  // text/plain が無ければ最初の body を返す
  if (p.body?.data) return decodeBase64Url(p.body.data);
  return '';
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

// ===== SESマッチング機能向けの拡張 =====
// 既存 collectFromEmail() は無変更（引数なし・従来動作）。SES専用に任意クエリ+添付ダウンロード
// 込みで取得する別関数を追加する（要件: 既存呼び出し側への影響ゼロ）。

// SES専用: 指定クエリでメールを取得し、添付(Excel/PDF)をダウンロードして返す。
export async function collectSesRawMail(query: string): Promise<SesRawMail[]> {
  const auth = getGoogleAuth();
  if (!auth) {
    console.warn('SESメール収集: Google サービスアカウント設定が未完了');
    return [];
  }

  const gmail = google.gmail({ version: 'v1', auth });
  const mails: SesRawMail[] = [];

  try {
    let pageToken: string | undefined;
    do {
      const list = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 100,
        pageToken,
      });

      for (const ref of list.data.messages ?? []) {
        if (!ref.id) continue;
        try {
          const msg = await gmail.users.messages.get({ userId: 'me', id: ref.id, format: 'full' });
          mails.push(await buildSesRawMail(gmail, msg.data));
        } catch (err) {
          console.error(`SESメール収集: メッセージ取得に失敗 (${ref.id}): ${String(err)}`);
        }
      }

      pageToken = list.data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (err) {
    console.error(`SESメール収集: 収集中にエラー: ${String(err)}`);
  }

  console.log(`SESメール収集: ${mails.length}件を収集`);
  return mails;
}

async function buildSesRawMail(gmail: gmail_v1.Gmail, msg: gmail_v1.Schema$Message): Promise<SesRawMail> {
  const headers = msg.payload?.headers ?? [];
  const header = (name: string) =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';

  const subject = header('Subject');
  const from = header('From');
  const to = header('To');
  const body = extractBody(msg.payload);
  const dateMs = Number(msg.internalDate ?? Date.now());
  const attachments = await collectAttachments(gmail, msg.id ?? '', msg.payload);

  return {
    id: `sesmail_${msg.id}`,
    from,
    to,
    subject,
    body,
    receivedAt: new Date(dateMs),
    attachments,
    sheetLinks: extractSheetLinks(body),
  };
}

// 添付ファイル（Excel/PDF）をダウンロードしbase64（標準）のまま保持する。テキスト化は parse 段で行う
async function collectAttachments(
  gmail: gmail_v1.Gmail,
  messageId: string,
  payload: gmail_v1.Schema$MessagePart | undefined,
): Promise<SesAttachment[]> {
  const results: SesAttachment[] = [];
  for (const part of flattenParts(payload)) {
    const filename = part.filename;
    const attachmentId = part.body?.attachmentId;
    if (!filename || !attachmentId) continue;
    if (!isSupportedAttachment(filename, part.mimeType ?? '')) continue;
    try {
      const att = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId });
      const data = base64UrlToStandard(att.data.data ?? '');
      results.push({ filename, mimeType: part.mimeType ?? 'application/octet-stream', data });
    } catch (err) {
      console.error(`SESメール収集: 添付ダウンロードに失敗 (${filename}): ${String(err)}`);
    }
  }
  return results;
}

function flattenParts(payload: gmail_v1.Schema$MessagePart | undefined): gmail_v1.Schema$MessagePart[] {
  if (!payload) return [];
  const parts: gmail_v1.Schema$MessagePart[] = [];
  const walk = (p: gmail_v1.Schema$MessagePart): void => {
    parts.push(p);
    for (const child of p.parts ?? []) walk(child);
  };
  walk(payload);
  return parts;
}

function isSupportedAttachment(filename: string, mimeType: string): boolean {
  return (
    /\.(xlsx|xls|pdf)$/i.test(filename) ||
    mimeType === 'application/pdf' ||
    mimeType.includes('spreadsheet') ||
    mimeType === 'application/vnd.ms-excel'
  );
}

// Gmail添付APIはbase64url形式で返すため、標準base64（xlsx解析・Claude documentブロック用）に変換する
function base64UrlToStandard(data: string): string {
  let b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';
  return b64;
}

// 本文中の Google スプレッドシートリンクを検出する
function extractSheetLinks(body: string): string[] {
  const matches = body.match(/https:\/\/docs\.google\.com\/spreadsheets\/d\/[a-zA-Z0-9_-]+[^\s]*/g);
  return matches ? [...new Set(matches)] : [];
}
