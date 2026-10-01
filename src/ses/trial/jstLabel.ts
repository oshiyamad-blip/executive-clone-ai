// シートの「受信日時」表記（日本時間）を epoch ミリ秒にする。読めなければ NaN。
// Sheets が日時と解釈して読み戻すと時が1桁（2026/10/01 8:27）になるため、桁数の揺れを受け付ける。
export function parseJstLabel(s: string): number {
  const m = /^\s*(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(s);
  if (!m) return NaN;
  const p = (v: string | undefined) => String(v ?? '0').padStart(2, '0');
  return Date.parse(`${m[1]}-${p(m[2])}-${p(m[3])}T${p(m[4])}:${m[5]}:${p(m[6])}+09:00`);
}
