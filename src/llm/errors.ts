// LLMの応答が使えない（途中打ち切り・拒否・空）ことを表す型付きエラー。
// 呼び出し側（SESの自動修復）は種類で対処を変える（打ち切りなら出力上限を増やして再試行する等）。
// 文言は固定なので、ログ秘匿モードでもそのまま出してよい（SafeLogError）
import { SafeLogError } from '../ses/redact.js';

export type LlmOutputProblem = 'max_tokens' | 'refusal' | 'empty' | 'schema';

const MESSAGES: Record<LlmOutputProblem, string> = {
  max_tokens: 'LLM応答が出力上限(max_tokens)で途中打ち切りになりました',
  refusal: 'LLMが応答を拒否しました(refusal)',
  empty: 'LLM応答に本文がありませんでした',
  schema: 'LLM応答のJSONが指定の形（スキーマ）に合いませんでした',
};

export class LlmOutputError extends SafeLogError {
  constructor(readonly problem: LlmOutputProblem, readonly model: string) {
    super(`${MESSAGES[problem]}（model: ${model}）`);
    this.name = 'LlmOutputError';
  }
}

export function isTruncationError(err: unknown): boolean {
  return err instanceof LlmOutputError && err.problem === 'max_tokens';
}

function errorText(err: unknown): string {
  const e = (err ?? {}) as { message?: unknown; error?: unknown };
  let body = '';
  try {
    body = e.error === undefined ? '' : JSON.stringify(e.error);
  } catch {
    body = '';
  }
  return `${typeof e.message === 'string' ? e.message : ''} ${body}`;
}

// モデルを主語にした退役・提供終了の言い回しだけを拾う（「<機能> is not available for model …」「… is deprecated for this model」の
// ような、生きているモデルでの機能・引数の誤りで代替モデルに切り替えない）
const MODEL_RETIRED =
  /\bmodel\b[^.;]{0,80}?\b(?:has been|have been|is|was)\s+(?:now\s+)?(?:deprecated|retired|removed|sunset|discontinued|no longer (?:available|supported))|\bmodel\b[^.;]{0,80}?\b(?:reached|is past|has passed)\s+(?:its\s+)?end[- ]of[- ]life/i;

// モデルそのものが使えない（退役・提供終了・存在しないモデルID）ことを示すAPIエラーか。
// 404 not_found_error は「model: …」を含むときだけ（ファイル・バッチ等の別リソースの404と取り違えない）
export function isModelUnavailableError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status !== 'number') return false;
  const text = errorText(err);
  if (!/model/i.test(text)) return false;
  if (status === 404) return /not_found_error|not[_ ]found/i.test(text);
  if (status === 400 || status === 410) return MODEL_RETIRED.test(text);
  return false;
}
