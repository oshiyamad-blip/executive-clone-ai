// Xserver（IMAP/SMTP）プロバイダ。@自社を Xserver で運用している場合の既定。
// 共有メーリス(sales@)を IMAP で収集し、全員に返信の下書きを下書きフォルダに APPEND、
// サマリは SMTP で送信する。Google Workspace 不要。
// 設定不足時は warn して縮退（他機能は継続）。実サーバ接続は本番でのみ疎通する。
import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail, type AddressObject } from 'mailparser';
import nodemailer from 'nodemailer';
import { extractSheetLinks, isSupportedAttachment } from '../../collectors/email.js';
import { loadProcessedMailIds } from '../store.js';
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
    console.warn(
      'Xserver収集: IMAP設定(XSERVER_IMAP_HOST/USER/PASS)が未完了のためスキップ' +
        '（Google Workspace 運用の場合は MAIL_PROVIDER=gmail を設定してください）',
    );
    return [];
  }
  const client = imapClient();
  const mails: SesRawMail[] = [];
  // 接続・検索・処理済みID読込の失敗は呼び出し側へ伝える（収集失敗としてバッチを異常終了扱いにするため）
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
        const processed = await loadProcessedMailIds();
        const targets = uids.filter((uid) => !processed.has(mailId(uidValidity, uid)));
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
