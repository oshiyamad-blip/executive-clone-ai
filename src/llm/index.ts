import { anthropicText, anthropicJson, anthropicJsonWithDocuments, type PdfDocument } from './anthropic.js';

// Gemini の SDK は LLM_PROVIDER=gemini のときだけ読み込む（使わない SDK のコードを、鍵を持つバッチの中で動かさない）
async function gemini(): Promise<typeof import('./gemini.js')> {
  return import('./gemini.js');
}

export { LlmOutputError, isTruncationError } from './errors.js';
export type { PdfDocument };

// LLMプロバイダの抽象化。LLM_PROVIDER=anthropic（既定）| gemini で切替。
// これにより「APIを増やさず既存のGoogle/GWS環境（Gemini）で動かす」等が可能。

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface GenOptions {
  maxTokens?: number;
  // 未指定なら各プロバイダの既定（env グローバル）。SES等の段階別モデル切替に使う。
  // Gemini運用時に Claude のモデルIDが渡された場合は Gemini の既定モデルに置き換える
  model?: string;
  // テキスト生成で、途中打ち切り・拒否・空応答を例外にする（バッチ用途。対話UIは従来どおり案内文を返す）
  strict?: boolean;
  // SDKの自動再試行回数（呼び出し側が自前で再試行する場合は0にして多重再試行を避ける）
  maxRetries?: number;
  timeoutMs?: number;
  // 推論の深さ（Anthropic の output_config.effort）。対応していないモデル（Haiku 等）と Gemini では無視する
  effort?: LlmEffort;
}

export type LlmEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

function provider(): string {
  return (process.env.LLM_PROVIDER?.trim() || 'anthropic').toLowerCase();
}

// テキスト生成（対話・即断・ブリーフィング・ダイジェスト）
export async function generateText(
  system: string,
  messages: LlmMessage[],
  opts: GenOptions = {},
): Promise<string> {
  const maxTokens = opts.maxTokens ?? 8192;
  return provider() === 'gemini'
    ? (await gemini()).geminiText(system, messages, maxTokens, opts)
    : anthropicText(system, messages, maxTokens, opts);
}

// 構造化JSON生成（シグナル抽出・ストーリー構築）。schema は JSON Schema。
// 出力上限での打ち切り・拒否は LlmOutputError（壊れたJSONを黙って受け取らない）
export async function generateJson<T = unknown>(
  system: string,
  user: string,
  schema: object,
  opts: GenOptions = {},
): Promise<T> {
  const maxTokens = opts.maxTokens ?? 16000;
  return provider() === 'gemini'
    ? ((await gemini()).geminiJson(system, user, schema, maxTokens, opts) as Promise<T>)
    : (anthropicJson(system, user, schema, maxTokens, opts) as Promise<T>);
}

// PDFつきの構造化JSON生成（SESの添付スキルシート等）。プロバイダの切替に従う
export async function generateJsonWithDocuments<T = unknown>(
  system: string,
  user: string,
  schema: object,
  documents: PdfDocument[],
  opts: GenOptions = {},
): Promise<T> {
  const maxTokens = opts.maxTokens ?? 16000;
  if (documents.length === 0) return generateJson<T>(system, user, schema, opts);
  return provider() === 'gemini'
    ? ((await gemini()).geminiJson(system, user, schema, maxTokens, opts, documents) as Promise<T>)
    : (anthropicJsonWithDocuments(system, user, schema, documents, maxTokens, opts) as Promise<T>);
}
