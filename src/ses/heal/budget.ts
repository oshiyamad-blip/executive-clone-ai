// 自動修復のコスト予算メーター（円）。
// llm/anthropic.ts が記録する実測トークンを llm/pricing.ts で円換算し、
// 「修復のために追加で使った分」だけを inHealScope() の前後差分で計上する。
// 前提: SESバッチのLLM呼び出しは逐次実行（並行呼び出しがあると差分帰属が崩れる）。
import { totalLlmCostJpy } from '../../llm/pricing.js';
import { healBudgetJpy } from '../config.js';

let batchStartCostJpy = 0;
let healSpent = 0;

// バッチ冒頭で呼ぶ（コスト集計と修復消費をリセット）
export function startHealBatch(): void {
  batchStartCostJpy = totalLlmCostJpy();
  healSpent = 0;
}

// このバッチで使ったLLMコスト概算（修復以外も含む全体）
export function batchCostJpy(): number {
  return totalLlmCostJpy() - batchStartCostJpy;
}

export function healSpentJpy(): number {
  return healSpent;
}

export function healRemainingJpy(): number {
  return Math.max(0, healBudgetJpy() - healSpent);
}

// この区間のLLM消費を「修復分」として計上する
export async function inHealScope<T>(fn: () => Promise<T>): Promise<T> {
  const before = totalLlmCostJpy();
  try {
    return await fn();
  } finally {
    healSpent += totalLlmCostJpy() - before;
  }
}
