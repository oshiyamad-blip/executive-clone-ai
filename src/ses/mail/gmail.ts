// Gmail（Google Workspace）プロバイダ。@自社を Google Workspace で運用している場合に使う。
// SES専用メールボックス（SES_TARGET_GMAIL。グループではなく実ユーザー）としてDWDで収集・サマリ送信し、
// 下書きは担当営業本人（担当者メール列・確認UIで指定）として作成する。
// DWDに登録するスコープは gmail.readonly / gmail.compose / gmail.send の3つ。呼び出しごとに必要な1つだけを要求する。
import { collectSesRawMail } from '../../collectors/email.js';
import {
  getGoogleAuthAs,
  loadServiceAccountCredentials,
  SES_GMAIL_COLLECT_SCOPES,
  SES_GMAIL_DRAFT_SCOPES,
  SES_GMAIL_SEND_SCOPES,
} from '../../collectors/googleAuth.js';
import { google } from 'googleapis';
import { SafeLogError } from '../redact.js';
import { sesTargetGmail, collectDays } from '../config.js';
import { buildReplyMime, buildPlainMime } from './mime.js';
import type { SesRawMail, DraftRef } from '../../types/index.js';

function mailboxReady(): boolean {
  return Boolean(sesTargetGmail()) && loadServiceAccountCredentials() !== null;
}

export function collectReady(): boolean {
  return mailboxReady();
}

// SES専用メールボックスの受信メール（送信済み・下書き・迷惑メール・ゴミ箱を除く）を収集期間ぶん取得する。
// 宛先(to:)で絞らない（BCC・転送で届いたメールも拾うため。メールボックス自体がSES専用である前提）
export async function collect(isProcessed: (mailId: string) => boolean): Promise<SesRawMail[]> {
  const auth = getGoogleAuthAs(sesTargetGmail(), SES_GMAIL_COLLECT_SCOPES);
  if (!auth) throw new SafeLogError('Gmail収集: SES_TARGET_GMAIL または Google認証（サービスアカウント）が未設定です');
  const afterEpoch = Math.floor((Date.now() - collectDays() * 24 * 60 * 60 * 1000) / 1000);
  const query = `after:${afterEpoch} -in:sent -in:drafts -in:spam -in:trash`;
  return collectSesRawMail(auth, query, isProcessed);
}

export function draftReady(): boolean {
  return loadServiceAccountCredentials() !== null;
}

// 担当営業本人(fromEmail)を impersonate して、全員に返信のスレッド下書きを本人のGmailに作成する。
// 失敗は例外で返す（呼び出し側が「作成済」と誤記録しないため）
export async function createReplyDraft(ref: DraftRef, fromEmail: string): Promise<DraftRef> {
  const finalized: DraftRef = { ...ref, from: fromEmail };
  const auth = getGoogleAuthAs(fromEmail, SES_GMAIL_DRAFT_SCOPES);
  if (!auth) {
    throw new SafeLogError('Gmail下書き: Google認証（サービスアカウント）が未設定のため下書きを作成できません');
  }
  const gmail = google.gmail({ version: 'v1', auth });
  // 手組みヘッダではなく共通MIMEビルダーを使う（日本語表示名のRFC2047エンコード等をXserver側と統一）
  const raw = (await buildReplyMime(finalized)).toString('base64url');
  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw } },
  });
  const draftId = res.data.id;
  if (!draftId) throw new SafeLogError('Gmail下書き: 下書きIDが返らなかったため作成を確認できません');
  const messageId = res.data.message?.id ?? '';
  const url = messageId ? `https://mail.google.com/mail/u/0/#drafts?compose=${messageId}` : '';
  return { ...finalized, draftId, url };
}

export function sendReady(): boolean {
  return mailboxReady();
}

export async function sendPlainMail(to: string, subject: string, body: string): Promise<void> {
  const auth = getGoogleAuthAs(sesTargetGmail(), SES_GMAIL_SEND_SCOPES);
  if (!auth) throw new SafeLogError('Gmail送信: SES_TARGET_GMAIL または Google認証（サービスアカウント）が未設定です');
  const gmail = google.gmail({ version: 'v1', auth });
  const raw = (await buildPlainMime(to, subject, body)).toString('base64url');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
}

// 診断（npm run doctor）用: SES専用メールボックスとして収集・送信のトークンが取れるか（DWDのスコープ登録の確認）。
// 問題があれば理由を返し、問題なければ null
export async function probeGmail(): Promise<string | null> {
  if (!mailboxReady()) return 'SES_TARGET_GMAIL または Google認証（GOOGLE_SA_KEY_JSON 等）が未設定です';
  for (const [label, scopes] of [
    ['gmail.readonly', SES_GMAIL_COLLECT_SCOPES],
    ['gmail.send', SES_GMAIL_SEND_SCOPES],
  ] as const) {
    try {
      await getGoogleAuthAs(sesTargetGmail(), [...scopes])!.authorize();
    } catch {
      return `SES_TARGET_GMAIL として ${label} のトークンを取得できません（管理コンソールのドメイン全体の委任にスコープを登録したか確認）`;
    }
  }
  return null;
}
