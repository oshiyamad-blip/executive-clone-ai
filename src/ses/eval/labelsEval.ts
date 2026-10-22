// ラベルストアを今のコードで再生して、規則の変更が良い組を落としていないか・優先度が営業の評価と合うかを測る
// （npm run ses:eval:labels）。実データを読むため DEMO_MODE は付けない。
// 標準出力は件数・割合・組のキー（要員ID|案件ID）だけ。案件名・社名・本文・経歴の文は出さない（Actions のログは公開されうる）
//   --json <path>       結果を JSON で書く
//   --baseline <path>   前回の結果との差を出す
//   --fail-on-drop      足切りの再現率が基準より下がったら終了コード1
import { readFileSync, writeFileSync } from 'node:fs';
import { buildProperCandidates } from '../proper/index.js';
import { __setProperJudgeForTest, __setCachedProjectIdsForTest } from '../proper/judge.js';
import { salesPriorityOf } from '../proper/salesList.js';
import { jstDateOf } from '../dates.js';
import {
  labelsDir, readLabelStore, latestSales, prefilterRecall, isClaudeCheck, reviveProject, PRIORITY_NONE, PROPOSED_OR_LATER,
  type LabelPair, type PrefilterRecall,
} from './labels.js';
import type { ProperEngineer } from '../../types/index.js';

const MARKS = ['◎', '○', '△', '×'] as const;
const MISSED_MAX = 20;

interface PriorityRow { n: number; checks: Record<string, number>; checked: number; validityPct: number | null; reasons: Record<string, number>; proposed: number; }
export interface LabelsEvalResult {
  counts: {
    pairs: number; withSales: number; excludedNoEngineer: number; skippedLines: number;
    byEngineer: Record<string, number>; byVerdict: Record<string, number>; byPriority: Record<string, number>;
  };
  recall: {
    ai: { total: number; kept: number; ratePct: number | null; missed: string[] };
    sales: { total: number; kept: number; ratePct: number | null; missed: string[] };
    negative: { total: number; kept: number; ratePct: number | null };
  };
  // rows・checks・validityPct は営業の評価だけ（Claude確認を除く）。以前の基準 JSON は Claude 分を含んでいた
  priority: { rows: Record<string, PriorityRow>; changedFromStored: number; compared: number; claude: { checked: number; good: number; validityPct: number | null } } | null;
}

const pct = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };

// 保存した判定をそのまま返す判定器で今のコードの優先度を計算する。要員ごと・judgedAt の日付（JST）ごとにまとめて1回で通す
async function recomputedPriorities(pairs: LabelPair[], engineersByHash: Map<string, ProperEngineer>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
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
      for (const p of group) out.set(p.key, byKey.get(p.key) ?? PRIORITY_NONE);
    } catch (err) {
      console.error(`優先度の再計算に失敗しました（飛ばします）: ${err instanceof Error ? err.constructor.name : 'Error'}`);
    }
  }
  __setProperJudgeForTest(null);
  __setCachedProjectIdsForTest(null);
  return out;
}

export async function evaluateLabels(dir: string): Promise<LabelsEvalResult> {
  const store = readLabelStore(dir);
  const engineersByHash = new Map(store.engineers.map((e) => [e.hash, e.engineer]));
  const pairs = store.pairs;
  const usable = pairs.filter((p) => engineersByHash.has(p.engineerHash));
  const sales = latestSales(store.sales);
  const counts: LabelsEvalResult['counts'] = {
    pairs: pairs.length, withSales: pairs.filter((p) => sales.has(p.key)).length, excludedNoEngineer: pairs.length - usable.length,
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
    const now = await recomputedPriorities(rated, engineersByHash);
    const rows: Record<string, PriorityRow> = {};
    let changed = 0;
    let compared = 0;
    const claude = { checked: 0, good: 0, validityPct: null as number | null };
    for (const p of rated) {
      const prio = now.get(p.key);
      if (prio === undefined) continue;
      const s = sales.get(p.key);
      if (!s) continue;
      compared += 1;
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
    priority = { rows, changedFromStored: changed, compared, claude };
  }
  return { counts, recall, priority };
}

const fmt = (v: number | null) => (v === null ? '-' : `${v}%`);
const table = (m: Record<string, number>) => Object.entries(m).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `    ${k}: ${v}`).join('\n') || '    （なし）';

export function formatResult(res: LabelsEvalResult, base: LabelsEvalResult | null): string[] {
  const lines: string[] = [];
  const diff = (now: number | null, was: number | undefined | null) => (base && now !== null && was !== undefined && was !== null ? `（基準 ${was}% → ${Math.round((now - was) * 10) / 10 >= 0 ? '+' : ''}${Math.round((now - was) * 10) / 10}pt）` : '');
  const c = res.counts;
  lines.push('=== ラベルの評価 ===', '', '■ 件数', `  組: ${c.pairs}（営業の評価あり ${c.withSales}・要員の控えなしで除外 ${c.excludedNoEngineer}・読めない行 ${c.skippedLines}）`);
  lines.push('  要員ごと:', table(c.byEngineer), '  verdict ごと:', table(c.byVerdict), '  保存時の優先度ごと:', table(c.byPriority));
  const rc = res.recall;
  lines.push('', '■ 足切りの再現率（今の足切りを通る割合）');
  lines.push(`  AI正例（recommend/conditional）: ${rc.ai.kept}/${rc.ai.total} = ${fmt(rc.ai.ratePct)} ${diff(rc.ai.ratePct, base?.recall.ai.ratePct)}`);
  lines.push(`  営業正例（◎○または提案済以降）: ${rc.sales.kept}/${rc.sales.total} = ${fmt(rc.sales.ratePct)} ${diff(rc.sales.ratePct, base?.recall.sales.ratePct)}`);
  lines.push(`  負例（reject）が通る割合: ${rc.negative.kept}/${rc.negative.total} = ${fmt(rc.negative.ratePct)} ${diff(rc.negative.ratePct, base?.recall.negative.ratePct)}`);
  if (rc.ai.missed.length > 0) lines.push(`  落ちたAI正例（最大${MISSED_MAX}件）: ${rc.ai.missed.join(', ')}`);
  if (rc.sales.missed.length > 0) lines.push(`  落ちた営業正例（最大${MISSED_MAX}件）: ${rc.sales.missed.join(', ')}`);
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
