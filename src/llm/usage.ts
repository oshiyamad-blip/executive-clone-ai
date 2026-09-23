// LLM使用量の記録（コスト概算・自動修復の予算制御用。プロバイダ共通）。
// 呼び出しごとの usage をプロセス内に蓄積する。llm/pricing.ts が円換算に使う。
export interface LlmUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

const usageLog: LlmUsage[] = [];

export function getLlmUsageLog(): readonly LlmUsage[] {
  return usageLog;
}

export function recordLlmUsage(model: string, inputTokens: number, outputTokens: number): void {
  usageLog.push({
    model,
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
  });
}
