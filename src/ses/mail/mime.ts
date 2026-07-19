// MIME組み立て（プロバイダ共通）。nodemailer の streamTransport で送信せずにバッファを得る。
// 手組みのヘッダ結合と違い、日本語の表示名・件名のRFC2047エンコードや
// MIME-Version / Content-Transfer-Encoding の付与を正しく行える（Gmail/Xserverで挙動を揃える）。
import nodemailer from 'nodemailer';
import type { DraftRef } from '../../types/index.js';

function builder() {
  return nodemailer.createTransport({ streamTransport: true, newline: 'unix', buffer: true });
}

// 全員に返信（To/Cc/Re:件名/In-Reply-To/References付き）のMIMEを組み立てる
export async function buildReplyMime(ref: DraftRef): Promise<Buffer> {
  const info = await builder().sendMail({
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

// プレーンメール（サマリ通知等）のMIMEを組み立てる。from省略時はヘッダを付けない
// （Gmail APIは認証ユーザーのアドレスを自動で補完する）。
export async function buildPlainMime(
  to: string,
  subject: string,
  body: string,
  from?: string,
): Promise<Buffer> {
  const info = await builder().sendMail({ from, to, subject, text: body });
  return info.message as unknown as Buffer;
}
