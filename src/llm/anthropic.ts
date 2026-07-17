import Anthropic from '@anthropic-ai/sdk';
import type { LlmMessage } from './index.js';

// Anthropic（Claude）バックエンド。従来どおり adaptive thinking + 構造化出力を使う。
// クライアントは遅延生成（Gemini運用時にAnthropicキーが無くても import で落ちないように）。
let _client: Anthropic | null = null;
function client(): Anthropic {
  return (_client ??= new Anthropic());
}
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8';

export async function anthropicText(
  system: string,
  messages: LlmMessage[],
  maxTokens: number,
): Promise<string> {
  const response = await client().messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    system,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  });
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
): Promise<unknown> {
  const response = await client().messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    system,
    output_config: { format: { type: 'json_schema', schema: schema as Record<string, unknown> } },
    messages: [{ role: 'user', content: user }],
  });
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') throw new Error('空のJSON応答');
  return JSON.parse(textBlock.text);
}
