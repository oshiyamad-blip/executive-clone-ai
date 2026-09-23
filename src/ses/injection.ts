// メールに埋め込まれた「AIへの指示」（プロンプトインジェクション）の検知。抽出のAIが立てる印（injectionSuspected）に加え、
// 典型的な言い回しをコードでも拾う（AIが見落としても、自動の下書きに進ませない）。
// 印の付いた案件・要員の組は要確認にし、AI判定・自動の下書きに回さない（人が内容を確かめる）

export const INJECTION_REVIEW_REASON = 'メール内にAIへの指示らしき記載';
export const INJECTION_CAUTION = 'メール本文にAIへの指示らしき記載があるため、AI判定と自動の下書きを行いません（内容を人が確認してください）';

// 通常の営業メールには現れない、AI・システムに向けた命令の言い回しだけを拾う（生成AI案件の説明文
// 「生成AIへの移行」「プロンプト設計」「PDFとして出力すること」等は拾わない）
const PATTERNS: RegExp[] = [
  /(?:以前|前|上記|これまで|先ほど|今まで)の(?:指示|命令|ルール|設定|プロンプト)を(?:無視|忘れ|破棄)/,
  /(?:指示|命令|ルール|プロンプト)を(?:無視|忘れ)(?:して|せよ|しろ)/,
  /ignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)/i,
  /disregard\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above)\s+(?:instructions?|prompts?)/i,
  /(?:AI|LLM|ChatGPT|GPT|Claude|Gemini|アシスタント|人工知能)(?:への|に対する|に向けた)(?:指示|命令)/i,
  /(?:AI|LLM|ChatGPT|GPT|Claude|Gemini|アシスタント|人工知能)(?:は|が)(?:次|以下)の(?:指示|命令)に従/i,
  /(?:抽出|出力|採点|判定)(?:せよ|しろ)(?:[。.!！\s」]|$)/,
  /(?:スコア|点数|score)を\s*\d{2,3}\s*点?(?:に|と)(?:せよ|しろ|して(?:ください)?|すること)/i,
  /you\s+are\s+(?:now\s+)?(?:an?\s+)?(?:ai|assistant|language\s+model|chatbot)\b/i,
  /<\/?\s*(?:untrusted_mail|case_data|reference_feedback)\s*>/i,
];

export function looksLikeInjection(text: string): boolean {
  const s = text.normalize('NFKC');
  return PATTERNS.some((p) => p.test(s));
}
