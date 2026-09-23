// LLM呼び出しの自動修復: バックオフ再試行 → 上位モデルへの昇格。予算（円）とエラー種別で拘束する。
// demoでは絶対に動かない（呼び出し元がprod経路のみで使う前提だが、二重に isDemo() でも防御）。
// - 出力上限での打ち切り（LlmOutputError: max_tokens）は、同じ依頼を繰り返しても同じく切れるため
//   出力上限を増やして再試行する
// - 各試行はSDKの自動再試行を0にする（SDK既定の再試行と掛け算で要求が膨らまないように）
// - 試行ごとにコストを見積もり、残り予算を超える試行はしない（1回の昇格で予算を大きく超えないように）
import { isDemo, healEnabled, matchModel } from '../config.js';
import { isTruncationError } from '../../llm/index.js';
import { healRemainingJpy, inHealScope } from './budget.js';
import { pastRunDeadline } from '../schedule.js';
import { recordHealEvent, recordStat } from './events.js';
import { maskPii } from './quarantine.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 修復の1回の試行の条件。呼び出し側はこれに従って同じ処理をやり直す
export interface HealAttempt {
  model?: string; // 上位モデルへの昇格時のみ指定（未指定なら通常のモデル）
  maxTokensFactor: number; // 出力上限の倍率（打ち切りからの再試行で2倍）
  sdkRetries: number; // SDKの自動再試行回数（修復側で再試行するため0）
}

// 試行のコスト見積もり（円）。見積もれない呼び出し側は省略してよい
export type HealEstimate = (attempt: HealAttempt) => number;

// 再試行して意味のあるエラーか。認証・リクエスト不正（4xxの恒久系）は再試行しても無駄
export function isRetryableLlmError(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 413) return false;
  return true; // 429 / 5xx / 529 / ネットワーク / 打ち切り / JSONパース失敗 / 空応答 は再試行の価値あり
}

// 予算内で試行してよいか。見積もりが残り予算を超えるなら試行しない
function withinBudget(label: string, step: string, attempt: HealAttempt, estimate?: HealEstimate): boolean {
  const remaining = healRemainingJpy();
  const cost = estimate ? estimate(attempt) : 0;
  if (remaining > 0 && Number.isFinite(cost) && cost <= remaining) return true;
  recordStat('budgetExhausted');
  const detail = estimate && remaining > 0 ? `（見積り約${cost.toFixed(1)}円 > 残り${remaining.toFixed(1)}円）` : '';
  recordHealEvent('warn', `${label}: 修復予算の範囲外のため${step}せず、次回バッチに繰り越します${detail}`);
  return false;
}

// 失敗したLLM処理を修復する: ①2秒待って再試行（打ち切りなら出力上限2倍） → ②5秒待って上位モデルへ昇格。
// 成功すれば結果を、修復できなければ null を返す（呼び出し元は従来のフォールバックへ）。
export async function healLlmCall<T>(
  label: string,
  firstError: unknown,
  attempt: (a: HealAttempt) => Promise<T>,
  estimate?: HealEstimate,
): Promise<T | null> {
  if (isDemo() || !healEnabled()) return null;
  if (pastRunDeadline()) {
    // 修復の再試行・昇格は時間がかかるため、実行時間の期限を過ぎたら行わない（ジョブの制限時間を越えないように）
    recordHealEvent('warn', `${label}: 実行時間の上限を過ぎたため修復を省き、次回バッチに繰り越します`);
    return null;
  }

  if (!isRetryableLlmError(firstError)) {
    recordHealEvent(
      'warn',
      `${label}: 再試行不能なエラー種別のため修復をスキップ`,
      maskPii(String(firstError)).slice(0, 120),
    );
    return null;
  }

  let factor = isTruncationError(firstError) ? 2 : 1;
  const retry: HealAttempt = { maxTokensFactor: factor, sdkRetries: 0 };
  if (!withinBudget(label, '再試行', retry, estimate)) return null;

  await sleep(2000);
  try {
    const value = await inHealScope(() => attempt(retry));
    recordStat('healedRetry');
    recordHealEvent('info', `${label}: 再試行${factor > 1 ? '（出力上限を拡大）' : ''}で成功しました`);
    return value;
  } catch (err) {
    if (isTruncationError(err)) {
      factor *= 2; // 拡大しても切れた場合は昇格でさらに広げる
    } else if (!isRetryableLlmError(err)) {
      recordHealEvent('warn', `${label}: 再試行でも恒久的なエラーのため昇格しません`, maskPii(String(err)).slice(0, 120));
      return null;
    }
  }

  // 上位モデルは adaptive thinking の思考トークンも出力上限に数えるため、打ち切りでなくても上限を2倍にする
  const escalate: HealAttempt = { model: matchModel(), maxTokensFactor: Math.max(2, factor), sdkRetries: 0 };
  if (!withinBudget(label, '昇格', escalate, estimate)) return null;

  await sleep(5000);
  try {
    const value = await inHealScope(() => attempt(escalate));
    recordStat('healedEscalation');
    recordHealEvent('info', `${label}: 上位モデルへの昇格で成功しました`);
    return value;
  } catch (err) {
    recordHealEvent('warn', `${label}: 昇格でも失敗しました`, maskPii(String(err)).slice(0, 120));
    return null;
  }
}
