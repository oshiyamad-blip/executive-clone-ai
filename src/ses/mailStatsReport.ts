// メール量の測定（npm run ses:mail-stats）の集計と表示（純関数）。
// 表示するのは集計値だけ（件名・アドレス・氏名・本文・ドメイン名は出さない。公開リポジトリのActionsログで実行するため）
import { ownMailReason, type OwnMailPolicy } from './mail/ownMail.js';
import { estimateCallJpy, jpyPerUsd } from '../llm/pricing.js';
import { extractModel, matchModel, healBudgetJpy } from './config.js';
import { nextRunAt, RUN_HOURS_JST, DAY_MS } from './schedule.js';
import type { SesMailMeta, SesAttachmentKind } from '../types/index.js';

const HOUR_MS = 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * HOUR_MS; // 日本時間は夏時間がないため固定オフセットで足りる
const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

export { nextRunAt, RUN_HOURS_JST, DAY_MS };

const KIND_LABELS: Record<SesAttachmentKind, string> = {
  pdf: 'PDF',
  xlsx: 'Excel（.xlsx）',
  xls: 'Excel（.xls）',
  docx: 'Word（.docx）',
  other: 'その他',
};
const KINDS = Object.keys(KIND_LABELS) as SesAttachmentKind[];

// 件名のキーワード分類（固定）。1通が複数の分類に当たることがある。どれにも当たらないものを「その他」とする
export const SUBJECT_GROUPS: Array<{ label: string; pattern: RegExp }> = [
  { label: '案件', pattern: /案件|募集|求人|急募|プロジェクト|\bPJ\b/i },
  { label: '要員・人材', pattern: /要員|人材|人財|技術者|エンジニア情報|スキルシート|稼働可|フリーランス|個人事業主|弊社社員|プロパー|\bBP\b/i },
  { label: '面談', pattern: /面談|面接|打ち?合わ?せ|日程調整/ },
];

// 費用の概算の前提（docs/ses-matching-requirements.md §8 のランニングコスト試算と同じ係数）
export const COST_ASSUMPTIONS = {
  extractInputTokens: 3000, // 抽出1通の入力（システムプロンプト＋本文＋添付テキスト）
  extractInputTokensWithPdf: 6000, // PDF添付のあるメール（PDFはページ数に比例して増える）
  extractOutputTokens: 500,
  judgePairsPerMail: 0.3, // 最終判定に回る候補ペア数（受信1通あたり）
  judgeInputTokens: 1500,
  judgeOutputTokens: 300,
  matchesPerMail: 0.1, // 成立マッチ数（受信1通あたり）
  draftsPerMatch: 2, // 案件側・要員側の紹介文面
  draftInputTokens: 2000,
  draftOutputTokens: 800,
  daysPerMonth: 30,
};

export interface RunSlotStats {
  hour: number; // 実行時刻（日本時間）
  runs: number;
  avg: number;
  max: number;
}

export interface MailStats {
  since: Date;
  until: Date;
  total: number;
  ownExcluded: number; // 自分たちのメール（本バッチの送信元・サマリ・自社ドメイン）として収集対象外になる件数
  target: number;
  perDay: Array<{ label: string; count: number; partial: boolean }>;
  perWeekday: Array<{ label: string; total: number; fullDays: number }>;
  perHour: number[]; // 0〜23時（日本時間）
  weekdayAvg: number;
  weekendAvg: number;
  withAttachment: number;
  kindMails: Record<SesAttachmentKind, number>; // その種類の添付を含むメール数
  kindFiles: Record<SesAttachmentKind, number>; // 添付ファイル数（Gmailはメール単位）
  subjectGroups: Array<{ label: string; count: number }>;
  senderDomains: number;
  avgSizeKb: number;
  runSlots: RunSlotStats[];
  runMax: number;
  runsOverCap: number;
}

function jstDayIndex(ms: number): number {
  return Math.floor((ms + JST_OFFSET_MS) / DAY_MS);
}

function emptyKinds(): Record<SesAttachmentKind, number> {
  return { pdf: 0, xlsx: 0, xls: 0, docx: 0, other: 0 };
}

// 集計（純関数）。since〜until の外のメールは数えない。cap は1回の実行で抽出する上限（SES_MAX_MAILS_PER_RUN）
export function aggregateMailStats(
  metas: SesMailMeta[],
  opts: { since: Date; until: Date; policy: OwnMailPolicy; cap: number },
): MailStats {
  const sinceMs = opts.since.getTime();
  const untilMs = opts.until.getTime();
  const inWindow = metas.filter((m) => {
    const t = m.receivedAt.getTime();
    return t >= sinceMs && t <= untilMs;
  });
  const target = inWindow.filter((m) => ownMailReason(m.fromAddress, m.subject, opts.policy) === null);

  // 日別（日本時間）。初日と最終日は途中までしか含まないため平均から外す
  const firstDay = jstDayIndex(sinceMs);
  const lastDay = jstDayIndex(untilMs);
  const dayCounts = new Map<number, number>();
  const perHour = new Array<number>(24).fill(0);
  for (const m of target) {
    const t = m.receivedAt.getTime();
    const day = jstDayIndex(t);
    dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
    perHour[new Date(t + JST_OFFSET_MS).getUTCHours()] += 1;
  }
  const perDay: MailStats['perDay'] = [];
  const perWeekday = WEEKDAY_LABELS.map((label) => ({ label, total: 0, fullDays: 0 }));
  let weekdaySum = 0;
  let weekdayDays = 0;
  let weekendSum = 0;
  let weekendDays = 0;
  for (let day = firstDay; day <= lastDay; day += 1) {
    const date = new Date(day * DAY_MS);
    const wd = date.getUTCDay();
    const count = dayCounts.get(day) ?? 0;
    const partial = day === firstDay || day === lastDay;
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    perDay.push({ label: `${mm}-${dd}(${WEEKDAY_LABELS[wd]})`, count, partial });
    if (partial) continue;
    perWeekday[wd].total += count;
    perWeekday[wd].fullDays += 1;
    if (wd === 0 || wd === 6) {
      weekendSum += count;
      weekendDays += 1;
    } else {
      weekdaySum += count;
      weekdayDays += 1;
    }
  }

  // 添付・件名・送信元ドメイン・サイズ
  const kindMails = emptyKinds();
  const kindFiles = emptyKinds();
  let withAttachment = 0;
  const groupCounts = SUBJECT_GROUPS.map(() => 0);
  let otherSubjects = 0;
  const domains = new Set<string>();
  let sizeSum = 0;
  for (const m of target) {
    if (m.attachmentKinds.length > 0) withAttachment += 1;
    for (const k of m.attachmentKinds) kindFiles[k] += 1;
    for (const k of new Set(m.attachmentKinds)) kindMails[k] += 1;
    const subject = m.subject.normalize('NFKC');
    let hit = false;
    SUBJECT_GROUPS.forEach((g, i) => {
      if (g.pattern.test(subject)) {
        groupCounts[i] += 1;
        hit = true;
      }
    });
    if (!hit) otherSubjects += 1;
    const at = m.fromAddress.lastIndexOf('@');
    if (at >= 0) domains.add(m.fromAddress.slice(at + 1).toLowerCase());
    sizeSum += m.sizeBytes;
  }

  // 定時バッチ1回あたりの件数。前回の実行から今回の実行までに届いた分を数える
  // （期間の最初の回は前回の実行が期間外で件数が欠けるため除く。期間の終わり以降の回も除く）
  const slotCounts = new Map<number, number>();
  for (const m of target) {
    const slot = nextRunAt(m.receivedAt.getTime());
    slotCounts.set(slot, (slotCounts.get(slot) ?? 0) + 1);
  }
  const slots: number[] = [];
  for (let s = nextRunAt(sinceMs); s <= untilMs; s = nextRunAt(s + 1)) slots.push(s);
  const fullSlots = slots.slice(1);
  const runSlots: RunSlotStats[] = RUN_HOURS_JST.map((hour) => {
    const counts = fullSlots
      .filter((s) => new Date(s + JST_OFFSET_MS).getUTCHours() === hour)
      .map((s) => slotCounts.get(s) ?? 0);
    const sum = counts.reduce((a, b) => a + b, 0);
    return { hour, runs: counts.length, avg: counts.length ? sum / counts.length : 0, max: counts.length ? Math.max(...counts) : 0 };
  });
  const allSlotCounts = fullSlots.map((s) => slotCounts.get(s) ?? 0);

  return {
    since: opts.since,
    until: opts.until,
    total: inWindow.length,
    ownExcluded: inWindow.length - target.length,
    target: target.length,
    perDay,
    perWeekday,
    perHour,
    weekdayAvg: weekdayDays ? weekdaySum / weekdayDays : 0,
    weekendAvg: weekendDays ? weekendSum / weekendDays : 0,
    withAttachment,
    kindMails,
    kindFiles,
    subjectGroups: [
      ...SUBJECT_GROUPS.map((g, i) => ({ label: g.label, count: groupCounts[i] })),
      { label: 'その他（いずれにも当たらない）', count: otherSubjects },
    ],
    senderDomains: domains.size,
    avgSizeKb: target.length ? sizeSum / target.length / 1024 : 0,
    runSlots,
    runMax: allSlotCounts.length ? Math.max(...allSlotCounts) : 0,
    runsOverCap: allSlotCounts.filter((c) => c > opts.cap).length,
  };
}

export interface CostEstimate {
  monthlyMails: number;
  pdfShare: number;
  extractJpy: number;
  judgeJpy: number;
  draftJpy: number;
  totalJpy: number;
}

// 月額の概算（円・30日換算）。days は測定した日数
export function estimateMonthlyCost(target: number, pdfMails: number, days: number): CostEstimate {
  const a = COST_ASSUMPTIONS;
  const monthlyMails = days > 0 ? (target / days) * a.daysPerMonth : 0;
  const pdfShare = target > 0 ? pdfMails / target : 0;
  const extractPerMail =
    pdfShare * estimateCallJpy(extractModel(), a.extractInputTokensWithPdf, a.extractOutputTokens) +
    (1 - pdfShare) * estimateCallJpy(extractModel(), a.extractInputTokens, a.extractOutputTokens);
  const extractJpy = monthlyMails * extractPerMail;
  const judgeJpy = monthlyMails * a.judgePairsPerMail * estimateCallJpy(matchModel(), a.judgeInputTokens, a.judgeOutputTokens);
  const draftJpy =
    monthlyMails * a.matchesPerMail * a.draftsPerMatch * estimateCallJpy(matchModel(), a.draftInputTokens, a.draftOutputTokens);
  return { monthlyMails, pdfShare, extractJpy, judgeJpy, draftJpy, totalJpy: extractJpy + judgeJpy + draftJpy };
}

function num(n: number, digits = 0): string {
  return n.toLocaleString('ja-JP', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${num((part / whole) * 100, 1)}%` : '-';
}

function bar(count: number, max: number, width = 30): string {
  if (max <= 0 || count <= 0) return '';
  return '█'.repeat(Math.max(1, Math.round((count / max) * width)));
}

function jstDate(d: Date): string {
  return new Date(d.getTime() + JST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

// 表示用の行（集計値のみ。件名・アドレス・ドメイン名は含めない）
export function formatMailStats(s: MailStats, days: number, cap: number): string[] {
  const lines: string[] = [];
  const p = (line = '') => lines.push(line.trimEnd());
  p(`期間: ${jstDate(s.since)} 〜 ${jstDate(s.until)}（日本時間・直近${days}日）`);
  p(`受信数: ${num(s.total)}件（うち自分たちのメールとして収集対象外 ${num(s.ownExcluded)}件 → 収集対象 ${num(s.target)}件）`);
  p('以下はすべて収集対象のメールの集計です。');
  p(`1日平均: 平日 ${num(s.weekdayAvg, 1)}件 / 土日 ${num(s.weekendAvg, 1)}件（初日と最終日は途中までのため平均から除外）`);
  p(`1通の平均サイズ: ${num(s.avgSizeKb, 1)}KB（添付込み）`);

  p('');
  p('■ 日別（日本時間）');
  const dayMax = Math.max(0, ...s.perDay.map((d) => d.count));
  for (const d of s.perDay) p(`  ${d.label} ${String(d.count).padStart(5)} ${bar(d.count, dayMax)}${d.partial ? '（途中まで）' : ''}`);

  p('');
  p('■ 曜日別（合計 / 1日平均。途中までの日を除く）');
  for (const i of [1, 2, 3, 4, 5, 6, 0]) {
    const w = s.perWeekday[i];
    p(`  ${w.label}: ${String(w.total).padStart(5)}件 / ${w.fullDays ? num(w.total / w.fullDays, 1) : '-'}件（${w.fullDays}日分）`);
  }

  p('');
  p('■ 時間帯別（日本時間・受信時刻）');
  const hourMax = Math.max(0, ...s.perHour);
  s.perHour.forEach((c, h) => p(`  ${String(h).padStart(2, '0')}時 ${String(c).padStart(5)} ${bar(c, hourMax)}`));

  p('');
  p('■ 添付ファイル');
  p(`  添付ありのメール: ${num(s.withAttachment)}件（${pct(s.withAttachment, s.target)}）`);
  for (const k of KINDS) {
    p(`  ${KIND_LABELS[k]}: ${num(s.kindMails[k])}通に${num(s.kindFiles[k])}ファイル（${pct(s.kindMails[k], s.target)}のメール）`);
  }
  p('  ※ 本文中のスプレッドシートのリンクは本文を読まないため数えていません');

  p('');
  p('■ 件名のキーワード分類（1通が複数に当たることがあります）');
  for (const g of s.subjectGroups) p(`  ${g.label}: ${num(g.count)}件（${pct(g.count, s.target)}）`);

  p('');
  p(`■ 送信元ドメインの種類: ${num(s.senderDomains)}（ドメイン名は表示しません）`);

  p('');
  p(`■ 定時バッチ（平日 ${RUN_HOURS_JST.map((h) => `${h}:00`).join('・')}）1回あたりの処理件数の見込み`);
  for (const r of s.runSlots) {
    p(`  ${r.hour}:00 の回: 平均 ${num(r.avg, 1)}件 / 最大 ${num(r.max)}件（${r.runs}回分）`);
  }
  if (s.runsOverCap > 0) {
    p(`  ⚠️ 1回の上限（SES_MAX_MAILS_PER_RUN=${cap}）を超える回が${s.runsOverCap}回ありました（最大${num(s.runMax)}件）。`);
    p('     超えた分は次の回に回ります。追いつかない場合は上限を引き上げてください（費用と実行時間が増えます）');
  } else {
    p(`  ✅ 1回の上限（SES_MAX_MAILS_PER_RUN=${cap}）に収まっています`);
  }

  const cost = estimateMonthlyCost(s.target, s.kindMails.pdf, days);
  const a = COST_ASSUMPTIONS;
  p('');
  p(`■ LLM費用の月額概算（${a.daysPerMonth}日換算・1ドル=${jpyPerUsd()}円）`);
  p(`  収集対象: 月 約${num(cost.monthlyMails)}件（PDF添付あり ${pct(cost.pdfShare, 1)}）`);
  p(`  抽出（${extractModel()}）: 約${num(cost.extractJpy)}円`);
  p(`  最終判定（${matchModel()}）: 約${num(cost.judgeJpy)}円`);
  p(`  紹介文面の生成（${matchModel()}）: 約${num(cost.draftJpy)}円`);
  p(`  合計: 約${num(cost.totalJpy)}円/月`);
  p('  前提（docs/ses-matching-requirements.md §8 と同じ係数）:');
  p(`   ・抽出: 全メールに1回。入力${num(a.extractInputTokens)}トークン（PDF添付ありは${num(a.extractInputTokensWithPdf)}）・出力${num(a.extractOutputTokens)}トークン`);
  p(`   ・最終判定: 候補ペアが受信1通あたり${a.judgePairsPerMail}件。1件あたり入力${num(a.judgeInputTokens)}・出力${num(a.judgeOutputTokens)}トークン`);
  p(
    `   ・紹介文面: 成立マッチが受信1通あたり${a.matchesPerMail}件・1件${a.draftsPerMatch}通。1通あたり入力${num(a.draftInputTokens)}・出力${num(a.draftOutputTokens)}トークン`,
  );
  p(`   ・自己修復（上限 ${healBudgetJpy()}円/回）・プロパーのスキルシート抽出・再試行は含みません`);
  return lines;
}
