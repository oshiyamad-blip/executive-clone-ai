import Anthropic from '@anthropic-ai/sdk';
import type { LlmMessage, GenOptions } from './index.js';
import { recordLlmUsage, getLlmUsageLog, type LlmUsage } from './usage.js';
import { LlmOutputError } from './errors.js';

export { getLlmUsageLog, type LlmUsage };

// Anthropic（Claude）バックエンド。従来どおり adaptive thinking + 構造化出力を使う。
// クライアントは遅延生成（Gemini運用時にAnthropicキーが無くても import で落ちないように）。
// SDKの自動再試行は1回に抑える（SESの自動修復が自前で再試行するため、既定の2回と掛け算にならないように）。
// タイムアウトを明示すると、SDKが大きな max_tokens の非ストリーミング呼び出しを事前に拒否する判定も外れる
// （出力上限を増やしての再試行で使う）
let _client: Anthropic | null = null;
function client(): Anthropic {
  return (_client ??= new Anthropic({ maxRetries: 1, timeout: 10 * 60 * 1000 }));
}
const MODEL = process.env.ANTHROPIC_MODEL?.trim() || 'claude-opus-4-8';

function recordUsage(model: string, usage: { input_tokens: number; output_tokens: number }): void {
  recordLlmUsage(model, usage.input_tokens, usage.output_tokens);
}

// adaptive thinking（thinking: {type: 'adaptive'}）は Opus/Sonnet系（4.6以降）でのみ有効で、
// Haiku 4.5 等の旧世代モデルには存在しない設定のため付与すると 400 になりうる。
// SES抽出（extractModel）は既定で claude-haiku-4-5 を使うため、モデル名で分岐する。
function supportsAdaptiveThinking(model: string): boolean {
  return !model.includes('haiku');
}

function thinkingParam(model: string): { type: 'adaptive' } | undefined {
  return supportsAdaptiveThinking(model) ? { type: 'adaptive' } : undefined;
}

// 呼び出し単位のSDKオプション（再試行回数・タイムアウト）
function requestOptions(opts: GenOptions): { maxRetries?: number; timeout?: number } {
  const o: { maxRetries?: number; timeout?: number } = {};
  if (opts.maxRetries !== undefined) o.maxRetries = opts.maxRetries;
  if (opts.timeoutMs !== undefined) o.timeout = opts.timeoutMs;
  return o;
}

// 構造化出力の本文を取り出す。途中打ち切り・拒否は壊れた/空のJSONを黙って受け取らず型付きエラーにする
function jsonText(response: Anthropic.Messages.Message, model: string): string {
  if (response.stop_reason === 'max_tokens') throw new LlmOutputError('max_tokens', model);
  if (response.stop_reason === 'refusal') throw new LlmOutputError('refusal', model);
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text' || !textBlock.text.trim()) throw new LlmOutputError('empty', model);
  return textBlock.text;
}

export async function anthropicText(
  system: string,
  messages: LlmMessage[],
  maxTokens: number,
  opts: GenOptions = {},
): Promise<string> {
  const resolvedModel = opts.model ?? MODEL;
  const response = await client().messages.create(
    {
      model: resolvedModel,
      max_tokens: maxTokens,
      ...(thinkingParam(resolvedModel) ? { thinking: thinkingParam(resolvedModel) } : {}),
      system,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    },
    requestOptions(opts),
  );
  recordUsage(resolvedModel, response.usage);
  const textBlock = response.content.find((b) => b.type === 'text');
  const answer = textBlock && textBlock.type === 'text' ? textBlock.text : '';
  // バッチ用途（strict）では、途中で切れた文面や拒否・空応答を正常な回答として返さない
  if (opts.strict) {
    if (response.stop_reason === 'max_tokens') throw new LlmOutputError('max_tokens', resolvedModel);
    if (response.stop_reason === 'refusal') throw new LlmOutputError('refusal', resolvedModel);
    if (!answer.trim()) throw new LlmOutputError('empty', resolvedModel);
    return answer;
  }
  if (!answer.trim()) {
    return response.stop_reason === 'max_tokens'
      ? '（回答が長くなりすぎて途中で止まりました。質問を分けてお試しください。）'
      : '（うまく回答を生成できませんでした。もう一度お試しください。）';
  }
  return answer;
}

export async function anthropicJson(
  system: string,
  user: string,
  schema: object,
  maxTokens: number,
  opts: GenOptions = {},
): Promise<unknown> {
  const resolvedModel = opts.model ?? MODEL;
  const response = await client().messages.create(
    {
      model: resolvedModel,
      max_tokens: maxTokens,
      ...(thinkingParam(resolvedModel) ? { thinking: thinkingParam(resolvedModel) } : {}),
      system,
      output_config: { format: { type: 'json_schema', schema: schema as Record<string, unknown> } },
      messages: [{ role: 'user', content: user }],
    },
    requestOptions(opts),
  );
  recordUsage(resolvedModel, response.usage);
  return JSON.parse(jsonText(response, resolvedModel));
}

export interface PdfDocument {
  mediaType: 'application/pdf';
  dataBase64: string;
}

// PDF読解用（documentブロック）。SES案件のスキルシートPDFなどをClaudeに直接読ませる用途。
// 構造化出力(json_schema)と併用し、抽出結果を確実にパースする。
export async function anthropicJsonWithDocuments(
  system: string,
  user: string,
  schema: object,
  documents: PdfDocument[],
  maxTokens: number,
  opts: GenOptions = {},
): Promise<unknown> {
  const content: Array<Anthropic.Messages.DocumentBlockParam | Anthropic.Messages.TextBlockParam> = [
    ...documents.map((d) => ({
      type: 'document' as const,
      source: { type: 'base64' as const, media_type: d.mediaType, data: d.dataBase64 },
    })),
    { type: 'text' as const, text: user },
  ];
  const resolvedModel = opts.model ?? MODEL;
  const response = await client().messages.create(
    {
      model: resolvedModel,
      max_tokens: maxTokens,
      ...(thinkingParam(resolvedModel) ? { thinking: thinkingParam(resolvedModel) } : {}),
      system,
      output_config: { format: { type: 'json_schema', schema: schema as Record<string, unknown> } },
      messages: [{ role: 'user', content }],
    },
    requestOptions(opts),
  );
  recordUsage(resolvedModel, response.usage);
  return JSON.parse(jsonText(response, resolvedModel));
}
