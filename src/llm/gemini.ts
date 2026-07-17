import { GoogleGenAI } from '@google/genai';
import type { LlmMessage } from './index.js';

// Gemini バックエンド。
// - 無料/低コスト枠: Google AI Studio の APIキー（GEMINI_API_KEY）
// - 企業/セキュア: Vertex AI（GOOGLE_GENAI_USE_VERTEXAI=true + GCPプロジェクト）
//   ※ Vertex なら極秘データが自社GCP内に留まり、GWS/Google環境と親和的。
const MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

function client(): GoogleGenAI {
  if (process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true') {
    return new GoogleGenAI({
      vertexai: true,
      project: process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1',
    });
  }
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

export async function geminiText(
  system: string,
  messages: LlmMessage[],
  maxTokens: number,
): Promise<string> {
  const ai = client();
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const response = await ai.models.generateContent({
    model: MODEL,
    contents,
    config: { systemInstruction: system, maxOutputTokens: maxTokens },
  });
  const answer = response.text ?? '';
  return answer.trim() ? answer : '（うまく回答を生成できませんでした。もう一度お試しください。）';
}

export async function geminiJson(
  system: string,
  user: string,
  schema: object,
  maxTokens: number,
): Promise<unknown> {
  const ai = client();
  // Gemini の responseSchema は JSON Schema と細部が異なるため、スキーマはプロンプトに
  // 埋め込み、responseMimeType=application/json で確実にJSONを得てパースする（プロバイダ非依存）。
  const prompt = `${user}\n\n次のJSON Schemaに厳密に従い、JSONのみを出力してください（前後の説明文やコードフェンスは不要）:\n${JSON.stringify(schema)}`;
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { systemInstruction: system, maxOutputTokens: maxTokens, responseMimeType: 'application/json' },
  });
  return parseJsonLoose(response.text ?? '');
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
