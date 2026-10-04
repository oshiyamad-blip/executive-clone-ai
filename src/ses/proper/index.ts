// プロパー（自社社員のスキルシート）→ 案件候補の実行本体。SESバッチ（runSesBatch）と ses:own-match から呼ぶ。
// 本番: スキルシートのフォルダと管理表「プロパー管理」を同期 → 稼働可の社員 × 直近の募集中案件を突合 →
//       案件スプレッドシートの「プロパー候補」タブへ保存（提案の全員に返信文面つき。担当者メールで次回バッチが下書きにする）
// demo: fixtureの自社社員 × 渡された案件で突合と文面作成だけを行う（Drive・Sheets・LLMに接続しない）
// コンソールには件数だけを出す（氏名・案件名は出さない。詳細はサマリメールと案件スプレッドシート）
import { isDemo, properEnabled, properMasterEnabled, properProjectLookbackDays, properJudgePerEngineer, properAuditSample, properFailGatePct, properJudgeBudgetJpy, maxCandidatesPerItem } from '../config.js';
import { loadRosterEngineers, rosterConfigured } from './roster.js';
import { safeErr } from '../redact.js';
import { ownPairsForJudge, auditPairsForJudge, signedMan } from '../ownMatch.js';
import { getLlmUsageLog } from '../../llm/usage.js';
import { usageCostJpy } from '../../llm/pricing.js';
import { judgeProperPairs, cachedProjectIdsFor, pruneJudgeCache, properBudgetExhausted } from './judge.js';
import { startJudgeBudget } from '../match.js';
import { pastRunDeadline } from '../schedule.js';
import { techNamesIn } from '../skillDict.js';
import { wideRegionOf, isFullRemoteLocation } from '../prefecture.js';
import { loadSkillEquivalences } from '../skillEquiv.js';
import { writeDemoArtifact } from '../store.js';
import { recordHealEvent, recordFatal } from '../heal/events.js';
import { loadFixtureProperEngineers } from '../fixtures/ownEngineers.js';
import { fetchOpenProjects } from '../../database/index.js';
import {
  saveProperCandidatesSheets,
  newProperCandidateIdsSheets,
  retireProperCandidatesSheets,
  sheetsDbConfigured,
  PROPER_CANDIDATE_TAB,
} from '../../database/sheets.js';
import { syncProperMaster, loadProperEngineers, properLabelOf, properMasterConfigured, type ProperSyncResult } from './master.js';
import { buildProperProposalDraft } from './proposal.js';
import { writeSalesList, salesListConfigured, salesRowOf, mergeSalesRows, HIGH_RATE_GAP_MAN, SalesHeaderMismatchError } from './salesList.js';
import type { Project, ProperEngineer, ProperCandidate, OwnMatch, ProperJudgment } from '../../types/index.js';

export interface ProperRunResult {
  demo: boolean;
  sync: ProperSyncResult | null;
  engineers: number; // 突合対象（稼働可）の社員数
  projects: number; // 突合対象の案件数
  candidates: ProperCandidate[];
  saved: number; // 「プロパー候補」タブに追加・更新した行数
  added: number; // 今回初めて見つかった候補（サマリを送るかの判断に使う）
  retired: number; // 稼働可でなくなった社員の候補として退役させた行数
  salesRows: number | null; // 営業リストに書き出した行数（未設定・失敗・見送りは null）
  deferred?: number; // 費用の上限・実行の期限で次回に回したAI判定の組数
  skipped?: string[]; // 書き込みを見送った理由（サマリに載せる固定文言。氏名・案件名・組のキーは含めない）
}

// Sheetsの案件タブは全行を読むため、直近の遡り期間に絞った上での上限は大きめでよい（Notionは100件で頭打ち）
const PROJECT_FETCH_LIMIT = 1000;

export interface JudgeStats {
  prefiltered: number; // ルールの足切りを通った組
  judged: number; // AI判定した組（控えの再利用を含む）
  cached: number;
  rejected: number; // AIが見送りとした組
  outOfArea: number; // 勤務地をルールで読めず、AIが読んだ出社先が本人と違う地方だった組
  failed: number; // AI判定に失敗した組
  overCap: number; // 判定の上限（PROPER_JUDGE_PER_ENGINEER）で判定しなかった組
  deferred: number; // 費用の上限・実行の期限で判定せず次回に回した組（失敗に数えない。下の2つの合計）
  deferredBudget: number;
  deferredDeadline: number;
  audited: number; // 足切りで落とした組から監視のために判定した組（上の judged には含めない）
  auditHits: number; // うち、候補になった組（見送りでない組）
  auditTokens: { input: number; output: number; costJpy: number }; // 監視の判定に使った量（キャッシュの分は入力に含む）
  gated: boolean; // AI判定の失敗が多く、この回は候補の保存と営業リストの書き込みを見送る
}

const SKILL_TENTATIVE_NOTE = '【参考提案】スキルは許容範囲内のため人によるご確認を推奨。';

// 案件単価が希望単価をこの額（万円）以上上回る案件は、求められる水準が大きく上とみなし、AIが推奨しない限り候補にしない
export const LEVEL_GAP_MAN = 30;

// AIの判定を候補に反映する。見送りは null（候補にしない）
export function applyJudgment(m: OwnMatch, j: ProperJudgment): OwnMatch | null {
  if (j.verdict === 'reject') return null;
  if (j.verdict !== 'recommend' && (m.rateGapMan ?? 0) >= LEVEL_GAP_MAN) return null;
  // 求める水準が高く経験の無い必須がある高単価の組は、候補に残したまま要確認（優先度C）にする（商流が浅い高単価の組は利益が大きいため外さない）
  const highGap = (m.rateGapMan ?? 0) >= HIGH_RATE_GAP_MAN;
  const unmetRequired = (j.checks ?? []).filter((c) => c.kind === '必須' && c.status === 'unmet').map((c) => c.requirement);
  const overLevel = highGap && j.rateReason === 'high_level' && unmetRequired.length > 0;
  const notes = [
    ...(overLevel ? [`［確認］案件単価が希望より${m.rateGapMan}万円高く求める水準も高い案件で、経験の無い必須があります（${unmetRequired.join('、')}）。`] : []),
    ...j.reviewNotes.map((n) => `［確認］${n}。`),
    ...j.concerns.map((c) => `［確認］${c.replace(/。$/, '')}。`),
  ].join('');
  return {
    ...m,
    band: j.verdict === 'recommend' ? 'strong' : 'tentative',
    needsReview: m.needsReview || j.reviewNotes.length > 0 || overLevel,
    matchedSkills: j.met,
    missingSkills: j.gaps,
    // スキルの一致率による参考提案の注記はAIの判定で置き換える（鮮度・単価・年数の注記は残す）
    reason: `${notes}${m.reason.replace(SKILL_TENTATIVE_NOTE, '')}`,
    judgment: j,
  };
}

// 同じ案件が別のメール（別の会社経由・再送）で届いたものを1件にまとめる。案件名（括弧の補足を除く）が同じで単価の差が
// DEDUPE_RATE_GAP_MAN 以内なら同じ案件とみなし、単価の高い方（同じなら新しい受信）を残す（商流で単価が数万円違うことがある）。
// 単価の無い案件はまとめない（同じ名前でSE枠・PG枠のように役割が違うことがある）。
// 丸括弧の中（「会員認証基盤移行担当」「API担当」のような役割・担当）が違う案件、必須の技術が重ならない案件もまとめない
// （9/29の試行で、案件名が同じ別の枠を1件にまとめてしまう誤りが53組中6組あった）。
// 残した案件のIDに、まとめた他のメールの営業元会社を返す（営業リストの確認事項に出す）
const DEDUPE_RATE_GAP_MAN = 10;
const DEDUPE_MIN_TECH_OVERLAP = 0.5;
const DEDUPE_MIN_TEXT_OVERLAP = 0.3; // 片方に技術名が無いとき
const DEDUPE_SAME_TEXT = 0.6; // 技術名の重なりが少なくても、必須の書きぶりがほぼ同じなら同じ案件
// 名前の違う同じ案件とみなす条件（sameOpeningRetitled）
const DEDUPE_RETITLED_TITLE_OVERLAP = 0.3;
const DEDUPE_RETITLED_CLOSE_TITLE = 0.4; // これ未満なら必須の書きぶりがほぼ同じ（DEDUPE_SAME_TEXT）ことも求める
const DEDUPE_RETITLED_REQ_OVERLAP = 0.3;
const DEDUPE_RETITLED_RATE_GAP_MAN = 5;
const DEDUPE_RETITLED_SAME_TITLE = 0.8; // 名前がほぼ同じなら単価の差は同じ名前の案件と同じ幅まで許す
const DEDUPE_RETITLED_ROLE_SHARED = 0.4; // 括弧の役割の文字がこの割合も相手の名前に無ければ別の枠

// 丸括弧の補足のうち役割・担当を表すもの。案件番号（「DC-23615」）や働き方（「フルリモート」「急募」）は営業元ごとの書き添えなので除く
function roleKeyOf(title: string): string {
  return [...title.normalize('NFKC').matchAll(/[(（]([^()（）]*)[)）]/g)]
    .map((m) => m[1].replace(/\s+/g, '').toLowerCase())
    .filter((k) => k && !/^[a-z]{0,4}[-_#]?\d[\w-]*$/.test(k) && !/^(?:フル)?リモート|在宅|常駐|出社|急募/.test(k))
    .join('|');
}

// 両方に括弧の補足があり、互いに含まず、使う文字も半分以上違うときだけ別の役割とみなす
// （「（証券向けサポート募集）」と「（証券向け）」、「（Java+PHP）」と「（PHP+Java）」は同じ枠の書き方の違い）
function rolesDiffer(ra: string, rb: string): boolean {
  if (!ra || !rb || ra === rb || ra.includes(rb) || rb.includes(ra)) return false;
  const ca = new Set(ra);
  const cb = new Set(rb);
  const inter = [...ca].filter((c) => cb.has(c)).length;
  return inter / (ca.size + cb.size - inter) < 0.5;
}

// 同じ案件の再送・転送とみなせる2件か（役割が同じで、必須の技術が半分以上重なる。技術が片方にしか無いものは別の枠）
export function sameOpening(a: Project, b: Project): boolean {
  if (rolesDiffer(roleKeyOf(a.title), roleKeyOf(b.title))) return false;
  return requirementsMatch(a, b);
}

function requirementsMatch(a: Project, b: Project): boolean {
  const ta = new Set(techNamesIn(a.requiredSkills.join('、')).map((t) => t.toLowerCase()));
  const tb = new Set(techNamesIn(b.requiredSkills.join('、')).map((t) => t.toLowerCase()));
  const text = textOverlap(a.requiredSkills.join(''), b.requiredSkills.join(''));
  if (ta.size === 0 || tb.size === 0) return text >= DEDUPE_MIN_TEXT_OVERLAP;
  return jaccard(ta, tb) >= DEDUPE_MIN_TECH_OVERLAP || text >= DEDUPE_SAME_TEXT;
}

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const inter = [...a].filter((x) => b.has(x)).length;
  return inter / (a.size + b.size - inter);
}

// 必須の書きぶりの近さ（2文字ずつの重なり）。技術名の無い要件（「基地局の置局施工管理」）どうしを比べる
export function textOverlap(a: string, b: string): number {
  const grams = (s: string) => {
    const t = s.normalize('NFKC').toLowerCase().replace(/[\s、,・/()（）]/g, '');
    return new Set(Array.from({ length: Math.max(0, t.length - 1) }, (_, i) => t.slice(i, i + 2)));
  };
  return jaccard(grams(a), grams(b));
}

// 出社先の駅・地名の先頭（「勝どき（出社メイン）」「勝どき駅」を同じにする）。フルリモート等で地名が無ければ空
function locationKeyOf(location: string): string {
  const head = location.normalize('NFKC').replace(/[(（【\[].*?[)）】\]]/g, '').split(/[、,/／・\s]/)[0] ?? '';
  const key = head.replace(/駅$|常駐$|出社$/g, '').trim();
  return /リモート|在宅|未定|不明|応相談/.test(key) ? '' : key;
}

// 案件名の書き方が違う同じ案件か（営業元ごとに名前を付け直す：「システム再構築支援」と「再構築支援（金融システム再構築プロジェクト）」）。
// 名前が違う分、出社先・必須の書きぶり・案件名の書きぶりの重なりをそろって求め、単価の差も小さいものに限る。
// 9/29〜30の実メール1498件で、名前の違う別の枠（NVH解析と衝突解析、LLM開発と要件整理、別システムのJava開発）を
// まとめないよう決めた値
function sameOpeningRetitled(a: Project, b: Project): boolean {
  const ra = a.rateMax ?? a.rateMin;
  const rb = b.rateMax ?? b.rateMin;
  if (ra === null || rb === null) return false;
  const la = locationKeyOf(a.location);
  if (!la || la !== locationKeyOf(b.location)) return false;
  const title = textOverlap(a.title, b.title);
  const req = textOverlap(a.requiredSkills.join(''), b.requiredSkills.join(''));
  if (Math.abs(ra - rb) > DEDUPE_RETITLED_RATE_GAP_MAN && title < DEDUPE_RETITLED_SAME_TITLE) return false;
  if (title < DEDUPE_RETITLED_TITLE_OVERLAP || req < DEDUPE_RETITLED_REQ_OVERLAP) return false;
  if (title < DEDUPE_RETITLED_CLOSE_TITLE && req < DEDUPE_SAME_TEXT) return false;
  // 括弧の役割は、相手の案件名のどこにも書かれていないときだけ別の枠とみなす（名前と括弧が入れ替わった書き方があるため）
  const roleClash = (x: Project, y: Project) => {
    const role = roleKeyOf(x.title);
    if (!role) return false;
    const other = new Set(y.title.normalize('NFKC').toLowerCase());
    const chars = [...new Set(role)];
    return chars.filter((c) => other.has(c)).length / chars.length < DEDUPE_RETITLED_ROLE_SHARED;
  };
  return !roleClash(a, b) && !roleClash(b, a) && requirementsMatch(a, b);
}

export function dedupeProjects(projects: Project[]): { kept: Project[]; others: Map<string, string[]>; aliasOf: Map<string, string> } {
  const core = (t: string) => t.normalize('NFKC').replace(/[(（【\[].*?[)）】\]]/g, '').replace(/\s+/g, '').toLowerCase();
  const rateOf = (p: Project) => p.rateMax ?? p.rateMin;
  const byTitle = new Map<string, Project[]>();
  const kept: Project[] = [];
  for (const p of projects) {
    if (rateOf(p) === null || !core(p.title)) kept.push(p);
    else byTitle.set(core(p.title), [...(byTitle.get(core(p.title)) ?? []), p]);
  }
  const byRate = (a: Project, b: Project) =>
    (rateOf(b) as number) - (rateOf(a) as number) || new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime();
  const clusters: Project[][] = [];
  for (const group of byTitle.values()) {
    const own: Project[][] = [];
    for (const p of [...group].sort(byRate)) {
      const c = own.find((cl) => Math.abs((rateOf(cl[0]) as number) - (rateOf(p) as number)) <= DEDUPE_RATE_GAP_MAN && sameOpening(cl[0], p));
      if (c) c.push(p);
      else own.push([p]);
    }
    clusters.push(...own);
  }
  // 名前の違う同じ案件をまとめる（代表どうしを比べ、単価の高い方・新しい受信を代表に残す）
  const merged: Project[][] = [];
  for (const cl of [...clusters].sort((x, y) => byRate(x[0], y[0]))) {
    // 同じ名前どうしは上で単価の幅・役割を見て分けたので、ここでは名前の違うものだけをまとめる
    const into = merged.find((m) => core(m[0].title) !== core(cl[0].title) && sameOpeningRetitled(m[0], cl[0]));
    if (into) into.push(...cl);
    else merged.push([...cl]);
  }
  const others = new Map<string, string[]>();
  const aliasOf = new Map<string, string>();
  for (const cl of merged) {
    kept.push(cl[0]);
    for (const p of cl.slice(1)) aliasOf.set(p.id, cl[0].id);
    if (cl.length > 1) others.set(cl[0].id, [...new Set(cl.slice(1).map((p) => p.agentCompany).filter(Boolean))]);
  }
  return { kept, others, aliasOf };
}

// AI判定する組の選び方。控えにある（判定済みの）組は上限に関係なく選び、控えに無い組は
// 社員ごと・案件ごとの新規判定数が上限未満のときだけ選ぶ。上限で漏れた組は控えが増えるにつれ次の回に回る。並びは入力のまま
export function selectPairsForJudge<T extends { match: { ownEngineerId: string; projectId: string } }>(
  all: T[],
  cachedIdsOf: (engineerId: string) => Set<string> | undefined,
  perEngineer: number,
  perProject: number,
): T[] {
  const byEngineer = new Map<string, number>();
  const byProject = new Map<string, number>();
  return all.filter((p) => {
    const { ownEngineerId: e, projectId: pr } = p.match;
    if (cachedIdsOf(e)?.has(pr)) return true;
    if ((byEngineer.get(e) ?? 0) >= perEngineer || (byProject.get(pr) ?? 0) >= perProject) return false;
    byEngineer.set(e, (byEngineer.get(e) ?? 0) + 1);
    byProject.set(pr, (byProject.get(pr) ?? 0) + 1);
    return true;
  });
}

// 足切りの監視に回す組。ルールの足切りで落ちた「惜しい組」から PROPER_AUDIT_SAMPLE 組まで。通常の判定に回す組・控えにある組は除く
export function pickAuditPairs(
  engineers: ProperEngineer[],
  projects: Project[],
  now: Date,
  regular: Array<{ match: OwnMatch }>,
  cachedIdsOf: (engineerId: string) => Set<string> | undefined,
): Array<{ match: OwnMatch; rulePass: boolean }> {
  const n = properAuditSample();
  if (n <= 0) return [];
  const taken = new Set(regular.map((p) => p.match.id));
  return auditPairsForJudge(engineers, projects, Number.MAX_SAFE_INTEGER, now)
    .filter((p) => !taken.has(p.match.id) && !cachedIdsOf(p.match.ownEngineerId)?.has(p.match.projectId))
    .slice(0, n);
}

// 失敗がこの組数以上のときだけ失敗率を見る（数組の失敗で回全体を止めないため）
export const FAIL_GATE_MIN_FAILED = 5;

// AI判定の失敗が多い回か（失敗数 ≥ 最小件数 かつ 失敗率 > 閾値%。閾値 0 は無効）
export function failGateTripped(failed: number, judged: number, pct = properFailGatePct()): boolean {
  if (pct <= 0 || failed < FAIL_GATE_MIN_FAILED) return false;
  return (failed / (judged + failed)) * 100 > pct;
}

// 稼働可の社員 × 案件 → ルールの足切り → AI判定（根拠を経歴と照合）→ 社員ごと・案件ごとの上限で候補にする
export async function buildProperCandidates(
  engineers: ProperEngineer[],
  projects: Project[],
  now = new Date(),
): Promise<{ candidates: ProperCandidate[]; stats: JudgeStats; auditHitKeys: string[] }> {
  const engineerById = new Map(engineers.map((e) => [e.id, e]));
  const deduped = dedupeProjects(projects);
  projects = deduped.kept;
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const perItem = properJudgePerEngineer();
  const all = ownPairsForJudge(engineers, projects, Number.MAX_SAFE_INTEGER, now);
  const cachedByEngineer = new Map<string, Set<string>>();
  for (const e of engineers) cachedByEngineer.set(e.id, await cachedProjectIdsFor(e));
  const pairs = selectPairsForJudge(all, (id) => cachedByEngineer.get(id), perItem, perItem);
  const stats: JudgeStats = {
    prefiltered: all.length, judged: 0, cached: 0, rejected: 0, outOfArea: 0, failed: 0, overCap: all.length - pairs.length,
    deferred: 0, deferredBudget: 0, deferredDeadline: 0,
    audited: 0, auditHits: 0, auditTokens: { input: 0, output: 0, costJpy: 0 }, gated: false,
  };
  const auditHitKeys: string[] = [];
  const judged: OwnMatch[] = [];
  // 本体の判定予算と同じ考え方で、プロパー判定の開始からのLLM費用に上限を掛ける（監視の判定も同じ上限の中）
  const budget = startJudgeBudget(properJudgeBudgetJpy());
  // 判定結果を候補の元（judged）に反映する。監視の組は別の集計に数える
  const consume = (list: typeof pairs, outcomes: Awaited<ReturnType<typeof judgeProperPairs>>, st: JudgeStats): OwnMatch[] => {
    const out: OwnMatch[] = [];
    list.forEach((p, i) => {
      const o = outcomes[i];
      // 先送りの組は失敗ではない（候補にも要確認にもしない。営業リストの既存の行は残り、次の回の判定が続く）
      if (o.deferred) {
        st.deferred += 1;
        if (o.deferReason === 'budget') st.deferredBudget += 1;
        else st.deferredDeadline += 1;
        return;
      }
      if (!o.judgment) {
        st.failed += 1;
        // AI判定に失敗した組は、ルールだけの基準も満たすときに限り要確認で残す
        if (p.rulePass) out.push({ ...p.match, needsReview: true, reason: `AI判定に失敗したため要確認です。${p.match.reason}` });
        return;
      }
      st.judged += 1;
      if (o.cached) st.cached += 1;
      // 勤務地をルールで読めなかった案件は、AIが読んだ出社先の地方で判定する（本人と違う地方の出社は候補にしない）
      const project = projectById.get(p.match.projectId) as Project;
      const engineer = engineerById.get(p.match.ownEngineerId) as ProperEngineer;
      const fullRemote = project.remote === 'full' || isFullRemoteLocation(project.location);
      const aiRegion = wideRegionOf(o.judgment.workPrefecture ?? null);
      const ownRegion = wideRegionOf(engineer.prefecture);
      if (!project.prefecture && !fullRemote && aiRegion && ownRegion && aiRegion !== ownRegion) {
        st.outOfArea += 1;
        return;
      }
      const m = applyJudgment(p.match, o.judgment);
      const dup = deduped.others.get(p.match.projectId);
      if (m && dup) m.reason = `［確認］同じ案件が別のメールでも届いています${dup.length > 0 ? `（${dup.join('、')}）` : ''}。${m.reason}`;
      if (m) out.push(m);
      else st.rejected += 1;
    });
    return out;
  };
  const toJudge = (list: typeof pairs) => list.map((p) => ({ engineer: engineerById.get(p.match.ownEngineerId) as ProperEngineer, project: projectById.get(p.match.projectId) as Project }));
  judged.push(...consume(pairs, await judgeProperPairs(toJudge(pairs), projects, { budget }), stats));
  // 失敗の多い回（監視の判定は含めない）は、呼び出し側が候補の保存と営業リストの書き込みを見送る
  stats.gated = failGateTripped(stats.failed, stats.judged);
  // 足切りの監視: 落とした組から少しだけ判定し、良い組を落としていないかを見る。使った量は呼び出し前後のログの差で数える
  const audit = pickAuditPairs(engineers, projects, now, pairs, (id) => cachedByEngineer.get(id));
  // 費用の上限に達した回・期限を過ぎた回は監視をしない（判定の続きを優先する）
  if (audit.length > 0 && !properBudgetExhausted(budget) && !pastRunDeadline()) {
    const logStart = getLlmUsageLog().length;
    const scratch: JudgeStats = { ...stats, judged: 0, cached: 0, rejected: 0, outOfArea: 0, failed: 0, deferred: 0, deferredBudget: 0, deferredDeadline: 0 };
    const hits = consume(audit, await judgeProperPairs(toJudge(audit), projects, { budget }), scratch);
    // 監視の当たりはルール上は候補外の組なので、営業リストの候補には入れない（数えて、試運転ではキーをラベルに残す）
    const auditHit = hits.filter((m) => m.judgment);
    auditHitKeys.push(...auditHit.map((m) => `${m.ownEngineerId}|${m.projectId}`));
    stats.audited = scratch.judged;
    stats.auditHits = auditHit.length;
    for (const u of getLlmUsageLog().slice(logStart)) {
      stats.auditTokens.input += u.inputTokens + (u.cacheCreationInputTokens ?? 0) + (u.cacheReadInputTokens ?? 0);
      stats.auditTokens.output += u.outputTokens;
      stats.auditTokens.costJpy += usageCostJpy(u);
    }
  }
  // 並び: AIの推奨 → 条件つき → 要確認、同じ区分の中はAIの見立ての合い方（必須の満たす・近い経験・経験なしの重みづけ）→ ルールの並び。
  // 社員ごと・案件ごとの上限を掛ける（上限の中にAIが良いと見た組から入るように）
  const cat = (m: OwnMatch) => (m.needsReview ? 2 : m.band === 'strong' ? 0 : 1);
  const order = judged
    .map((m, i) => ({ m, i, fit: judgmentFit(m.judgment) }))
    .sort((a, b) => cat(a.m) - cat(b.m) || b.fit - a.fit || a.i - b.i);
  const limit = maxCandidatesPerItem();
  const perEngineer = new Map<string, number>();
  const perProject = new Map<string, number>();
  const candidates: ProperCandidate[] = [];
  const seen = new Set<string>();
  for (const { m } of order) {
    // 人がシートの行を複製していても、同じ社員×案件の候補は1件にする（同じIDの行が2つあると
    // 担当者メールを入れた側の行が下書き依頼として読まれない）
    if (seen.has(m.id)) continue;
    // 基準を超える組（clearsBar）は上限に関係なく載せ、ほかは社員ごと・案件ごとに上限まで
    // 上限を超えた組も、AIが見送っていなければ「参考」として残す（営業から候補の数を求められているため。
    // 主な候補とは優先度で分け、見送り理由・精度チェックで参考の当たり率を測る）
    const full = (perEngineer.get(m.ownEngineerId) ?? 0) >= limit || (perProject.get(m.projectId) ?? 0) >= limit;
    // 必須の半分以上が経験なしの条件つきは、上限に関係なく「参考」に下げる（数は出しつつ主な候補の当たり率を保つ）
    const reference = (full && !clearsBar(m)) || weakOnRequired(m);
    const engineer = engineerById.get(m.ownEngineerId);
    const project = projectById.get(m.projectId);
    if (!engineer || !project) continue;
    seen.add(m.id);
    if (!reference) {
      perEngineer.set(m.ownEngineerId, (perEngineer.get(m.ownEngineerId) ?? 0) + 1);
      perProject.set(m.projectId, (perProject.get(m.projectId) ?? 0) + 1);
    }
    // 元のメールにAIへの指示らしき記載がある案件には、提案文面（下書きの元）を用意しない（要確認で人が確かめる）
    const suspicious = project.injectionSuspected || /AIへの指示らしき記載/.test(m.judgment?.reviewNotes.join('') ?? '');
    const draftToProject = suspicious ? undefined : buildProperProposalDraft(engineer, project, m.judgment?.pitch);
    candidates.push({ ...m, properLabel: properLabelOf(engineer), ...(draftToProject ? { draftToProject } : {}), ...(reference ? { reference: true } : {}) });
  }
  return { candidates, stats, auditHitKeys };
}

// 件数の上限（MAX_CANDIDATES_PER_ITEM）を超えても載せる組: AIの推奨、または条件つきで経歴の裏付けのある要件が足りない要件以上。
// 要確認（根拠が経歴に無い等）は含めない
export function clearsBar(m: OwnMatch): boolean {
  if (m.needsReview || !m.judgment) return false;
  if (m.judgment.verdict === 'recommend') return true;
  const r = requiredCounts(m.judgment);
  return r.met - r.close - r.unmet >= 0;
}

// 条件つきのうち、必須の2件以上かつ半分以上が経験なしで、満たす必須が1件以下の組
export function weakOnRequired(m: OwnMatch): boolean {
  if (!m.judgment || m.judgment.verdict === 'recommend' || !m.judgment.checks) return false;
  const r = requiredCounts(m.judgment);
  const total = r.met + r.close + r.unmet;
  return r.unmet >= 2 && r.unmet * 2 >= total && r.met <= 1;
}

// 必須の要件の照合結果の数（尚可は数えない）。照合結果の無い古い判定は「合っている点」「足りない点」の行から数える
function requiredCounts(j: ProperJudgment): { met: number; close: number; unmet: number } {
  if (j.checks) {
    const req = j.checks.filter((c) => c.kind === '必須');
    return {
      met: req.filter((c) => c.status === 'met').length,
      close: req.filter((c) => c.status === 'close').length,
      unmet: req.filter((c) => c.status === 'unmet').length,
    };
  }
  const close = j.met.filter((l) => /（近い経験） ← /.test(l)).length;
  return { met: j.met.length - close, close, unmet: Math.max(0, j.gaps.length - close) };
}

// AIの見立ての合い方（必須だけで数える。尚可の数で並びが動かないように）: 満たす1・近い経験0.5・経験なし−2。
// 経験の無い必須がある組は、近い経験ばかりの組より下にする
export function judgmentFit(j: ProperJudgment | undefined): number {
  if (!j) return -Infinity;
  const r = requiredCounts(j);
  return r.met + 0.5 * r.close - 2 * r.unmet;
}

function logJudge(s: JudgeStats): void {
  const log = s.overCap > 0 || s.deferred > 0 ? console.warn : console.log;
  log(
    `プロパー判定: 足切り通過${s.prefiltered}組 → AI判定${s.judged}組（控えの再利用${s.cached}）・見送り${s.rejected}・勤務地が別の地方${s.outOfArea}・失敗${s.failed}` +
      (s.overCap > 0 ? `・上限（PROPER_JUDGE_PER_ENGINEER）で判定しなかった組${s.overCap}` : ''),
  );
  if (s.deferred > 0) {
    console.warn(
      `プロパー判定: 判定${s.judged - s.cached}組（控え${s.cached}組）・先送り${s.deferred}組（費用の上限${s.deferredBudget}／時間${s.deferredDeadline}。次回の実行で続きを判定します）`,
    );
  }
  if (s.gated) {
    console.warn(`プロパー判定: AI判定の失敗が多いため（${s.judged + s.failed}組中${s.failed}組）、今回は候補の保存と営業リストの書き込みを見送りました`);
  }
  if (s.audited > 0) {
    console.log(
      `足切りの監視: ${s.audited}組判定・うち当たり${s.auditHits}組 / 監視の判定: 入力${s.auditTokens.input}・出力${s.auditTokens.output}トークン（約${Math.round(s.auditTokens.costJpy * 10) / 10}円）`,
    );
  }
}

function logCounts(prefix: string, r: ProperRunResult): void {
  const drafts = r.candidates.filter((c) => c.draftToProject).length;
  console.log(`${prefix}: 社員${r.engineers}名 × 案件${r.projects}件 → 候補${r.candidates.length}件（提案文面${drafts}件）`);
}

async function runProperDemo(projects: Project[]): Promise<ProperRunResult> {
  const engineers = loadFixtureProperEngineers();
  const { candidates, stats } = await buildProperCandidates(engineers, projects);
  logJudge(stats);
  writeDemoArtifact('proper-candidates', candidates);
  // 営業リストの行（本番で営業用スプレッドシートの「全体」タブに書く内容）
  const projectById = new Map(projects.map((p) => [p.id, p]));
  writeDemoArtifact('proper-sales-list', mergeSalesRows(candidates.map((c) => salesRowOf(c, projectById.get(c.projectId))), []));
  const result: ProperRunResult = {
    demo: true, sync: null, engineers: engineers.length, projects: projects.length, candidates, saved: 0, added: candidates.length, retired: 0, salesRows: null,
  };
  logCounts('プロパー候補(DEMO・fixture社員)', result);
  return result;
}

function logSync(s: ProperSyncResult): void {
  console.log(
    `プロパー: スキルシート${s.listed}件（新規${s.added}・更新${s.updated}・変更なし${s.unchanged}・` +
      `抽出失敗${s.failed}・次回へ保留${s.deferred}・所在不明${s.missing}・未対応形式${s.unsupportedNames.length}）`,
  );
}

// 要員リストを読めなかった回は、稼働中の社員の候補を退役させない（読めなかっただけで一覧から消えたとみなさない）
let rosterReadOk = true;

async function loadRosterSafely(): Promise<ProperEngineer[]> {
  rosterReadOk = true;
  if (!rosterConfigured()) return [];
  try {
    return await loadRosterEngineers();
  } catch (err) {
    rosterReadOk = false;
    console.error(`要員リスト: 読み込みに失敗しました（今回は要員リストの社員を使いません）: ${safeErr(err)}`);
    recordHealEvent('warn', '要員リストを読めませんでした（サービスアカウントへの共有とシートIDを確認してください）');
    return [];
  }
}

// 営業リストの失敗は候補の保存（案件スプレッドシート）を止めない
async function writeSalesListSafely(
  candidates: ProperCandidate[],
  projects: Project[],
  engineers: ProperEngineer[],
  openProjects: { ids: Set<string>; aliasOf: Map<string, string> },
): Promise<{ rows: number | null; skipped?: string }> {
  if (!salesListConfigured()) return { rows: null };
  try {
    const n = await writeSalesList(candidates, projects, engineers, openProjects);
    console.log(`営業リスト: ${n ?? 0}行を書き出しました`);
    return { rows: n };
  } catch (err) {
    // 見出しが今の並びと違うときは何も書いていない。差は列名だけを出し、実行は失敗扱いにして知らせる
    if (err instanceof SalesHeaderMismatchError) {
      const msg = `営業リストの見出しが変わっているため書き込みを見送りました（列: ${err.diff.join('、')}）。見出しを元に戻すか、システム担当が列の並びを合わせてください`;
      console.error(`営業リスト: ${msg}`);
      recordFatal(msg);
      return { rows: null, skipped: msg };
    }
    console.error(`営業リスト: 書き出しに失敗しました: ${safeErr(err)}`);
    recordHealEvent('warn', '営業リストのスプレッドシートに書き出せませんでした（サービスアカウントへの編集者での共有とシートIDを確認してください）');
    return { rows: null };
  }
}

// demoProjects は demo でだけ使う（本番は案件DBから直近の募集中案件を読む）。
// 未設定なら null（スキップ）。例外は呼び出し側で受け、本体のバッチは止めない
export async function runProperFlow(demoProjects: Project[] = []): Promise<ProperRunResult | null> {
  if (!isDemo() && !properEnabled()) {
    console.log('プロパー候補: PROPER_SKILLSHEET_FOLDER_ID / PROPER_MASTER_SPREADSHEET_ID（または PROPER_ROSTER_SPREADSHEET_ID）が未設定のためスキップします');
    return null;
  }
  await loadSkillEquivalences(); // 育てた同義辞書をスキル判定に反映
  if (isDemo()) return runProperDemo(demoProjects);

  const sync = properMasterEnabled() ? await syncProperMaster() : null;
  if (sync) logSync(sync);
  if (sync && sync.writeFailed > 0) {
    recordHealEvent('warn', `管理表「プロパー管理」への書き込みに${sync.writeFailed}件失敗しました（次回の実行で再試行します）`);
  }
  const engineers = [...(sync ? await loadProperEngineers(sync.presentFileIds) : []), ...(await loadRosterSafely())];
  const since = new Date(Date.now() - properProjectLookbackDays() * 24 * 60 * 60 * 1000);
  const projects = await fetchOpenProjects(PROJECT_FETCH_LIMIT, { receivedSince: since });
  const { candidates, stats } = await buildProperCandidates(engineers, projects);
  logJudge(stats);
  const deduped = dedupeProjects(projects);
  const openProjects = { ids: new Set(deduped.kept.map((p) => p.id)), aliasOf: deduped.aliasOf };

  const skipped: string[] = [];
  if (stats.gated) {
    const msg = `AI判定の失敗が多いため（${stats.judged + stats.failed}組中${stats.failed}組）、今回は候補の保存と営業リストの書き込みを見送りました`;
    skipped.push(msg);
    recordFatal(msg);
  }
  let saved = 0;
  let retired = 0;
  let added = 0;
  if (sheetsDbConfigured()) {
    if (!stats.gated) {
      added = (await newProperCandidateIdsSheets(candidates.map((c) => c.id))).size;
      saved = await saveProperCandidatesSheets(candidates);
    }
    // 管理表を読めたとき（未設定で空に見えているのではないとき）だけ、稼働可でなくなった社員の候補を退役させる
    if (rosterReadOk && (properMasterConfigured() || rosterConfigured())) retired = await retireProperCandidatesSheets(new Set(engineers.map((e) => e.id)));
    if (retired > 0) console.log(`プロパー候補: 稼働可でなくなった社員の候補${retired}行を退役させました（氏名・必要案件単価・文面を消去）`);
  } else if (candidates.length > 0 && !stats.gated) {
    console.warn(`プロパー候補: 案件スプレッドシート（SHEETS_DB_SPREADSHEET_ID）が未設定のため「${PROPER_CANDIDATE_TAB}」タブに保存できません`);
  }
  // 要員リストや案件を読めなかった回に書くと、営業中の要員の行が消えるため書かない（前回のまま残す）
  const canWriteSales = rosterReadOk && projects.length > 0 && !stats.gated;
  if (!canWriteSales && !stats.gated) console.warn('営業リスト: 要員リストか案件を読めなかったため、今回は書き出しません（前回のまま残します）');
  const sales = canWriteSales ? await writeSalesListSafely(candidates, projects, engineers, openProjects) : { rows: null };
  if (sales.skipped) skipped.push(sales.skipped);
  const pruned = await pruneJudgeCache();
  if (pruned > 0) console.log(`プロパー判定: 古い判定の控え${pruned}行を片付けました`);
  const result: ProperRunResult = {
    demo: false, sync, engineers: engineers.length, projects: projects.length, candidates, saved, added, retired, salesRows: sales.rows,
    ...(stats.deferred > 0 ? { deferred: stats.deferred } : {}),
    ...(skipped.length > 0 ? { skipped } : {}),
  };
  logCounts('プロパー候補', result);
  return result;
}

// 担当者メールによるプロパー候補の下書き依頼を受けてよい社員（管理表で稼働可の社員）のID。確かめられなければ null
// （依頼は作らずに次回へ回す）
export async function activeProperEngineerIds(): Promise<Set<string> | null> {
  if (isDemo() || !properEnabled() || (!properMasterConfigured() && !rosterConfigured())) return null;
  const master = properMasterConfigured() ? await loadProperEngineers(null) : [];
  let roster: ProperEngineer[] = [];
  try {
    roster = rosterConfigured() ? await loadRosterEngineers() : [];
  } catch (err) {
    console.warn(`要員リスト: 読み込みに失敗したため、下書き依頼の確認を次回に回します: ${safeErr(err)}`);
    return null;
  }
  return new Set([...master, ...roster].map((e) => e.id));
}

// ===== サマリメール =====

const MAIL_LIST_MAX = 30;

function candidateLine(c: ProperCandidate): string {
  const rate = c.projectRate !== null ? `${c.projectRate}万円/月` : '単価不明';
  // 社員ごとの必要案件単価（社内の原価に近い値）はメールに載せず、案件単価との差だけにする
  const need =
    c.requiredProjectRate !== null ? (c.rateGapMan !== null ? `必要案件単価との差${signedMan(c.rateGapMan)}万円` : '必要案件単価あり') : '必要案件単価未入力';
  const tags = `${c.band === 'tentative' ? '[参考提案]' : ''}${c.needsReview ? '[要確認]' : !c.meetsRate && c.rateGapMan !== null ? '[単価交渉]' : ''}`;
  return `・${tags}${c.properLabel} × ${c.projectTitle} — 案件${rate}（${need}）・スキル一致率${Math.round(c.skillMatchRate * 100)}%`;
}

// サマリメール用の節。forMail=false（コンソール用）では氏名・案件名を含めず件数だけにする
export function properSummaryLines(r: ProperRunResult | null, forMail: boolean): string[] {
  if (!r) return [];
  const lines = ['【プロパー候補（自社社員 × 案件）】'];
  lines.push(
    r.demo
      ? `プロパー候補: ${r.candidates.length}件（demo・fixture社員）`
      : `プロパー候補: ${r.candidates.length}件（詳細は案件スプシの『${PROPER_CANDIDATE_TAB}』タブ）`,
  );
  for (const m of r.skipped ?? []) lines.push(`■${m}`);
  if ((r.deferred ?? 0) > 0) lines.push(`・AI判定${r.deferred}組は費用の上限・時間の都合で次回の実行に回しました（営業リストの既存の行はそのまま残ります）`);
  const s = r.sync;
  if (s) {
    lines.push(
      `スキルシート: ${s.listed}件（新規${s.added}・更新${s.updated}・抽出失敗${s.failed}・次回へ保留${s.deferred}・所在不明${s.missing}）`,
    );
    if (s.failed > 0) lines.push('・抽出失敗は管理表「プロパー管理」の「抽出メモ」に理由があります');
  }
  if (forMail) {
    // ファイル名は氏名を含むことが多いため、サマリメールには件数だけを載せる（ファイルはスキルシートのフォルダで確認）
    if (s && s.unsupportedNames.length > 0) {
      lines.push(
        `・未対応形式のため読み取っていないファイル: ${s.unsupportedNames.length}件（スキルシートのフォルダで確認し、PDF・Excel・Word(.docx)・Googleドキュメントで保存してください）`,
      );
    }
    for (const c of r.candidates.slice(0, MAIL_LIST_MAX)) lines.push(candidateLine(c));
    if (r.candidates.length > MAIL_LIST_MAX) lines.push(`  ほか${r.candidates.length - MAIL_LIST_MAX}件`);
    if (!r.demo && r.candidates.length > 0) {
      lines.push(
        `■提案の下書き: 「${PROPER_CANDIDATE_TAB}」タブで「案件側文面」を確認し、「担当者メール」にご自身の会社アドレスを入れると、`,
        '  次回のバッチでそのアドレスから案件の元メールへの「全員に返信」下書きが作成されます（イニシャルのみ記載・必要案件単価は記載しません）',
      );
    }
  }
  lines.push('');
  return lines;
}
