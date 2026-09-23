// メールに埋め込まれた「AIへの指示」（プロンプトインジェクション）の検知。抽出のAIが立てる印（injectionSuspected）に加え、
// 典型的な言い回しをコードでも拾う（AIが見落としても、自動の下書きに進ませない）。
// 印の付いた案件・要員の組は要確認にし、AI判定・自動の下書きに回さない（人が内容を確かめる）

export const INJECTION_REVIEW_REASON = 'メール内にAIへの指示らしき記載';
export const INJECTION_CAUTION = 'メール本文にAIへの指示らしき記載があるため、AI判定と自動の下書きを行いません（内容を人が確認してください）';

// 通常の営業メールには現れない、AI・システムに向けた命令の言い回しだけを拾う（生成AI案件の説明文
// 「生成AIへの移行」「プロンプト設計」「PDFとして出力すること」等は拾わない）。
// 日本語の言い回しは空白・ゼロ幅文字を除いた本文で照合する（「以前の指示を 無視」「無\u200B視」ですり抜けさせない）
const JA_PATTERNS: RegExp[] = [
  /(?:以前|前|上記|これまで|先ほど|今まで|上)の(?:指示|命令|ルール|設定|プロンプト)(?:は|を|も)(?:すべて|全て|全部)?(?:無視|忘れ|破棄)/,
  /(?:指示|命令|ルール|プロンプト)(?:は|を|も)(?:すべて|全て|全部)?(?:無視|忘れ)(?:して|せよ|しろ|すること|しなさい)/,
  /(?:システム)?プロンプト(?:は|を|も)(?:無視|忘れ|上書き|破棄|変更|表示|出力)/,
  /(?:AI|LLM|ChatGPT|GPT|Claude|Gemini|アシスタント|人工知能)(?:への|に対する|に向けた)(?:指示|命令)/i,
  /(?:AI|LLM|ChatGPT|GPT|Claude|Gemini|アシスタント|人工知能)(?:は|が)(?:次|以下)の(?:指示|命令)に従/i,
  /(?:抽出|出力|採点|判定)(?:せよ|しろ)(?:[。.!！」]|$)/,
  /(?:スコア|点数|score)(?:は|を)\d{2,3}点?(?:に|と|で)(?:せよ|しろ|して|すること|出力|回答|答え|採点|判定|評価)/i,
  /injectionSuspected/i,
];
const EN_PATTERNS: RegExp[] = [
  /ignore\s+(?:all\s+|any\s+|the\s+|everything\s+)?(?:previous|prior|above|earlier|preceding)\b/i,
  /disregard\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|preceding)\b/i,
  /(?:ignore|reveal|override|forget|print|show)\s+(?:the\s+|your\s+)?system\s*prompt/i,
  /(?:set|give|output|assign)\s+(?:the\s+)?score\s+(?:to|of|as)\s+\d{2,3}/i,
  /you\s+are\s+(?:now\s+)?(?:an?\s+)?(?:ai|assistant|language\s+model|chatbot)\b/i,
  /<\/?\s*(?:untrusted_mail|case_data|reference_feedback)\s*>/i,
];

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;

export function looksLikeInjection(text: string): boolean {
  const spaced = text.normalize('NFKC').replace(ZERO_WIDTH, '');
  const compact = spaced.replace(/\s+/g, '');
  return JA_PATTERNS.some((p) => p.test(compact)) || EN_PATTERNS.some((p) => p.test(spaced));
}
