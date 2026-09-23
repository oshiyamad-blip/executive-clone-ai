// 収集時のメール・添付の大きさの上限（Xserver・Gmail 共通）。
// 添付は社外の誰からでも届く。抽出・解析の段で使えない大きさの添付まで base64 で全件メモリに抱えると、
// 大きな添付付きのメールを大量に送られただけで収集中にメモリを使い切り、処理済みにならないまま毎回同じメールで止まる。
// そのため、使えない大きさの添付は収集の時点で保持しない（件数だけ数える）。
import { SPREADSHEET_MAX_BYTES } from '../parse.js';

// PDFは抽出で base64 のまま API に送る。extract.ts の上限（base64で20MB文字≒元の15MB）を超えるものは使わない
export const PDF_MAX_BYTES = 15 * 1024 * 1024;
// 1通で保持する添付の合計（extract.ts が1通で送るPDFの合計の上限 base64 24MB文字≒18MB に表計算の余裕を足した値）
export const MAIL_ATTACHMENT_TOTAL_MAX_BYTES = 30 * 1024 * 1024;
// 1通の大きさ（RFC822の原文）の上限。上の添付の上限（base64で約4/3倍）と本文に余裕を見た値。超えるメールは本文を取得しない
export const MAIL_MAX_BYTES = 45 * 1024 * 1024;

// 収集の時点で保持する本文の上限（文字）。抽出に使うのは先頭の5万字（extract.ts）で、残りは再送の指紋・
// シートのリンクの検出に使う分の余裕。何十MBもの本文を抱えたまま次の段に渡さない
export const MAIL_BODY_MAX_CHARS = 200_000;

export function capMailBody(body: string): string {
  return body.length > MAIL_BODY_MAX_CHARS ? body.slice(0, MAIL_BODY_MAX_CHARS) : body;
}

export interface SizedAttachment {
  filename: string;
  mimeType: string;
  bytes: number;
}

function isPdf(a: SizedAttachment): boolean {
  return a.mimeType === 'application/pdf' || /\.pdf$/i.test(a.filename);
}

// 保持する添付（純関数）。種類ごとの上限と1通の合計の上限の内に収まるものだけを先頭から選ぶ
export function attachmentsWithinLimits<T extends SizedAttachment>(items: T[]): { kept: T[]; dropped: number } {
  const kept: T[] = [];
  let total = 0;
  for (const a of items) {
    const cap = isPdf(a) ? PDF_MAX_BYTES : SPREADSHEET_MAX_BYTES;
    if (!(a.bytes >= 0) || a.bytes > cap || total + a.bytes > MAIL_ATTACHMENT_TOTAL_MAX_BYTES) continue;
    total += a.bytes;
    kept.push(a);
  }
  return { kept, dropped: items.length - kept.length };
}
