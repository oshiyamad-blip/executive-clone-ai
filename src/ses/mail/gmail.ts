// Gmail（Google Workspace）プロバイダ。@自社を Google Workspace で運用している場合に使う。
// SES専用メールボックス（SES_TARGET_GMAIL。グループではなく実ユーザー）としてDWDで収集・サマリ送信し、
// 下書きは担当営業本人（担当者メール列・確認UIで指定）として作成する。
// DWDに登録するスコープは gmail.readonly / gmail.compose / gmail.send の3つ。呼び出しごとに必要な1つだけを要求する。
// DWD はテナントの全員のメールボックスに及ぶため、専用の鍵（SES_GMAIL_SA_KEY_JSON）だけで行う（メインの鍵ではなりすまさない）。
import { collectSesRawMail } from '../../collectors/email.js';
import {
  SES_GMAIL_COLLECT_SCOPES,
  SES_GMAIL_DRAFT_SCOPES,
  SES_GMAIL_SEND_SCOPES,
} from '../../collectors/googleAuth.js';
import { google } from 'googleapis';
import { SafeLogError } from '../redact.js';
import { gmailDelegatedAuth, gmailCredentialsReady, gmailAuthProblem } from '../googleCreds.js';
import { sesTargetGmail, collectDays } from '../config.js';
import { pickForRun } from '../schedule.js';
import { buildReplyMime, buildPlainMime } from './mime.js';
import { addressOf } from './ownMail.js';
import type { DraftRef, SesMailMeta, SesAttachmentKind } from '../../types/index.js';
import type { CollectOptions, CollectOutcome } from './index.js';

function mailboxReady(): boolean {
  return Boolean(sesTargetGmail()) && gmailCredentialsReady();
}

export function collectReady(): boolean {
  return mailboxReady();
}

// SES専用メールボックスの受信メール（送信済み・下書き・迷惑メール・ゴミ箱を除く）を収集期間ぶん取得する。
// 宛先(to:)で絞らない（BCC・転送で届いたメールも拾うため。メールボックス自体がSES専用である前提）
export async function collect(isProcessed: (mailId: string) => boolean, opts: CollectOptions): Promise<CollectOutcome> {
  const auth = gmailDelegatedAuth(sesTargetGmail(), SES_GMAIL_COLLECT_SCOPES);
  if (!auth) throw new SafeLogError('Gmail収集: SES_TARGET_GMAIL または Gmail用のサービスアカウント鍵（SES_GMAIL_SA_KEY_JSON）が未設定です');
  const afterEpoch = Math.floor((Date.now() - collectDays() * 24 * 60 * 60 * 1000) / 1000);
  const query = `after:${afterEpoch} -in:sent -in:drafts -in:spam -in:trash`;
  return collectSesRawMail(auth, query, isProcessed, {
    limit: opts.limit,
    pick: (items, limit) => pickForRun(items, limit, collectDays(), opts.now),
  });
}

export function draftReady(): boolean {
  return gmailCredentialsReady();
}

// 担当営業本人(fromEmail)を impersonate して、全員に返信のスレッド下書きを本人のGmailに作成する。
// 失敗は例外で返す（呼び出し側が「作成済」と誤記録しないため）
export async function createReplyDraft(ref: DraftRef, fromEmail: string): Promise<DraftRef> {
  const finalized: DraftRef = { ...ref, from: fromEmail };
  const auth = gmailDelegatedAuth(fromEmail, SES_GMAIL_DRAFT_SCOPES);
  if (!auth) {
    throw new SafeLogError('Gmail下書き: Gmail用のサービスアカウント鍵（SES_GMAIL_SA_KEY_JSON）が未設定のため下書きを作成できません');
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

// Gmail API では任意のヘッダで下書きを検索できないため確かめない（drafts.create は作成結果を同期的に返す）
export async function draftExists(_draftKey: string): Promise<boolean | null> {
  return null;
}

export function sendReady(): boolean {
  return mailboxReady();
}

export async function sendPlainMail(to: string, subject: string, body: string): Promise<void> {
  const auth = gmailDelegatedAuth(sesTargetGmail(), SES_GMAIL_SEND_SCOPES);
  if (!auth) throw new SafeLogError('Gmail送信: SES_TARGET_GMAIL または Google認証（サービスアカウント）が未設定です');
  const gmail = google.gmail({ version: 'v1', auth });
  const raw = (await buildPlainMime(to, subject, body)).toString('base64url');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
}

// メール量の測定（npm run ses:mail-stats）用。本文・添付を取得せず、一覧（ID）と件名・送信元ヘッダ・受信日時・サイズだけを読む。
// 添付の種類はメール単位で検索クエリ（filename:pdf 等）の該当有無から求める（添付ごとの個数は数えない）
export async function scanMeta(since: Date): Promise<SesMailMeta[]> {
  const auth = gmailDelegatedAuth(sesTargetGmail(), SES_GMAIL_COLLECT_SCOPES);
  if (!auth) throw new SafeLogError('Gmail測定: SES_TARGET_GMAIL または Google認証（サービスアカウント）が未設定です');
  const gmail = google.gmail({ version: 'v1', auth });
  const base = `after:${Math.floor(since.getTime() / 1000)} -in:sent -in:drafts -in:spam -in:trash`;

  const listIds = async (q: string): Promise<Set<string>> => {
    const ids = new Set<string>();
    let pageToken: string | undefined;
    do {
      const res = await gmail.users.messages.list({ userId: 'me', q, maxResults: 500, pageToken });
      for (const m of res.data.messages ?? []) if (m.id) ids.add(m.id);
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return ids;
  };

  const all = await listIds(base);
  const withAttachment = await listIds(`${base} has:attachment`);
  const kindQueries: Array<[Exclude<SesAttachmentKind, 'other'>, string]> = [
    ['pdf', 'filename:pdf'],
    ['xlsx', 'filename:xlsx'],
    ['xls', 'filename:xls'],
    ['docx', 'filename:docx'],
  ];
  const kindIds = new Map<SesAttachmentKind, Set<string>>();
  for (const [kind, q] of kindQueries) kindIds.set(kind, await listIds(`${base} ${q}`));

  const ids = [...all];
  const metas: SesMailMeta[] = [];
  let failed = 0;
  // 利用上限（ユーザーあたり毎秒250単位・get=5単位）に収まるよう、同時10件ずつ取得する
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    const settled = await Promise.allSettled(
      chunk.map((id) =>
        gmail.users.messages.get({
          userId: 'me',
          id,
          format: 'metadata',
          metadataHeaders: ['Subject', 'From'],
          fields: 'id,internalDate,sizeEstimate,payload/headers',
        }),
      ),
    );
    for (const r of settled) {
      if (r.status === 'rejected') {
        failed += 1;
        continue;
      }
      const res = r.value;
      const id = res.data.id ?? '';
      const header = (name: string) => res.data.payload?.headers?.find((h) => h.name?.toLowerCase() === name)?.value ?? '';
      const kinds: SesAttachmentKind[] = [];
      for (const [kind, set] of kindIds) if (set.has(id)) kinds.push(kind);
      // xls の検索は xlsx にも当たり得るため、xlsx と重なる分は数えない
      if (kinds.includes('xls') && kinds.includes('xlsx')) kinds.splice(kinds.indexOf('xls'), 1);
      if (kinds.length === 0 && withAttachment.has(id)) kinds.push('other');
      metas.push({
        receivedAt: new Date(Number(res.data.internalDate ?? 0)),
        subject: header('subject'),
        fromAddress: addressOf(header('from')),
        sizeBytes: res.data.sizeEstimate ?? 0,
        attachmentKinds: kinds,
      });
    }
  }
  if (failed > 0) console.warn(`Gmail測定: ${failed}件はメタ情報を取得できなかったため集計から除外しました`);
  return metas;
}

// 診断（npm run doctor）用: SES専用メールボックスとして収集・送信のトークンが取れるか（DWDのスコープ登録の確認）。
// 問題があれば理由を返し、問題なければ null
export async function probeGmail(): Promise<string | null> {
  if (!mailboxReady()) return sesTargetGmail() ? gmailAuthProblem() ?? 'Google認証が未設定です' : 'SES_TARGET_GMAIL が未設定です';
  for (const [label, scopes] of [
    ['gmail.readonly', SES_GMAIL_COLLECT_SCOPES],
    ['gmail.send', SES_GMAIL_SEND_SCOPES],
  ] as const) {
    try {
      await gmailDelegatedAuth(sesTargetGmail(), [...scopes])!.authorize();
    } catch {
      return `SES_TARGET_GMAIL として ${label} のトークンを取得できません（管理コンソールのドメイン全体の委任にスコープを登録したか確認）`;
    }
  }
  return null;
}
