// バッチの健全性の1行記録（計測のための運用負荷ゼロの仕組み）。
// 抽出の不明率・必須スキルの空・辞書にないスキル語・候補0件の案件・除外理由の内訳・AI判定の平均点と関門・
// 再提案抑制・判定の繰越・判定失敗（ヒューリスティック退避）・キャッシュ読込率・コスト・下書きの数を集め、
// サマリメールの診断レポートに載せ、Sheets運用の本番ではスプレッドシート「メトリクス」タブに1行追記する。
// 件数・比率だけを扱い、人名・案件名・スキル語そのものは持たない（公開ログに出してよい）
import { getStats, recordHealEvent } from './heal/events.js';
import { batchCostJpy, batchUsage } from './heal/budget.js';
import { primarySelectTally, judgeTallySnapshot, type ExclusionReason } from './match.js';
import { cacheReadShare } from '../llm/pricing.js';
import { isDemo, dbProvider, extractModelFallbackActive, extractModel, configuredExtractModel } from './config.js';
import { sheetsDbConfigured, appendMetricsRowSheets, METRICS_TAB } from '../database/sheets.js';
import { safeErr } from './redact.js';

export type MetricsMode = '通常' | '突合のみ' | '収集のみ' | 'demo';

let mode: MetricsMode = '通常';

export function setMetricsMode(m: MetricsMode): void {
  mode = m;
}

const EXCLUSION_CODES: ExclusionReason[] = ['skill', 'location', 'timing', 'rate', 'remote', 'sameAgent'];

export interface BatchMetrics {
  at: string; // ISO
  mode: MetricsMode;
  mails: number;
  projects: number;
  engineers: number;
  rateNullPct: number | null;
  prefectureNullPct: number | null;
  startNullPct: number | null;
  desiredRateNullPct: number | null;
  requiredEmptyPct: number | null;
  skillTokens: number;
  unknownSkillTokens: number;
  unknownSkillPct: number | null;
  projectsConsidered: number;
  noCandidatePct: number | null;
  exclusions: Record<ExclusionReason, number>;
  pairsEvaluated: number;
  pairsSelected: number;
  judged: number;
  avgScore: number | null;
  demoted: number;
  rejected: number;
  suppressed: number;
  deferred: number;
  heuristicFallback: number;
  fallbackPct: number | null;
  cacheReadPct: number | null;
  costJpy: number;
  drafts: number;
  requestedDrafts: number;
  extractModelFallback: boolean;
}

function pct(n: number, d: number): number | null {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// 今回のバッチの集計から1行分の値を作る（requestedDrafts = 担当者メールで作成した下書きの件数）
export function collectBatchMetrics(opts: { requestedDrafts?: number; now?: Date } = {}): BatchMetrics {
  const s = getStats();
  const p = primarySelectTally();
  const j = judgeTallySnapshot();
  const attempted = j.judged + j.failed;
  const cache = cacheReadShare(batchUsage());
  return {
    at: (opts.now ?? new Date()).toISOString(),
    mode,
    mails: s.collected,
    projects: s.extractedProjects,
    engineers: s.extractedEngineers,
    rateNullPct: pct(s.projectRateNull, s.extractedProjects),
    prefectureNullPct: pct(s.prefectureNull, s.prefectureChecked),
    startNullPct: pct(s.projectStartNull, s.extractedProjects),
    desiredRateNullPct: pct(s.engineerRateNull, s.extractedEngineers),
    requiredEmptyPct: pct(s.requiredSkillsEmpty, s.extractedProjects),
    skillTokens: s.skillTokens,
    unknownSkillTokens: s.unknownSkillTokens,
    unknownSkillPct: pct(s.unknownSkillTokens, s.skillTokens),
    projectsConsidered: p.projectsConsidered,
    noCandidatePct: pct(p.projectsWithoutCandidates, p.projectsConsidered),
    exclusions: Object.fromEntries(EXCLUSION_CODES.map((c) => [c, p.reasons[c]])) as Record<ExclusionReason, number>,
    pairsEvaluated: p.evaluated,
    pairsSelected: p.selected,
    judged: j.judged,
    avgScore: j.judged > 0 ? round1(j.scoreSum / j.judged) : null,
    demoted: j.demoted,
    rejected: j.rejected,
    suppressed: p.suppressed,
    deferred: j.deferredBudget + j.deferredError,
    heuristicFallback: j.failed,
    fallbackPct: pct(j.failed, attempted),
    cacheReadPct: cache === null ? null : round1(cache * 100),
    costJpy: round1(batchCostJpy()),
    drafts: s.draftsCreated,
    requestedDrafts: opts.requestedDrafts ?? 0,
    extractModelFallback: extractModelFallbackActive(),
  };
}

// 警告のしきい値（%）と、判断に要る最低の母数（少ない回の1件で警告しないように）
export const METRIC_THRESHOLDS = {
  requiredEmptyPct: { max: 20, minSample: 5 },
  unknownSkillPct: { max: 30, minSample: 20 },
  fallbackPct: { max: 10, minSample: 5 },
  noCandidatePct: { max: 50, minSample: 5 },
} as const;

// しきい値を超えた項目の警告文（純関数。件数・比率だけ）
export function metricWarnings(m: BatchMetrics): string[] {
  const t = METRIC_THRESHOLDS;
  const out: string[] = [];
  const over = (value: number | null, sample: number, rule: { max: number; minSample: number }) =>
    value !== null && sample >= rule.minSample && value > rule.max;
  if (over(m.requiredEmptyPct, m.projects, t.requiredEmptyPct)) {
    out.push(
      `メトリクス: 必須スキルが空の案件が${m.requiredEmptyPct}%です（基準${t.requiredEmptyPct.max}%。抽出の指示・メールの書式の変化を確認してください）`,
    );
  }
  if (over(m.unknownSkillPct, m.skillTokens, t.unknownSkillPct)) {
    out.push(
      `メトリクス: 辞書にないスキル語が${m.unknownSkillPct}%です（基準${t.unknownSkillPct.max}%。「_状態」タブの unknownSkillTokens を見て辞書を育ててください）`,
    );
  }
  if (over(m.fallbackPct, m.judged + m.heuristicFallback, t.fallbackPct)) {
    out.push(
      `メトリクス: AI判定に失敗してルールの結果で保存した組が${m.fallbackPct}%です（基準${t.fallbackPct.max}%。判定モデルの設定・応答を確認してください）`,
    );
  }
  if (over(m.noCandidatePct, m.projectsConsidered, t.noCandidatePct)) {
    out.push(
      `メトリクス: 候補が1件も無い案件が${m.noCandidatePct}%です（基準${t.noCandidatePct.max}%。スキル辞書・しきい値・要員の在庫を確認してください）`,
    );
  }
  return out;
}

const REASON_LABEL: Record<ExclusionReason, string> = {
  skill: 'スキル',
  location: '勤務地',
  timing: '時期',
  rate: '単金',
  remote: 'リモート条件',
  sameAgent: '同一営業元',
};

const show = (v: number | null, unit = '%') => (v === null ? '-' : `${v}${unit}`);

// サマリメール（診断レポート）とコンソールに載せる表示（件数・比率だけ）
export function formatMetricsLines(m: BatchMetrics): string[] {
  const exclusions = EXCLUSION_CODES.filter((c) => m.exclusions[c] > 0)
    .map((c) => `${REASON_LABEL[c]}${m.exclusions[c]}`)
    .join('・');
  const lines = [
    '【バッチのメトリクス（件数・比率のみ）】',
    `メール ${m.mails}通 → 抽出 案件${m.projects}件・要員${m.engineers}件`,
    `不明の割合: 単金 ${show(m.rateNullPct)} / 都道府県 ${show(m.prefectureNullPct)} / 開始日 ${show(m.startNullPct)} / 希望単金 ${show(m.desiredRateNullPct)}` +
      ` / 必須スキル空 ${show(m.requiredEmptyPct)} / 辞書にないスキル語 ${m.unknownSkillTokens}語（${show(m.unknownSkillPct)}）`,
    `一次選抜: 評価${m.pairsEvaluated}組 → 判定対象${m.pairsSelected}組 / 候補0件の案件 ${show(m.noCandidatePct)}（${m.projectsConsidered}件中） / 除外: ${exclusions || 'なし'}`,
    `AI判定: ${m.judged}組（平均${show(m.avgScore, '点')}） / 基準未満で降格 ${m.demoted} / 不適合 ${m.rejected} / 再提案抑制 ${m.suppressed} / 判定繰越 ${m.deferred} / 判定失敗（ルールの結果で保存）${m.heuristicFallback}`,
    `コスト: 約${m.costJpy}円（キャッシュ読込率 ${show(m.cacheReadPct)}） / 紹介文面 ${m.drafts}通 / 担当者指定の下書き ${m.requestedDrafts}件`,
  ];
  if (m.extractModelFallback) {
    lines.push(`抽出モデル: ${extractModel()} で代替中（設定: ${configuredExtractModel()}。ANTHROPIC_MODEL_EXTRACT を後継のモデルに変更してください）`);
  }
  return lines;
}

// スプレッドシート「メトリクス」タブの1行（列の名前 → 値）
export function metricsRowValues(m: BatchMetrics): Record<string, string | number | null> {
  return {
    実行日時: m.at,
    モード: m.mode,
    メール数: m.mails,
    '抽出件数(案件)': m.projects,
    '抽出件数(要員)': m.engineers,
    'null率(単金)': m.rateNullPct,
    'null率(都道府県)': m.prefectureNullPct,
    'null率(開始日)': m.startNullPct,
    'null率(希望単金)': m.desiredRateNullPct,
    必須スキル空率: m.requiredEmptyPct,
    未知スキル語数: m.unknownSkillTokens,
    候補0件の案件率: m.noCandidatePct,
    '除外理由内訳(JSON)': JSON.stringify(m.exclusions),
    判定数: m.judged,
    Sonnet平均点: m.avgScore,
    ゲート降格数: m.demoted,
    不適合数: m.rejected,
    再提案抑制数: m.suppressed,
    判定繰越数: m.deferred,
    ヒューリスティック退避数: m.heuristicFallback,
    キャッシュ読込率: m.cacheReadPct,
    'バッチコスト(円)': m.costJpy,
    下書き作成数: m.drafts,
    スキル語数: m.skillTokens,
    評価組数: m.pairsEvaluated,
    判定対象組数: m.pairsSelected,
    担当者指定の下書き作成数: m.requestedDrafts,
    抽出モデル代替: m.extractModelFallback ? 1 : 0,
  };
}

// しきい値の警告を積み、Sheets運用の本番では「メトリクス」タブに1行追記する（demo・Notion運用は書かない）。
// 書けなくてもバッチは止めない（1回分の記録が欠けるだけ。警告としてサマリに載せる）
export async function recordBatchMetrics(m: BatchMetrics): Promise<void> {
  for (const w of metricWarnings(m)) recordHealEvent('warn', w);
  if (isDemo()) return;
  if (dbProvider() !== 'sheets') {
    console.log('SESメトリクス: Notion運用ではメトリクスを表に記録しません（サマリメールの診断レポートに載せます）');
    return;
  }
  if (!sheetsDbConfigured()) return;
  try {
    await appendMetricsRowSheets(metricsRowValues(m));
  } catch (err) {
    console.warn(`SESメトリクス: 記録に失敗: ${safeErr(err)}`);
    recordHealEvent('warn', `バッチのメトリクスをスプレッドシート「${METRICS_TAB}」タブに記録できませんでした（この回の分は欠けます）`);
  }
}
