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

function heading(words: string[]): RegExp {
  const spaced = words.map((w) => [...w].join('[\\s　]*')).join('|');
  return new RegExp(`${LEAD}(?:${spaced})[\\s　]*[】\\]］]?[\\s　]*[:：】]`, 'm');
}

const ENGINEER_HEADINGS = heading(['氏名', '名前', 'イニシャル', '最寄駅', '最寄り駅', '最寄', '希望単価', '希望単金', '稼働開始日', '稼働可能日', '性別']);
const PROJECT_HEADINGS = heading(['案件名', '必須スキル', '必須', '尚可スキル', '尚可', '募集人数', '人数', '面談回数', '面談', '精算', '精算幅', '商流', '作業内容', '業務内容', '開発環境', '予算']);

// 見出しの行数（引用行は数えない）
function countLines(body: string, re: RegExp): number {
  let n = 0;
  for (const line of body.normalize('NFKC').split(/\r?\n/)) {
    // 見出しは行頭の短い範囲にある。長い行をそのまま正規表現にかけない（空白の連続で遅くならないように）
    const head = line.slice(0, 80);
    if (/^\s*(>|＞)/.test(head)) continue;
    if (re.test(head)) n += 1;
  }
  return n;
}

export function classifyMailKind(mail: Pick<SesRawMail, 'body'>): MailKind {
  const body = mail.body.slice(0, 20_000);
  const eng = countLines(body, ENGINEER_HEADINGS);
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
