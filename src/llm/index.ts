import { anthropicText, anthropicJson } from './anthropic.js';
import { geminiText, geminiJson } from './gemini.js';

// LLMプロバイダの抽象化。LLM_PROVIDER=anthropic（既定）| gemini で切替。
// これにより「APIを増やさず既存のGoogle/GWS環境（Gemini）で動かす」等が可能。

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface GenOptions {
  maxTokens?: number;
}

function provider(): string {
  return (process.env.LLM_PROVIDER ?? 'anthropic').toLowerCase();
}

// テキスト生成（対話・即断・ブリーフィング・ダイジェスト）
export async function generateText(
  system: string,
  messages: LlmMessage[],
  opts: GenOptions = {},
): Promise<string> {
  const maxTokens = opts.maxTokens ?? 8192;
  return provider() === 'gemini'
    ? geminiText(system, messages, maxTokens)
    : anthropicText(system, messages, maxTokens);
}

// 構造化JSON生成（シグナル抽出・ストーリー構築）。schema は JSON Schema。
export async function generateJson<T = unknown>(
  system: string,
  user: string,
  schema: object,
  opts: GenOptions = {},
): Promise<T> {
  const maxTokens = opts.maxTokens ?? 16000;
  return provider() === 'gemini'
    ? (geminiJson(system, user, schema, maxTokens) as Promise<T>)
    : (anthropicJson(system, user, schema, maxTokens) as Promise<T>);
}
