// ログ秘匿（公開リポジトリのActionsログ対策）。logRedact() が真のとき、コンソールには
// ID・件数・エラー種別だけを出し、氏名・メールアドレス・件名・案件名・API生エラー文は出さない。
// 詳細はサマリメール（非公開）側で確認する運用。
import { createHmac, randomBytes } from 'crypto';
import { logRedact } from './config.js';

const MASK = '＊';

// メールID（Message-ID のハッシュ）・案件/要員/マッチのID（メールIDから決まる）は、メールの送り主が手元で計算できる。
// 公開ログにそのまま出すと「自分の送ったメールが抽出に失敗した・指示混入と判定された」が外から分かってしまうため、
// 秘匿モードではプロセスごとの乱数鍵で HMAC した別名にする（同じ実行の中では同じIDは同じ別名。鍵は保存・出力しない）
const RUN_LOG_KEY = randomBytes(32);
const ID_IN_TEXT = /\b(?:sesmail|proj|eng|match|ownmatch|proper)_[A-Za-z0-9_-]+/g;

export function pseudonymizeId(id: string, key: Buffer): string {
  return `#${createHmac('sha256', key).update(id).digest('hex').slice(0, 10)}`;
}

// ログに出すID。秘匿モードでは実行ごとの別名（外部から計算できない）
export function logId(id: string): string {
  return logRedact() ? pseudonymizeId(id, RUN_LOG_KEY) : id;
}

// 文中のID（sesmail_… / proj_… / eng_… / match_… 等）を logId の別名に置き換える（修復イベントのコンソール出力用）
export function redactIdsIn(text: string, redact: boolean = logRedact(), key: Buffer = RUN_LOG_KEY): string {
  return redact ? text.replace(ID_IN_TEXT, (m) => pseudonymizeId(m, key)) : text;
}

// 秘匿モードでは伏せ字にするラベル（氏名・案件名・件名・ファイル名・URL等）
export function redactable(label: string): string {
  return logRedact() ? MASK : label;
}

// 文言が固定・内容を含まないと分かっているエラー。秘匿モードでもメッセージを出してよい
export class SafeLogError extends Error {}

// エラーの種別・HTTPステータス・コードだけの表記（メッセージ本文を含まない）
export function errKind(err: unknown): string {
  const e = (err ?? {}) as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  const parts = [err instanceof Error ? err.name : typeof err];
  const status = e.status ?? e.response?.status;
  if (typeof status === 'number' || typeof status === 'string') parts.push(`status=${String(status).slice(0, 10)}`);
  if (typeof e.code === 'number' || typeof e.code === 'string') parts.push(`code=${String(e.code).slice(0, 40)}`);
  return parts.join(' ');
}

// エラーのログ表記。秘匿モードでは種別・HTTPステータス・コードのみ（API応答が本文等を反響し得るため）
export function formatErr(err: unknown, redact: boolean): string {
  if (err instanceof SafeLogError) return err.message;
  if (!redact) return String(err);
  return `${errKind(err)}（詳細は秘匿）`;
}

export function safeErr(err: unknown): string {
  return formatErr(err, logRedact());
}
