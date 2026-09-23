// 開始時期・稼働可能日の日付の解決（受信日基準・決定的・純関数）。extract が参照する。
// 「即日」「10月〜」「11月中旬」のように原文の表記から決まる日付はコードで決め、LLM の年の補完や日付計算に頼らない。
// 表記から決まらないときだけ LLM が返した日付を使い、年の取り違え（受信日より大きく前）を補正する。

const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000; // 日本時間は夏時間がないため固定オフセットで足りる

// 年の記載の無い月日・LLM が返した日付が、受信日のこの日数より前なら翌年とみなす。
// 再送された案件の「8月〜」は受信が9月でも今年の8月（＝既に開始可）で、1年近く先の開始は SES では稀なため
export const PAST_TOLERANCE_DAYS = 60;

// 受信日からこれより先の日付は読み違いとみなす
const FUTURE_LIMIT_DAYS = 730;

// YYYY-MM-DD の実在する日付だけを通す（'2026-10' や '2026/11/01' はDBの日付型で保存に失敗するため null）
export function validIsoDate(s: string | null): string | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}

// 受信日時の日本時間の日付（YYYY-MM-DD）
export function jstDateOf(d: Date): string {
  return new Date(d.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

function dayNumber(iso: string): number {
  return Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
}

function isoOf(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1) return null;
  return validIsoDate(`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
}

function lastDayOf(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// 月の中の位置（上旬=1日・中旬=11日・下旬=21日・末=末日。記載なし・「中」は1日）
function dayOfPart(part: string | undefined, y: number, m: number): number {
  if (!part) return 1;
  if (/中旬/.test(part)) return 11;
  if (/下旬|後半/.test(part)) return 21;
  if (/末/.test(part)) return lastDayOf(y, m);
  return 1;
}

// 年の記載が無い月日を、受信日の PAST_TOLERANCE_DAYS 日前以降で最も早い日付になる年で解決する
// （受信 2026-09-23: 「10月」→2026-10-01、「1月」→2027-01-01、「8月」→2026-08-01）
function withInferredYear(month: number, day: number | 'part', part: string | undefined, receivedIso: string): string | null {
  const receivedYear = Number(receivedIso.slice(0, 4));
  const floor = dayNumber(receivedIso) - PAST_TOLERANCE_DAYS;
  for (const y of [receivedYear - 1, receivedYear, receivedYear + 1]) {
    const d = day === 'part' ? dayOfPart(part, y, month) : day;
    const iso = isoOf(y, month, d);
    if (iso && dayNumber(iso) >= floor) return iso;
  }
  return null;
}

// 受信月から months か月後の月の日付（「来月中旬」等）
function relativeMonth(receivedIso: string, months: number, part: string | undefined): string | null {
  const y0 = Number(receivedIso.slice(0, 4));
  const m0 = Number(receivedIso.slice(5, 7)) - 1 + months;
  const y = y0 + Math.floor(m0 / 12);
  const m = (m0 % 12) + 1;
  return isoOf(y, m, dayOfPart(part, y, m));
}

const PART = '(上旬|初旬|中旬|下旬|月末|末日|末|頭|初め|はじめ|前半|後半|中)?';

interface Rule {
  re: RegExp;
  resolve: (m: RegExpExecArray, receivedIso: string) => string | null;
}

// 表記の規則。原文で最も先に現れた表記を採り（「即日（11月〜も可）」→即日）、同じ位置では長く一致した規則を採る
const RULES: Rule[] = [
  { re: /即日|即稼働|即時|即入場|随時|今すぐ|asap/gi, resolve: (_m, r) => r },
  {
    re: /(20\d{2})[年/.-](\d{1,2})[月/.-](\d{1,2})日?/g,
    resolve: (m) => isoOf(Number(m[1]), Number(m[2]), Number(m[3])),
  },
  {
    re: new RegExp(`(20\\d{2})(?:年|[/.-])(\\d{1,2})月?${PART}`, 'g'),
    resolve: (m) => isoOf(Number(m[1]), Number(m[2]), dayOfPart(m[3], Number(m[1]), Number(m[2]))),
  },
  {
    re: /(\d{1,2})月(\d{1,2})日|(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/g,
    resolve: (m, r) => withInferredYear(Number(m[1] ?? m[3]), Number(m[2] ?? m[4]), undefined, r),
  },
  {
    re: new RegExp(`(?<!\\d)(\\d{1,2})月${PART}`, 'g'),
    resolve: (m, r) => withInferredYear(Number(m[1]), 'part', m[2], r),
  },
  { re: new RegExp(`再来月${PART}`, 'g'), resolve: (m, r) => relativeMonth(r, 2, m[1]) },
  { re: new RegExp(`(?:来月|翌月)${PART}`, 'g'), resolve: (m, r) => relativeMonth(r, 1, m[1]) },
  {
    re: new RegExp(`(?:今月|当月)${PART}`, 'g'),
    resolve: (m, r) => {
      const d = relativeMonth(r, 0, m[1]);
      return d && d > r ? d : r; // 今月の既に過ぎた日は受信日（＝即日）
    },
  },
];

// 開始時期・稼働可能日の原文（「即日」「2026年10月〜」「11月中旬」「来月から」）から日付を決める。決まらなければ null
export function resolveDateText(text: string, receivedAt: Date): string | null {
  const t = (text ?? '').normalize('NFKC').replace(/\s+/g, '');
  if (!t) return null;
  const receivedIso = jstDateOf(receivedAt);
  let best: { index: number; length: number; value: string | null } | null = null;
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (let m = rule.re.exec(t); m; m = rule.re.exec(t)) {
      const better = !best || m.index < best.index || (m.index === best.index && m[0].length > best.length);
      if (better) best = { index: m.index, length: m[0].length, value: rule.resolve(m, receivedIso) };
    }
  }
  return best?.value ?? null;
}

// LLM が返した ISO 日付の補正。受信日の PAST_TOLERANCE_DAYS 日より前なら年の取り違えとみなして1年後ろへずらし、
// それでも前、または受信日から2年より先なら読み違いとして null
export function sanitizeIsoDate(iso: string | null, receivedAt: Date): string | null {
  const valid = validIsoDate(iso);
  if (!valid) return null;
  const received = dayNumber(jstDateOf(receivedAt));
  let date = valid;
  if (dayNumber(date) < received - PAST_TOLERANCE_DAYS) {
    date = isoOf(Number(date.slice(0, 4)) + 1, Number(date.slice(5, 7)), Number(date.slice(8, 10))) ?? '';
    if (!date || dayNumber(date) < received - PAST_TOLERANCE_DAYS) return null;
  }
  return dayNumber(date) > received + FUTURE_LIMIT_DAYS ? null : date;
}

// 開始時期・稼働可能日の日付: 原文の表記から決まればそれを、決まらなければ LLM の日付を補正して使う
export function resolveItemDate(text: string, llmIso: string | null, receivedAt: Date): string | null {
  return resolveDateText(text, receivedAt) ?? sanitizeIsoDate(llmIso, receivedAt);
}
