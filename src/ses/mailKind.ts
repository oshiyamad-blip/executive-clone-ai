// 抽出の前に、メールが要員の紹介か案件の募集かを本文の見出しで見分ける（LLM を使わない）。
// 「案件だけ」モード（SES_TARGET=projects）では要員の紹介メールを抽出しない。平日の受信の半分以上が要員メールで、
// 経歴書の添付も多く、抽出費用の大半を占めるため。要員は要員管理表（プロパー管理）に登録した人だけを使う。
// 年齢・国籍・所属は案件側の参画条件にも書かれるため要員の見出しに数えない。
// 件名は当てにしない（「要員募集」＝案件、「案件情報」なのに中身が要員、の食い違いが実メールで見られた）。
// 迷うメール（両方の見出しがある・どちらも無い）は抽出する側に倒す（案件の取りこぼしを避ける）
import type { SesRawMail } from '../types/index.js';

export type MailKind = 'engineer' | 'project' | 'unknown';

// 行頭の飾り（【】■◆・数字の見出し等）を除いた見出し語。全角空白で字間を空けた「氏　名」も読む
const LEAD = String.raw`^[\s　]*(?:[【\[［■◆◇●○▼▽★☆・\-*]|\d{1,2}[.)）]|[①-⑳])*[\s　]*`;

// 行頭の飾りの記号（LEAD と同じ。数字の見出しは含めない）。◆氏名◆ のように閉じの飾りで終わる見出しは、行頭にも飾りがある行だけ読む
const DECO = String.raw`[【\[［■◆◇●○▼▽★☆・\-*]`;
const CLOSE_DECO = String.raw`[◆◇■□●○★☆▼▽]`;
// 空白だけで値が続く見出し（◆名前 A.B）の行頭の飾り。地の文に出やすい・や - * 数字は含めない
const OPEN_DECO = String.raw`[◆◇■□●○★☆▼▽]`;

function heading(words: string[]): RegExp {
  const spaced = words.map((w) => [...w].join('[\\s　]*')).join('|');
  const word = `(?:${spaced})`;
  const tail = String.raw`[\s　]*[】\]］]?[\s　]*[:：】]`;
  // 括弧で始まる見出しだけ、見出し語の前に短い語＋区切りを1つまで許す（【年齢・性別】【住所／最寄り駅】）。上限つきで入れ子の量指定子は作らない
  const bracketed = String.raw`^[\s　]*(?:${DECO})*[【\[［][\s　]*(?:[^】\]］\n]{1,6}[・／/、][\s　]*)?${word}${tail}`;
  const closedByDeco = String.raw`^[\s　]*(?:${DECO})+[\s　]*${word}[\s　]*${CLOSE_DECO}`;
  // コロンも閉じの飾りも無い「◆名前 A.B」。値が空の「◆名前」だけ・飾りの無い「名前 山田」・中黒の「・稼働 中です」は数えない
  const spacedValue = String.raw`^[\s　]*(?:${OPEN_DECO})+[\s　]*${word}[\s　]+\S`;
  return new RegExp(`${LEAD}${word}${tail}|${bracketed}|${closedByDeco}|${spacedValue}`, 'm');
}

// 所属・稼働・住まい・並行状況は要員の紹介の定型（【氏名】【所属】【稼働】【単金】の並び）。案件にも書かれうるが、
// 案件の見出しが2つ以上あるメールは要員とみなさないため、1行の紛れで案件を取りこぼすことはない
// 要員の見出しは「違う見出し語の数」で数える（同じ語が何行あっても1つ）。案件を並べたメールは各案件に「最寄駅：」が出るため。
// 表記ゆれは同じ語にまとめる（最寄駅・最寄り駅・最寄り・最寄／稼働・稼動／希望単価・希望単金／氏名・名前・要員名・イニシャル／稼働開始日・稼働可能日）
const ENGINEER_GROUPS = [
  { key: 'name', words: ['氏名', '名前', '要員名', 'イニシャル'] },
  { key: 'station', words: ['最寄駅', '最寄り駅', '最寄り', '最寄'] },
  { key: 'home', words: ['住まい', '居住地'] },
  { key: 'affil', words: ['所属'] },
  { key: 'work', words: ['稼働', '稼動'] },
  { key: 'parallel', words: ['並行状況'] },
  { key: 'number', words: ['技術者番号'] },
  { key: 'price', words: ['希望単価', '希望単金'] },
  { key: 'start', words: ['稼働開始日', '稼働可能日'] },
  { key: 'sex', words: ['性別'] },
].map((g) => ({ key: g.key, re: heading(g.words) }));
const PROJECT_HEADINGS = heading(['案件名', '必須スキル', '必須', '尚可スキル', '尚可', '募集人数', '人数', '面談回数', '面談', '精算', '精算幅', '商流', '作業内容', '業務内容', '開発環境', '予算']);

// 見出しの無い要員紹介の名乗りの行（「☆A.B（25歳…」）。イニシャルと年齢を兼ねるので要員の見出し2語と数える。
// 3文字以上の英字（ABC）や行の途中の「担当はA.B（25歳）です」は当てない
const INITIAL_AGE = new RegExp(String.raw`^\s*(?:${DECO})*\s*[A-Z]\.?\s*[A-Z]\.?\s*[(]\s*\d{2}\s*歳`);

// 本文の各行（長い行は見出しの始まりで区切った片）の先頭80文字を onHead に渡す。引用行は渡さない
function eachHead(body: string, onHead: (head: string) => void): void {
  for (const line of body.normalize('NFKC').split(/\r?\n/)) {
    // 改行が潰れて1行に見出しが並ぶメールがある。長い行だけ見出しの始まりの前で分ける（短い行は今までどおり）。
    // 全角空白で字下げした見出しは NFKC 後に半角空白の連続になる。値の直後（コロンが続かない）の2つ以上の空白だけで区切り、
    // 「最寄駅　　：」の字間の空白や地の文の空白1つでは区切らない
    const pieces = line.length > 200 ? line.split(/(?=[【［\[◆◇■□●○★☆▼▽])|(?<=\S)(?=\s{2,}[^\s:：])/) : [line];
    for (const piece of pieces) {
      // 見出しは行頭の短い範囲にある。長い行をそのまま正規表現にかけない（空白の連続で遅くならないように）
      const head = piece.slice(0, 80);
      if (/^\s*(>|＞)/.test(head)) continue;
      onHead(head);
    }
  }
}

// 見出しの行数（引用行は数えない）
function countLines(body: string, re: RegExp): number {
  let n = 0;
  eachHead(body, (head) => {
    if (re.test(head)) n += 1;
  });
  return n;
}

// 要員の見出しの違う語の数。イニシャル＋（NN歳）の行は「名前」と「年齢」の2語と数える
function countEngineerWords(body: string): number {
  const seen = new Set<string>();
  eachHead(body, (head) => {
    const hit = ENGINEER_GROUPS.find((g) => g.re.test(head));
    if (hit) seen.add(hit.key);
    else if (INITIAL_AGE.test(head)) {
      seen.add('name');
      seen.add('age');
    }
  });
  return seen.size;
}

export function classifyMailKind(mail: Pick<SesRawMail, 'body'>): MailKind {
  const body = mail.body.slice(0, 20_000);
  const eng = countEngineerWords(body);
  const proj = countLines(body, PROJECT_HEADINGS);
  // 要員の見出しが2つ以上あり、案件の見出しがほとんど無いものだけを要員とする（一覧や混在メールは抽出側へ）
  if (eng >= 2 && proj <= 1) return 'engineer';
  if (proj >= 2 && eng <= 1) return 'project';
  return 'unknown';
}

export interface KindSplit {
  extract: SesRawMail[];
  skippedEngineerMailIds: string[];
}

// 案件だけモードでは要員メールを抽出対象から外す（それ以外のモードはそのまま）
export function splitByKind(mails: SesRawMail[], projectsOnly: boolean): KindSplit {
  if (!projectsOnly) return { extract: mails, skippedEngineerMailIds: [] };
  const extract: SesRawMail[] = [];
  const skippedEngineerMailIds: string[] = [];
  for (const m of mails) {
    if (classifyMailKind(m) === 'engineer') skippedEngineerMailIds.push(m.id);
    else extract.push(m);
  }
  return { extract, skippedEngineerMailIds };
}

// 案件だけモードでは、振り分けを抜けて抽出された要員も保存・突合に使わない（使う要員は名簿のプロパーだけ）。
// 元メールは呼び出し側で処理済みにするため、ここでは要員だけを落とす
export function engineersToKeep<T>(engineers: T[], projectsOnly: boolean): { kept: T[]; dropped: number } {
  if (!projectsOnly) return { kept: engineers, dropped: 0 };
  return { kept: [], dropped: engineers.length };
}

// 募集終了・充足の連絡か（抽出せず、同じ送信元の募集中の案件を閉じる）。
// 件名の先頭のタグか、本文の完了形の文だけで判定する（「★1名参画決定★」「決定実績あり」は募集中の案件、
// 「募集終了となった場合はご容赦」「スキル充足度」は通常の案件メールの定型文のため当てない）
const CLOSED_SUBJECT = /^[\s★☆※]*(?:re|fw|fwd)?[\s:：]*[【\[［](?:募集終了|募集締切|募集締め切り|充足|CLOSE|クローズ|終了)[】\]］]/i;
const CLOSED_BODY = /募集(?:枠)?(?:充足|終了|締め?切り?).{0,20}(?:となりました|とさせて(?:頂|いただ)きます|いたしました|致しました)|CLOSEとなりました|一度募集終了とさせて/;

export function isClosedNotice(mail: Pick<SesRawMail, 'subject' | 'body'>): boolean {
  if (CLOSED_SUBJECT.test(mail.subject.normalize('NFKC').slice(0, 200))) return true;
  const body = mail.body.normalize('NFKC').slice(0, 3000);
  return CLOSED_BODY.test(body);
}

// 募集終了の連絡の本文・件名に、募集中の案件の案件名が含まれるか（空白・記号を除いて比べる。短すぎる名前は使わない）
export function mentionsTitle(notice: Pick<SesRawMail, 'subject' | 'body'>, title: string): boolean {
  const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s　【】\[\]［］()（）「」『』、。・:：/／\-ー_~〜★☆※!！?？]/g, '');
  const t = norm(title);
  if (t.length < 6) return false;
  return norm(`${notice.subject}\n${notice.body.slice(0, 5000)}`).includes(t);
}

// 件名だけで明らかな要員メールを抽出の前に外す（試運転の抽出費用を減らす）。本文の見出しで見分ける classifyMailKind とは別で、
// 件名に要員の語・イニシャル・年齢があり、案件側の語が無いときだけ true。迷うものは抽出に回す。
// 年齢は「45歳まで」のような案件の条件を除く。語は実メールで測って決めた（広げると案件を取りこぼした）
const SUBJECT_ENGINEER_RE = /【要員】|【人材】|【技術者】|要員情報|要員紹介|要員のご紹介|人材情報|人材紹介|人材のご紹介|技術者情報|技術者紹介|技術者のご紹介|エンジニア紹介|エンジニアのご紹介|男性|女性|(?<![A-Za-z])[A-Z]\.\s?[A-Z]\.?(?![A-Za-z])|\d{2}歳(?!まで|以下|以上|迄|~|〜)/;
const SUBJECT_PROJECT_RE = /案件|募集|急募|求人|枠|増員|ポジション/;

// 抽出に回す順番を決める件名の点数（高いほど先）。使用量を抑えるため、上位の割合だけを抽出する。
// 語のリストは要員のスキルに合わせて見直す（要員の顔ぶれが変わると当たる語も変わる）
const SUBJECT_TECH_RE = /java|spring|javascript|sql|oracle|postgre|vb|\.net|c#|asp|access|jp1|linux|windows|aws|azure|サーバ|運用|保守|監視|インフラ|テスト|php|cobol|jcl|汎用機|移行|構築|ヘルプ|基盤|db|改修|開発/g;
const SUBJECT_LIST_RE = /新着|注力|案件一覧|案件情報|案件のご連絡|案件のご案内|一覧/;
const SUBJECT_OFF_RE = /python|golang|\bgo\b|react|vue|typescript|sap|salesforce|pmo|ios|android|kotlin|swift|ruby|unity|c\+\+|データサイエン|機械学習|セキュリティ|sre|kubernetes|フロントエンド/g;

export function subjectPriority(subject: string): number {
  const s = subject.normalize('NFKC').toLowerCase();
  const tech = (s.match(SUBJECT_TECH_RE) ?? []).length;
  const off = (s.match(SUBJECT_OFF_RE) ?? []).length;
  return tech + (SUBJECT_LIST_RE.test(s) ? 2 : 0) - off * 1.5;
}

export function engineerBySubject(subject: string): boolean {
  const s = subject.normalize('NFKC');
  if (SUBJECT_PROJECT_RE.test(s)) return false;
  return SUBJECT_ENGINEER_RE.test(s);
}
