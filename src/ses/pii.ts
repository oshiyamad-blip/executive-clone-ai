// 個人情報の最小化（共通）。
// - maskPii: 診断ログ・隔離リスト・修正パッチ案の入力に載せる前に、メールアドレス・電話番号・氏名らしき並びを伏せる
// - toInitials: 抽出した要員の表示名をイニシャル（「K.S.」の形）だけにする。フルネームは保存・判定・文面に流さない
//   （IDはメール由来のハッシュのままで、表示名を結合のキーにしない）

// ===== maskPii =====

const NAME_MASK = '<氏名>';

// 氏名の欄の見出し（「氏名: 山田太郎」「名前：Taro Suzuki」）
const NAME_LABEL = /(氏名|お名前|名前|本名|フルネーム|要員名|技術者名|ご担当者|担当者|担当)(\s*[:：]\s*)([^\n\r]*)/g;
// 「氏名 山田太郎」のように区切りが空白だけの欄（氏名のみ。「担当 開発」等の業務の語を伏せないため）
const NAME_LABEL_SPACED = /(氏名)([ \u3000]+)(?![:：])([^\n\r]*)/g;

// 欄の値の終わり（区切り記号・次の「見出し:」・2つ以上の空白）。括弧の中の読み仮名も氏名として伏せるため括弧では切らない
const VALUE_END = /[／/|,，、;；]|\s{2,}|\s+[^\s:：]{1,8}\s*[:：]/;

const KANJI = '[\\u4E00-\\u9FFF\\u3005\\u3006\\u30F6]';

// 敬称の直前の漢字（「田中太郎様」「佐々木健太様」「鈴木さん」「田中 太郎 様」「営業部山田様」）。前に漢字が続く語の一部は拾わない
const HONORIFIC_NAME = new RegExp(
  `(?<!${KANJI})(${KANJI}{1,3}[ \\u3000]${KANJI}{1,3}|${KANJI}{2,8})(?=\\s?(?:様|さま|さん|氏|殿|君))`,
  'g',
);

// 件名の「【要員】山田太郎 30歳」「[人材]佐藤」: 見出しの直後の漢字の並び
const LISTING_NAME = new RegExp(`([【\\[](?:要員|人材|技術者|エンジニア)(?:情報|紹介|のご紹介)?[】\\]]\\s*)(${KANJI}{2,5})(?!${KANJI})`, 'g');

// 組織・役割の語の末尾（「営業部山田様」の「部」）。この後ろの2〜4文字だけを氏名とみなす
const ORG_TAIL = /^(.*[部課社室局店所会係班])(.{2,4})$/;

// 敬称が付いても人名ではない語（役割・組織・取引上の立場・呼びかけ）
const NOT_A_NAME =
  /担当|営業|採用|人事|総務|経理|窓口|各位|御中|関係|代表|責任|管理|取締|社長|部長|課長|係長|主任|室長|本部|支店|事業|本人|個人|法人|新人|顧客|貴社|御社|弊社|当社|皆|諸|先方|同氏|両氏|要員|技術|開発|協力|取引|元請|直請|上位|下位|発注|受注|請負|客先|購入|利用/;
const NOT_A_NAME_SUFFIX = /[者社員位客部課係室局庁省店所会団組班陣達等方系]$/;

// イニシャルの形（「K.S.」「K・S」「KS」「K.S.（イニシャル）」）。社外に出してよい表記のため伏せない
const INITIALS_ONLY = /^[A-Z](?:\s?[.・･]?\s?[A-Z]){1,2}\.?(?:\s*[(（]イニシャル[)）])?$/i;

function maskNameValue(value: string): string {
  const end = value.search(VALUE_END);
  const head = end >= 0 ? value.slice(0, end) : value;
  const name = head.trim();
  if (!name || INITIALS_ONLY.test(name) || name.startsWith('<')) return value;
  return value.replace(name, NAME_MASK);
}

function nameLike(s: string): boolean {
  return !NOT_A_NAME.test(s) && !NOT_A_NAME_SUFFIX.test(s);
}

function maskHonorificName(match: string): string {
  const parts = match.split(/[ 　]/);
  if (parts.length === 2) {
    if (nameLike(parts.join(''))) return NAME_MASK;
    // 「営業部 山田様」: 前の語は組織・役割で、後ろの語だけが名前
    return parts[1].length >= 2 && nameLike(parts[1]) ? `${parts[0]} ${NAME_MASK}` : match;
  }
  // 「営業部山田様」「株式会社田中様」: 組織の語の後ろの2〜4文字だけが名前（4文字以下は「会田」等の名前の一部とみなす）
  const org = match.length > 4 ? match.match(ORG_TAIL) : null;
  if (org) return nameLike(org[2]) ? `${org[1]}${NAME_MASK}` : match;
  return match.length <= 6 && nameLike(match) ? NAME_MASK : match;
}

// メールアドレス・電話番号・氏名らしき並びをマスクする（診断ログ・repairプロンプトに載せる前に必ず通す）。
// 全角（０９０−…）・括弧（03(1234)5678）・区切りなし（09012345678）・+81 表記も拾えるよう先に NFKC で正規化する。
// 氏名は「氏名: 」等の欄の値と、敬称（様・さん・氏・殿）の直前の漢字2〜4文字だけを伏せる（スキル名・業務の語を伏せすぎない）
export function maskPii(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '<メールアドレス>')
    .replace(/(?<![\d])(?:\+81[\s-]?\(?0?\)?|0)\d{1,4}[\s-]*\(?[\s-]*\d{1,4}[\s-]*\)?[\s-]*\d{3,4}(?![\d])/g, '<電話番号>')
    .replace(/(?<![\d])0\d{9,10}(?![\d])/g, '<電話番号>')
    .replace(NAME_LABEL, (_m, label: string, sep: string, value: string) => `${label}${sep}${maskNameValue(value)}`)
    .replace(NAME_LABEL_SPACED, (_m, label: string, sep: string, value: string) => `${label}${sep}${maskNameValue(value)}`)
    .replace(LISTING_NAME, (m, head: string, name: string) => (nameLike(name) ? `${head}${NAME_MASK}` : m))
    .replace(HONORIFIC_NAME, maskHonorificName);
}

// ===== toInitials =====

// イニシャルを決められなかった要員の表示名（文面では差し込みの表記に置き換える）
export const UNKNOWN_INITIALS = '（イニシャル不明）';

// 表示名としてイニシャルが決まっているか（名寄せ・文面の宛名に使ってよいか）
export function hasKnownInitials(displayName: string): boolean {
  const s = displayName.trim();
  return s !== '' && s !== UNKNOWN_INITIALS;
}

// かなの頭文字 → ローマ字（ヘボン式の1文字目）
const KANA_INITIAL: Array<[string, string]> = [
  ['アイウエオ', ''],
  ['カキクケコ', 'K'],
  ['ガギグゲゴ', 'G'],
  ['サスセソ', 'S'],
  ['シ', 'S'],
  ['ザズゼゾ', 'Z'],
  ['ジヂ', 'J'],
  ['タテト', 'T'],
  ['チ', 'C'],
  ['ツ', 'T'],
  ['ダデド', 'D'],
  ['ヅ', 'Z'],
  ['ナニヌネノ', 'N'],
  ['ハヒヘホ', 'H'],
  ['フ', 'F'],
  ['バビブベボ', 'B'],
  ['パピプペポ', 'P'],
  ['マミムメモ', 'M'],
  ['ヤユヨ', 'Y'],
  ['ラリルレロ', 'R'],
  ['ワ', 'W'],
  ['ヲ', 'O'],
  ['ヴ', 'V'],
];

const VOWEL_INITIAL: Record<string, string> = { ア: 'A', イ: 'I', ウ: 'U', エ: 'E', オ: 'O' };

function kanaInitial(ch: string): string | null {
  // ひらがな → カタカナ
  const kata = /[ぁ-ゖ]/.test(ch) ? String.fromCharCode(ch.charCodeAt(0) + 0x60) : ch;
  for (const [chars, letter] of KANA_INITIAL) {
    if (!chars.includes(kata)) continue;
    return letter || VOWEL_INITIAL[kata] || null;
  }
  return null;
}

const HONORIFIC_SUFFIX = /\s*(?:様|さま|さん|氏|殿|君|くん)$/;
const DOTTED_INITIALS = /(?:^|[^A-Za-z])([A-Za-z])\s*[.・･]\s*([A-Za-z])(?:\s*[.・･]\s*([A-Za-z]))?\s*[.・･]?(?![A-Za-z])/;
// 区切りの無い大文字だけの並びは2文字だけをイニシャルとみなす（「KEN」「LEE」のような短い名前を綴りのまま出さない）
const BARE_INITIALS = /^[A-Za-z]{2}$/;
const NAME_PREFIX = /^(?:mr|mrs|ms|miss|mx|dr|prof)\.?\s+/i;
const ROMAJI_NAME = /^[A-Za-z]+(?:[\s,.・･]+[A-Za-z]+){1,2}\.?$/;
const KANA_NAME = /^[ぁ-ゖァ-ヺー]+(?:[\s・･]+[ぁ-ゖァ-ヺー]+){1,2}$/;

function formatInitials(letters: string[]): string {
  return `${letters.map((l) => l.toUpperCase()).join('.')}.`;
}

function initialsFrom(part: string): string | null {
  const s = part.replace(HONORIFIC_SUFFIX, '').trim().replace(NAME_PREFIX, '');
  if (!s) return null;
  const dotted = s.match(DOTTED_INITIALS);
  if (dotted) return formatInitials([dotted[1], dotted[2], dotted[3]].filter((x): x is string => Boolean(x)));
  if (BARE_INITIALS.test(s) && s === s.toUpperCase()) return formatInitials([...s]);
  if (ROMAJI_NAME.test(s)) {
    const words = s.split(/[\s,.・･]+/).filter(Boolean);
    if (words.some((w) => w.length >= 2)) return formatInitials(words.map((w) => w[0]));
  }
  if (KANA_NAME.test(s)) {
    const letters = s.split(/[\s・･]+/).map((w) => kanaInitial(w[0]));
    if (letters.every((l): l is string => l !== null)) return formatInitials(letters);
  }
  return null;
}

// 表示名をイニシャル（「K.S.」の形。2〜3文字）にする。イニシャル・ローマ字の氏名・区切りのある読み仮名から作れるときだけ作り、
// 読みの分からない漢字の氏名などから決められなければ UNKNOWN_INITIALS（フルネームは返さない）。
// 括弧の中（「山田太郎（T.Y.）」「K.S.（イニシャル）」）も手がかりにする
export function toInitials(raw: string): string {
  const s = raw.normalize('NFKC').trim();
  if (!s) return UNKNOWN_INITIALS;
  const inner = [...s.matchAll(/[(（\[【]([^)）\]】]*)[)）\]】]/g)].map((m) => m[1]);
  const outer = s.replace(/[(（\[【][^)）\]】]*[)）\]】]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const part of [outer, ...inner]) {
    const initials = initialsFrom(part);
    if (initials) return initials;
  }
  return UNKNOWN_INITIALS;
}
