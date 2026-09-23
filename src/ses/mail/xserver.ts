// Xserver（IMAP/SMTP）プロバイダ。@自社を Xserver で運用している場合の既定。
// 共有メーリス(sales@)を IMAP で収集し、全員に返信の下書きを下書きフォルダに APPEND、
// サマリは SMTP で送信する。Google Workspace 不要。
// 設定不足時の扱い（CIでは異常終了・手元ではスキップ）は呼び出し側（collect.ts / notify.ts）が決める。
import { createHash } from 'crypto';
import { ImapFlow, type MessageStructureObject } from 'imapflow';
import { simpleParser, type ParsedMail, type AddressObject } from 'mailparser';
import nodemailer from 'nodemailer';
import { extractSheetLinks, isSupportedAttachment, attachmentKind } from '../../collectors/email.js';
import { buildReplyMime, DRAFT_KEY_HEADER } from './mime.js';
import { pickForRun } from '../schedule.js';
import { safeErr, SafeLogError } from '../redact.js';
import {
  xserverImapHost,
  xserverImapPort,
  xserverSmtpHost,
  xserverSmtpPort,
  xserverSharedUser,
  xserverSharedPass,
  xserverDraftsMailbox,
  collectDays,
} from '../config.js';
import type { SesRawMail, DraftRef, SesAttachment, SesMailMeta, SesAttachmentKind } from '../../types/index.js';
import type { CollectOptions, CollectOutcome } from './index.js';

function imapConfigured(): boolean {
  return Boolean(xserverImapHost() && xserverSharedUser() && xserverSharedPass());
}

function smtpConfigured(): boolean {
  return Boolean(xserverSmtpHost() && xserverSharedUser() && xserverSharedPass());
}

function imapClient(timeoutMs?: number): ImapFlow {
  return new ImapFlow({
    host: xserverImapHost(),
    port: xserverImapPort(),
    secure: true,
    auth: { user: xserverSharedUser(), pass: xserverSharedPass() },
    logger: false,
    ...(timeoutMs ? { connectionTimeout: timeoutMs, greetingTimeout: timeoutMs, socketTimeout: timeoutMs * 3 } : {}),
  });
}

function smtpTransport(timeoutMs?: number) {
  const implicitTls = xserverSmtpPort() === 465;
  return nodemailer.createTransport({
    host: xserverSmtpHost(),
    port: xserverSmtpPort(),
    secure: implicitTls,
    // 587等（STARTTLS）では暗号化を必須にする（STARTTLSを剥がされて共有メールボックスのパスワードを平文で送らないため）
    requireTLS: !implicitTls,
    tls: { minVersion: 'TLSv1.2' },
    auth: { user: xserverSharedUser(), pass: xserverSharedPass() },
    ...(timeoutMs ? { connectionTimeout: timeoutMs, greetingTimeout: timeoutMs, socketTimeout: timeoutMs } : {}),
  });
}

// imapflow は APPEND 等でフォルダ名に個人用名前空間の接頭辞（例: 'INBOX.'）を補うため、存在確認も同じ規則で比べる
function namespacedPath(client: ImapFlow, path: string): string {
  const prefix = (client as unknown as { namespace?: { prefix?: string } }).namespace?.prefix ?? '';
  if (path.toUpperCase() === 'INBOX') return 'INBOX';
  return prefix && !path.startsWith(prefix) ? `${prefix}${path}` : path;
}

// 診断（npm run doctor）用の疎通確認: IMAPへのログインと下書きフォルダの存在、SMTPの認証。
// 問題があれば理由（固定文言＋エラー種別）を返し、問題なければ null
export async function probeImap(timeoutMs = 10_000): Promise<string | null> {
  if (!imapConfigured()) return 'IMAP設定(XSERVER_IMAP_HOST/USER/PASS)が未完了です';
  const client = imapClient(timeoutMs);
  try {
    await client.connect();
    const boxes = await client.list();
    const drafts = xserverDraftsMailbox();
    const candidates = new Set([drafts, namespacedPath(client, drafts)]);
    if (!boxes.some((b) => candidates.has(b.path))) {
      const special = boxes.find((b) => b.specialUse === '\\Drafts')?.path;
      return `下書きフォルダ「${drafts}」が見つかりません${special ? `（このサーバーの下書きフォルダは「${special}」です。XSERVER_DRAFTS_MAILBOX に設定してください）` : ''}`;
    }
    return null;
  } catch (err) {
    return `IMAPに接続・ログインできません（${safeErr(err)}。ポート${xserverImapPort()}への外向き通信とパスワードを確認）`;
  } finally {
    try {
      await client.logout();
    } catch {
      /* noop */
    }
  }
}

export async function probeSmtp(timeoutMs = 10_000): Promise<string | null> {
  if (!smtpConfigured()) return 'SMTP設定(XSERVER_SMTP_HOST/USER/PASS)が未完了です';
  try {
    await smtpTransport(timeoutMs).verify();
    return null;
  } catch (err) {
    return `SMTPに接続・認証できません（${safeErr(err)}。ポート${xserverSmtpPort()}への外向き通信とパスワードを確認）`;
  }
}

export function collectReady(): boolean {
  return imapConfigured();
}

interface Candidate {
  uid: number;
  id: string;
  receivedAt: Date;
}

// imapflow の search は NO/BAD 応答や接続断を false で返すため、「0件」と取り違えないよう例外にする
function searchResult(uids: number[] | false | undefined, label: string): number[] {
  if (uids === false || uids === undefined) throw new SafeLogError(`${label}: 受信箱の検索に失敗しました（接続・サーバーの状態を確認してください）`);
  return uids;
}

function internalDateOf(msg: { internalDate?: Date | string; envelope?: { date?: Date } }): Date {
  const d = msg.internalDate ? new Date(msg.internalDate) : msg.envelope?.date;
  return d && !Number.isNaN(d.getTime()) ? d : new Date();
}

export async function collect(isProcessed: (mailId: string) => boolean, opts: CollectOptions): Promise<CollectOutcome> {
  if (!imapConfigured()) {
    throw new SafeLogError(
      'Xserver収集: IMAP設定(XSERVER_IMAP_HOST/USER/PASS)が未完了です（Google Workspace 運用の場合は MAIL_PROVIDER=gmail）',
    );
  }
  const client = imapClient();
  const mails: SesRawMail[] = [];
  let deferred: Date[] = [];
  // 接続・認証・検索の失敗は呼び出し側へ伝える（収集失敗としてバッチを異常終了扱いにするため）
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(Date.now() - collectDays() * 24 * 60 * 60 * 1000);
      const uids = searchResult(await client.search({ since }, { uid: true }), 'Xserver収集');
      if (uids.length > 0) {
        const uidValidity = String((client.mailbox as { uidValidity?: bigint }).uidValidity ?? '0');
        // 1) 本文を取らずに受信日時（INTERNALDATE）と Message-ID だけを読み、処理済みを除く
        const candidates: Candidate[] = [];
        const seen = new Set<string>();
        let skipped = 0;
        for await (const msg of client.fetch(uids, { envelope: true, internalDate: true }, { uid: true })) {
          const ids = mailIdsOf(uidValidity, msg.uid, msg.envelope?.messageId);
          if (ids.some(isProcessed) || seen.has(ids[0])) {
            skipped += 1;
            continue;
          }
          seen.add(ids[0]);
          candidates.push({ uid: msg.uid, id: ids[0], receivedAt: internalDateOf(msg) });
        }
        if (skipped > 0) console.log(`Xserver収集: ${skipped}件は処理済みのため取得をスキップ`);
        // 2) 上限まで選んだメールだけ本文・添付を取得する（残りは次回以降。毎回全件をダウンロードしない）
        const pick = pickForRun(candidates, opts.limit, collectDays(), opts.now);
        deferred = pick.deferred.map((c) => c.receivedAt);
        const byUid = new Map(pick.picked.map((c) => [c.uid, c]));
        if (byUid.size > 0) {
          for await (const msg of client.fetch([...byUid.keys()], { source: true }, { uid: true })) {
            const meta = byUid.get(msg.uid);
            if (!meta) continue;
            try {
              const parsed = await simpleParser(msg.source as Buffer);
              mails.push(toSesRawMail(parsed, meta.id, meta.receivedAt));
            } catch (err) {
              console.error(`Xserver収集: メール解析に失敗 (uid ${msg.uid}): ${safeErr(err)}`);
            }
          }
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    try {
      await client.logout();
    } catch {
      /* noop */
    }
  }
  console.log(`Xserver収集: ${mails.length}件を収集${deferred.length > 0 ? `（上限超過で次回以降に回した未処理 ${deferred.length}件）` : ''}`);
  return { mails, deferred };
}

// メール量の測定（npm run ses:mail-stats）用。受信箱を EXAMINE（読み取り専用）で開き、
// ENVELOPE・BODYSTRUCTURE・INTERNALDATE・サイズだけを取得する（本文・添付は取得せず、既読などのフラグも変えない）
export async function scanMeta(since: Date): Promise<SesMailMeta[]> {
  if (!imapConfigured()) {
    throw new SafeLogError('Xserver測定: IMAP設定(XSERVER_IMAP_HOST/USER/PASS)が未完了です');
  }
  const client = imapClient();
  const metas: SesMailMeta[] = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      const uids = searchResult(await client.search({ since }, { uid: true }), 'Xserver測定');
      if (uids.length > 0) {
        const query = { envelope: true, bodyStructure: true, internalDate: true, size: true };
        for await (const msg of client.fetch(uids, query, { uid: true })) {
          const internal = msg.internalDate ? new Date(msg.internalDate) : msg.envelope?.date;
          metas.push({
            receivedAt: internal && !Number.isNaN(internal.getTime()) ? internal : new Date(0),
            subject: msg.envelope?.subject ?? '',
            fromAddress: (msg.envelope?.from?.[0]?.address ?? '').toLowerCase(),
            sizeBytes: msg.size ?? 0,
            attachmentKinds: msg.bodyStructure ? attachmentKindsOf(msg.bodyStructure) : [],
          });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    try {
      await client.logout();
    } catch {
      /* noop */
    }
  }
  return metas;
}

// 添付として数える部分: Content-Disposition が attachment、またはファイル名付きで inline でないもの
// （本文中の署名画像など inline の部分は数えない）
function attachmentKindsOf(node: MessageStructureObject, out: SesAttachmentKind[] = []): SesAttachmentKind[] {
  if (node.childNodes?.length) {
    for (const child of node.childNodes) attachmentKindsOf(child, out);
    return out;
  }
  const filename = node.dispositionParameters?.filename ?? node.parameters?.name ?? '';
  const disposition = (node.disposition ?? '').toLowerCase();
  if (disposition === 'attachment' || (filename && disposition !== 'inline')) {
    out.push(attachmentKind(filename, node.type ?? ''));
  }
  return out;
}

// 処理済みの記録に使うメールID。Message-ID があればそれから作る（メールボックスの再構築で UIDVALIDITY・UID が
// 振り直されても、同じメールを新着として抽出し直さないため）。無いメールと、以前の形式で記録済みのメールは UID で判定する
function mailIdsOf(uidValidity: string, uid: number, messageId: string | undefined): string[] {
  const legacy = `sesmail_x${uidValidity}_${uid}`;
  const mid = (messageId ?? '').trim().replace(/^<|>$/g, '').toLowerCase();
  if (!mid) return [legacy];
  return [`sesmail_m${createHash('sha256').update(mid).digest('hex').slice(0, 24)}`, legacy];
}

function addrText(a: AddressObject | AddressObject[] | undefined): string {
  if (!a) return '';
  if (Array.isArray(a)) return a.map((x) => x.text).filter(Boolean).join(', ');
  return a.text ?? '';
}

function refsText(r: string | string[] | undefined): string {
  if (!r) return '';
  return Array.isArray(r) ? r.join(' ') : r;
}

function toSesRawMail(p: ParsedMail, id: string, receivedAt: Date): SesRawMail {
  // Gmail経路と同じ許可リスト（xlsx/xls/pdf/spreadsheet）で絞り、署名画像やzip等をメモリに抱えない
  const attachments: SesAttachment[] = (p.attachments ?? [])
    .filter((a) => isSupportedAttachment(a.filename ?? '', a.contentType ?? ''))
    .map((a) => ({
      filename: a.filename ?? 'attachment',
      mimeType: a.contentType ?? '',
      data: a.content ? a.content.toString('base64') : '',
    }));
  const body = p.text ?? '';
  return {
    id,
    from: addrText(p.from),
    to: addrText(p.to),
    cc: addrText(p.cc),
    replyTo: addrText(p.replyTo),
    subject: p.subject ?? '',
    body,
    messageIdHeader: p.messageId ?? '',
    references: refsText(p.references),
    // 送信側の Date ヘッダではなくサーバーの受信日時（古い Date のメールを最初から「窓の端」と誤判定しないため）
    receivedAt,
    attachments,
    sheetLinks: extractSheetLinks(body),
  };
}

export function draftReady(): boolean {
  return imapConfigured();
}

// 全員に返信の下書きを、共有メールボックスの下書きフォルダに APPEND する（From=担当営業本人）。
// 担当営業は共有の下書きを開いて内容を確認のうえ送信する（送信は手動＝下書き止まりを維持）。
// 失敗は例外で返す（呼び出し側が「作成済」と誤記録しないため）
export async function createReplyDraft(ref: DraftRef, fromEmail: string): Promise<DraftRef> {
  const finalized: DraftRef = { ...ref, from: fromEmail };
  if (!imapConfigured()) {
    throw new SafeLogError('Xserver下書き: IMAP設定(XSERVER_IMAP_HOST/USER/PASS)が未完了のため下書きを作成できません');
  }
  const raw = await buildReplyMime(finalized);
  const client = imapClient();
  try {
    await client.connect();
    const res = await client.append(xserverDraftsMailbox(), raw, ['\\Draft']);
    if (!res) throw new SafeLogError(`Xserver下書き: 下書きフォルダ「${xserverDraftsMailbox()}」へ保存できませんでした`);
  } finally {
    try {
      await client.logout();
    } catch {
      /* noop */
    }
  }
  return { ...finalized, url: `imap://${xserverSharedUser()}/${xserverDraftsMailbox()}` };
}

// 下書きフォルダに同じ識別子（X-SES-Draft-Key）の下書きがあるか（APPENDの応答だけ失敗した場合の二重作成を防ぐ）
export async function draftExists(draftKey: string): Promise<boolean | null> {
  if (!imapConfigured() || !draftKey) return null;
  const client = imapClient();
  try {
    await client.connect();
    const lock = await client.getMailboxLock(xserverDraftsMailbox(), { readOnly: true });
    try {
      const uids = searchResult(await client.search({ header: { [DRAFT_KEY_HEADER]: draftKey } }, { uid: true }), 'Xserver下書き');
      return uids.length > 0;
    } finally {
      lock.release();
    }
  } finally {
    try {
      await client.logout();
    } catch {
      /* noop */
    }
  }
}

export function sendReady(): boolean {
  return smtpConfigured();
}

export async function sendPlainMail(to: string, subject: string, body: string): Promise<void> {
  if (!smtpConfigured()) {
    throw new SafeLogError('Xserver送信: SMTP設定(XSERVER_SMTP_HOST/USER/PASS)が未完了です');
  }
  await smtpTransport().sendMail({ from: xserverSharedUser(), to, subject, text: body });
}
