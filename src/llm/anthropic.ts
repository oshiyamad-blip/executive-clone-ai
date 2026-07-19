import Anthropic from '@anthropic-ai/sdk';
import type { LlmMessage } from './index.js';

// Anthropic（Claude）バックエンド。従来どおり adaptive thinking + 構造化出力を使う。
// クライアントは遅延生成（Gemini運用時にAnthropicキーが無くても import で落ちないように）。
let _client: Anthropic | null = null;
function client(): Anthropic {
  return (_client ??= new Anthropic());
}
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8';

// --- 使用量の記録（コスト概算・自動修復の予算制御用） ---
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

function recordUsage(model: string, usage: { input_tokens: number; output_tokens: number }): void {
  usageLog.push({ model, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens });
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

export async function anthropicText(
  system: string,
  messages: LlmMessage[],
  maxTokens: number,
  model?: string,
): Promise<string> {
  const resolvedModel = model ?? MODEL;
  const response = await client().messages.create({
    model: resolvedModel,
    max_tokens: maxTokens,
    ...(thinkingParam(resolvedModel) ? { thinking: thinkingParam(resolvedModel) } : {}),
    system,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  });
  recordUsage(resolvedModel, response.usage);
  const textBlock = response.content.find((b) => b.type === 'text');
  let answer = textBlock && textBlock.type === 'text' ? textBlock.text : '';
  if (!answer.trim()) {
    answer =
      response.stop_reason === 'max_tokens'
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
  model?: string,
): Promise<unknown> {
  const resolvedModel = model ?? MODEL;
  const response = await client().messages.create({
    model: resolvedModel,
    max_tokens: maxTokens,
    ...(thinkingParam(resolvedModel) ? { thinking: thinkingParam(resolvedModel) } : {}),
    system,
    output_config: { format: { type: 'json_schema', schema: schema as Record<string, unknown> } },
    messages: [{ role: 'user', content: user }],
  });
  recordUsage(resolvedModel, response.usage);
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') throw new Error('空のJSON応答');
  return JSON.parse(textBlock.text);
}

// PDF読解用（documentブロック）。SES案件のスキルシートPDFなどをClaudeに直接読ませる用途。
// 構造化出力(json_schema)と併用し、抽出結果を確実にパースする。
export async function anthropicJsonWithDocuments(
  system: string,
  user: string,
  schema: object,
  documents: Array<{ mediaType: 'application/pdf'; dataBase64: string }>,
  maxTokens: number,
  model?: string,
): Promise<unknown> {
  const content: Array<Anthropic.Messages.DocumentBlockParam | Anthropic.Messages.TextBlockParam> = [
    ...documents.map((d) => ({
      type: 'document' as const,
      source: { type: 'base64' as const, media_type: d.mediaType, data: d.dataBase64 },
    })),
    { type: 'text' as const, text: user },
  ];
  const resolvedModel = model ?? MODEL;
  const response = await client().messages.create({
    model: resolvedModel,
    max_tokens: maxTokens,
    ...(thinkingParam(resolvedModel) ? { thinking: thinkingParam(resolvedModel) } : {}),
    system,
    output_config: { format: { type: 'json_schema', schema: schema as Record<string, unknown> } },
    messages: [{ role: 'user', content }],
  });
  recordUsage(resolvedModel, response.usage);
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') throw new Error('空のJSON応答');
  return JSON.parse(textBlock.text);
}
