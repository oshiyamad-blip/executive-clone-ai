// HTMLだけのメール本文をテキストにする（text/plain の無いメール用）。
// mailparser の html-to-text は入力の大きさに対して処理時間が線形より速く伸び、数MBのHTML1通で収集が
// 数分〜十数分止まるため使わない。ここでは入力を先に切り詰め、タグを1回の走査で読み飛ばす（入れ子の深さ・閉じ忘れに
// よらず線形）。コメント・script/style・非表示の要素（hidden / display:none 等）の中身は捨て、文字参照を戻す
// （Gmail・Xserver のどちらの経路でも、指示の検知と抽出のAIに同じテキストを渡すため）

// 変換するHTMLの上限（文字）。抽出に使う本文はこれより短い（extract.ts MAX_BODY_CHARS）
export const HTML_TO_TEXT_MAX_INPUT = 1_000_000;

const SKIP_CONTENT = new Set(['script', 'style', 'head', 'title', 'template', 'svg', 'math', 'object', 'iframe']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const BLOCK = new Set([
  'p', 'div', 'tr', 'li', 'ul', 'ol', 'table', 'tbody', 'thead', 'tfoot', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'pre', 'section', 'article', 'header', 'footer', 'dl', 'dt', 'dd', 'center', 'form', 'fieldset',
]);
const CELL = new Set(['td', 'th']);
const HIDDEN_STYLE = /(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?![.\d]*[1-9])|opacity\s*:\s*0(?![.\d]*[1-9])|max-height\s*:\s*0(?![.\d]*[1-9])|mso-hide\s*:\s*all)/i;

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ensp: ' ', emsp: ' ', thinsp: ' ', copy: '©', reg: '®',
  yen: '¥', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', times: '×',
  shy: '', zwj: '', zwnj: '',
};

// 数値・名前の文字参照を文字に戻す（知らない名前はそのまま）。指示の検知（injection.ts）でも使う
export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{1,15});?/g, (m, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
      return String.fromCodePoint(code);
    }
    const named = NAMED[ref.toLowerCase()];
    return named ?? m;
  });
}

function tagNameOf(inner: string): { name: string; closing: boolean; selfClosing: boolean } {
  const m = inner.match(/^\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9:-]{0,40})/);
  if (!m) return { name: '', closing: false, selfClosing: false };
  return { name: m[2].toLowerCase(), closing: m[1] === '/', selfClosing: /\/\s*$/.test(inner) };
}

function isHiddenTag(inner: string): boolean {
  // 属性だけを見る（1つのタグの中身は短いのが普通だが、極端に長いタグで時間をかけないよう先頭だけ）
  const attrs = inner.slice(0, 4000);
  if (/(?:^|\s)hidden(?:\s|=|\/|$)/i.test(attrs) || /aria-hidden\s*=\s*["']?true/i.test(attrs)) return true;
  const style = attrs.match(/style\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i)?.[1] ?? '';
  return style !== '' && HIDDEN_STYLE.test(decodeHtmlEntities(style));
}

export function htmlToPlainText(html: string, maxInput = HTML_TO_TEXT_MAX_INPUT): string {
  const s = html.length > maxInput ? html.slice(0, maxInput) : html;
  const lower = s.toLowerCase();
  const out: string[] = [];
  // 開いている要素（名前・非表示/中身を捨てる要素か）。閉じタグは同じ名前が開いているときだけ、そこまでを閉じる
  const stack: Array<{ name: string; hides: boolean }> = [];
  const openCount = new Map<string, number>();
  let hiddenDepth = 0;
  let i = 0;
  const emit = (text: string) => {
    if (hiddenDepth === 0 && text) out.push(text);
  };
  const push = (name: string, hides: boolean) => {
    stack.push({ name, hides });
    openCount.set(name, (openCount.get(name) ?? 0) + 1);
    if (hides) hiddenDepth += 1;
  };
  const pop = () => {
    const top = stack.pop();
    if (!top) return;
    openCount.set(top.name, (openCount.get(top.name) ?? 1) - 1);
    if (top.hides) hiddenDepth -= 1;
  };
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) {
      emit(s.slice(i));
      break;
    }
    if (lt > i) emit(s.slice(i, lt));
    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4);
      i = end < 0 ? s.length : end + 3;
      continue;
    }
    const gt = s.indexOf('>', lt + 1);
    if (gt < 0) break; // 閉じない '<' 以降はタグの途中として捨てる
    const inner = s.slice(lt + 1, gt);
    i = gt + 1;
    if (inner.startsWith('!') || inner.startsWith('?')) continue; // DOCTYPE・CDATA・処理命令
    const { name, closing, selfClosing } = tagNameOf(inner);
    if (!name) {
      emit('<'); // タグではない '<'（「単価<80万」等）は文字として残し、続きを読む
      i = lt + 1;
      continue;
    }
    if (closing) {
      if ((openCount.get(name) ?? 0) > 0) {
        while (stack.length > 0 && stack[stack.length - 1].name !== name) pop();
        pop();
      }
      if (BLOCK.has(name)) emit('\n');
      else if (CELL.has(name)) emit('\t');
      continue;
    }
    if (name === 'br') emit('\n');
    if (BLOCK.has(name)) emit('\n');
    if (SKIP_CONTENT.has(name) && !selfClosing) {
      // 中身を捨てる要素は、対応する閉じタグまで読み飛ばす（中のタグは数えない）
      const close = lower.indexOf(`</${name}`, i);
      i = close < 0 ? s.length : close;
      continue;
    }
    if (VOID.has(name) || selfClosing) continue;
    push(name, isHiddenTag(inner));
  }
  // 行ごとに末尾の空白を落とし、空行の連続を1つにする（正規表現の後戻りで長い空白の並びに時間をかけない）
  const lines: string[] = [];
  let blank = 0;
  for (const line of decodeHtmlEntities(out.join('')).replace(/\u00a0/g, ' ').split('\n')) {
    const t = line.trimEnd();
    blank = t === '' ? blank + 1 : 0;
    if (blank <= 1) lines.push(t);
  }
  return lines.join('\n').trim();
}

// text/plain が「表示されない方はこちら」だけ・件名だけの1行など中身の無い代替本文（スタブ）か。
// 日次の一覧配信に多く、そのまま使うと抽出が空振りし、毎日同じ本文になって再送と誤判定される
const STUB_PATTERN = /うまく表示されない|正しく表示されない|表示されない(方|場合)|ブラウザで(表示|見る|ご覧)|HTML(形式|メール)で(ご覧|表示)|view (it |this (e-?mail|message) )?in (your |a )?browser/i;

// 本文に使うテキストを選ぶ（Gmail・Xserver の両経路で同じ規則にし、再送判定の指紋も揃える）。
// text/plain が無い・スタブ・HTMLのテキストの1/3未満の長さなら、HTMLをテキストにしたものを使う
export function chooseMailBody(plain: string | undefined | null, html: string | undefined | null): string {
  const p = (plain ?? '').trim();
  if (!html) return plain ?? '';
  const h = htmlToPlainText(html).trim();
  if (!p) return h;
  if (h.length > 0 && (STUB_PATTERN.test(p.slice(0, 2000)) || p.length * 3 < h.length)) return h;
  return plain ?? '';
}

// HTMLのリンク先（href）にある Google スプレッドシートのURL（表示テキストと違うことがあるため、リンク先を優先して拾う）
export function sheetLinksInHtml(html: string | undefined | null): string[] {
  if (!html) return [];
  const s = decodeHtmlEntities(html.slice(0, HTML_TO_TEXT_MAX_INPUT));
  const m = s.match(/https:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]+[^\s"'<>]*/g);
  return m ? [...new Set(m)] : [];
}
