// Xserver（IMAP/SMTP）プロバイダ。@自社を Xserver で運用している場合の既定。
// 共有メーリス(sales@)を IMAP で収集し、全員に返信の下書きを下書きフォルダに APPEND、
// サマリは SMTP で送信する。Google Workspace 不要。
// 設定不足時の扱い（CIでは異常終了・手元ではスキップ）は呼び出し側（collect.ts / notify.ts）が決める。
import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail, type AddressObject } from 'mailparser';
import nodemailer from 'nodemailer';
import { extractSheetLinks, isSupportedAttachment } from '../../collectors/email.js';
import { buildReplyMime } from './mime.js';
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
import type { SesRawMail, DraftRef, SesAttachment } from '../../types/index.js';

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

// 診断（npm run doctor）用の疎通確認: IMAPへのログインと下書きフォルダの存在、SMTPの認証。
// 問題があれば理由（固定文言＋エラー種別）を返し、問題なければ null
export async function probeImap(timeoutMs = 10_000): Promise<string | null> {
  if (!imapConfigured()) return 'IMAP設定(XSERVER_IMAP_HOST/USER/PASS)が未完了です';
  const client = imapClient(timeoutMs);
  try {
    await client.connect();
    const boxes = await client.list();
    const drafts = xserverDraftsMailbox();
    if (!boxes.some((b) => b.path === drafts)) {
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

export async function collect(isProcessed: (mailId: string) => boolean): Promise<SesRawMail[]> {
  if (!imapConfigured()) {
    throw new SafeLogError(
      'Xserver収集: IMAP設定(XSERVER_IMAP_HOST/USER/PASS)が未完了です（Google Workspace 運用の場合は MAIL_PROVIDER=gmail）',
    );
  }
  const client = imapClient();
  const mails: SesRawMail[] = [];
  // 接続・認証・検索の失敗は呼び出し側へ伝える（収集失敗としてバッチを異常終了扱いにするため）
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(Date.now() - collectDays() * 24 * 60 * 60 * 1000);
      const uids = await client.search({ since }, { uid: true });
      if (uids && uids.length > 0) {
        // UIDはメールボックス再構築(UIDVALIDITY変化)で再利用されるため、IDにUIDVALIDITYを含めて
        // 別メールとの誤同一視（誤スキップ）を防ぐ
        const uidValidity = String((client.mailbox as { uidValidity?: bigint }).uidValidity ?? '0');
        // 処理済みのUIDは本文ダウンロード前に除外する（毎回全件を再取得しない）
        const targets = uids.filter((uid) => !isProcessed(mailId(uidValidity, uid)));
        if (targets.length < uids.length) {
          console.log(`Xserver収集: ${uids.length - targets.length}件は処理済みのため取得をスキップ`);
        }
        if (targets.length > 0) {
          for await (const msg of client.fetch(targets, { source: true }, { uid: true })) {
            try {
              const parsed = await simpleParser(msg.source as Buffer);
              mails.push(toSesRawMail(parsed, uidValidity, msg.uid));
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
  console.log(`Xserver収集: ${mails.length}件を収集`);
  return mails;
}

function mailId(uidValidity: string, uid: number): string {
  return `sesmail_x${uidValidity}_${uid}`;
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

function toSesRawMail(p: ParsedMail, uidValidity: string, uid: number): SesRawMail {
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
    id: mailId(uidValidity, uid),
    from: addrText(p.from),
    to: addrText(p.to),
    cc: addrText(p.cc),
    replyTo: addrText(p.replyTo),
    subject: p.subject ?? '',
    body,
    messageIdHeader: p.messageId ?? '',
    references: refsText(p.references),
    receivedAt: p.date ?? new Date(),
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

export function sendReady(): boolean {
  return smtpConfigured();
}

export async function sendPlainMail(to: string, subject: string, body: string): Promise<void> {
  if (!smtpConfigured()) {
    throw new SafeLogError('Xserver送信: SMTP設定(XSERVER_SMTP_HOST/USER/PASS)が未完了です');
  }
  await smtpTransport().sendMail({ from: xserverSharedUser(), to, subject, text: body });
}
