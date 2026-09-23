import { google, gmail_v1 } from 'googleapis';
import { getGoogleAuth, type GoogleJwt } from './googleAuth.js';
import { redactable, safeErr } from '../ses/redact.js';
import type { RawLog, SesRawMail, SesAttachment, SesAttachmentKind } from '../types/index.js';

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

// MIMEツリーから text/plain 本文を再帰的に抽出する（base64url デコード）。
// Gmail API は転送エンコーディングだけを外し、本文はそのパートの charset のまま返すため、Content-Type の charset で
// 文字に戻す（日本語メールに多い ISO-2022-JP・Shift_JIS を UTF-8 として読むと文字化けする）
function extractBody(payload: unknown): string {
  const p = payload as {
    mimeType?: string;
    headers?: Array<{ name?: string | null; value?: string | null }>;
    body?: { data?: string };
    parts?: unknown[];
  } | undefined;
  if (!p) return '';

  if (p.mimeType === 'text/plain' && p.body?.data) {
    return decodeBase64Url(p.body.data, charsetOf(p.headers));
  }
  for (const part of p.parts ?? []) {
    const text = extractBody(part);
    if (text) return text;
  }
  // text/plain が無ければ最初の body を返す
  if (p.body?.data) return decodeBase64Url(p.body.data, charsetOf(p.headers));
  return '';
}

function charsetOf(headers: Array<{ name?: string | null; value?: string | null }> | undefined): string {
  const contentType = (headers ?? []).find((h) => h.name?.toLowerCase() === 'content-type')?.value ?? '';
  return contentType.match(/charset\s*=\s*"?([^";\s]+)"?/i)?.[1] ?? 'utf-8';
}

function decodeBase64Url(data: string, charset = 'utf-8'): string {
  const bytes = Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes);
  } catch {
    return bytes.toString('utf-8'); // 知らない charset 名は UTF-8 として読む
  }
}

// ===== SESマッチング機能向けの拡張 =====
// 既存 collectFromEmail() は無変更（引数なし・従来動作）。SES専用に任意クエリ+添付ダウンロード
// 込みで取得する別関数を追加する（要件: 既存呼び出し側への影響ゼロ）。

// SES専用: 指定クエリでメールを取得し、添付(Excel/PDF)をダウンロードして返す。
// 認証は呼び出し側が用意する（SES専用メールボックスとしてのDWD）。一覧取得の失敗は例外で返す
// （「メールが0件」と区別し、収集失敗としてバッチを異常終了扱いにするため）。
// isProcessed で処理済みのメッセージは本文・添付をダウンロードしない（毎回全件を取り直さない）
export async function collectSesRawMail(
  auth: GoogleJwt,
  query: string,
  isProcessed: (mailId: string) => boolean = () => false,
  opts: { limit?: number; pick?: <T extends { receivedAt: Date }>(items: T[], limit: number) => { picked: T[]; deferred: T[] } } = {},
): Promise<{ mails: SesRawMail[]; deferred: Date[] }> {
  const gmail = google.gmail({ version: 'v1', auth });
  const mails: SesRawMail[] = [];
  let skipped = 0;
  let failed = 0;

  // 一覧（IDだけ・新しい順）を先に全部読み、処理済みを除く（本文は上限まで選んだものだけ取得する）
  const unprocessed: string[] = [];
  let pageToken: string | undefined;
  do {
    const list = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 500, pageToken });
    for (const ref of list.data.messages ?? []) {
      if (!ref.id) continue;
      if (isProcessed(sesMailId(ref.id))) skipped += 1;
      else unprocessed.push(ref.id);
    }
    pageToken = list.data.nextPageToken ?? undefined;
  } while (pageToken);

  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  let targets = unprocessed;
  let deferred: Date[] = [];
  if (unprocessed.length > limit && opts.pick) {
    // 上限を超える分は受信日時だけを読んで、次回の実行で窓を外れるものを優先して選ぶ
    const dated: Array<{ id: string; receivedAt: Date }> = [];
    for (let i = 0; i < unprocessed.length; i += 10) {
      const chunk = unprocessed.slice(i, i + 10);
      const settled = await Promise.allSettled(
        chunk.map((id) => gmail.users.messages.get({ userId: 'me', id, format: 'minimal', fields: 'id,internalDate' })),
      );
      settled.forEach((r, j) => {
        const ms = r.status === 'fulfilled' ? Number(r.value.data.internalDate ?? NaN) : NaN;
        dated.push({ id: chunk[j], receivedAt: new Date(Number.isFinite(ms) ? ms : Date.now()) });
      });
    }
    const pick = opts.pick(dated, limit);
    targets = pick.picked.map((d) => d.id);
    deferred = pick.deferred.map((d) => d.receivedAt);
  } else if (unprocessed.length > limit) {
    deferred = unprocessed.slice(limit).map(() => new Date());
    targets = unprocessed.slice(0, limit);
  }

  for (const id of targets) {
    try {
      const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      mails.push(await buildSesRawMail(gmail, msg.data));
    } catch (err) {
      failed += 1;
      console.error(`SESメール収集: メッセージ取得に失敗 (${id}): ${safeErr(err)}`);
    }
  }

  if (skipped > 0) console.log(`SESメール収集: ${skipped}件は処理済みのため取得をスキップ`);
  if (failed > 0) console.warn(`SESメール収集: ${failed}件は取得に失敗しました（次回の実行で再取得します）`);
  console.log(`SESメール収集: ${mails.length}件を収集${deferred.length > 0 ? `（上限超過で次回以降に回した未処理 ${deferred.length}件）` : ''}`);
  return { mails, deferred };
}

function sesMailId(gmailMessageId: string): string {
  return `sesmail_${gmailMessageId}`;
}

async function buildSesRawMail(gmail: gmail_v1.Gmail, msg: gmail_v1.Schema$Message): Promise<SesRawMail> {
  const headers = msg.payload?.headers ?? [];
  const header = (name: string) =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';

  const subject = header('Subject');
  const from = header('From');
  const to = header('To');
  const cc = header('Cc');
  const body = extractBody(msg.payload);
  const dateMs = Number(msg.internalDate ?? Date.now());
  const attachments = await collectAttachments(gmail, msg.id ?? '', msg.payload);

  return {
    id: sesMailId(msg.id ?? ''),
    from,
    to,
    cc,
    replyTo: header('Reply-To'),
    subject,
    body,
    // 全員に返信のスレッド継続用。Message-ID が取れないメールは擬似スレッド化のみ（実害小）
    messageIdHeader: header('Message-ID') || header('Message-Id'),
    references: header('References'),
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
      console.error(`SESメール収集: 添付ダウンロードに失敗 (${redactable(filename)}): ${safeErr(err)}`);
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

// Xserver(IMAP)プロバイダも同じ許可リストで添付を絞るため共有する
export function isSupportedAttachment(filename: string, mimeType: string): boolean {
  return (
    /\.(xlsx|xls|pdf)$/i.test(filename) ||
    mimeType === 'application/pdf' ||
    mimeType.includes('spreadsheet') ||
    mimeType === 'application/vnd.ms-excel'
  );
}

// メール量の測定用の添付の種類。拡張子で判定し、拡張子で決まらない（octet-stream 等）ときはMIMEタイプで補う
const KIND_BY_EXT: Record<string, SesAttachmentKind> = { pdf: 'pdf', xlsx: 'xlsx', xlsm: 'xlsx', xls: 'xls', docx: 'docx' };

export function attachmentKind(filename: string, mimeType: string): SesAttachmentKind {
  const ext = (filename.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? '').toLowerCase();
  if (KIND_BY_EXT[ext]) return KIND_BY_EXT[ext];
  const mime = mimeType.toLowerCase();
  if (mime === 'application/pdf') return 'pdf';
  if (mime.includes('spreadsheetml')) return 'xlsx';
  if (mime === 'application/vnd.ms-excel') return 'xls';
  if (mime.includes('wordprocessingml')) return 'docx';
  return 'other';
}

// Gmail添付APIはbase64url形式で返すため、標準base64（xlsx解析・Claude documentブロック用）に変換する
function base64UrlToStandard(data: string): string {
  let b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';
  return b64;
}

// 本文中の Google スプレッドシートリンクを検出する
export function extractSheetLinks(body: string): string[] {
  const matches = body.match(/https:\/\/docs\.google\.com\/spreadsheets\/d\/[a-zA-Z0-9_-]+[^\s]*/g);
  return matches ? [...new Set(matches)] : [];
}
