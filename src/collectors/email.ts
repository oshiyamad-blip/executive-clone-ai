import { google, gmail_v1 } from 'googleapis';
import { getGoogleAuth, type GoogleJwt } from './googleAuth.js';
import { redactable, safeErr } from '../ses/redact.js';
import { attachmentsWithinLimits, capMailBody, MAIL_MAX_BYTES } from '../ses/mail/attachmentLimits.js';
import { htmlToPlainText } from '../ses/mail/htmlText.js';
import { checkAuthResults, authResultsWarning } from '../ses/mail/authResults.js';
import { normalizeAddressHeader } from '../ses/mail/ownMail.js';
import { recordHealEvent } from '../ses/heal/events.js';
import { maxMailMbPerRun } from '../ses/config.js';
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
  let trustedAuthResults = 0;

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

  // 本文を取る前に大きさ（sizeEstimate）を確かめ、1通の上限を超えるメールは取り込まない。1回の合計の大きさにも上限を設け、
  // 超えた分は次回に回す（Xserver経路と同じ。大きなメールを大量に送られて収集中にメモリ・時間を使い切らないように）
  let oversize = 0;
  let overBudget = 0;
  let budgetLeft = maxMailMbPerRun() * 1024 * 1024;
  for (const id of targets) {
    try {
      const meta = await gmail.users.messages.get({ userId: 'me', id, format: 'minimal', fields: 'id,sizeEstimate,internalDate' });
      const size = Number(meta.data.sizeEstimate ?? 0);
      if (size > MAIL_MAX_BYTES) {
        oversize += 1;
        continue;
      }
      if (mails.length > 0 && size > budgetLeft) {
        overBudget += 1;
        const ms = Number(meta.data.internalDate ?? NaN);
        deferred.push(new Date(Number.isFinite(ms) ? ms : Date.now()));
        continue;
      }
      budgetLeft -= size;
      const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      const built = await buildSesRawMail(gmail, msg.data);
      if (built.trustedAuthResults) trustedAuthResults++;
      mails.push(built.mail);
    } catch (err) {
      failed += 1;
      console.error(`SESメール収集: メッセージ取得に失敗 (${id}): ${safeErr(err)}`);
    }
  }

  if (oversize > 0) {
    recordHealEvent('warn', `SESメール収集: 大きすぎる（${Math.round(MAIL_MAX_BYTES / 1024 / 1024)}MB超の）メール${oversize}件は取り込みません（受信箱で直接確認してください）`);
  }
  if (overBudget > 0) {
    recordHealEvent('warn', `SESメール収集: 1回の取得量の上限（SES_MAX_MAIL_MB_PER_RUN=${maxMailMbPerRun()}MB）を超えるため、${overBudget}件を次回以降に回します`);
  }
  // Gmail が一番上に自分の結果を付けているかを毎回確かめる（付いていない経路のメールの送り主は認証されていない扱い）
  const authWarning = authResultsWarning('SESメール収集', `authserv-id（${GMAIL_AUTHSERV_IDS.join(',')}）`, {
    mails: mails.length,
    trusted: trustedAuthResults,
    receivedByUsWithoutResult: 0,
  });
  if (authWarning) recordHealEvent('warn', authWarning);
  if (skipped > 0) console.log(`SESメール収集: ${skipped}件は処理済みのため取得をスキップ`);
  if (failed > 0) console.warn(`SESメール収集: ${failed}件は取得に失敗しました（次回の実行で再取得します）`);
  console.log(`SESメール収集: ${mails.length}件を収集${deferred.length > 0 ? `（上限超過で次回以降に回した未処理 ${deferred.length}件）` : ''}`);
  return { mails, deferred };
}

function sesMailId(gmailMessageId: string): string {
  return `sesmail_${gmailMessageId}`;
}

// Gmail が受信時に一番上に付ける Authentication-Results の authserv-id（Xserver の XSERVER_AUTHSERV_ID とは別に持つ）
export const GMAIL_AUTHSERV_IDS: readonly string[] = ['mx.google.com'];

async function buildSesRawMail(
  gmail: gmail_v1.Gmail,
  msg: gmail_v1.Schema$Message,
): Promise<{ mail: SesRawMail; trustedAuthResults: boolean }> {
  const headers = msg.payload?.headers ?? [];
  const header = (name: string) =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';

  const subject = capSubject(header('Subject'));
  // 宛先は解釈し直した表記にする（表示名を1回だけデコードし、引用符をエスケープ。Xserver 経路と同じ形で宛先の判定に渡す）
  const from = normalizeAddressHeader(header('From'));
  const to = normalizeAddressHeader(header('To'));
  const cc = normalizeAddressHeader(header('Cc'));
  const body = capMailBody(extractSesBody(msg.payload));
  const dateMs = Number(msg.internalDate ?? Date.now());
  const attachments = await collectAttachments(gmail, msg.id ?? '', msg.payload);
  // 受信サーバー（Gmail）が付けた一番上の Authentication-Results だけを読む（下にあるものは送り主が書ける）
  // authserv-id が mx.google.com のものだけを信じる（Gmail は受信時に必ず自分の結果を一番上に付ける）
  // Gmail の一番上の Received は内部の名前（IPv6 等）のため、Received の並びは確かめない（Gmail は偽の結果を取り除く）
  const auth = checkAuthResults(
    headers.map((h) => ({ key: h.name ?? '', value: h.value ?? '' })),
    GMAIL_AUTHSERV_IDS,
    { requireReceivedBy: false },
  );
  const authDomain = auth.authDomain;

  const mail: SesRawMail = {
    id: sesMailId(msg.id ?? ''),
    from,
    to,
    cc,
    replyTo: normalizeAddressHeader(header('Reply-To')),
    subject,
    body,
    // 全員に返信のスレッド継続用。Message-ID が取れないメールは擬似スレッド化のみ（実害小）
    messageIdHeader: header('Message-ID') || header('Message-Id'),
    references: header('References'),
    receivedAt: new Date(dateMs),
    attachments,
    sheetLinks: extractSheetLinks(body),
    ...(authDomain ? { authDomain } : {}),
  };
  return { mail, trustedAuthResults: auth.trusted };
}

type BodyPart = {
  mimeType?: string | null;
  filename?: string | null;
  headers?: Array<{ name?: string | null; value?: string | null }> | null;
  body?: { data?: string | null } | null;
  parts?: BodyPart[] | null;
};

// 指定の種類の本文パート（添付ではないもの）を深さ優先で探す
function findBodyPart(p: BodyPart | undefined, mimeType: string, depth = 0): BodyPart | null {
  if (!p || depth > 20) return null;
  if (p.mimeType === mimeType && p.body?.data && !p.filename) return p;
  for (const part of p.parts ?? []) {
    const found = findBodyPart(part, mimeType, depth + 1);
    if (found) return found;
  }
  return null;
}

// SES用の本文: text/plain があればそれ、無ければ text/html をテキストにする（生のHTML（コメント・非表示の要素・
// 文字参照）のまま指示の検知と抽出のAIに渡さない。Xserver経路と同じテキストにする）
function extractSesBody(payload: unknown): string {
  const root = payload as BodyPart | undefined;
  const plain = findBodyPart(root, 'text/plain');
  if (plain?.body?.data) return decodeBase64Url(plain.body.data, charsetOf(plain.headers ?? undefined));
  const html = findBodyPart(root, 'text/html');
  if (html?.body?.data) return htmlToPlainText(decodeBase64Url(html.body.data, charsetOf(html.headers ?? undefined)));
  return '';
}

// 添付ファイル（Excel/PDF）をダウンロードしbase64（標準）のまま保持する。テキスト化は parse 段で行う
async function collectAttachments(
  gmail: gmail_v1.Gmail,
  messageId: string,
  payload: gmail_v1.Schema$MessagePart | undefined,
): Promise<SesAttachment[]> {
  const results: SesAttachment[] = [];
  const supported = flattenParts(payload)
    .filter((part) => part.filename && part.body?.attachmentId && isSupportedAttachment(part.filename, part.mimeType ?? ''))
    .map((part) => ({ filename: part.filename ?? '', mimeType: part.mimeType ?? '', bytes: part.body?.size ?? 0, part }));
  // 抽出・解析で使えない大きさの添付はダウンロードしない（attachmentLimits.ts）
  const { kept, dropped } = attachmentsWithinLimits(supported);
  if (dropped > 0) console.warn(`SESメール収集: 大きすぎる添付${dropped}件は読み込みません`);
  for (const { part } of kept) {
    const filename = part.filename ?? '';
    const attachmentId = part.body?.attachmentId ?? '';
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

// 件名の上限（文字）。件名は抽出のプロンプト・失敗時の伏せ字処理に丸ごと入るため、収集の時点で切り詰める
// （極端に長い件名で API 費用と伏せ字処理の時間を膨らませないため）
export const MAX_SUBJECT_CHARS = 500;

export function capSubject(subject: string): string {
  return subject.length > MAX_SUBJECT_CHARS ? subject.slice(0, MAX_SUBJECT_CHARS) : subject;
}

// 本文中の Google スプレッドシートリンクを検出する
export function extractSheetLinks(body: string): string[] {
  const matches = body.match(/https:\/\/docs\.google\.com\/spreadsheets\/d\/[a-zA-Z0-9_-]+[^\s]*/g);
  return matches ? [...new Set(matches)] : [];
}
