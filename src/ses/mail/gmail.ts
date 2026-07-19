// Gmail（Google Workspace）プロバイダ。@自社を Google Workspace で運用している場合に使う。
// ドメイン全体委任(DWD)で共有メーリスの収集・担当営業本人での下書き作成・サマリ送信を行う。
// SES用スコープ（gmail.compose / gmail.send / spreadsheets.readonly）のDWD登録が必要。
import { google } from 'googleapis';
import { collectSesRawMail } from '../../collectors/email.js';
import { getGoogleAuth, getGoogleAuthAs, SES_SCOPES } from '../../collectors/googleAuth.js';
import { sesTargetGmail } from '../config.js';
import { buildReplyMime, buildPlainMime } from './mime.js';
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
  const auth = getGoogleAuthAs(fromEmail, SES_SCOPES);
  if (!auth) {
    console.warn('Gmail下書き: Google認証未設定のため下書き作成をスキップ');
    return finalized;
  }
  const gmail = google.gmail({ version: 'v1', auth });
  // 手組みヘッダではなく共通MIMEビルダーを使う（日本語表示名のRFC2047エンコード等をXserver側と統一）
  const raw = (await buildReplyMime(finalized)).toString('base64url');
  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw } },
  });
  const draftId = res.data.id ?? finalized.draftId;
  const messageId = res.data.message?.id ?? '';
  const url = messageId ? `https://mail.google.com/mail/u/0/#drafts?compose=${messageId}` : '';
  return { ...finalized, draftId, url };
}

export async function sendPlainMail(to: string, subject: string, body: string): Promise<void> {
  const auth = getGoogleAuth(SES_SCOPES);
  if (!auth) {
    console.warn('Gmailサマリ送信: Google認証未設定のためスキップ');
    return;
  }
  const gmail = google.gmail({ version: 'v1', auth });
  const raw = (await buildPlainMime(to, subject, body)).toString('base64url');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
}
