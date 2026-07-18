// Gmail（Google Workspace）プロバイダ。@自社を Google Workspace で運用している場合に使う。
// ドメイン全体委任(DWD)で共有メーリスの収集・担当営業本人での下書き作成・サマリ送信を行う。
import { google } from 'googleapis';
import { collectSesRawMail } from '../../collectors/email.js';
import { getGoogleAuth, getGoogleAuthAs } from '../../collectors/googleAuth.js';
import { sesTargetGmail } from '../config.js';
import type { SesRawMail, DraftRef } from '../../types/index.js';

export async function collect(): Promise<SesRawMail[]> {
  const target = sesTargetGmail();
  const targetClause = target ? ` to:${target}` : '';
  const query = `newer_than:1d -in:drafts -in:spam -in:trash${targetClause}`;
  return collectSesRawMail(query);
}

// 担当営業本人(fromEmail)を impersonate して、全員に返信のスレッド下書きを本人のGmailに作成する。
export async function createReplyDraft(ref: DraftRef, fromEmail: string): Promise<DraftRef> {
  const finalized: DraftRef = { ...ref, from: fromEmail };
  const auth = getGoogleAuthAs(fromEmail);
  if (!auth) {
    console.warn('Gmail下書き: Google認証未設定のため下書き作成をスキップ');
    return finalized;
  }
  const gmail = google.gmail({ version: 'v1', auth });
  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw: buildRawReply(finalized) } },
  });
  const draftId = res.data.id ?? finalized.draftId;
  const messageId = res.data.message?.id ?? '';
  const url = messageId ? `https://mail.google.com/mail/u/0/#drafts?compose=${messageId}` : '';
  return { ...finalized, draftId, url };
}

export async function sendPlainMail(to: string, subject: string, body: string): Promise<void> {
  const auth = getGoogleAuth();
  if (!auth) {
    console.warn('Gmailサマリ送信: Google認証未設定のためスキップ');
    return;
  }
  const gmail = google.gmail({ version: 'v1', auth });
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw: buildRawPlain(to, subject, body) } });
}

// 全員に返信のMIME（From/To/Cc/In-Reply-To/References付き）を base64url で組み立てる。
function buildRawReply(ref: DraftRef): string {
  const lines: string[] = [`From: ${ref.from ?? ''}`, `To: ${ref.to}`];
  if (ref.cc) lines.push(`Cc: ${ref.cc}`);
  lines.push(`Subject: =?UTF-8?B?${Buffer.from(ref.subject, 'utf-8').toString('base64')}?=`);
  if (ref.inReplyTo) lines.push(`In-Reply-To: ${ref.inReplyTo}`);
  if (ref.references) lines.push(`References: ${ref.references}`);
  lines.push('Content-Type: text/plain; charset="UTF-8"', '', ref.body ?? '');
  return Buffer.from(lines.join('\n')).toString('base64url');
}

function buildRawPlain(to: string, subject: string, body: string): string {
  const message = [
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body,
  ].join('\n');
  return Buffer.from(message).toString('base64url');
}
