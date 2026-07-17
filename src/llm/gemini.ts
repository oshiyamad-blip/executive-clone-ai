import { GoogleGenAI } from '@google/genai';
import type { LlmMessage } from './index.js';

// Gemini バックエンド。
// - 無料/低コスト枠: Google AI Studio の APIキー（GEMINI_API_KEY）
// - 企業/セキュア: Vertex AI（GOOGLE_GENAI_USE_VERTEXAI=true + GCPプロジェクト）
//   ※ Vertex なら極秘データが自社GCP内に留まり、GWS/Google環境と親和的。
// 既定モデルはバックエンドごとに分ける。AI Studio は `-latest` エイリアスが使えるが、
// Vertex AI はエイリアスを解決できず 404 になる報告があるため、版付きのGAモデルに倒す。
// GEMINI_MODEL が指定されていれば常にそちらが優先。
const IS_VERTEX = process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true';
const MODEL = process.env.GEMINI_MODEL ?? (IS_VERTEX ? 'gemini-2.5-flash' : 'gemini-flash-latest');

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
  // responseJsonSchema（標準JSON Schemaによる制約付きデコード）で出力の妥当性を担保する
  // （Gemini 2.5系以降。それ以前のモデルを GEMINI_MODEL に指定すると非対応エラーになり得る）。
  // それでも稀に不正なJSONが返るため、パース失敗時は1回だけ再試行する。
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: user }] }],
      config: {
        systemInstruction: system,
        maxOutputTokens: maxTokens,
        responseMimeType: 'application/json',
        responseJsonSchema: schema,
      },
    });
    try {
      return parseJsonLoose(response.text ?? '');
    } catch (err) {
      lastErr = err;
      console.error(`Gemini JSON応答のパースに失敗（試行${attempt}/2）: ${String(err).slice(0, 120)}`);
    }
  }
  throw lastErr;
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
