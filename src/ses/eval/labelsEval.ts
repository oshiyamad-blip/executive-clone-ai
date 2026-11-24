// ラベルストアを今のコードで再生して、規則の変更が良い組を落としていないか・優先度が営業の評価と合うかを測る
// （npm run ses:eval:labels）。実データを読むため DEMO_MODE は付けない。
// 標準出力は件数・割合・組のキー（要員ID|案件ID）だけ。案件名・社名・本文・経歴の文は出さない（Actions のログは公開されうる）
//   --json <path>       結果を JSON で書く
//   --baseline <path>   前回の結果との差を出す
//   --fail-on-drop      足切りの再現率が基準より下がったら終了コード1
import { readFileSync, writeFileSync } from 'node:fs';
import { buildProperCandidates } from '../proper/index.js';
import { __setProperJudgeForTest, __setCachedProjectIdsForTest } from '../proper/judge.js';
import { salesPriorityOf, salesPriorityWithoutHighRateRule, salesPriorityWithoutBasicDesignRule, belowMinPriority, SALES_SKIPPED_STATUS } from '../proper/salesList.js';
import { jstDateOf } from '../dates.js';
import { commuteDistanceOf } from '../commute.js';
import {
  labelsDir, readLabelStore, latestSales, type LabelSales, prefilterRecall, isClaudeCheck, reviveProject, PRIORITY_NONE, PROPOSED_OR_LATER,
  type LabelPair, type PrefilterRecall,
} from './labels.js';
import type { Project, ProperEngineer } from '../../types/index.js';

const MARKS = ['◎', '○', '△', '×'] as const;
const MISSED_MAX = 20;

interface PriorityRow { n: number; checks: Record<string, number>; checked: number; validityPct: number | null; reasons: Record<string, number>; proposed: number; }
// 目標: 載せた組のうち提案済以降に進む割合（docs/ses-improvement-proposals-2026-11.md 4.2）
export const PROPOSED_TARGET_PCT = 5;
export interface OutcomeResult {
  listed: number;
  proposed: number;
  proposedPct: number | null;
  targetPct: number;
  targetMet: boolean | null; // 載せた組が無ければ null
  skipped: number;
  skippedPct: number | null;
  skipReasons: Record<string, number>;
}
export const NO_SKIP_REASON = '（理由なし）';

// 営業の見送り理由「勤務地・通勤」の行と、その組の直線距離（最寄駅と勤務地の駅）の分布。比べるために評価のある全組の分布も出す
export const COMMUTE_SKIP_REASON = '勤務地・通勤';
export const COMMUTE_BUCKETS = ['〜20km', '20〜30km', '30〜40km', '40km〜'] as const;
export interface CommuteRow { project: Pick<Project, 'location' | 'remote'>; residence: string | null; skipReason: string }
export interface CommuteDistribution {
  skippedByCommute: number; // 見送り理由が「勤務地・通勤」の組
  measured: number; // そのうち距離を出せた組
  buckets: Record<(typeof COMMUTE_BUCKETS)[number], number>;
  unmeasured: number; // 距離を出せなかった組（出せない理由は note）
  allRated: { measured: number; buckets: Record<(typeof COMMUTE_BUCKETS)[number], number> }; // 営業の評価がある全組（比較用）
  note: string;
}
const emptyBuckets = (): Record<(typeof COMMUTE_BUCKETS)[number], number> => ({ '〜20km': 0, '20〜30km': 0, '30〜40km': 0, '40km〜': 0 });
const bucketOf = (km: number): (typeof COMMUTE_BUCKETS)[number] => (km < 20 ? '〜20km' : km < 30 ? '20〜30km' : km < 40 ? '30〜40km' : '40km〜');

export function commuteDistribution(rows: CommuteRow[]): CommuteDistribution {
  const out: CommuteDistribution = {
    skippedByCommute: 0, measured: 0, buckets: emptyBuckets(), unmeasured: 0, allRated: { measured: 0, buckets: emptyBuckets() },
    note: '距離を出せない組: 案件がフルリモート・勤務地や要員の住まいが駅の表に無い・要員の控えが無い（ラベルの控えに残る住まい・勤務地の原文で数える）',
  };
  for (const r of rows) {
    const d = r.residence === null ? null : commuteDistanceOf(r.project, [r.residence]);
    if (d) {
      out.allRated.measured += 1;
      out.allRated.buckets[bucketOf(d.km)] += 1;
    }
    if (r.skipReason.trim() !== COMMUTE_SKIP_REASON) continue;
    out.skippedByCommute += 1;
    if (d) {
      out.measured += 1;
      out.buckets[bucketOf(d.km)] += 1;
    } else out.unmeasured += 1;
  }
  return out;
}

export function outcomeOf(listed: Array<Pick<LabelSales, 'status' | 'skipReason'>>): OutcomeResult {
  const proposed = listed.filter((s) => PROPOSED_OR_LATER.includes(s.status)).length;
  const skippedRows = listed.filter((s) => s.status === SALES_SKIPPED_STATUS);
  const skipReasons: Record<string, number> = {};
  for (const s of skippedRows) bump(skipReasons, s.skipReason.trim() || NO_SKIP_REASON);
  const proposedPct = pct(proposed, listed.length);
  return {
    listed: listed.length, proposed, proposedPct, targetPct: PROPOSED_TARGET_PCT,
    targetMet: proposedPct === null ? null : proposedPct >= PROPOSED_TARGET_PCT,
    skipped: skippedRows.length, skippedPct: pct(skippedRows.length, listed.length), skipReasons,
  };
}

export interface LabelsEvalResult {
  counts: {
    pairs: number; withSales: number; withMemo: number; excludedNoEngineer: number; skippedLines: number;
    byEngineer: Record<string, number>; byVerdict: Record<string, number>; byPriority: Record<string, number>;
  };
  recall: {
    ai: { total: number; kept: number; ratePct: number | null; missed: string[] };
    sales: { total: number; kept: number; ratePct: number | null; missed: string[] };
    negative: { total: number; kept: number; ratePct: number | null };
  };
  // rows・checks・validityPct は営業の評価だけ（Claude確認を除く）。以前の基準 JSON は Claude 分を含んでいた
  // 営業リストに載せた組（営業の評価がある組）のうち、提案済以降に進んだ割合と見送りの内訳
  outcome: OutcomeResult;
  commute?: CommuteDistribution;
  priority: { rows: Record<string, PriorityRow>; changedFromStored: number; compared: number;
    // 高単価×必須△・年数不足の規則（PROPER_HIGH_RATE_GAP_MAN）を当てて載らなくなる組と、そのうち営業が提案済以降にした組（0 でなければ規則を見直す）
    highRateRule?: { dropped: number; droppedProposed: number; proposedKeys: string[] };
    // 基本設計が必須なのに経歴に基本設計の無い組（PROPER_BASIC_DESIGN_STRICT）の規則で載らなくなる組と、そのうち営業が提案済以降にした組
    basicDesignRule?: { dropped: number; droppedProposed: number; proposedKeys: string[] }; claude: { checked: number; good: number; validityPct: number | null } } | null;
}

const pct = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };

// 保存した判定をそのまま返す判定器で今のコードの優先度を計算する。要員ごと・judgedAt の日付（JST）ごとにまとめて1回で通す
// highRateDropped: 高単価×必須△・年数不足の規則（B4）で、規則が無ければ載っていた組が載らなくなるものの key
async function recomputedPriorities(pairs: LabelPair[], engineersByHash: Map<string, ProperEngineer>): Promise<{ priorities: Map<string, string>; highRateDropped: Set<string>; basicDesignDropped: Set<string> }> {
  const out = new Map<string, string>();
  const highRateDropped = new Set<string>();
  const basicDesignDropped = new Set<string>();
  const judgments = new Map(pairs.map((p) => [p.key, p.judgment]));
  __setProperJudgeForTest(async (e, p) => {
    const j = judgments.get(`${e.id}|${p.id}`);
    if (!j) throw new Error('保存した判定がない組');
    return j;
  });
  __setCachedProjectIdsForTest(async () => new Set<string>());
  process.env.PROPER_JUDGE_PER_ENGINEER = '300';
  const groups = new Map<string, LabelPair[]>();
  for (const p of pairs) {
    if (!engineersByHash.has(p.engineerHash)) continue;
    const k = `${p.engineerHash}|${jstDateOf(new Date(p.judgedAt))}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  for (const group of groups.values()) {
    const engineer = engineersByHash.get(group[0].engineerHash) as ProperEngineer;
    const at = new Date(group.map((p) => p.judgedAt).sort().at(-1) as string);
    const projects = [...new Map(group.map((p) => [p.projectId, reviveProject(p.project)])).values()];
    try {
      const { candidates } = await buildProperCandidates([engineer], projects, at);
      const byKey = new Map(candidates.map((c) => [`${c.ownEngineerId}|${c.projectId}`, salesPriorityOf(c)]));
      for (const c of candidates) {
        if (belowMinPriority(salesPriorityOf(c)) && !belowMinPriority(salesPriorityWithoutHighRateRule(c))) highRateDropped.add(`${c.ownEngineerId}|${c.projectId}`);
        if (belowMinPriority(salesPriorityOf(c)) && !belowMinPriority(salesPriorityWithoutBasicDesignRule(c))) basicDesignDropped.add(`${c.ownEngineerId}|${c.projectId}`);
      }
      for (const p of group) out.set(p.key, byKey.get(p.key) ?? PRIORITY_NONE);
    } catch (err) {
      console.error(`優先度の再計算に失敗しました（飛ばします）: ${err instanceof Error ? err.constructor.name : 'Error'}`);
    }
  }
  __setProperJudgeForTest(null);
  __setCachedProjectIdsForTest(null);
  return { priorities: out, highRateDropped, basicDesignDropped };
}

export async function evaluateLabels(dir: string): Promise<LabelsEvalResult> {
  const store = readLabelStore(dir);
  const engineersByHash = new Map(store.engineers.map((e) => [e.hash, e.engineer]));
  const pairs = store.pairs;
  const usable = pairs.filter((p) => engineersByHash.has(p.engineerHash));
  const sales = latestSales(store.sales);
  const counts: LabelsEvalResult['counts'] = {
    pairs: pairs.length, withSales: pairs.filter((p) => sales.has(p.key)).length,
    withMemo: pairs.filter((p) => (sales.get(p.key)?.memo ?? '').trim() !== '').length, excludedNoEngineer: pairs.length - usable.length,
    skippedLines: store.skipped, byEngineer: {}, byVerdict: {}, byPriority: {},
  };
  for (const p of usable) {
    bump(counts.byEngineer, p.engineerLabel);
    bump(counts.byVerdict, p.judgment.verdict);
    bump(counts.byPriority, p.priority || PRIORITY_NONE);
  }
  const r: PrefilterRecall = prefilterRecall(usable, engineersByHash, sales);
  const rate = (t: { total: number; kept: number }) => pct(t.kept, t.total);
  const recall: LabelsEvalResult['recall'] = {
    ai: { total: r.ai.total, kept: r.ai.kept, ratePct: rate(r.ai), missed: r.ai.missed.slice(0, MISSED_MAX) },
    sales: { total: r.sales.total, kept: r.sales.kept, ratePct: rate(r.sales), missed: r.sales.missed.slice(0, MISSED_MAX) },
    negative: { total: r.negative.total, kept: r.negative.kept, ratePct: rate(r.negative) },
  };
  let priority: LabelsEvalResult['priority'] = null;
  const rated = usable.filter((p) => sales.has(p.key));
  if (rated.length > 0) {
    const { priorities: now, highRateDropped, basicDesignDropped } = await recomputedPriorities(rated, engineersByHash);
    const rows: Record<string, PriorityRow> = {};
    let changed = 0;
    let compared = 0;
    const highRateRule = { dropped: 0, droppedProposed: 0, proposedKeys: [] as string[] };
    const basicDesignRule = { dropped: 0, droppedProposed: 0, proposedKeys: [] as string[] };
    const claude = { checked: 0, good: 0, validityPct: null as number | null };
    for (const p of rated) {
      const prio = now.get(p.key);
      if (prio === undefined) continue;
      const s = sales.get(p.key);
      if (!s) continue;
      compared += 1;
      if (highRateDropped.has(p.key)) {
        highRateRule.dropped += 1;
        if (PROPOSED_OR_LATER.includes(s.status)) {
          highRateRule.droppedProposed += 1;
          highRateRule.proposedKeys.push(p.key);
        }
      }
      if (basicDesignDropped.has(p.key)) {
        basicDesignRule.dropped += 1;
        if (PROPOSED_OR_LATER.includes(s.status)) {
          basicDesignRule.droppedProposed += 1;
          basicDesignRule.proposedKeys.push(p.key);
        }
      }
      if ((p.priority || PRIORITY_NONE) !== prio) changed += 1;
      const row = (rows[prio] ??= { n: 0, checks: {}, checked: 0, validityPct: null, reasons: {}, proposed: 0 });
      row.n += 1;
      const mark = MARKS.find((m) => s.check.trim().startsWith(m));
      if (mark && isClaudeCheck(s.checkMemo)) {
        claude.checked += 1;
        if (mark === '◎' || mark === '○') claude.good += 1;
      } else if (mark) {
        bump(row.checks, mark);
        row.checked += 1;
      }
      if (s.skipReason.trim()) bump(row.reasons, s.skipReason.trim());
      if (PROPOSED_OR_LATER.includes(s.status)) row.proposed += 1;
    }
    for (const row of Object.values(rows)) row.validityPct = pct((row.checks['◎'] ?? 0) + (row.checks['○'] ?? 0), row.checked);
    claude.validityPct = pct(claude.good, claude.checked);
    priority = { rows, changedFromStored: changed, compared, claude, highRateRule: { ...highRateRule, proposedKeys: highRateRule.proposedKeys.slice(0, MISSED_MAX) }, basicDesignRule: { ...basicDesignRule, proposedKeys: basicDesignRule.proposedKeys.slice(0, MISSED_MAX) } };
  }
  const outcome = outcomeOf(pairs.map((p) => sales.get(p.key)).filter((x): x is LabelSales => x !== undefined));
  const commute = commuteDistribution(
    pairs.flatMap((p) => {
      const s = sales.get(p.key);
      if (!s) return [];
      return [{ project: reviveProject(p.project), residence: engineersByHash.get(p.engineerHash)?.residence ?? null, skipReason: s.skipReason }];
    }),
  );
  return { counts, recall, outcome, commute, priority };
}

const fmt = (v: number | null) => (v === null ? '-' : `${v}%`);
const table = (m: Record<string, number>) => Object.entries(m).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `    ${k}: ${v}`).join('\n') || '    （なし）';

export function formatResult(res: LabelsEvalResult, base: LabelsEvalResult | null): string[] {
  const lines: string[] = [];
  const diff = (now: number | null, was: number | undefined | null) => (base && now !== null && was !== undefined && was !== null ? `（基準 ${was}% → ${Math.round((now - was) * 10) / 10 >= 0 ? '+' : ''}${Math.round((now - was) * 10) / 10}pt）` : '');
  const c = res.counts;
  lines.push('=== ラベルの評価 ===', '', '■ 件数', `  組: ${c.pairs}（営業の評価あり ${c.withSales}・うちメモあり ${c.withMemo ?? 0}・要員の控えなしで除外 ${c.excludedNoEngineer}・読めない行 ${c.skippedLines}）`);
  lines.push('  要員ごと:', table(c.byEngineer), '  verdict ごと:', table(c.byVerdict), '  保存時の優先度ごと:', table(c.byPriority));
  const rc = res.recall;
  lines.push('', '■ 足切りの再現率（今の足切りを通る割合）');
  lines.push(`  AI正例（recommend/conditional）: ${rc.ai.kept}/${rc.ai.total} = ${fmt(rc.ai.ratePct)} ${diff(rc.ai.ratePct, base?.recall.ai.ratePct)}`);
  lines.push(`  営業正例（◎○または提案済以降）: ${rc.sales.kept}/${rc.sales.total} = ${fmt(rc.sales.ratePct)} ${diff(rc.sales.ratePct, base?.recall.sales.ratePct)}`);
  lines.push(`  負例（reject）が通る割合: ${rc.negative.kept}/${rc.negative.total} = ${fmt(rc.negative.ratePct)} ${diff(rc.negative.ratePct, base?.recall.negative.ratePct)}`);
  if (rc.ai.missed.length > 0) lines.push(`  落ちたAI正例（最大${MISSED_MAX}件）: ${rc.ai.missed.join(', ')}`);
  if (rc.sales.missed.length > 0) lines.push(`  落ちた営業正例（最大${MISSED_MAX}件）: ${rc.sales.missed.join(', ')}`);
  const oc = res.outcome;
  lines.push('', '■ 載せた行の結果（営業リストに載せた組＝営業の評価がある組）');
  lines.push(`  提案済以降: ${oc.proposed}/${oc.listed} = ${fmt(oc.proposedPct)}（目標 ${oc.targetPct}%）${oc.targetMet === null ? '' : oc.targetMet ? ' 目標達成' : ' 目標未達'}`);
  lines.push(`  見送り: ${oc.skipped}/${oc.listed} = ${fmt(oc.skippedPct)}`);
  for (const [reason, n] of Object.entries(oc.skipReasons).sort(([a], [b]) => a.localeCompare(b))) lines.push(`      見送り理由 ${reason}: ${n}`);
  const cm = res.commute;
  if (cm) {
    lines.push('', '■ 見送り理由「勤務地・通勤」の組の直線距離（最寄駅と勤務地の駅。印は付けるだけで組は外していない）');
    lines.push(`  見送り理由が「${COMMUTE_SKIP_REASON}」の組: ${cm.skippedByCommute}（距離を出せた ${cm.measured}・出せない ${cm.unmeasured}）`);
    lines.push(`  距離の分布: ${COMMUTE_BUCKETS.map((b) => `${b} ${cm.buckets[b]}`).join(' / ')}`);
    lines.push(`  （比較）営業の評価がある全組の分布（距離を出せた ${cm.allRated.measured}）: ${COMMUTE_BUCKETS.map((b) => `${b} ${cm.allRated.buckets[b]}`).join(' / ')}`);
    lines.push(`  ${cm.note}`);
  }
  lines.push('', '■ 優先度の妥当さ（営業の最新の評価がある組・今のコードで再計算）');
  if (!res.priority) {
    lines.push('  まだありません');
  } else {
    lines.push('  （◎○△×・妥当率は営業の評価だけ。Claude確認は下の1行）', '  優先度 | 組 | ◎ | ○ | △ | × | 妥当率(◎○÷チェック済み) | 提案済以降');
    for (const [prio, row] of Object.entries(res.priority.rows).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  ${prio} | ${row.n} | ${MARKS.map((m) => row.checks[m] ?? 0).join(' | ')} | ${fmt(row.validityPct)}（${row.checked}件） | ${row.proposed}`);
      for (const [reason, n] of Object.entries(row.reasons).sort(([a], [b]) => a.localeCompare(b))) lines.push(`      見送り理由 ${reason}: ${n}`);
    }
    const cl = res.priority.claude;
    lines.push(`  Claude確認: チェック${cl.checked}件・妥当率${fmt(cl.validityPct)}`);
    const hr = res.priority.highRateRule;
    if (hr) {
      lines.push(`  高単価×必須△・年数不足の規則で載らなくなる組: ${hr.dropped}（うち営業が提案済以降にした組 ${hr.droppedProposed}${hr.droppedProposed > 0 ? '。規則を見直す' : ''}）`);
      if (hr.proposedKeys.length > 0) lines.push(`    提案済以降だった組（最大${MISSED_MAX}件）: ${hr.proposedKeys.join(', ')}`);
    }
    const bd = res.priority.basicDesignRule;
    if (bd) {
      lines.push(`  基本設計が必須で経歴に基本設計の無い組の規則で載らなくなる組: ${bd.dropped}（うち営業が提案済以降にした組 ${bd.droppedProposed}${bd.droppedProposed > 0 ? '。規則を見直す' : ''}）`);
      lines.push('    （ラベルの控えに残る範囲で数えた近い値: 必須の文は保存した判定の checks、経歴は控えた要員の工程年数とプロフィール文。控えに無い情報は数えられない）');
      if (bd.proposedKeys.length > 0) lines.push(`    提案済以降だった組（最大${MISSED_MAX}件）: ${bd.proposedKeys.join(', ')}`);
    }
    lines.push(`  保存時と優先度が違う組: ${res.priority.changedFromStored}/${res.priority.compared}`);
  }
  return lines;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const dir = labelsDir();
  const res = await evaluateLabels(dir);
  const basePath = arg('--baseline');
  const base = basePath ? (JSON.parse(readFileSync(basePath, 'utf8')) as LabelsEvalResult) : null;
  for (const l of formatResult(res, base)) console.log(l);
  const out = arg('--json');
  if (out) writeFileSync(out, JSON.stringify(res, null, 1));
  if (args.includes('--fail-on-drop') && base) {
    const dropped = (['ai', 'sales'] as const).filter((k) => (res.recall[k].ratePct ?? 100) < (base.recall[k].ratePct ?? 0));
    if (dropped.length > 0) {
      console.log(`\n足切りの再現率が基準より下がりました: ${dropped.join(', ')}`);
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && /labelsEval\.[tj]s$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
