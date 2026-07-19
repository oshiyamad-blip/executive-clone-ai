import { google } from 'googleapis';
import { getBillingGoogleAuth } from '../collectors/googleAuth.js';
import type { Member } from '../types/engagements.js';

// 受領書類（委託先の請求書・正社員の勤表）検出用の Gmail 収集。
// 既存 collectors/email.ts と同様のページング・MIME再帰パターンを踏襲する。

export interface ReceivedMail {
  messageId: string;
  from: string;
  subject: string;
  receivedAt: Date;
  member?: Member;
  pdfs: Array<{ filename: string; data: Buffer }>;
}

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20MB

interface GmailHeader {
  name?: string | null;
  value?: string | null;
}

interface GmailPart {
  mimeType?: string | null;
  filename?: string | null;
  body?: { attachmentId?: string | null; size?: number | null } | null;
  parts?: GmailPart[] | null;
}

// 要員のメールアドレスから検索クエリを組み立てる（BILLING_GMAIL_QUERY で上書き可）
function buildQuery(members: Member[]): string {
  const custom = process.env.BILLING_GMAIL_QUERY;
  if (custom) return custom;

  const emails = members.map((m) => m.email).filter((e): e is string => Boolean(e && e.trim() !== ''));
  if (emails.length === 0) {
    return '(請求書 OR invoice OR 勤務表 OR 勤表) has:attachment filename:pdf newer_than:40d -in:spam -in:trash';
  }
  return `from:(${emails.join(' OR ')}) has:attachment filename:pdf newer_than:40d -in:spam -in:trash`;
}

// MIMEツリーからPDF添付（application/pdf または .pdf ファイル名）を再帰的に集める
function findPdfParts(payload: GmailPart | undefined | null): GmailPart[] {
  if (!payload) return [];
  const result: GmailPart[] = [];
  const isPdf =
    payload.mimeType === 'application/pdf' || (payload.filename?.toLowerCase().endsWith('.pdf') ?? false);
  if (isPdf && payload.body?.attachmentId) {
    result.push(payload);
  }
  for (const part of payload.parts ?? []) {
    result.push(...findPdfParts(part));
  }
  return result;
}

// From ヘッダから `<...>` 内のメールアドレス、無ければヘッダ全体を小文字化して返す
function extractEmailAddress(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from).trim().toLowerCase();
}

function decodeBase64Url(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export async function fetchDocumentEmails(members: Member[]): Promise<ReceivedMail[]> {
  // 共有メールボックス（billing@ 等）が設定されていればそちらを受信箱にする
  const auth = getBillingGoogleAuth();
  if (!auth) {
    console.warn('検収: Google サービスアカウント設定が未完了のため、メール取得をスキップします');
    return [];
  }

  const gmail = google.gmail({ version: 'v1', auth });
  const query = buildQuery(members);
  const memberByEmail = new Map(
    members.filter((m) => m.email).map((m) => [m.email.toLowerCase(), m] as const),
  );

  const results: ReceivedMail[] = [];

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
          const headers = (msg.data.payload?.headers ?? []) as GmailHeader[];
          const header = (name: string) =>
            headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';

          const from = header('From');
          const subject = header('Subject');
          const dateMs = Number(msg.data.internalDate ?? Date.now());

          const pdfParts = findPdfParts(msg.data.payload as GmailPart | undefined);
          const pdfs: Array<{ filename: string; data: Buffer }> = [];

          for (const part of pdfParts) {
            const attachmentId = part.body?.attachmentId;
            if (!attachmentId) continue;
            const declaredSize = part.body?.size ?? 0;
            if (declaredSize > MAX_ATTACHMENT_BYTES) {
              console.warn(`検収: 添付「${part.filename ?? '(無題)'}」が20MBを超えるためスキップします`);
              continue;
            }

            const attachment = await gmail.users.messages.attachments.get({
              userId: 'me',
              messageId: ref.id,
              id: attachmentId,
            });
            const data = attachment.data.data;
            if (!data) continue;

            const buffer = decodeBase64Url(data);
            if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
              console.warn(`検収: 添付「${part.filename ?? '(無題)'}」が20MBを超えるためスキップします`);
              continue;
            }
            pdfs.push({ filename: part.filename || 'document.pdf', data: buffer });
          }

          if (pdfs.length === 0) continue;

          const member = memberByEmail.get(extractEmailAddress(from));
          results.push({ messageId: ref.id, from, subject, receivedAt: new Date(dateMs), member, pdfs });
        } catch (err) {
          console.warn(`検収: メール(${ref.id})の取得中にエラー: ${String(err)}`);
        }
      }

      pageToken = list.data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (err) {
    console.error(`検収: メール検索中にエラー: ${String(err)}`);
  }

  console.log(`検収: PDF添付付きメール ${results.length}件を検出`);
  return results;
}
