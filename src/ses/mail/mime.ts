// MIME組み立て（プロバイダ共通）。nodemailer の streamTransport で送信せずにバッファを得る。
// 手組みのヘッダ結合と違い、日本語の表示名・件名のRFC2047エンコードや
// MIME-Version / Content-Transfer-Encoding の付与を正しく行える（Gmail/Xserverで挙動を揃える）。
import nodemailer from 'nodemailer';
import type { DraftRef } from '../../types/index.js';

// 改行はCRLF（RFC 5322。IMAP APPEND ではLFだけの行を受け付けないサーバーがある。Gmail APIもCRLFで問題ない）。
// 本文・宛先は外部由来（スプレッドシートの下書きデータ等）のため、nodemailer のファイル読み込み・URL取得は常に禁止する
function builder() {
  return nodemailer.createTransport({
    streamTransport: true,
    newline: 'windows',
    buffer: true,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}

// 文字列以外（{path:…} {href:…} 等）が紛れ込んでも、そのままの値として扱わせない
function text(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
}

// 下書きの識別子のヘッダ名（作成の成否が分からなかったときに、下書きフォルダに既にあるかを探す）
export const DRAFT_KEY_HEADER = 'X-SES-Draft-Key';

// 全員に返信（To/Cc/Re:件名/In-Reply-To/References付き）のMIMEを組み立てる
export async function buildReplyMime(ref: DraftRef): Promise<Buffer> {
  const key = text(ref.draftKey).replace(/[^A-Za-z0-9_-]/g, '');
  const info = await builder().sendMail({
    from: text(ref.from),
    to: text(ref.to),
    cc: text(ref.cc),
    subject: text(ref.subject),
    text: text(ref.body),
    inReplyTo: text(ref.inReplyTo),
    references: text(ref.references),
    disableFileAccess: true,
    disableUrlAccess: true,
    ...(key ? { headers: { [DRAFT_KEY_HEADER]: key } } : {}),
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
  const info = await builder().sendMail({ from, to, subject, text: text(body), disableFileAccess: true, disableUrlAccess: true });
  return info.message as unknown as Buffer;
}
