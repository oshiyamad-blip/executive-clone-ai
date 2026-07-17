import { anthropicText, anthropicJson, anthropicJsonFromPdf } from './anthropic.js';
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

// PDFを直接読解させて構造化JSONを生成する（請求書・勤表の抽出用）。Anthropicのみ対応。
export async function generateJsonFromPdf<T = unknown>(
  system: string,
  user: string,
  pdf: Buffer,
  schema: object,
  opts: GenOptions = {},
): Promise<T> {
  if (provider() === 'gemini') {
    throw new Error('PDF入力は LLM_PROVIDER=anthropic のみ対応です');
  }
  const maxTokens = opts.maxTokens ?? 16000;
  return anthropicJsonFromPdf(system, user, pdf.toString('base64'), schema, maxTokens) as Promise<T>;
}
