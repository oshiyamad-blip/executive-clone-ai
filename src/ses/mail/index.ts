// メール送受信プロバイダの抽象化。MAIL_PROVIDER=xserver（既定・IMAP/SMTP）| gmail（Google Workspace API）。
// マッチング・確認UI・全員に返信の組み立ては共通。収集・下書き作成・サマリ送信の「口」だけを切り替える。
// （src/llm/index.ts の LLM_PROVIDER と同じ流儀）
import { mailProvider } from '../config.js';
import * as gmail from './gmail.js';
import * as xserver from './xserver.js';
import type { SesRawMail, DraftRef, SesMailMeta } from '../../types/index.js';

export interface MailTransport {
  // 収集に必要な設定が揃っているか
  collectReady(): boolean;
  // 共有メールボックス（メーリス）から収集期間内のメールを取得する。isProcessed が真のメールは本文を取得しない。
  // 接続・認証・検索の失敗は例外（「0件」と区別するため）
  collect(isProcessed: (mailId: string) => boolean): Promise<SesRawMail[]>;
  // 下書き作成に必要な設定が揃っているか（揃っていなければ依頼を消化せず次回に回す）
  draftReady(): boolean;
  // 全員に返信の下書きを、担当営業本人の会社アドレス(fromEmail)で作成する。作成できなければ例外
  createReplyDraft(ref: DraftRef, fromEmail: string): Promise<DraftRef>;
  // サマリ送信に必要な設定が揃っているか
  sendReady(): boolean;
  // サマリ等のプレーンメールを送信する。送れなければ例外
  sendPlainMail(to: string, subject: string, body: string): Promise<void>;
  // メール量の測定用に、since 以降の受信メールのメタ情報だけを読み取り専用で取得する（本文・添付は取得しない）
  scanMeta(since: Date): Promise<SesMailMeta[]>;
}

// オフライン自己検証（npm run ses:flow:check）用の差し替え口（本番コードからは呼ばない）
let testTransport: MailTransport | null = null;

export function __setMailTransportForTest(t: MailTransport | null): void {
  testTransport = t;
}

function transport(): MailTransport {
  if (testTransport) return testTransport;
  return mailProvider() === 'gmail' ? gmail : xserver;
}

export function collectMailReady(): boolean {
  return transport().collectReady();
}

export function collectMail(isProcessed: (mailId: string) => boolean): Promise<SesRawMail[]> {
  return transport().collect(isProcessed);
}

export function replyDraftReady(): boolean {
  return transport().draftReady();
}

export function createReplyDraftViaMail(ref: DraftRef, fromEmail: string): Promise<DraftRef> {
  return transport().createReplyDraft(ref, fromEmail);
}

export function sendMailReady(): boolean {
  return transport().sendReady();
}

export function sendPlainMailViaMail(to: string, subject: string, body: string): Promise<void> {
  return transport().sendPlainMail(to, subject, body);
}

export function scanMailMetaViaMail(since: Date): Promise<SesMailMeta[]> {
  return transport().scanMeta(since);
}
