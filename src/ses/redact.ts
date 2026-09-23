// ログ秘匿（公開リポジトリのActionsログ対策）。logRedact() が真のとき、コンソールには
// ID・件数・エラー種別だけを出し、氏名・メールアドレス・件名・案件名・API生エラー文は出さない。
// 詳細はサマリメール（非公開）側で確認する運用。
import { logRedact } from './config.js';

const MASK = '＊';

// 秘匿モードでは伏せ字にするラベル（氏名・案件名・件名・ファイル名・URL等）
export function redactable(label: string): string {
  return logRedact() ? MASK : label;
}

// 文言が固定・内容を含まないと分かっているエラー。秘匿モードでもメッセージを出してよい
export class SafeLogError extends Error {}

// エラーのログ表記。秘匿モードでは種別・HTTPステータス・コードのみ（API応答が本文等を反響し得るため）
export function formatErr(err: unknown, redact: boolean): string {
  if (err instanceof SafeLogError) return err.message;
  if (!redact) return String(err);
  const e = (err ?? {}) as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  const parts = [err instanceof Error ? err.name : typeof err];
  const status = e.status ?? e.response?.status;
  if (typeof status === 'number' || typeof status === 'string') parts.push(`status=${String(status).slice(0, 10)}`);
  if (typeof e.code === 'number' || typeof e.code === 'string') parts.push(`code=${String(e.code).slice(0, 40)}`);
  return `${parts.join(' ')}（詳細は秘匿）`;
}

export function safeErr(err: unknown): string {
  return formatErr(err, logRedact());
}
