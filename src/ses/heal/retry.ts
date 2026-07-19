// LLM呼び出しの自動修復: バックオフ再試行 → 上位モデルへの昇格。予算（円）とエラー種別で拘束する。
// demoでは絶対に動かない（呼び出し元がprod経路のみで使う前提だが、二重に isDemo() でも防御）。
import { isDemo, healEnabled, matchModel } from '../config.js';
import { healRemainingJpy, inHealScope } from './budget.js';
import { recordHealEvent, recordStat } from './events.js';
import { maskPii } from './quarantine.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 再試行して意味のあるエラーか。認証・リクエスト不正（4xxの恒久系）は再試行しても無駄
export function isRetryableLlmError(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  if (status === 400 || status === 401 || status === 403 || status === 404) return false;
  return true; // 429 / 5xx / 529 / ネットワーク / JSONパース失敗 / 空応答 は再試行の価値あり
}

// 失敗したLLM処理を修復する: ①2秒待って同条件で再試行 → ②5秒待って上位モデルへ昇格。
// 成功すれば結果を、修復できなければ null を返す（呼び出し元は従来のフォールバックへ）。
export async function healLlmCall<T>(
  label: string,
  firstError: unknown,
  attempt: (modelOverride?: string) => Promise<T>,
): Promise<T | null> {
  if (isDemo() || !healEnabled()) return null;

  if (!isRetryableLlmError(firstError)) {
    recordHealEvent(
      'warn',
      `${label}: 再試行不能なエラー種別のため修復をスキップ（${maskPii(String(firstError)).slice(0, 120)}）`,
    );
    return null;
  }

  if (healRemainingJpy() <= 0) {
    recordStat('budgetExhausted');
    recordHealEvent('warn', `${label}: 修復予算を使い切ったため再試行せず、次回バッチに繰り越します`);
    return null;
  }

  await sleep(2000);
  try {
    const value = await inHealScope(() => attempt());
    recordStat('healedRetry');
    recordHealEvent('info', `${label}: 再試行で成功しました`);
    return value;
  } catch {
    // 昇格へ
  }

  if (healRemainingJpy() <= 0) {
    recordStat('budgetExhausted');
    recordHealEvent('warn', `${label}: 修復予算を使い切ったため昇格せず、次回バッチに繰り越します`);
    return null;
  }

  await sleep(5000);
  try {
    const value = await inHealScope(() => attempt(matchModel()));
    recordStat('healedEscalation');
    recordHealEvent('info', `${label}: 上位モデルへの昇格で成功しました`);
    return value;
  } catch (err) {
    recordHealEvent('warn', `${label}: 昇格でも失敗しました（${maskPii(String(err)).slice(0, 120)}）`);
    return null;
  }
}
