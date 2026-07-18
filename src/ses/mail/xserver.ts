// Xserver（IMAP/SMTP）プロバイダ。@自社を Xserver で運用している場合の既定。
// 共有メーリス(sales@)を IMAP で収集し、全員に返信の下書きを下書きフォルダに APPEND、
// サマリは SMTP で送信する。Google Workspace 不要。
// 設定不足時は warn して縮退（他機能は継続）。実サーバ接続は本番でのみ疎通する。
import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail, type AddressObject } from 'mailparser';
import nodemailer from 'nodemailer';
import { extractSheetLinks } from '../../collectors/email.js';
import {
  xserverImapHost,
  xserverImapPort,
  xserverSmtpHost,
  xserverSmtpPort,
  xserverSharedUser,
  xserverSharedPass,
  xserverDraftsMailbox,
  xserverCollectDays,
} from '../config.js';
import type { SesRawMail, DraftRef, SesAttachment } from '../../types/index.js';

function imapConfigured(): boolean {
  return Boolean(xserverImapHost() && xserverSharedUser() && xserverSharedPass());
}

function smtpConfigured(): boolean {
  return Boolean(xserverSmtpHost() && xserverSharedUser() && xserverSharedPass());
}

function imapClient(): ImapFlow {
  return new ImapFlow({
    host: xserverImapHost(),
    port: xserverImapPort(),
    secure: true,
    auth: { user: xserverSharedUser(), pass: xserverSharedPass() },
    logger: false,
  });
}

export async function collect(): Promise<SesRawMail[]> {
  if (!imapConfigured()) {
    console.warn('Xserver収集: IMAP設定(XSERVER_IMAP_HOST/USER/PASS)が未完了のためスキップ');
    return [];
  }
  const client = imapClient();
  const mails: SesRawMail[] = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(Date.now() - xserverCollectDays() * 24 * 60 * 60 * 1000);
      const uids = await client.search({ since }, { uid: true });
      if (uids && uids.length > 0) {
        for await (const msg of client.fetch(uids, { source: true }, { uid: true })) {
          try {
            const parsed = await simpleParser(msg.source as Buffer);
            mails.push(toSesRawMail(parsed, msg.uid));
          } catch (err) {
            console.error(`Xserver収集: メール解析に失敗 (uid ${msg.uid}): ${String(err)}`);
          }
        }
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    console.error(`Xserver収集: エラー: ${String(err)}`);
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

function addrText(a: AddressObject | AddressObject[] | undefined): string {
  if (!a) return '';
  if (Array.isArray(a)) return a.map((x) => x.text).filter(Boolean).join(', ');
  return a.text ?? '';
}

function refsText(r: string | string[] | undefined): string {
  if (!r) return '';
  return Array.isArray(r) ? r.join(' ') : r;
}

function toSesRawMail(p: ParsedMail, uid: number): SesRawMail {
  const attachments: SesAttachment[] = (p.attachments ?? []).map((a) => ({
    filename: a.filename ?? 'attachment',
    mimeType: a.contentType ?? '',
    data: a.content ? a.content.toString('base64') : '',
  }));
  const body = p.text ?? '';
  return {
    id: `sesmail_x${uid}`,
    from: addrText(p.from),
    to: addrText(p.to),
    cc: addrText(p.cc),
    subject: p.subject ?? '',
    body,
    messageIdHeader: p.messageId ?? '',
    references: refsText(p.references),
    receivedAt: p.date ?? new Date(),
    attachments,
    sheetLinks: extractSheetLinks(body),
  };
}

// 全員に返信の下書きを、共有メールボックスの下書きフォルダに APPEND する（From=担当営業本人）。
// 担当営業は共有の下書きを開いて内容を確認のうえ送信する（送信は手動＝下書き止まりを維持）。
export async function createReplyDraft(ref: DraftRef, fromEmail: string): Promise<DraftRef> {
  const finalized: DraftRef = { ...ref, from: fromEmail };
  if (!imapConfigured()) {
    console.warn('Xserver下書き: IMAP設定が未完了のため下書き作成をスキップ');
    return finalized;
  }
  const raw = await buildMime(finalized);
  const client = imapClient();
  try {
    await client.connect();
    await client.append(xserverDraftsMailbox(), raw, ['\\Draft']);
  } catch (err) {
    console.error(`Xserver下書き: 下書きフォルダへのAPPENDに失敗: ${String(err)}`);
  } finally {
    try {
      await client.logout();
    } catch {
      /* noop */
    }
  }
  return { ...finalized, url: `imap://${xserverSharedUser()}/${xserverDraftsMailbox()}` };
}

export async function sendPlainMail(to: string, subject: string, body: string): Promise<void> {
  if (!smtpConfigured()) {
    console.warn('Xserverサマリ送信: SMTP設定が未完了のためスキップ');
    return;
  }
  const transporter = nodemailer.createTransport({
    host: xserverSmtpHost(),
    port: xserverSmtpPort(),
    secure: xserverSmtpPort() === 465,
    auth: { user: xserverSharedUser(), pass: xserverSharedPass() },
  });
  await transporter.sendMail({ from: xserverSharedUser(), to, subject, text: body });
}

// nodemailer の streamTransport で、送信せずに全員に返信のMIMEバッファを組み立てる。
async function buildMime(ref: DraftRef): Promise<Buffer> {
  const builder = nodemailer.createTransport({ streamTransport: true, newline: 'unix', buffer: true });
  const info = await builder.sendMail({
    from: ref.from,
    to: ref.to,
    cc: ref.cc,
    subject: ref.subject,
    text: ref.body,
    inReplyTo: ref.inReplyTo,
    references: ref.references,
  });
  return info.message as unknown as Buffer;
}
