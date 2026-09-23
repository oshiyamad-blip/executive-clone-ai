import { GoogleGenAI, type GenerateContentResponse } from '@google/genai';
import type { LlmMessage, GenOptions } from './index.js';
import type { PdfDocument } from './anthropic.js';
import { recordLlmUsage } from './usage.js';
import { LlmOutputError } from './errors.js';

// Gemini バックエンド。
// - 無料/低コスト枠: Google AI Studio の APIキー（GEMINI_API_KEY）
// - 企業/セキュア: Vertex AI（GOOGLE_GENAI_USE_VERTEXAI=true + GCPプロジェクト）
//   ※ Vertex なら極秘データが自社GCP内に留まり、GWS/Google環境と親和的。
// 既定モデルはバックエンドごとに分ける。AI Studio は `-latest` エイリアスが使えるが、
// Vertex AI はエイリアスを解決できず 404 になる報告があるため、版付きのGAモデルに倒す。
// GEMINI_MODEL が指定されていれば常にそちらが優先。
const IS_VERTEX = process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true';
const MODEL = process.env.GEMINI_MODEL?.trim() || (IS_VERTEX ? 'gemini-2.5-flash' : 'gemini-flash-latest');

function client(): GoogleGenAI {
  if (IS_VERTEX) {
    return new GoogleGenAI({
      vertexai: true,
      project: process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1',
    });
  }
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

// 呼び出し側はモデル設定（extractModel/matchModel 等）として Claude のモデルIDを渡してくる。
// それをそのまま Gemini に送ると 404 になるため、Gemini のモデル名以外は既定モデルに置き換える
function resolveModel(requested: string | undefined): string {
  return requested && requested.startsWith('gemini') ? requested : MODEL;
}

function recordUsage(model: string, response: GenerateContentResponse): void {
  const u = response.usageMetadata;
  recordLlmUsage(model, u?.promptTokenCount ?? 0, (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0));
}

// 打ち切り・安全フィルタによる停止を型付きエラーにする（strict時のテキスト、およびJSONは常に）
function checkFinish(response: GenerateContentResponse, model: string): void {
  const reason = String(response.candidates?.[0]?.finishReason ?? '');
  if (reason === 'MAX_TOKENS') throw new LlmOutputError('max_tokens', model);
  if (reason.includes('SAFETY') || reason === 'PROHIBITED_CONTENT' || reason === 'BLOCKLIST') {
    throw new LlmOutputError('refusal', model);
  }
}

export async function geminiText(
  system: string,
  messages: LlmMessage[],
  maxTokens: number,
  opts: GenOptions = {},
): Promise<string> {
  const ai = client();
  const model = resolveModel(opts.model);
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const response = await ai.models.generateContent({
    model,
    contents,
    config: { systemInstruction: system, maxOutputTokens: maxTokens },
  });
  recordUsage(model, response);
  const answer = response.text ?? '';
  if (opts.strict) {
    checkFinish(response, model);
    if (!answer.trim()) throw new LlmOutputError('empty', model);
    return answer;
  }
  return answer.trim() ? answer : '（うまく回答を生成できませんでした。もう一度お試しください。）';
}

export async function geminiJson(
  system: string,
  user: string,
  schema: object,
  maxTokens: number,
  opts: GenOptions = {},
  documents: PdfDocument[] = [],
): Promise<unknown> {
  const ai = client();
  const model = resolveModel(opts.model);
  // Gemini の responseSchema は JSON Schema と細部が異なるため、スキーマはプロンプトに
  // 埋め込み、responseMimeType=application/json で確実にJSONを得てパースする（プロバイダ非依存）。
  const prompt = `${user}\n\n次のJSON Schemaに厳密に従い、JSONのみを出力してください（前後の説明文やコードフェンスは不要）:\n${JSON.stringify(schema)}`;
  // PDFは inlineData として同じリクエストに載せる（Gemini運用でPDFだけ別プロバイダへ送らないため）
  const parts = [
    ...documents.map((d) => ({ inlineData: { mimeType: d.mediaType, data: d.dataBase64 } })),
    { text: prompt },
  ];
  const response = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts }],
    config: { systemInstruction: system, maxOutputTokens: maxTokens, responseMimeType: 'application/json' },
  });
  recordUsage(model, response);
  checkFinish(response, model);
  const text = response.text ?? '';
  if (!text.trim()) throw new LlmOutputError('empty', model);
  return parseJsonLoose(text);
}

// 無料枠モデルが ```json フェンスや前後の説明文を付けることがあるため、頑健にJSONを取り出す。
function parseJsonLoose(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.search(/[[{]/);
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}
