// LLM使用量（トークン）→ 概算コスト（円）換算。
// 自動修復（src/ses/heal/）の「一定のAPI予算内」制御と、サマリのコスト表示に使う。
// 単価は $/MTok。モデル追加時はここに1行足す（未知モデルは安全側にSonnet相当で見積もる）。
import { getLlmUsageLog, type LlmUsage } from './anthropic.js';

interface UsdPerMTok {
  input: number;
  output: number;
}

const PRICING_USD_PER_MTOK: Array<{ match: string; price: UsdPerMTok }> = [
  { match: 'haiku-4-5', price: { input: 1, output: 5 } },
  { match: 'sonnet-5', price: { input: 3, output: 15 } },
  { match: 'sonnet-4-6', price: { input: 3, output: 15 } },
  { match: 'opus-4-8', price: { input: 5, output: 25 } },
  { match: 'opus-4-7', price: { input: 5, output: 25 } },
  { match: 'opus-4-6', price: { input: 5, output: 25 } },
];

const FALLBACK_PRICE: UsdPerMTok = { input: 3, output: 15 }; // 未知モデルはSonnet相当で概算

function usdPerMTok(model: string): UsdPerMTok {
  const hit = PRICING_USD_PER_MTOK.find((p) => model.includes(p.match));
  return hit ? hit.price : FALLBACK_PRICE;
}

export function jpyPerUsd(): number {
  return Number(process.env.JPY_PER_USD ?? '150');
}

export function usageCostJpy(usage: LlmUsage): number {
  const price = usdPerMTok(usage.model);
  const usd = (usage.inputTokens / 1_000_000) * price.input + (usage.outputTokens / 1_000_000) * price.output;
  return usd * jpyPerUsd();
}

// プロセス開始からの累計LLMコスト概算（円）。自動修復はこの差分で自身の消費を計測する
export function totalLlmCostJpy(): number {
  return getLlmUsageLog().reduce((sum, u) => sum + usageCostJpy(u), 0);
}
