// LLM使用量の記録（コスト概算・自動修復の予算制御用。プロバイダ共通）。
// 呼び出しごとの usage をプロセス内に蓄積する。llm/pricing.ts が円換算に使う。
// Anthropic の input_tokens はキャッシュを使わなかった入力だけを数え、キャッシュへの書き込み・読み込みの分は
// 別に返る（入力の合計 = input + cacheCreation + cacheRead）。1時間キャッシュへの書き込みは書き込みの内数で持つ
export interface LlmUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number; // キャッシュへの書き込み（5分・1時間の合計）
  cacheCreation1hInputTokens?: number; // うち1時間キャッシュへの書き込み
  cacheReadInputTokens?: number; // キャッシュからの読み込み
}

export interface CacheUsage {
  creation?: number | null;
  creation1h?: number | null;
  read?: number | null;
}

const usageLog: LlmUsage[] = [];

export function getLlmUsageLog(): readonly LlmUsage[] {
  return usageLog;
}

function tokens(n: number | null | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

export function recordLlmUsage(model: string, inputTokens: number, outputTokens: number, cache: CacheUsage = {}): void {
  const creation = tokens(cache.creation);
  const read = tokens(cache.read);
  usageLog.push({
    model,
    inputTokens: tokens(inputTokens),
    outputTokens: tokens(outputTokens),
    ...(creation > 0
      ? { cacheCreationInputTokens: creation, cacheCreation1hInputTokens: Math.min(creation, tokens(cache.creation1h)) }
      : {}),
    ...(read > 0 ? { cacheReadInputTokens: read } : {}),
  });
}
