// LLM使用量（トークン）→ 概算コスト（円）換算。
// 自動修復（src/ses/heal/）の「一定のAPI予算内」制御と、サマリのコスト表示に使う。
// 単価は $/MTok。モデル追加時はここに1行足す（未知モデルは安全側に高めの単価で見積もる）。
// プロンプトキャッシュは入力単価の倍率で数える（5分キャッシュへの書き込み 1.25倍・1時間 2倍・読み込み 0.1倍）
import { getLlmUsageLog, type LlmUsage } from './usage.js';

interface UsdPerMTok {
  input: number;
  output: number;
}

const PRICING_USD_PER_MTOK: Array<{ match: string; price: UsdPerMTok }> = [
  { match: 'haiku-4-5', price: { input: 1, output: 5 } },
  { match: 'sonnet-5', price: { input: 2, output: 10 } },
  { match: 'sonnet-4-6', price: { input: 3, output: 15 } },
  { match: 'opus-4-8', price: { input: 5, output: 25 } },
  { match: 'opus-4-7', price: { input: 5, output: 25 } },
  { match: 'opus-4-6', price: { input: 5, output: 25 } },
  // Gemini（LLM_PROVIDER=gemini）。Flash系の公開単価に基づく概算
  { match: 'gemini', price: { input: 0.3, output: 2.5 } },
];

const FALLBACK_PRICE: UsdPerMTok = { input: 3, output: 15 }; // 未知モデルは安全側（Sonnet 4.6 相当）で概算

export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2;
export const CACHE_READ_MULTIPLIER = 0.1;

function usdPerMTok(model: string): UsdPerMTok {
  const hit = PRICING_USD_PER_MTOK.find((p) => model.includes(p.match));
  return hit ? hit.price : FALLBACK_PRICE;
}

// 数値でない・0以下の値（例: '160円'）は既定に戻す（NaNで予算判定が素通りにならないように）
export function jpyPerUsd(): number {
  const n = Number((process.env.JPY_PER_USD ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : 160;
}

// 呼び出し前のコスト見積もり（円）。自動修復が「次の1回で予算を超えるか」を判定するのに使う
export function estimateCallJpy(model: string, inputTokens: number, outputTokens: number): number {
  return usageCostJpy({ model, inputTokens, outputTokens });
}

// 1回分の料金（米ドル）。キャッシュの書き込み（1時間の分は内数）と読み込みは入力単価の倍率で数える
export function usageCostUsd(usage: LlmUsage): number {
  const price = usdPerMTok(usage.model);
  const write = usage.cacheCreationInputTokens ?? 0;
  const write1h = Math.min(write, usage.cacheCreation1hInputTokens ?? 0);
  const inputEquivalent =
    usage.inputTokens +
    (write - write1h) * CACHE_WRITE_5M_MULTIPLIER +
    write1h * CACHE_WRITE_1H_MULTIPLIER +
    (usage.cacheReadInputTokens ?? 0) * CACHE_READ_MULTIPLIER;
  return (inputEquivalent / 1_000_000) * price.input + (usage.outputTokens / 1_000_000) * price.output;
}

export function usageCostJpy(usage: LlmUsage): number {
  return usageCostUsd(usage) * jpyPerUsd();
}

// プロセス開始からの累計LLMコスト概算（円）。自動修復はこの差分で自身の消費を計測する
export function totalLlmCostJpy(): number {
  return getLlmUsageLog().reduce((sum, u) => sum + usageCostJpy(u), 0);
}

// 入力のうちキャッシュから読んだ割合（0〜1）。入力が無い・どの呼び出しもキャッシュを使っていない（書き込みも読み込みも0）
// ときは null（プロンプトキャッシュを使っていない構成で「0%」と表示して、キャッシュの劣化と読み違えないように）
export function cacheReadShare(usages: readonly LlmUsage[]): number | null {
  let read = 0;
  let written = 0;
  let total = 0;
  for (const u of usages) {
    const r = u.cacheReadInputTokens ?? 0;
    read += r;
    written += u.cacheCreationInputTokens ?? 0;
    total += u.inputTokens + (u.cacheCreationInputTokens ?? 0) + r;
  }
  return total > 0 && read + written > 0 ? read / total : null;
}
