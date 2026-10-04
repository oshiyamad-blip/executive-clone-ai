// 営業に渡す「プロパー提案候補リスト」（営業専用の別スプレッドシート。PROPER_SALES_SPREADSHEET_ID）。
// 案件スプレッドシート（DB）は生データ・内部IDを含むため営業に共有せず、判断に要る列だけを見やすい形で書き出す。
// - 「全体」タブ: 優先度 → 要員 → 受信の新しい順。左に判断に要る列、右に詳細（本文・文面）。ID列は隠す
// - 要員ごとのタブ: 「全体」を FILTER で映す閲覧用（入力は「全体」で行う）。候補が0件の営業中の要員にも作り、要員の増減に合わせてバッチが足し引きする
// - 色: 優先度（A=緑/B=黄/C=灰）と対応状況（提案済=青/面談調整=紫/面談済=橙/成約=緑/見送り=灰）を条件付き書式で
// - 人が入力する列（対応状況・担当営業・メモ・精度チェック・精度メモ）は毎回の書き直しでも ID で引き継ぎ、今回の候補から外れた行も入力があれば残す
// - 候補から外れて人の入力も無い行は、消す前に「期限切れ」タブへ控える（上限 SALES_EXPIRED_KEEP 行。クローズ済みの照合には使わない）
// - 機械の列「最終更新」（判定の中身が変わった日時）「前回優先度」で、再判定による行の変化を営業が見分けられる
// - 「見送り」「クローズ」の行は次の更新で「クローズ済み」へ移す（成約は全体に残す）。見送り理由「募集終了」はその案件の他の要員の行にも及ぶ
// - 要員一覧: いま営業している要員（稼働可）を、候補が0件の要員も含めて1行ずつ（稼働開始・希望単価・スキル・本人の希望・候補数）
// - 精度チェック: 営業が候補ごとに「合っていたか」を付け、「精度集計」タブが優先度・要員ごとの妥当率を数式で出す（AI判定の精度の測定）
import { google, type sheets_v4 } from 'googleapis';
import { GOOGLE_REQUEST_TIMEOUT_MS, withGoogleRetry, columnLetter, quoteTab } from '../../database/sheetBook.js';
import { properSalesSpreadsheetId, salesExpiredKeep } from '../config.js';
import { sesMainAuth } from '../googleCreds.js';
import { norm } from './judge.js';
import { normalizeSubject } from '../resend.js';
import { parseJstLabel } from '../trial/jstLabel.js';
import type { Project, ProperCandidate, ProperEngineer, RateReason, RequirementCheck } from '../../types/index.js';

export const SALES_ALL_TAB = '全体';
// 候補から外れ、人の入力も無いため「全体」から消した行の控え（見なかった候補の記録。クローズ済みの照合には使わない）
export const SALES_EXPIRED_TAB = '期限切れ';
const STAFF_TAB_METADATA_KEY = 'ses_sales_staff_tab';
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

export const SALES_STATUSES = ['未着手', '提案済', '面談調整', '面談済', '成約', '見送り', 'クローズ'] as const;
// 営業が「クローズ」にした行は次の更新で「全体」から外し、このタブへ移す（同じ案件が再送されても一覧に戻さないための控えも兼ねる）
export const SALES_CLOSED_STATUS = 'クローズ';
export const SALES_CLOSED_TAB = 'クローズ済み';
// 見送りは結果を残したまま片付ける（クローズに変えると見送りの記録が消えるため）。見送り理由が募集終了なら案件ごと終わりとして扱う
export const SALES_SKIPPED_STATUS = '見送り';
export const SALES_ENDED_REASON = '募集終了';
// 次の更新で「全体」から「クローズ済み」へ移す対応状況
export const isClosingStatus = (status: string): boolean => {
  const v = status.trim();
  return v === SALES_CLOSED_STATUS || v === SALES_SKIPPED_STATUS;
};
// 精度チェックの選択肢（先頭の記号で集計する）。◎○を「妥当」として妥当率に数える
export const ACCURACY_MARKS = ['◎ 妥当', '○ 概ね妥当', '△ 微妙', '× ズレ'] as const;
export const SALES_SUMMARY_TAB = '精度集計';
export const SALES_STAFF_LIST_TAB = '要員一覧';
const STAFF_LIST_TAB_METADATA_KEY = 'ses_sales_staff_list_tab';
const SUMMARY_TAB_METADATA_KEY = 'ses_sales_summary_tab';
export const SALES_PRIORITIES = { a: 'A 提案推奨', b: 'B 条件交渉', c: 'C 要確認', d: 'D 参考' } as const;
// 営業が見送り・クローズにした理由（AI判定の見直しと、要員ごとの傾向の集計に使う）
export const SALES_SKIP_REASONS = ['ハードルが高い（スキル・経験不足）', '単価が安い', '勤務地・通勤', '本人の希望と違う', '募集終了', '重複', 'その他'] as const;

// 列の定義（順番がそのまま表示順）。width はピクセル、wrap=false は折り返さずに切る（長文はセルを開いて読む）
interface SalesColumn {
  name: string;
  width: number;
  wrap?: boolean;
  human?: boolean; // 人が入力する列（書き直しでも引き継ぐ）
  hidden?: boolean;
}
export const SALES_COLUMNS: SalesColumn[] = [
  { name: 'No', width: 36 },
  { name: '優先度', width: 92 },
  { name: '要員', width: 56 },
  { name: '案件名', width: 240, wrap: true },
  { name: '案件単価(万)', width: 64 },
  { name: '希望単価(万)', width: 64 },
  { name: '差(万)', width: 52 },
  { name: '勤務地', width: 110, wrap: true },
  { name: 'リモート', width: 56 },
  { name: '開始', width: 80, wrap: true },
  { name: '判定理由', width: 260, wrap: true },
  { name: '合っている点', width: 260, wrap: true },
  { name: '足りない点', width: 160, wrap: true },
  { name: '交渉ポイント', width: 220, wrap: true },
  { name: '対応状況', width: 80, human: true },
  { name: '見送り理由', width: 140, human: true },
  { name: '担当営業', width: 72, human: true },
  { name: 'メモ', width: 160, wrap: true, human: true },
  { name: '精度チェック', width: 96, human: true },
  { name: '精度メモ', width: 180, wrap: true, human: true },
  { name: '確認事項', width: 220, wrap: true },
  { name: '必須スキル', width: 160, wrap: true },
  { name: '営業元会社', width: 140, wrap: true },
  // 下書き依頼の「担当者メール」（営業が自分のアドレスを入れる列）と取り違えないよう、営業元（相手先）の連絡先だと名前で分ける
  { name: '営業元担当者', width: 72 },
  { name: '営業元メール', width: 160 },
  { name: 'メール件名', width: 280, wrap: false },
  { name: '受信日時', width: 108 },
  { name: '追加日時', width: 108 }, // バッチがこの行を足した日時（新着の見分け用。機械の列で、既存の行は引き継ぐ）
  { name: '最終更新', width: 108 }, // 判定の中身（JUDGMENT_COLS）が前と変わった日時。変わらない再判定では前の値のまま
  { name: '前回優先度', width: 80 }, // 優先度が変わったときの、変わる前の優先度
  { name: '案件詳細（メール本文より）', width: 320, wrap: false },
  { name: '判定の理由', width: 320, wrap: false },
  { name: '提案文面（案）', width: 320, wrap: false },
  { name: 'ID', width: 40, hidden: true },
];
// 列名を変えた列の旧名（古い控えの見出しを読み替える）
const RENAMED_FROM: Record<string, string> = { 営業元担当者: '担当者', 営業元メール: '担当者メール' };
const COL = Object.fromEntries(SALES_COLUMNS.map((c, i) => [c.name, i])) as Record<string, number>;
const HEADER = SALES_COLUMNS.map((c) => c.name);
const LAST_COL = columnLetter(SALES_COLUMNS.length - 1);
// 要員のタブは FILTER で映すだけのため、人が入力する列の見出しに入力先を添える
const staffHeaderOf = (h: string) => (SALES_COLUMNS.find((c) => c.name === h)?.human ? `${h}（入力は全体タブ）` : h);

type Row = Array<string | number>;

// 営業向けの表記（保存用の「不可」ではなく「常駐」）
const SALES_REMOTE_LABEL: Record<Project['remote'], string> = { full: 'フル', partial: '一部', none: '常駐', unknown: '' };

// 条件付きなのに経験の無い必須（unmet）がある組の、その要件名（見送りにはせず、優先度 C で主な候補と分ける）
function unmetRequiredOf(c: ProperCandidate): string[] {
  if (c.judgment?.verdict !== 'conditional') return [];
  return (c.judgment.checks ?? []).filter((k) => k.kind === '必須' && k.status === 'unmet').map((k) => k.requirement);
}

// 必須の年数条件に経歴の年数が足りず close にした要件（AI判定の照合で付く）
function yearShortRequiredOf(c: ProperCandidate): Array<{ requirement: string; shortYears: number }> {
  return (c.judgment?.checks ?? []).flatMap((k) => (k.kind === '必須' && typeof k.shortYears === 'number' ? [{ requirement: k.requirement, shortYears: k.shortYears }] : []));
}

// 優先度: 要確認（単価・スキル不明や指示混入疑い、AIの根拠が経歴に無い等）→ C。上限超え等の参考 → D。
// 条件付きで経験の無い必須がある組も C。
// AI判定のある候補は「推奨」かつ単価を満たせば A、ほかは B。AI判定の無い候補は、交渉や参考提案の注記が無く単価を満たす強マッチ → A
export function salesPriorityOf(c: ProperCandidate): string {
  if (c.needsReview) return SALES_PRIORITIES.c;
  if (c.reference) return SALES_PRIORITIES.d;
  if (unmetRequiredOf(c).length > 0) return SALES_PRIORITIES.c;
  if (c.judgment) {
    if (c.judgment.verdict !== 'recommend' || !c.meetsRate) return SALES_PRIORITIES.b;
    // 必須の年数が足りない組は交渉が要るため、A にせず B までに抑える（下げるだけで上げない）
    return yearShortRequiredOf(c).length > 0 ? SALES_PRIORITIES.b : SALES_PRIORITIES.a;
  }
  if (c.band === 'strong' && c.meetsRate && !/【(単価交渉|経験交渉|年数交渉|参考提案)】/.test(c.reason)) return SALES_PRIORITIES.a;
  return SALES_PRIORITIES.b;
}

// 根拠（ownMatch の reason）から交渉ポイント・確認事項を取り出す（どちらも1行1項目）
export function salesNotesOf(reason: string): { negotiation: string; confirm: string } {
  const negotiation: string[] = [];
  const confirm: string[] = [];
  for (const m of reason.matchAll(/【(単価交渉|経験交渉|年数交渉|参考提案)】([^【［。]*)/g)) {
    const body = m[2].replace(/。$/, '').trim();
    negotiation.push(m[1] === '参考提案' ? `参考提案${body ? `: ${body}` : ''}` : `${m[1].replace('交渉', '')}: ${body}`);
  }
  for (const m of reason.matchAll(/［(条件|確認)］([^【［。]*)/g)) confirm.push(m[2].trim());
  const review = /([^。）]*)のため要確認です/.exec(reason);
  if (review) confirm.unshift(`要確認: ${review[1].trim()}`);
  return { negotiation: negotiation.join('\n'), confirm: confirm.join('\n') };
}

export function jstLabel(d: Date): string {
  if (!Number.isFinite(d.getTime())) return '';
  const j = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${j.getUTCFullYear()}/${p(j.getUTCMonth() + 1)}/${p(j.getUTCDate())} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}`;
}

const CHECK_MARKS: Record<RequirementCheck['status'], string> = { met: '○', close: '△', unmet: '×' };
const BULLET = /^\s*(?:[・\-*●○◯◎►▶>＞]|\d+[.．)）])/;
export const CHECK_LEGEND = '【要件の照合】○ 経験あり　△ 近い経験　× 経験なし（AIの判定を経歴と照合した結果。理由は右の「判定の理由」列）';

// メール本文の必須・尚可の行の先頭に ○△× を付ける。1行に複数の要件がある行は行末に記号だけを要件の順に添え、
// 本文に見つからない要件は冒頭の一覧に回す。要件名と理由は隣の「判定の理由」列に出すため、ここには書かない
export function markRequirementsInMail(detail: string, checks: RequirementCheck[]): string {
  if (checks.length === 0) return detail;
  const lines = detail.split('\n');
  // 必須・尚可の見出し（【必須スキル】・▼尚可・必須：など）から次の見出しまでを要件の範囲とし、同じ語が案件名などにもあるときは範囲内の行を選ぶ
  const inSkill: boolean[] = [];
  let skill = false;
  for (const l of lines) {
    const t = l.trim();
    const kw = /必須|尚可|歓迎|スキル|要件|求める|該当/;
    const heading = /^[【▼■◆□●<＜≪《〈\[]/.test(t) || /^[^・\-*\s]{1,12}[：:]/.test(t) || (t.length <= 16 && kw.test(t));
    if (heading) skill = kw.test(t.slice(0, 16));
    inSkill.push(skill);
  }
  const lineOf = (q: string): number => {
    const hits = lines.flatMap((l, i) => (norm(l).includes(q) ? [i] : []));
    // 要件の範囲が読めるメールで範囲外にしか無い語（案件名・見出しの飾り）には付けず、冒頭の一覧に回す
    return hits.find((i) => inSkill[i]) ?? hits.find((i) => BULLET.test(lines[i])) ?? (inSkill.includes(true) ? -1 : (hits[0] ?? -1));
  };
  const byLine = new Map<number, RequirementCheck[]>();
  const unplaced: RequirementCheck[] = [];
  for (const c of checks) {
    const q = norm(c.quote);
    const at = q.length >= 2 ? lineOf(q) : -1;
    if (at < 0) unplaced.push(c);
    else byLine.set(at, [...(byLine.get(at) ?? []), c]);
  }
  const marked = lines.map((line, i) => {
    const cs = byLine.get(i);
    if (!cs) return line;
    if (cs.length === 1) return `${CHECK_MARKS[cs[0].status]} ${line}`;
    return `${line}　→ ${cs.map((c) => CHECK_MARKS[c.status]).join('')}`;
  });
  const head = [CHECK_LEGEND];
  if (unplaced.length > 0) {
    head.push(...unplaced.map((c) => `${CHECK_MARKS[c.status]} ${c.kind}: ${c.requirement}`));
  }
  return [...head, '', ...(detail.trim() ? marked : [])].join('\n').trimEnd();
}

// 「判定の理由」: 要件ごとに1行。メール本文側は記号だけにしているため、名前と理由はここで読む
export function checkReasonLines(checks: RequirementCheck[]): string {
  return checks
    .map((k) => {
      const ev = k.evidence ? `経歴「${k.evidence}」` : '';
      const why =
        k.status === 'met' ? ev || '経験あり'
        : k.status === 'close' ? (typeof k.shortYears === 'number' ? `近い経験（経歴は約${k.shortYears.toFixed(1)}年）` : `近い経験${ev ? `（${ev}）` : ''}`)
        : k.note ? `経験なし（${k.note}）` : '経歴に記載なし';
      return `${CHECK_MARKS[k.status]} ${k.kind} ${k.requirement} ― ${why}`;
    })
    .join('\n');
}

// 案件単価が希望単価をこの額（万円）以上上回る組には、AIが見立てた高い理由（商流が浅い／求める水準が高い）を出す
export const HIGH_RATE_GAP_MAN = 15;

const RATE_REASON_LABEL: Record<RateReason, string> = {
  shallow_flow: '商流が浅い見込み（利益が大きい）',
  high_level: '求める水準が高い見込み',
  unclear: '理由は判断できず',
};

// 案件単価が希望より大きく高い組の「高単価の理由」（AIの見立て）
function rateReasonLine(c: ProperCandidate): string {
  const reason = c.judgment?.rateReason;
  if (!reason || (c.rateGapMan ?? 0) < HIGH_RATE_GAP_MAN) return '';
  return `高単価: 希望より+${c.rateGapMan}万円（${RATE_REASON_LABEL[reason]}）`;
}

// 候補1件を「全体」タブの1行にする（No と人の入力列は後で埋める）
export function salesRowOf(c: ProperCandidate, project: Project | undefined): Row {
  const row: Row = HEADER.map(() => '');
  const { negotiation, confirm } = salesNotesOf(c.reason);
  row[COL['優先度']] = salesPriorityOf(c);
  row[COL['要員']] = c.properLabel;
  row[COL['案件名']] = c.projectTitle;
  row[COL['案件単価(万)']] = c.projectRate ?? '';
  row[COL['希望単価(万)']] = c.requiredProjectRate ?? '';
  row[COL['差(万)']] = c.rateGapMan ?? '';
  // AI判定があれば「要件 ← 経歴の根拠」を1行ずつ、無ければ満たしたスキル名を並べる
  const sep = c.judgment ? '\n' : '、';
  row[COL['判定理由']] = c.judgment
    ? [`やること: ${c.judgment.work}`, c.judgment.levelFit ? `レベル: ${c.judgment.levelFit}` : '', rateReasonLine(c)].filter(Boolean).join('\n')
    : '';
  row[COL['合っている点']] = (c.matchedSkills ?? []).join(sep);
  row[COL['足りない点']] = (c.missingSkills ?? []).join(sep);
  // 年数不足の必須は、優先度を B に抑える理由として交渉ポイントにも出す（照合由来の「年数:」の行がすでにあれば足さない）
  const yearNotes = /^年数:/m.test(negotiation) ? [] : yearShortRequiredOf(c).map((y) => `年数: 必須${y.requirement}に対し経歴約${y.shortYears.toFixed(1)}年`);
  row[COL['交渉ポイント']] = [negotiation, ...yearNotes].filter(Boolean).join('\n');
  const unmet = c.needsReview || c.reference ? [] : unmetRequiredOf(c);
  row[COL['確認事項']] = unmet.length > 0 ? [`要確認: 経験の無い必須があります（${unmet.join('、')}）`, confirm].filter(Boolean).join('\n') : confirm;
  row[COL['提案文面（案）']] = c.draftToProject?.body ?? '';
  row[COL['判定の理由']] = checkReasonLines(c.judgment?.checks ?? []);
  row[COL['ID']] = c.id;
  if (project) {
    row[COL['勤務地']] = project.location;
    row[COL['リモート']] = SALES_REMOTE_LABEL[project.remote];
    row[COL['開始']] = project.startPeriod;
    row[COL['必須スキル']] = project.requiredSkills.join('、');
    row[COL['営業元会社']] = project.agentCompany;
    row[COL['営業元担当者']] = project.agentContact;
    row[COL['営業元メール']] = project.agentEmail;
    row[COL['メール件名']] = project.replyTarget?.subject ?? '';
    row[COL['受信日時']] = jstLabel(project.receivedAt);
    row[COL['案件詳細（メール本文より）']] = markRequirementsInMail((project.detail ?? '').replace(/&nbsp;/g, ' ').trim(), c.judgment?.checks ?? []);
  }
  return row;
}

const NUMERIC_COLS = new Set(['No', '案件単価(万)', '希望単価(万)', '差(万)']);
const HUMAN_COLS = SALES_COLUMNS.flatMap((c, i) => (c.human ? [i] : []));

// 「最終更新」を動かす判定の中身の列。受信日時・追加日時・案件詳細など、判定が同じなら変わらない列は含めない
const JUDGMENT_COLS = ['優先度', '案件単価(万)', '希望単価(万)', '判定理由', '合っている点', '足りない点', '交渉ポイント', '確認事項', '判定の理由'].map((n) => COL[n]);
// 同じ判定から作り直した行が「更新」にならないよう、前後の空白と改行コードの差は無視して比べる
const sameCell = (a: string | number | undefined, b: string | number | undefined) => {
  const k = (v: string | number | undefined) => String(v ?? '').replace(/\r\n?/g, '\n').trim();
  return k(a) === k(b);
};

// 既存の行へ判定を書き直すときの「最終更新」「前回優先度」。判定の中身が変わったときだけ今回の日時にし、優先度が変わったら前の優先度を残す
function carryStamps(next: Row, prev: Row, now: string): void {
  const changed = JUDGMENT_COLS.some((c) => !sameCell(next[c], prev[c]));
  next[COL['最終更新']] = changed && now ? now : (prev[COL['最終更新']] ?? '');
  const was = String(prev[COL['優先度']] ?? '').trim();
  next[COL['前回優先度']] = was !== '' && !sameCell(next[COL['優先度']], prev[COL['優先度']]) ? prev[COL['優先度']] : (prev[COL['前回優先度']] ?? '');
}

// 同じメールの行どうしの照合（試運転と本番でメールの ID が違っても引き当てる）。要員・営業元メール・件名（正規化）が同じで受信日時が30分以内
export interface MailRef {
  engineer: string;
  email: string;
  subject: string;
  at: number;
}
const MAIL_WINDOW_MS = 30 * 60 * 1000;
export function mailRefOf(engineer: string, email: string, subject: string, receivedAt: string): MailRef | null {
  const at = parseJstLabel(receivedAt);
  const subj = normalizeSubject(subject);
  if (!engineer.trim() || !email.trim() || !subj || !Number.isFinite(at)) return null;
  return { engineer: engineer.trim(), email: email.trim().toLowerCase(), subject: subj, at };
}
export const sameMail = (a: MailRef, b: MailRef): boolean =>
  a.engineer === b.engineer && a.email === b.email && a.subject === b.subject && Math.abs(a.at - b.at) <= MAIL_WINDOW_MS;
const mailRefOfRow = (r: Row): MailRef | null =>
  mailRefOf(String(r[COL['要員']] ?? ''), String(r[COL['営業元メール']] ?? ''), String(r[COL['メール件名']] ?? ''), String(r[COL['受信日時']] ?? ''));

// 控えにあるメールの組か。1通に複数の案件がある（同じ要員・同じメールの行が複数ある）と取り違えるため、
// 控えにも今回の候補にも同じメールの行がちょうど1つのときだけ同じ組とみなす（siblings は今回の候補のメールの一覧）
export function closedByMail(ref: MailRef | null, closedMails: MailRef[], siblings: MailRef[]): boolean {
  if (!ref) return false;
  return closedMails.filter((c) => sameMail(c, ref)).length === 1 && siblings.filter((s) => sameMail(s, ref)).length <= 1;
}

function hasHumanInput(row: Row): boolean {
  return HUMAN_COLS.some((i) => {
    const v = String(row[i] ?? '').trim();
    return v !== '' && !(i === COL['対応状況'] && v === SALES_STATUSES[0]);
  });
}

// 営業が対応した印になる入力（精度チェック・精度メモは対応していなくても付くので除く）
const ACCURACY_COLS = new Set([COL['精度チェック'], COL['精度メモ']]);
function hasSalesInput(row: Row): boolean {
  return HUMAN_COLS.some((i) => {
    if (ACCURACY_COLS.has(i)) return false;
    const v = String(row[i] ?? '').trim();
    return v !== '' && !(i === COL['対応状況'] && v === SALES_STATUSES[0]);
  });
}

const legacyKey = (engineer: string, title: string) => `${engineer}|${title}`.replace(/\s+/g, '');

// 案件名での照合は、短い名前だと別の募集を取り違えやすいため一定の長さ以上だけにする（短いときは ID だけで見る）
const CLOSED_KEY_MIN_TITLE = 6;
export function closedKeyOf(engineer: string, title: string): string {
  return title.replace(/\s+/g, '').length < CLOSED_KEY_MIN_TITLE ? '' : legacyKey(engineer, title);
}

// 行ID（ownmatch_<要員ID>_<案件ID>）の案件ID部分。案件IDは proj_ で始まる（それ以外の形は最初の要員IDを除いた残り）
export function projectIdOf(rowId: string): string {
  return (/_(proj_.+)$/.exec(rowId) ?? /^ownmatch_[^_]+_(.+)$/.exec(rowId))?.[1] ?? '';
}

// 「クローズ済み」タブの照合用の集合。ID は同じ候補、keys は要員＋案件名（切り替え前後で ID が変わっても戻さないため）、
// endedRowIds は「見送り」かつ見送り理由が募集終了の行（その案件を以後の候補に入れない根拠）
export interface ClosedState {
  ids: Set<string>;
  keys: Set<string>;
  endedRowIds: Set<string>;
  mails: MailRef[]; // 要員＋営業元メール＋件名＋受信日時（切り替えで案件名の抽出結果が変わっても戻さないため）
}
export function closedStateOf(values: string[][]): ClosedState {
  const header = (values[0] ?? []).map((h) => String(h ?? '').trim());
  const at = (name: string) => header.indexOf(name);
  const state: ClosedState = { ids: new Set(), keys: new Set(), endedRowIds: new Set(), mails: [] };
  for (const cells of values.slice(1)) {
    const cell = (name: string) => (at(name) >= 0 ? String(cells[at(name)] ?? '').trim() : '');
    const id = cell('ID');
    if (id) state.ids.add(id);
    const key = closedKeyOf(cell('要員'), cell('案件名'));
    if (key) state.keys.add(key);
    const mail = mailRefOf(cell('要員'), cell('営業元メール'), cell('メール件名'), cell('受信日時'));
    if (mail) state.mails.push(mail);
    if (id && cell('対応状況') === SALES_SKIPPED_STATUS && cell('見送り理由') === SALES_ENDED_REASON) state.endedRowIds.add(id);
  }
  return state;
}

// ID列の無い以前のリスト（バッチ導入前に手で作った営業リスト）の人の入力を、要員＋案件名で引ける形にする
function legacyInputs(legacy: string[][]): Map<string, string[]> {
  const header = legacy[0] ?? [];
  const at = (name: string) => header.indexOf(name);
  const out = new Map<string, string[]>();
  if (at('要員') < 0 || at('案件名') < 0) return out;
  for (const cells of legacy.slice(1)) {
    const key = legacyKey(cells[at('要員')] ?? '', cells[at('案件名')] ?? '');
    const human = HUMAN_COLS.map((i) => (at(HEADER[i]) >= 0 ? (cells[at(HEADER[i])] ?? '').trim() : ''));
    if (human.some((v) => v !== '') && !out.has(key)) out.set(key, human);
  }
  return out;
}

// 今回の行に、前回までのシートの人の入力を ID で引き継ぐ（IDが変わった行は要員＋案件名で引く）。
// 今回の候補に無い前回の行は、人の入力があるか stillOpen が真（案件がまだ募集中で要員も営業中・希望単価も同じ）なら前回のまま残す。
// 判定の上限や重複の代表の入れ替わりで、営業が見たばかりの行が次の回に消えないようにするため。
// existing はシートの値（1行目は見出し。列は見出しの名前で探すため、人が列を並べ替えていても読める）。
// legacy は同じスプレッドシートにある以前のリスト（ID列なし）。IDで引けない行だけ、要員＋案件名が同じ行の入力を引き継ぐ
export function mergeSalesRows(
  fresh: Row[],
  existing: string[][],
  legacy: string[][] = [],
  stillOpen: (id: string, previous: Row) => boolean = () => false,
  canonical: (id: string) => string = (id) => id,
  addedAt = '',
): Row[] {
  const fromLegacy = legacyInputs(legacy);
  const header = existing[0] ?? [];
  const at = (name: string) => header.indexOf(name);
  const idAt = at('ID');
  const previous = new Map<string, Row>();
  if (idAt >= 0) {
    for (const cells of existing.slice(1)) {
      const id = (cells[idAt] ?? '').trim();
      if (!id) continue;
      const row: Row = HEADER.map((name) => {
        const v = at(name) >= 0 ? (cells[at(name)] ?? '') : '';
        return NUMERIC_COLS.has(name) && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v;
      });
      previous.set(id, row);
    }
  }
  const byKey = new Map<string, string>();
  for (const [id, prev] of previous) {
    const key = legacyKey(String(prev[COL['要員']]), String(prev[COL['案件名']]));
    if (!byKey.has(key)) byKey.set(key, id);
  }
  const freshIds = new Set(fresh.map((r) => String(r[COL['ID']])));
  const byCanonical = new Map<string, string>();
  for (const id of previous.keys()) if (!byCanonical.has(canonical(id))) byCanonical.set(canonical(id), id);
  const out: Row[] = [];
  const seen = new Set<string>();
  for (const r of fresh) {
    const id = String(r[COL['ID']]);
    seen.add(id);
    let prev = previous.get(id);
    const alias = byCanonical.get(id);
    if (!prev && alias && !freshIds.has(alias) && !seen.has(alias)) {
      prev = previous.get(alias);
      seen.add(alias);
    }
    if (!prev) {
      const other = byKey.get(legacyKey(String(r[COL['要員']]), String(r[COL['案件名']])));
      if (other && !freshIds.has(other) && !seen.has(other)) {
        prev = previous.get(other);
        seen.add(other);
      }
    }
    const merged = [...r];
    const old = prev ? null : fromLegacy.get(legacyKey(String(r[COL['要員']]), String(r[COL['案件名']])));
    HUMAN_COLS.forEach((i, k) => {
      merged[i] = prev ? prev[i] : (old?.[k] ?? '');
    });
    // 追加日時は人の入力ではないが、書き直しで消さないよう前の値を引き継ぐ（前が空なら空のまま。前の行が無ければ今回の日時）
    merged[COL['追加日時']] = prev ? prev[COL['追加日時']] : addedAt;
    if (prev) carryStamps(merged, prev, addedAt);
    else {
      merged[COL['最終更新']] = addedAt;
      merged[COL['前回優先度']] = '';
    }
    if (merged[COL['対応状況']] === '') merged[COL['対応状況']] = SALES_STATUSES[0];
    out.push(merged);
  }
  for (const [id, prev] of previous) if (!seen.has(id) && (hasHumanInput(prev) || stillOpen(id, prev))) out.push(prev);
  return sortSalesRows(out);
}

// 優先度 → 要員 → 受信の新しい順。No を振り直す
export function sortSalesRows(rows: Row[]): Row[] {
  const s = (r: Row, name: string) => String(r[COL[name]] ?? '');
  const sorted = [...rows].sort(
    (a, b) =>
      s(a, '優先度').localeCompare(s(b, '優先度')) ||
      s(a, '要員').localeCompare(s(b, '要員')) ||
      s(b, '受信日時').localeCompare(s(a, '受信日時')) ||
      s(a, 'ID').localeCompare(s(b, 'ID')),
  );
  return sorted.map((r, i) => {
    const copy = [...r];
    copy[COL['No']] = i + 1;
    return copy;
  });
}

// 営業が入力している最中のシートを書き直さないための、行ごとの差分。
// 並び替えも「全体」の消去もせず、既存の行はバッチが作る列（人の入力の列以外）だけを同じ行に書き直し、新しい候補は下に足す。
// 消すのは、今回の候補に無く・人の入力も無く・案件が募集中でもない行だけ（書く直前に読み直して、入力が入っていれば残す）。
// 見出しが既定の並びでない（人が列を並べ替えた・初回）ときは null（全体を書き直す）
export interface SalesUpdatePlan {
  updates: Array<{ row: number; values: Row }>; // row はシートの行番号（1始まり、見出しが1行目）
  appends: Row[];
  deleteIds: string[];
  closeIds: string[]; // 営業が「クローズ」「見送り」にした行（「クローズ済み」へ移して「全体」から消す）
  expireIds: string[]; // 精度チェック・精度メモだけの行が期限切れになったもの（「クローズ済み」へ移して「全体」から消す）
  endedIds: string[]; // 募集終了の案件の、営業の入力が無い他の要員の行（対応状況は空のまま「クローズ済み」へ移して「全体」から消す）
  closedRows: Row[]; // クローズ・見送りにした行＋期限切れの行＋募集終了の行
  dropRows: Row[]; // deleteIds の行そのもの（「全体」から消す前に「期限切れ」タブへ移す）
  rekeyed: number; // 案件IDが変わっても同じメールの行とみなして引き継いだ行数（試運転から本番への切り替え）
  rows: Row[]; // 書いた後のシートの並び（要員のタブ・件数用）
}

// 「全体」の見出しが今の並びと違うときの差。列名だけを返し、セルの値は含めない（ログ・サマリに出してよい形）
export function salesHeaderDiff(header: string[]): string[] {
  const got = header.map((h) => h.trim());
  if (got.length === HEADER.length && got.every((h, i) => h === HEADER[i])) return [];
  const missing = HEADER.filter((h) => !got.includes(h)).map((h) => `不足: ${h}`);
  const extra = got.filter((h) => h && !HEADER.includes(h)).map((h) => `余分: ${h}`);
  return [...missing, ...extra, ...(missing.length === 0 && extra.length === 0 ? ['列の並びが違います'] : [])];
}

// 見出しが空（まだ何も書かれていない）なら初回の作成。見出しがあって今の並びと違うときは人が列をいじっているので、何も書かずに止める
export class SalesHeaderMismatchError extends Error {
  constructor(readonly diff: string[]) {
    super(`営業リストの見出しが今の列の並びと違います（${diff.join('、')}）`);
    this.name = 'SalesHeaderMismatchError';
  }
}

function assertSalesHeaderOrEmpty(values: string[][]): void {
  const header = values[0] ?? [];
  if (header.every((h) => !String(h ?? '').trim())) return;
  const diff = salesHeaderDiff(header);
  if (diff.length > 0) throw new SalesHeaderMismatchError(diff);
}

// 控え（「クローズ済み」タブ）由来の追加の照合と、新しい行に入れる日時
export interface SalesPlanOptions {
  closedKeys?: Set<string>; // 要員＋案件名（closedStateOf の keys）
  closedMails?: MailRef[]; // 要員＋営業元メール＋件名＋受信日時（closedStateOf の mails）
  endedRowIds?: Set<string>; // 控えにある「見送り・募集終了」の行ID（closedStateOf の endedRowIds）
  addedAt?: string; // 新しい行の「追加日時」（受信日時と同じ書式）
}

export function planSalesUpdate(
  fresh: Row[],
  existing: string[][],
  stillOpen: (id: string, previous: Row) => boolean = () => false,
  canonical: (id: string) => string = (id) => id,
  closedIds: Set<string> = new Set(),
  opts: SalesPlanOptions = {},
): SalesUpdatePlan | null {
  const header = existing[0] ?? [];
  if (header.length !== HEADER.length || header.some((h, i) => h !== HEADER[i])) return null;
  const toRow = (cells: string[]): Row =>
    HEADER.map((name, i) => {
      const v = cells[i] ?? '';
      return NUMERIC_COLS.has(name) && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v;
    });
  const current = existing.slice(1).map(toRow);
  const isClosed = (r: Row) => isClosingStatus(String(r[COL['対応状況']]));
  const closedRows = current.filter((r) => isClosed(r) && String(r[COL['ID']]).trim());
  const closedNow = new Set([...closedIds, ...closedRows.map((r) => String(r[COL['ID']]).trim())]);
  // クローズ・見送りにした候補は、同じ案件の別メール（代表の読み替え）で届いても戻さない
  const closedCanon = new Set([...closedNow].map(canonical));
  // 試運転と本番で案件IDが変わる（スレッドID由来とMessage-ID由来）ため、要員＋案件名でも照合する
  const closedKeys = new Set([...(opts.closedKeys ?? []), ...closedRows.map((r) => closedKeyOf(String(r[COL['要員']]), String(r[COL['案件名']])))]);
  closedKeys.delete('');
  // 「見送り・募集終了」の行は、その案件そのものが終わった印として扱う（代表の読み替えを含む）
  const endedRowIds = new Set([
    ...(opts.endedRowIds ?? []),
    ...closedRows.filter((r) => String(r[COL['対応状況']]).trim() === SALES_SKIPPED_STATUS && String(r[COL['見送り理由']]).trim() === SALES_ENDED_REASON).map((r) => String(r[COL['ID']]).trim()),
  ]);
  const endedProjects = new Set([...endedRowIds].map((id) => projectIdOf(canonical(id))).filter(Boolean));
  const projectEnded = (id: string) => endedProjects.has(projectIdOf(canonical(id)));
  const closedMails = [...(opts.closedMails ?? []), ...closedRows.flatMap((r) => mailRefOfRow(r) ?? [])];
  const siblingMails = fresh.flatMap((r) => mailRefOfRow(r) ?? []);
  fresh = fresh.filter((r) => {
    const id = String(r[COL['ID']]);
    return (
      !closedNow.has(id) && !closedCanon.has(canonical(id)) && !projectEnded(id) &&
      !closedKeys.has(closedKeyOf(String(r[COL['要員']]), String(r[COL['案件名']]))) && !closedByMail(mailRefOfRow(r), closedMails, siblingMails)
    );
  });
  const freshById = new Map(fresh.map((r) => [String(r[COL['ID']]), r]));
  const freshByKey = new Map<string, string>();
  for (const r of fresh) {
    const key = legacyKey(String(r[COL['要員']]), String(r[COL['案件名']]));
    if (!freshByKey.has(key)) freshByKey.set(key, String(r[COL['ID']]));
  }
  const used = new Set<string>();
  const updates: SalesUpdatePlan['updates'] = [];
  const deleteIds: string[] = [];
  const dropRows: Row[] = [];
  const expireIds: string[] = [];
  const expiredRows: Row[] = [];
  const endedIds: string[] = [];
  const endedRows: Row[] = [];
  const rows: Row[] = [];
  // 募集終了の案件の行は、営業の入力が無ければ控えへ移す（入力がある行は通常の扱いで残る）
  const eligible = (prev: Row) => {
    const id = String(prev[COL['ID']]).trim();
    return id !== '' && !isClosed(prev) && !(projectEnded(id) && !hasSalesInput(prev));
  };
  // 今回の候補との引き当て: ID（代表の読み替えを含む）→ 要員＋案件名
  const matchOf = new Map<number, string>();
  current.forEach((prev, i) => {
    if (!eligible(prev)) return;
    const id = String(prev[COL['ID']]).trim();
    const byId = [id, canonical(id)].find((x) => freshById.has(x) && !used.has(x));
    const byKey = freshByKey.get(legacyKey(String(prev[COL['要員']]), String(prev[COL['案件名']])));
    const match = byId ?? (byKey && !used.has(byKey) ? byKey : undefined);
    if (match) {
      used.add(match);
      matchOf.set(i, match);
    }
  });
  // 試運転と本番では案件IDの付け方が違う（メールID由来）。引き当てられなかった行のうち、同じメール（要員・営業元メール・件名・受信日時30分以内）が
  // 候補とちょうど1対1になる組は同じ行とみなし、IDだけ新しい値に付け替える（人の入力・追加日時・前回優先度はそのまま）
  const existingIds = new Set(current.flatMap((r) => [String(r[COL['ID']]).trim(), canonical(String(r[COL['ID']]).trim())]));
  const loose = current.flatMap((prev, i) => (eligible(prev) && !matchOf.has(i) ? [{ i, ref: mailRefOfRow(prev) }] : []));
  const looseFresh = fresh.flatMap((r) => {
    const id = String(r[COL['ID']]);
    return used.has(id) || existingIds.has(id) ? [] : [{ id, ref: mailRefOfRow(r) }];
  });
  let rekeyed = 0;
  for (const f of looseFresh) {
    if (!f.ref || used.has(f.id)) continue;
    const prevs = loose.filter((x) => x.ref && sameMail(x.ref, f.ref as MailRef) && !matchOf.has(x.i));
    if (prevs.length !== 1) continue;
    const prevRef = prevs[0].ref as MailRef;
    if (looseFresh.filter((g) => !used.has(g.id) && g.ref && sameMail(prevRef, g.ref)).length !== 1) continue;
    matchOf.set(prevs[0].i, f.id);
    used.add(f.id);
    rekeyed += 1;
  }
  current.forEach((prev, i) => {
    const id = String(prev[COL['ID']]).trim();
    if (!id) {
      rows.push(prev); // 人が足した行（IDなし）はそのまま
      return;
    }
    if (isClosed(prev)) return;
    if (projectEnded(id) && !hasSalesInput(prev)) {
      endedIds.push(id);
      endedRows.push(prev);
      return;
    }
    const match = matchOf.get(i);
    if (match) {
      const next = [...(freshById.get(match) as Row)];
      next[COL['No']] = prev[COL['No']];
      next[COL['追加日時']] = prev[COL['追加日時']];
      HUMAN_COLS.forEach((c) => {
        next[c] = prev[c];
      });
      carryStamps(next, prev, opts.addedAt ?? '');
      updates.push({ row: i + 2, values: next });
      rows.push(next);
    } else if (stillOpen(id, prev) || hasSalesInput(prev)) {
      rows.push(prev);
    } else if (hasHumanInput(prev)) {
      expireIds.push(id);
      expiredRows.push(prev);
    } else {
      deleteIds.push(id);
      dropRows.push(prev);
    }
  });
  const maxNo = Math.max(0, ...current.map((r) => (typeof r[COL['No']] === 'number' ? (r[COL['No']] as number) : 0)));
  const appends = sortSalesRows(fresh.filter((r) => !used.has(String(r[COL['ID']])))).map((r, k) => {
    const next = [...r];
    next[COL['No']] = maxNo + k + 1;
    next[COL['追加日時']] = opts.addedAt ?? '';
    next[COL['最終更新']] = opts.addedAt ?? '';
    next[COL['前回優先度']] = '';
    if (next[COL['対応状況']] === '') next[COL['対応状況']] = SALES_STATUSES[0];
    return next;
  });
  return {
    updates,
    appends,
    deleteIds,
    closeIds: closedRows.map((r) => String(r[COL['ID']]).trim()),
    expireIds,
    endedIds,
    closedRows: [...closedRows, ...expiredRows, ...endedRows],
    dropRows,
    rekeyed,
    rows: [...rows, ...appends],
  };
}

// 人の入力の列（対応状況〜精度メモ）は連続している。行を書き直すときはその両側だけを書く
const HUMAN_FIRST = Math.min(...HUMAN_COLS);
const HUMAN_LAST = Math.max(...HUMAN_COLS);

// 要員のタブ名（シート名に使えない文字を除く。「全体」と重ならないようにする）
export function staffTabName(label: string): string {
  const name = label.replace(/[[\]*?/\\:]/g, '').trim().slice(0, 90) || '（イニシャル不明）';
  return name === SALES_ALL_TAB ? `${name}_要員` : name;
}

export function staffFilterFormula(label: string): string {
  const tab = quoteTab(SALES_ALL_TAB);
  const c = columnLetter(COL['要員']);
  return `=IFERROR(FILTER(${tab}!A2:${LAST_COL},${tab}!${c}2:${c}="${label.replace(/"/g, '""')}"),"")`;
}

// 「精度集計」タブの値（数式）。優先度ごと・要員ごとに、精度チェックの件数と妥当率（◎○ ÷ チェック済み）を出す
// 試運転で Claude が付けた精度チェックは精度メモがこの文言で始まる。営業の評価と分けて数える
export const CLAUDE_CHECK_MEMO_PREFIX = '（Claude確認）';

export function summaryValues(staffLabels: string[]): string[][] {
  const tab = quoteTab(SALES_ALL_TAB);
  const closed = quoteTab(SALES_CLOSED_TAB);
  const letter = (name: string) => columnLetter(COL[name]);
  const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const inTab = (t: string, conds: Array<[string, string]>) => conds.map(([n, v]) => `${t}!${letter(n)}2:${letter(n)},${q(v)}`).join(',');
  // 全体とクローズ済みの両方を数える（期限切れ・クローズした行は全体から外れるため）
  const both = (conds: Array<[string, string]>) => [tab, closed].map((t) => `COUNTIFS(${inTab(t, conds)})`).join('+');
  const row = (label: string, cond: Array<[string, string]>, r: number): string[] => {
    const c = (mark: string) => `=${both([...cond, ['精度チェック', `${mark}*`]])}`;
    // 営業の評価だけ（精度メモが「（Claude確認）」で始まらない行）
    const human = (mark: string) => `=${both([...cond, ['精度チェック', `${mark}*`], ['精度メモ', `<>${CLAUDE_CHECK_MEMO_PREFIX}*`]])}`;
    const all = cond.length ? `=COUNTIFS(${inTab(tab, cond)})` : `=COUNTA(${tab}!${letter('ID')}2:${letter('ID')})`;
    return [
      label, all, c('?'), c('◎'), c('○'), c('△'), c('×'), `=IFERROR((D${r}+E${r})/C${r},"")`,
      human('?'), human('◎'), human('○'), human('△'), human('×'), `=IFERROR((J${r}+K${r})/I${r},"")`,
    ];
  };
  const groups: Array<[string, Array<[string, string]>]> = [
    ['全体', []],
    ...(['A', 'B', 'C', 'D'] as const).map((p): [string, Array<[string, string]>] => [`優先度 ${p}`, [['優先度', `${p}*`]]]),
    ...staffLabels.map((l): [string, Array<[string, string]>] => [`要員 ${l}`, [['要員', l]]]),
  ];
  return [
    ['区分', '候補数', 'チェック済（クローズ済みを含む）', '◎ 妥当', '○ 概ね妥当', '△ 微妙', '× ズレ', '妥当率（◎＋○）',
      'チェック済（営業）', '◎（営業）', '○（営業）', '△（営業）', '×（営業）', '妥当率（営業）'],
    ...groups.map(([label, cond], i) => row(label, cond, i + 2)),
    [],
    ['見送り理由（クローズ済みを含む）', '件数', ...staffLabels],
    ...SALES_SKIP_REASONS.map((r) => [r, `=${both([['見送り理由', r]])}`, ...staffLabels.map((l) => `=${both([['見送り理由', r], ['要員', l]])}`)]),
  ];
}

// 「精度集計」の上の表（妥当率の％表示を付ける行数。見出しを含む）
export function summaryTopRows(staffLabels: string[]): number {
  return 1 + 1 + 4 + staffLabels.length;
}

// 「要員一覧」タブの値。文字の列（stringsは RAW で書く）と、候補数などの数式の列（formulas は USER_ENTERED）に分ける
export const STAFF_LIST_HEADER = ['要員', '稼働開始', '希望単価(万)', '経験年数', '主なスキル', '本人の希望', '候補数', 'うちA', '提案済以降', '成約'];
export function staffListValues(engineers: Array<Pick<ProperEngineer, 'proposalLabel' | 'displayName' | 'availableDate' | 'requiredProjectRate' | 'experienceYears' | 'skills' | 'wish'>>): { strings: Array<Array<string | number>>; formulas: string[][] } {
  const tab = quoteTab(SALES_ALL_TAB);
  const col = (name: string) => `${tab}!${columnLetter(COL[name])}2:${columnLetter(COL[name])}`;
  const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const sorted = [...engineers].sort((a, b) => (a.proposalLabel || a.displayName).localeCompare(b.proposalLabel || b.displayName));
  const strings = sorted.map((e) => [
    e.proposalLabel || e.displayName,
    e.availableDate,
    e.requiredProjectRate ?? '',
    e.experienceYears ?? '',
    e.skills.slice(0, 15).join('、'),
    e.wish ?? '',
  ]);
  const formulas = sorted.map((e) => {
    const who = `${col('要員')},${q(e.proposalLabel || e.displayName)}`;
    return [
      `=COUNTIFS(${who})`,
      `=COUNTIFS(${who},${col('優先度')},"A*")`,
      `=COUNTIFS(${who},${col('対応状況')},"<>未着手",${col('対応状況')},"<>見送り",${col('対応状況')},"<>")`,
      `=COUNTIFS(${who},${col('対応状況')},"成約")`,
    ];
  });
  return { strings: [STAFF_LIST_HEADER.slice(0, 6), ...strings], formulas: [STAFF_LIST_HEADER.slice(6), ...formulas] };
}

// ===== 書式 =====

const rgb = (hex: string): sheets_v4.Schema$Color => ({
  red: parseInt(hex.slice(0, 2), 16) / 255,
  green: parseInt(hex.slice(2, 4), 16) / 255,
  blue: parseInt(hex.slice(4, 6), 16) / 255,
});

// 優先度・対応状況の色（背景, 文字）
export const PRIORITY_COLORS: Array<[string, string, string]> = [
  ['A', 'C6EFCE', '006100'],
  ['B', 'FFEB9C', '9C5700'],
  ['C', 'D9D9D9', '404040'],
  ['D', 'DEEAF6', '44546A'],
];
export const ACCURACY_COLORS: Array<[string, string, string]> = [
  ['◎', 'C6EFCE', '006100'],
  ['○', 'E2EFDA', '375623'],
  ['△', 'FFEB9C', '9C5700'],
  ['×', 'F8CBAD', '9C0006'],
];
export const STATUS_COLORS: Array<[string, string, string]> = [
  ['提案済', 'DDEBF7', '1F4E78'],
  ['面談調整', 'E4DFEC', '5B2C6F'],
  ['面談済', 'FCE4D6', '843C0C'],
  ['成約', 'A9D08E', '0B3D0B'],
  ['見送り', 'EDEDED', '808080'],
  ['クローズ', 'BFBFBF', '404040'],
];

function conditionalRules(sheetId: number): sheets_v4.Schema$Request[] {
  const range = (col: number): sheets_v4.Schema$GridRange => ({ sheetId, startRowIndex: 1, startColumnIndex: col, endColumnIndex: col + 1 });
  const rule = (col: number, type: string, value: string, bg: string, fg: string, bold: boolean): sheets_v4.Schema$Request => ({
    addConditionalFormatRule: {
      index: 0,
      rule: {
        ranges: [range(col)],
        booleanRule: {
          condition: { type, values: [{ userEnteredValue: value }] },
          format: { backgroundColor: rgb(bg), textFormat: { foregroundColor: rgb(fg), bold } },
        },
      },
    },
  });
  return [
    ...PRIORITY_COLORS.map(([p, bg, fg]) => rule(COL['優先度'], 'TEXT_STARTS_WITH', p, bg, fg, true)),
    ...STATUS_COLORS.map(([s, bg, fg]) => rule(COL['対応状況'], 'TEXT_EQ', s, bg, fg, s === '成約')),
    ...ACCURACY_COLORS.map(([m, bg, fg]) => rule(COL['精度チェック'], 'TEXT_STARTS_WITH', m, bg, fg, true)),
  ];
}

// タブ1枚分の見た目（見出し・固定・列幅・折り返し・色・隠し列）。既存の条件付き書式は消してから付け直す
// layout: 列幅・非表示・固定・フィルタも付ける（作ったばかりのタブだけ。毎回付け直すと、営業が変えた列幅や絞り込みが消える）
// protect: 入力しない場所の保護の設定を付ける（既定は layout と同じ。列を組み替えて書き直すときは古い設定が残っているため付け足さない）
export function formatRequests(sheetId: number, existingRuleCount: number, isAll: boolean, layout = true, protect = layout): sheets_v4.Schema$Request[] {
  const reqs: sheets_v4.Schema$Request[] = [];
  for (let i = existingRuleCount - 1; i >= 0; i--) reqs.push({ deleteConditionalFormatRule: { sheetId, index: i } });
  if (layout) reqs.push({
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: 1, frozenColumnCount: FROZEN_COLS } },
      fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount',
    },
  });
  reqs.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
      cell: {
        userEnteredFormat: {
          backgroundColor: rgb('1F4E78'),
          textFormat: { foregroundColor: rgb('FFFFFF'), bold: true },
          wrapStrategy: 'WRAP',
          verticalAlignment: 'MIDDLE',
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat,wrapStrategy,verticalAlignment)',
    },
  });
  SALES_COLUMNS.forEach((c, i) => {
    if (layout) reqs.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: c.width, hiddenByUser: Boolean(c.hidden) },
        fields: 'pixelSize,hiddenByUser',
      },
    });
    reqs.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: i, endColumnIndex: i + 1 },
        cell: {
          userEnteredFormat: {
            wrapStrategy: c.wrap ? 'WRAP' : 'CLIP',
            verticalAlignment: 'TOP',
            horizontalAlignment: NUMERIC_COLS.has(c.name) ? 'RIGHT' : 'LEFT',
          },
        },
        fields: 'userEnteredFormat(wrapStrategy,verticalAlignment,horizontalAlignment)',
      },
    });
  });
  reqs.push(...conditionalRules(sheetId));
  if (isAll) {
    reqs.push({
      setDataValidation: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: COL['対応状況'], endColumnIndex: COL['対応状況'] + 1 },
        rule: {
          condition: { type: 'ONE_OF_LIST', values: SALES_STATUSES.map((s) => ({ userEnteredValue: s })) },
          showCustomUi: true,
          strict: true,
        },
      },
    });
    reqs.push({
      setDataValidation: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: COL['見送り理由'], endColumnIndex: COL['見送り理由'] + 1 },
        rule: {
          condition: { type: 'ONE_OF_LIST', values: SALES_SKIP_REASONS.map((s) => ({ userEnteredValue: s })) },
          showCustomUi: true,
          strict: true,
        },
      },
    });
    reqs.push({
      setDataValidation: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: COL['精度チェック'], endColumnIndex: COL['精度チェック'] + 1 },
        rule: {
          condition: { type: 'ONE_OF_LIST', values: ACCURACY_MARKS.map((s) => ({ userEnteredValue: s })) },
          showCustomUi: true,
          strict: true,
        },
      },
    });
    if (layout) reqs.push({ setBasicFilter: { filter: { range: { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: SALES_COLUMNS.length } } } });
  }
  if (protect) reqs.push(...protectRequests(sheetId, isAll));
  return reqs;
}

// 入力しない場所の保護。バッチが毎回書き直す列・FILTERで映すだけの要員のタブへの入力は消えるため。
// 全体タブの機械の列は営業が誤って触っても止めず確認だけ出す（行の並べ替え・削除などの操作を妨げないため）。
// 要員のタブは入力しても次の更新で消えるだけなので、警告ではなく編集不可にする（作成者＝バッチのサービスアカウントだけが編集できる）
export function protectRequests(sheetId: number, isAll: boolean): sheets_v4.Schema$Request[] {
  const protect = (range: sheets_v4.Schema$GridRange, description: string, warningOnly: boolean) => ({
    addProtectedRange: { protectedRange: { range, description, warningOnly } },
  });
  if (!isAll) return [protect({ sheetId }, '全体タブから自動で映しています（編集できません）。対応状況・メモなどは全体タブに入力してください', false)];
  const note = 'バッチが更新のたびに書き直す列です。入力は「対応状況」〜「精度メモ」の列へ';
  return [
    protect({ sheetId, startColumnIndex: 0, endColumnIndex: HUMAN_FIRST }, note, true),
    protect({ sheetId, startColumnIndex: HUMAN_LAST + 1, endColumnIndex: SALES_COLUMNS.length }, note, true),
  ];
}

const SUMMARY_MAX_COLS = 26; // 精度集計の見送り理由の表は要員の数だけ横に伸びる
const HEADER_FORMAT: sheets_v4.Schema$CellFormat = {
  backgroundColor: rgb('1F4E78'),
  textFormat: { foregroundColor: rgb('FFFFFF'), bold: true },
  verticalAlignment: 'MIDDLE',
};

// 「精度集計」「要員一覧」の書式: 見出しの色・数字は右寄せ・文字は左上寄せ・妥当率は％
export function sideTabFormatRequests(summaryId: number, staffListId: number, summaryRows = 1000): sheets_v4.Schema$Request[] {
  const cells = (sheetId: number, from: number, to: number, format: sheets_v4.Schema$CellFormat, fields: string, header = false) => ({
    repeatCell: {
      range: { sheetId, startRowIndex: header ? 0 : 1, ...(header ? { endRowIndex: 1 } : {}), startColumnIndex: from, endColumnIndex: to },
      cell: { userEnteredFormat: format },
      fields: `userEnteredFormat(${fields})`,
    },
  });
  const frozen = (sheetId: number) => ({
    // 1列目（区分・要員のラベル）も固定して、右へスクロールしても何の行か分かるようにする
    updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1, frozenColumnCount: 1 } }, fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount' },
  });
  const width = (sheetId: number, index: number, pixelSize: number) => ({
    updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: index, endIndex: index + 1 }, properties: { pixelSize }, fields: 'pixelSize' },
  });
  const topLeft = { horizontalAlignment: 'LEFT', verticalAlignment: 'TOP', wrapStrategy: 'WRAP' };
  const right = { horizontalAlignment: 'RIGHT', verticalAlignment: 'TOP' };
  const summaryCols = 14;
  const rowsOf = (req: ReturnType<typeof cells>, start: number, end: number) => ({
    repeatCell: { ...req.repeatCell, range: { ...req.repeatCell.range, startRowIndex: start, endRowIndex: end } },
  });
  return [
    frozen(summaryId),
    cells(summaryId, 0, summaryCols, HEADER_FORMAT, 'backgroundColor,textFormat,verticalAlignment', true),
    cells(summaryId, 0, 1, topLeft, 'horizontalAlignment,verticalAlignment,wrapStrategy'),
    cells(summaryId, 1, SUMMARY_MAX_COLS, right, 'horizontalAlignment,verticalAlignment'),
    // 妥当率の列（すべて・営業の評価だけ）
    ...[7, summaryCols - 1].map((i) => rowsOf(cells(summaryId, i, i + 1, { numberFormat: { type: 'PERCENT', pattern: '0.0%' } }, 'numberFormat'), 1, summaryRows)),
    // 下の見送り理由の表の見出し
    rowsOf(cells(summaryId, 0, SUMMARY_MAX_COLS, HEADER_FORMAT, 'backgroundColor,textFormat,verticalAlignment'), summaryRows + 1, summaryRows + 2),
    ...Array.from({ length: summaryCols }, (_, i) => width(summaryId, i, 110)),
    frozen(staffListId),
    cells(staffListId, 0, STAFF_LIST_HEADER.length, HEADER_FORMAT, 'backgroundColor,textFormat,verticalAlignment', true),
    cells(staffListId, 0, 2, topLeft, 'horizontalAlignment,verticalAlignment,wrapStrategy'),
    cells(staffListId, 2, 4, right, 'horizontalAlignment,verticalAlignment'),
    cells(staffListId, 4, 6, topLeft, 'horizontalAlignment,verticalAlignment,wrapStrategy'),
    cells(staffListId, 6, STAFF_LIST_HEADER.length, right, 'horizontalAlignment,verticalAlignment'),
    width(staffListId, 4, 360),
    width(staffListId, 5, 260),
  ];
}

// ===== 書き出し =====

// 新しいタブの既定は26列で、それを超える列数の表を書くと枠を超えて弾かれるため列を足して作る
// 横にスクロールしても No・優先度・要員・案件名が見えるよう、行の見出しとここまでを固定する（全体・要員・クローズ済みで共通）
const FROZEN_COLS = COL['案件名'] + 1;
const WIDE_GRID = { columnCount: SALES_COLUMNS.length + 1 };

export function salesListConfigured(): boolean {
  return Boolean(properSalesSpreadsheetId());
}

let sheetsApiOverride: sheets_v4.Sheets | null = null;

// 自己検証用: Google に接続せず、差し替えた Sheets API で書き込みの流れを確かめる
export function __setSalesSheetsApiForTest(api: sheets_v4.Sheets | null): void {
  sheetsApiOverride = api;
}

function sheetsApi(): sheets_v4.Sheets | null {
  if (sheetsApiOverride) return sheetsApiOverride;
  const auth = sesMainAuth(SCOPES);
  return auth ? google.sheets({ version: 'v4', auth, timeout: GOOGLE_REQUEST_TIMEOUT_MS }) : null;
}

interface TabInfo {
  sheetId: number;
  title: string;
  rules: number;
  rowCount: number;
  columnCount: number;
  staff: boolean; // バッチが作った要員のタブ
}

async function readTabs(api: sheets_v4.Sheets, spreadsheetId: string): Promise<TabInfo[]> {
  const res = await withGoogleRetry(() =>
    api.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),conditionalFormats,developerMetadata(metadataKey))' }),
  );
  return (res.data.sheets ?? []).map((s) => ({
    sheetId: s.properties?.sheetId ?? 0,
    title: s.properties?.title ?? '',
    rules: s.conditionalFormats?.length ?? 0,
    rowCount: s.properties?.gridProperties?.rowCount ?? 0,
    columnCount: s.properties?.gridProperties?.columnCount ?? 0,
    staff: (s.developerMetadata ?? []).some((m) => m.metadataKey === STAFF_TAB_METADATA_KEY),
  }));
}

// 見出しに「要員」「案件名」「対応状況」がある最初のタブ（バッチが作った要員のタブを除く）。無ければ空
async function readLegacyList(api: sheets_v4.Sheets, spreadsheetId: string, tabs: TabInfo[]): Promise<string[][]> {
  for (const t of tabs.filter((x) => !x.staff)) {
    const res = await withGoogleRetry(() => api.spreadsheets.values.get({ spreadsheetId, range: `${quoteTab(t.title)}!A:AZ` }));
    const values = (res.data.values ?? []) as string[][];
    const header = values[0] ?? [];
    if (['要員', '案件名', '対応状況'].every((h) => header.includes(h))) return values;
  }
  return [];
}

// 「期限切れ」タブの上限を超えた分の、消す行数（古い行＝上から）。keep が 0 なら上限なし
export function expiredOverflow(existingDataRows: number, adding: number, keep: number): number {
  return keep > 0 ? Math.max(0, existingDataRows + adding - keep) : 0;
}

// 消す前の行を「期限切れ」タブの最後に足す（空のタブには見出しも書く）。上限を超えたら古い行から消す
async function appendExpired(api: sheets_v4.Sheets, spreadsheetId: string, sheetId: number | undefined, rows: Row[]): Promise<void> {
  const tab = quoteTab(SALES_EXPIRED_TAB);
  const existing = ((await withGoogleRetry(() => api.spreadsheets.values.get({ spreadsheetId, range: `${tab}!A:A` }))).data.values ?? []) as string[][];
  await withGoogleRetry(() =>
    api.spreadsheets.values.append({
      spreadsheetId,
      range: `${tab}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: existing.length === 0 ? [HEADER, ...rows] : rows },
    }),
  );
  const over = expiredOverflow(Math.max(0, existing.length - 1), rows.length, salesExpiredKeep());
  if (over > 0 && sheetId !== undefined) {
    await withGoogleRetry(() =>
      api.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: 1, endIndex: 1 + over } } }] },
      }),
    );
  }
}

// 候補を営業リストへ書き出す。書き出した行数（人の入力で残した行を含む）を返す。未設定なら null
// engineers: いま営業している要員（「要員一覧」タブに、候補が0件の要員も含めて載せる）
// openProjectIds: 今回の突合対象にした募集中の案件（重複を除いた代表）。前回の行のうち、案件がここにあり要員も営業中のものは
// 今回の候補に入らなくても残す（案件が募集終了・遡り期間外になるか、要員が営業から外れたら消える）
export async function writeSalesList(
  candidates: ProperCandidate[],
  projects: Project[],
  engineers: ProperEngineer[] = [],
  open: { ids: Set<string>; aliasOf: Map<string, string> } = { ids: new Set(), aliasOf: new Map() },
): Promise<number | null> {
  const spreadsheetId = properSalesSpreadsheetId();
  if (!spreadsheetId) return null;
  const api = sheetsApi();
  if (!api) throw new Error('営業リスト: Google認証（メインのサービスアカウント）が未設定です');

  const projectById = new Map(projects.map((p) => [p.id, p]));
  const fresh = candidates.map((c) => salesRowOf(c, projectById.get(c.projectId)));

  let tabs = await readTabs(api, spreadsheetId);
  // 見出しが今の並びと違うシートは、タブの追加も含めて何も書かずに止める（全体の書き直しは初回の作成だけ）
  if (tabs.some((t) => t.title === SALES_ALL_TAB)) {
    assertSalesHeaderOrEmpty(
      ((await withGoogleRetry(() => api.spreadsheets.values.get({ spreadsheetId, range: `${quoteTab(SALES_ALL_TAB)}!A1:${LAST_COL}1` }))).data.values ?? []) as string[][],
    );
  }
  // 初回（「全体」タブがまだ無い）は、同じスプレッドシートにある以前の営業リストのタブから人の入力を引き継ぐ
  const legacy = tabs.some((t) => t.title === SALES_ALL_TAB) ? [] : await readLegacyList(api, spreadsheetId, tabs);
  const structural: sheets_v4.Schema$Request[] = [];
  if (!tabs.some((t) => t.title === SALES_ALL_TAB)) structural.push({ addSheet: { properties: { title: SALES_ALL_TAB, index: 0, gridProperties: WIDE_GRID } } });
  if (!tabs.some((t) => t.title === SALES_STAFF_LIST_TAB)) {
    const sheetId = Math.max(0, ...tabs.map((t) => t.sheetId)) + 2000;
    structural.push({ addSheet: { properties: { sheetId, title: SALES_STAFF_LIST_TAB, index: 1 } } });
    structural.push({
      createDeveloperMetadata: {
        developerMetadata: { metadataKey: STAFF_LIST_TAB_METADATA_KEY, metadataValue: '1', location: { sheetId }, visibility: 'DOCUMENT' },
      },
    });
  }
  if (!tabs.some((t) => t.title === SALES_SUMMARY_TAB)) {
    const sheetId = Math.max(0, ...tabs.map((t) => t.sheetId)) + 1000;
    structural.push({ addSheet: { properties: { sheetId, title: SALES_SUMMARY_TAB, index: 1 } } });
    structural.push({
      createDeveloperMetadata: {
        developerMetadata: { metadataKey: SUMMARY_TAB_METADATA_KEY, metadataValue: '1', location: { sheetId }, visibility: 'DOCUMENT' },
      },
    });
  }
  if (!tabs.some((t) => t.title === SALES_CLOSED_TAB)) structural.push({ addSheet: { properties: { title: SALES_CLOSED_TAB, gridProperties: { ...WIDE_GRID, frozenRowCount: 1, frozenColumnCount: FROZEN_COLS } } } });
  if (!tabs.some((t) => t.title === SALES_EXPIRED_TAB)) {
    const sheetId = Math.max(0, ...tabs.map((t) => t.sheetId)) + 3000;
    structural.push({ addSheet: { properties: { sheetId, title: SALES_EXPIRED_TAB, gridProperties: { ...WIDE_GRID, frozenRowCount: 1, frozenColumnCount: FROZEN_COLS } } } });
    // 手で書き換えると控えにならないため、触ると確認が出るようにする（止めはしない）
    structural.push({ addProtectedRange: { protectedRange: { range: { sheetId }, description: '候補から外れて消した行の控えです。バッチが足します（手で編集しない）', warningOnly: true } } });
  }
  if (structural.length > 0) {
    await withGoogleRetry(() => api.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: structural } }));
    tabs = await readTabs(api, spreadsheetId);
  }
  const closedTab = quoteTab(SALES_CLOSED_TAB);
  const closedValues = ((await withGoogleRetry(() => api.spreadsheets.values.get({ spreadsheetId, range: `${closedTab}!A:${LAST_COL}` }))).data.values ??
    []) as string[][];
  const closedState = closedStateOf(closedValues);
  const closedIds = closedState.ids;
  const addedAt = jstLabel(new Date()); // この実行で足す行の「追加日時」

  // 要員の希望単価が変わった行は前回の判定のまま残さない（今回の候補に入っていれば新しい単価で書き直される）
  const stillOpen = (id: string, previous: Row) =>
    engineers.some(
      (e) =>
        id.startsWith(`ownmatch_${e.id}_`) &&
        open.ids.has(id.slice(`ownmatch_${e.id}_`.length)) &&
        String(e.requiredProjectRate ?? '') === String(previous[COL['希望単価(万)']] ?? '').trim(),
    );
  // 前回の行の案件が、今回は同じ案件の別メール（重複の代表）になっているときは代表のIDに読み替える
  const canonical = (id: string) => {
    for (const e of engineers) {
      const prefix = `ownmatch_${e.id}_`;
      const alias = id.startsWith(prefix) ? open.aliasOf.get(id.slice(prefix.length)) : undefined;
      if (alias) return `${prefix}${alias}`;
    }
    return id;
  };
  const readExisting = async () =>
    ((await withGoogleRetry(() => api.spreadsheets.values.get({ spreadsheetId, range: `${quoteTab(SALES_ALL_TAB)}!A:${LAST_COL}` }))).data.values ??
      []) as string[][];
  // 初回の作成（見出しが空）のときも、クローズの行は外して控えに移す
  const freshMails = fresh.flatMap((r) => mailRefOfRow(r) ?? []);
  const withoutClosed = (values: string[][]) => {
    const h = values[0] ?? [];
    const statusAt = h.indexOf('対応状況');
    const idAt = h.indexOf('ID');
    const closed = values.slice(1).filter((r) => statusAt >= 0 && isClosingStatus(r[statusAt] ?? ''));
    const ids = new Set(idAt >= 0 ? closed.map((r) => (r[idAt] ?? '').trim()).filter(Boolean) : []);
    const now = closedStateOf([h, ...closed]);
    const ended = new Set([...closedState.endedRowIds, ...now.endedRowIds]);
    const endedProjects = new Set([...ended].map((id) => projectIdOf(canonical(id))).filter(Boolean));
    return {
      kept: [h, ...values.slice(1).filter((r) => !closed.includes(r))],
      closedRows: closed.map((r) => HEADER.map((name) => (h.indexOf(name) >= 0 ? (r[h.indexOf(name)] ?? '') : ''))) as Row[],
      fresh: fresh.filter((r) => {
        const id = String(r[COL['ID']]);
        const key = closedKeyOf(String(r[COL['要員']]), String(r[COL['案件名']]));
        return (
          !closedIds.has(id) && !ids.has(id) && !closedIds.has(canonical(id)) && ![...ids].some((x) => canonical(x) === canonical(id)) &&
          !endedProjects.has(projectIdOf(canonical(id))) && !(key && (closedState.keys.has(key) || now.keys.has(key))) &&
          !closedByMail(mailRefOfRow(r), [...closedState.mails, ...now.mails], freshMails)
        );
      }),
    };
  };
  const planFor = (values: string[][]) => {
    const p = planSalesUpdate(fresh, values, stillOpen, canonical, closedIds, { closedKeys: closedState.keys, closedMails: closedState.mails, endedRowIds: closedState.endedRowIds, addedAt });
    if (p) return { plan: p, rows: p.rows, closedRows: p.closedRows };
    const w = withoutClosed(values);
    return { plan: null, rows: mergeSalesRows(w.fresh, w.kept, legacy, stillOpen, canonical, addedAt), closedRows: w.closedRows };
  };
  let existingValues = await readExisting();
  let planned = planFor(existingValues);
  let plan = planned.plan;
  let rows = planned.rows;
  if ((plan?.rekeyed ?? 0) > 0) console.log(`営業リスト: ID の付け替え${plan?.rekeyed}行`);

  // 要員のタブ: 行のある要員の分を揃え、いなくなった要員のタブ（バッチが作ったものだけ）を消す
  // 候補が0件の要員（いま営業している要員）にもタブを作る
  const labels = [...new Set([...rows.map((r) => String(r[COL['要員']])), ...engineers.map((e) => e.proposalLabel || e.displayName)])]
    .filter(Boolean)
    .sort();
  const wanted = new Map(labels.map((l) => [staffTabName(l), l]));
  const tabChanges: sheets_v4.Schema$Request[] = [];
  for (const t of tabs) if (t.staff && !wanted.has(t.title)) tabChanges.push({ deleteSheet: { sheetId: t.sheetId } });
  let nextId = Math.max(0, ...tabs.map((t) => t.sheetId)) + 1;
  const created = new Set<string>(structural.some((r) => r.addSheet?.properties?.title === SALES_ALL_TAB) ? [SALES_ALL_TAB] : []);
  for (const title of wanted.keys()) {
    if (tabs.some((t) => t.title === title)) continue;
    created.add(title);
    const sheetId = nextId++;
    tabChanges.push({ addSheet: { properties: { sheetId, title, gridProperties: WIDE_GRID } } });
    tabChanges.push({
      createDeveloperMetadata: {
        developerMetadata: { metadataKey: STAFF_TAB_METADATA_KEY, metadataValue: '1', location: { sheetId }, visibility: 'DOCUMENT' },
      },
    });
  }
  if (tabChanges.length > 0) {
    await withGoogleRetry(() => api.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: tabChanges } }));
    tabs = await readTabs(api, spreadsheetId);
  }

  // 値: 外部由来の文字列（件名・本文・社名）を数式にしないよう RAW で書く。要員タブの FILTER だけ USER_ENTERED
  const staffTabs = tabs.filter((t) => wanted.has(t.title));
  // 書く直前に読み直す（営業の入力・行の並べ替えを取り込む）
  existingValues = await readExisting();
  assertSalesHeaderOrEmpty(existingValues); // 読み直す間に見出しが変えられたときも、書く前に止める
  planned = planFor(existingValues);
  plan = planned.plan;
  rows = planned.rows;
  // 人が作ったタブは行の枠が小さいことがあり、枠を超える書き込みは弾かれるため先に広げる（FILTERで映す要員のタブも同じ行数にそろえる）
  const need = Math.max(rows.length, existingValues.length - 1 + (plan?.appends.length ?? 0)) + 1;
  const grow = [SALES_ALL_TAB, SALES_CLOSED_TAB, SALES_EXPIRED_TAB, ...staffTabs.map((t) => t.title)].flatMap((title) => {
    const t = tabs.find((x) => x.title === title);
    if (!t) return [];
    return [
      ...(t.rowCount < need && title !== SALES_CLOSED_TAB && title !== SALES_EXPIRED_TAB ? [{ appendDimension: { sheetId: t.sheetId, dimension: 'ROWS', length: need - t.rowCount } }] : []),
      ...(t.columnCount < SALES_COLUMNS.length ? [{ appendDimension: { sheetId: t.sheetId, dimension: 'COLUMNS', length: SALES_COLUMNS.length - t.columnCount } }] : []),
    ];
  });
  if (grow.length > 0) await withGoogleRetry(() => api.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: grow } }));
  // 「クローズ済み」の見出しが今の列の並びでない（列が増える前に作られた）ときは、見出しの名前で並べ直して書き直す。
  // そのまま足すと新しい行だけ列がずれ、ID 列が読めなくなる。行数は同じで列が増えるだけなので、先に消さずに上から書く（書き込みに失敗しても控えを失わない）
  const closedHeader = closedValues[0] ?? [];
  if (closedHeader.length > 0 && (closedHeader.length !== HEADER.length || closedHeader.some((h, i) => h !== HEADER[i]))) {
    // 列名を変えた2列（営業元担当者・営業元メール）は、旧名の列からも値を引き継ぐ（控えの連絡先を失わないため）
    const colOf = (name: string) => (closedHeader.indexOf(name) >= 0 ? closedHeader.indexOf(name) : closedHeader.indexOf(RENAMED_FROM[name] ?? '\u0000'));
    const remapped = [HEADER, ...closedValues.slice(1).map((r) => HEADER.map((name) => (colOf(name) >= 0 ? (r[colOf(name)] ?? '') : '')))];
    await withGoogleRetry(() =>
      api.spreadsheets.values.update({ spreadsheetId, range: `${closedTab}!A1`, valueInputOption: 'RAW', requestBody: { values: remapped } }),
    );
  }
  // クローズの行は先に控えへ移す（全体から消すのはその後。途中で失敗しても行が失われないように）
  if (planned.closedRows.length > 0) {
    const data = closedValues.length === 0 ? [HEADER, ...planned.closedRows] : planned.closedRows;
    await withGoogleRetry(() =>
      api.spreadsheets.values.append({
        spreadsheetId,
        range: `${closedTab}!A1`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: data },
      }),
    );
  }
  const staffHeaders = staffTabs.map((t) => ({ range: `${quoteTab(t.title)}!A1`, values: [HEADER.map(staffHeaderOf)] }));
  if (plan) {
    // 既存の行は人の入力の列を書かない（入力中のセルを上書きしない）。新しい候補は最後の行の下に足す
    const all = quoteTab(SALES_ALL_TAB);
    const machine = plan.updates.flatMap((u) => [
      { range: `${all}!A${u.row}:${columnLetter(HUMAN_FIRST - 1)}${u.row}`, values: [u.values.slice(0, HUMAN_FIRST)] },
      { range: `${all}!${columnLetter(HUMAN_LAST + 1)}${u.row}:${LAST_COL}${u.row}`, values: [u.values.slice(HUMAN_LAST + 1)] },
    ]);
    const appends = plan.appends.length > 0 ? [{ range: `${all}!A${existingValues.length + 1}`, values: plan.appends }] : [];
    await withGoogleRetry(() =>
      api.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'RAW', data: [...machine, ...appends, ...staffHeaders] } }),
    );
    if (plan.deleteIds.length > 0 || plan.closeIds.length > 0 || plan.expireIds.length > 0 || plan.endedIds.length > 0) {
      // 消す直前にもう一度読み、その間に入力が入った行・並べ替えで動いた行・クローズを戻した行を取り違えない
      const drop = new Set(plan.deleteIds);
      const close = new Set(plan.closeIds);
      const expire = new Set([...plan.expireIds, ...plan.endedIds]);
      const now = await readExisting();
      const allTab = tabs.find((t) => t.title === SALES_ALL_TAB) as TabInfo;
      const targets = now
        .map((cells, i) => ({ cells, i }))
        .filter(({ cells, i }) => {
          const id = (cells[COL['ID']] ?? '').trim();
          if (i === 0) return false;
          return (drop.has(id) && !hasHumanInput(cells)) || (expire.has(id) && !hasSalesInput(cells)) || (close.has(id) && isClosingStatus(cells[COL['対応状況']] ?? ''));
        });
      // 候補から外れて消す行は、消す前に「期限切れ」タブへ控える（控えに失敗したら消さない）
      const expiredOut = targets
        .filter(({ cells }) => drop.has((cells[COL['ID']] ?? '').trim()) && !hasHumanInput(cells))
        .map(({ cells }) => HEADER.map((_, c) => cells[c] ?? '') as Row);
      if (expiredOut.length > 0) await appendExpired(api, spreadsheetId, tabs.find((t) => t.title === SALES_EXPIRED_TAB)?.sheetId, expiredOut);
      const rowsToDelete = targets.map(({ i }) => i).sort((a, b) => b - a);
      if (rowsToDelete.length > 0) {
        await withGoogleRetry(() =>
          api.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
              requests: rowsToDelete.map((i) => ({
                deleteDimension: { range: { sheetId: allTab.sheetId, dimension: 'ROWS', startIndex: i, endIndex: i + 1 } },
              })),
            },
          }),
        );
      }
    }
  } else {
    await withGoogleRetry(() =>
      api.spreadsheets.values.batchClear({
        spreadsheetId,
        requestBody: { ranges: [SALES_ALL_TAB, ...staffTabs.map((t) => t.title)].map((t) => `${quoteTab(t)}!A:${LAST_COL}`) },
      }),
    );
    await withGoogleRetry(() =>
      api.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: 'RAW', data: [{ range: `${quoteTab(SALES_ALL_TAB)}!A1`, values: [HEADER, ...rows] }, ...staffHeaders] },
      }),
    );
  }
  await withGoogleRetry(() =>
    api.spreadsheets.values.batchClear({
      spreadsheetId,
      requestBody: { ranges: [`${quoteTab(SALES_SUMMARY_TAB)}!A:Z`, `${quoteTab(SALES_STAFF_LIST_TAB)}!A:J`] },
    }),
  );
  // 要員一覧: 要員リスト由来の文字は RAW、候補数の数式は USER_ENTERED
  const staffList = staffListValues(engineers);
  await withGoogleRetry(() =>
    api.spreadsheets.values.update({
      spreadsheetId,
      range: `${quoteTab(SALES_STAFF_LIST_TAB)}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: staffList.strings },
    }),
  );
  // 要員タブの FILTER と「精度集計」の数式だけ USER_ENTERED（外部由来の文字列は含まない）
  await withGoogleRetry(() =>
    api.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: [
          ...staffTabs.map((t) => ({ range: `${quoteTab(t.title)}!A2`, values: [[staffFilterFormula(wanted.get(t.title) as string)]] })),
          { range: `${quoteTab(SALES_SUMMARY_TAB)}!A1`, values: summaryValues(labels) },
          { range: `${quoteTab(SALES_STAFF_LIST_TAB)}!G1`, values: staffList.formulas },
        ],
      },
    }),
  );

  const all = tabs.find((t) => t.title === SALES_ALL_TAB) as TabInfo;
  const summary = tabs.find((t) => t.title === SALES_SUMMARY_TAB);
  const staffListTab = tabs.find((t) => t.title === SALES_STAFF_LIST_TAB);
  // plan が無いのは見出しの無い初回の作成だけ（見出し違いは上で止めている）。そのときだけ列幅・隠す列を付ける
  const rewritten = plan === null;
  const format = [
    ...formatRequests(all.sheetId, all.rules, true, created.has(SALES_ALL_TAB) || rewritten, created.has(SALES_ALL_TAB)),
    ...staffTabs.flatMap((t) => formatRequests(t.sheetId, t.rules, false, created.has(t.title) || rewritten, created.has(t.title))),
    ...(summary && staffListTab ? sideTabFormatRequests(summary.sheetId, staffListTab.sheetId, summaryTopRows(labels)) : []),
  ];
  await withGoogleRetry(() => api.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: format } }));
  return rows.length;
}
