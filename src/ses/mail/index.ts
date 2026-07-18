// メール送受信プロバイダの抽象化。MAIL_PROVIDER=xserver（既定・IMAP/SMTP）| gmail（Google Workspace API）。
// マッチング・確認UI・全員に返信の組み立ては共通。収集・下書き作成・サマリ送信の「口」だけを切り替える。
// （src/llm/index.ts の LLM_PROVIDER と同じ流儀）
import { mailProvider } from '../config.js';
import * as gmail from './gmail.js';
import * as xserver from './xserver.js';
import type { SesRawMail, DraftRef } from '../../types/index.js';

export interface MailTransport {
  // 共有メールボックス（メーリス）から未整理のメールを収集する
  collect(): Promise<SesRawMail[]>;
  // 全員に返信の下書きを、担当営業本人の会社アドレス(fromEmail)で作成する
  createReplyDraft(ref: DraftRef, fromEmail: string): Promise<DraftRef>;
  // サマリ等のプレーンメールを送信する
  sendPlainMail(to: string, subject: string, body: string): Promise<void>;
}

function transport(): MailTransport {
  return mailProvider() === 'gmail' ? gmail : xserver;
}

export function collectMail(): Promise<SesRawMail[]> {
  return transport().collect();
}

export function createReplyDraftViaMail(ref: DraftRef, fromEmail: string): Promise<DraftRef> {
  return transport().createReplyDraft(ref, fromEmail);
}

export function sendPlainMailViaMail(to: string, subject: string, body: string): Promise<void> {
  return transport().sendPlainMail(to, subject, body);
}
