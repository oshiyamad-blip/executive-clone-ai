// 通常バッチ（本番）のマッチング段: 一次選抜 → 最終判定 → 文面 → 保存を、案件・要員ごとの小分けで進める。
// - 判定したマッチはその場でまとめて保存し、候補ペアをすべて保存し終えた案件・要員にだけ「突合済」を付ける
//   （印はまとめて数分ごとと最後に付ける。付け損ねても、次回は判定済みのペアを除くので費用はかからない）
// - 実行時間の期限（SES_RUN_DEADLINE_MINUTES）を過ぎたら新しい判定を始めず、文面は定型文にする。突合済でない案件・要員は
//   次回の実行でも突合の対象に残るため、時間切れ・途中の失敗で判定し損ねたペアを取りこぼさない
// - 保存できなかったマッチ・文面を用意できなかったマッチのある案件・要員は突合済にしない（次回判定し直す）
// - 次回の実行では突合の対象期間（SES_MATCH_LOOKBACK_DAYS）を外れる案件・要員を先に突合し、それでも残れば異常終了で知らせる
// - 判定の予算（SES_JUDGE_BUDGET_JPY）に達した後の組・AI判定が一時的に失敗した組は「未判定」で保存し、その組の案件・要員は
//   突合済にしない（次回の実行で判定し、下書きは判定を通った組にだけ作る）。未判定の組は次回以降、一次選抜で選ばれ直さなくても
//   判定し直す（相手が対象期間を外れていれば ID で読み込む）。案件・要員が終わった等で判定できなくなった組は閉じる。
//   次回の実行では対象期間を外れる案件・要員の組は予算に達していても判定する
// - 上限であふれた組は、同じ案件・要員の組が不適合・低評価になって枠が空けば、同じ実行のうちに次点として判定する
import {
  primarySelectDetailed,
  prepareJudging,
  judgePairs,
  matchIdOf,
  formatPrimaryStats,
  startJudgeBudget,
  reportJudgeTally,
  judgeTallySnapshot,
  DEFERRED_BUDGET_CAUSE,
  addSelectedToTally,
  takeInjectionFlags,
  type PairScope,
  type PrimarySelectStats,
} from './match.js';
import type { SuppressionIndex } from './suppress.js';
import { createDrafts } from './draft.js';
import { persistMatches } from './notify.js';
import { markItemsMatched, closeDeferredMatches, markItemsInjectionSuspected } from '../database/index.js';
import { recordHealEvent, recordFatal } from './heal/events.js';
import { pastRunDeadline, isLastChance } from './schedule.js';
import { matchLookbackDays } from './config.js';
import { safeErr } from './redact.js';
import type { Project, Engineer, MatchPair, MatchResult } from '../types/index.js';

// 1回の判定・保存でまとめて扱うペア数の目安（保存の呼び出しを減らしつつ、途中で止まったときの手戻りを小さくする）
const PAIRS_PER_STEP = 20;

// 突合済の印と途中経過の記録をまとめて書く間隔（1ステップごとに大きなタブを読み直さないため）
const CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000;

interface Group {
  kind: 'project' | 'engineer';
  id: string;
  receivedAt: number;
  pairs: MatchPair[];
}

export interface IncrementalMatchResult {
  saved: MatchResult[]; // 保存できたマッチ（サマリに載せる）
  deferredItems: number; // 期限切れ・失敗で突合し終えず次回に回した案件・要員の数
  primaryStats: PrimarySelectStats; // 一次選抜の除外理由・上限の内訳
  closedPending: number; // 判定待ちのまま対象外になり閉じた組
}

export interface IncrementalMatchOptions {
  // 保存できたマッチを積む配列（途中で例外になっても、それまでに保存した分を呼び出し側が失わないように）
  saved?: MatchResult[];
  // 途中経過の記録（数分ごとと最後に、それまでに保存できたマッチを渡す）
  checkpoint?: (saved: MatchResult[]) => Promise<void>;
  // 以前「見送り」「ズレ」にした組（再提案抑制）
  suppression?: SuppressionIndex;
  // 判定待ちの組の相手のうち、突合の対象期間を外れた案件・要員
  pendingItems?: { projects: Project[]; engineers: Engineer[] };
}

// 候補ペアを「その組を受け持つ突合前の案件・要員」ごとにまとめる（案件が突合前ならその案件、そうでなければ要員）。
// どちらも突合済の判定待ちの組は、突合の対象期間の内にある側で受け持つ（期間外の相手で受け持つと、毎回「最後の機会」扱いになる）
export function groupPairs(
  projects: Project[],
  engineers: Engineer[],
  scope: PairScope,
  pairs: MatchPair[],
  now = new Date(),
  pendingItems: { projects: Project[]; engineers: Engineer[] } = { projects: [], engineers: [] },
): Group[] {
  const groups = new Map<string, Group>();
  const inPool = new Set([...projects.map((p) => `project:${p.id}`), ...engineers.map((e) => `engineer:${e.id}`)]);
  const received = new Map<string, number>([
    ...[...pendingItems.projects, ...projects].map((p) => [`project:${p.id}`, receivedMsOf(p.receivedAt)] as const),
    ...[...pendingItems.engineers, ...engineers].map((e) => [`engineer:${e.id}`, receivedMsOf(e.receivedAt)] as const),
  ]);
  const ensure = (kind: Group['kind'], id: string): Group => {
    const key = `${kind}:${id}`;
    let g = groups.get(key);
    if (!g) {
      g = { kind, id, receivedAt: received.get(key) ?? 0, pairs: [] };
      groups.set(key, g);
    }
    return g;
  };
  // 候補が1件も無い突合前の案件・要員も、突合済にするためのグループを作る
  for (const p of projects) if (scope.newProjectIds.has(p.id) && p.status === 'open') ensure('project', p.id);
  for (const e of engineers) if (scope.newEngineerIds.has(e.id) && e.status === 'available') ensure('engineer', e.id);
  for (const pair of pairs) {
    const byProject =
      scope.newProjectIds.has(pair.project.id) ||
      (!scope.newEngineerIds.has(pair.engineer.id) && !inPool.has(`engineer:${pair.engineer.id}`) && inPool.has(`project:${pair.project.id}`));
    if (byProject) ensure('project', pair.project.id).pairs.push(pair);
    else ensure('engineer', pair.engineer.id).pairs.push(pair);
  }
  // 次回の実行では突合の対象期間を外れるものを先に、残りは新しく届いたものから（期限で打ち切られても、
  // 取りこぼしを防ぎつつ鮮度の高い組を先に判定する）
  const lastChance = (g: Group) => (isLastChance(new Date(g.receivedAt), matchLookbackDays(), now) ? 1 : 0);
  return [...groups.values()].sort((a, b) => lastChance(b) - lastChance(a) || b.receivedAt - a.receivedAt);
}

function receivedMsOf(d: Date): number {
  const t = new Date(d).getTime();
  return Number.isFinite(t) ? t : 0;
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((x) => [x.id, x] as const)).values()];
}

// 最終判定のAIが指示らしき記載を見つけた案件・要員に印を付ける（次回以降の実行でもAI判定・自動の下書きに回さない）
export async function persistInjectionFlags(): Promise<void> {
  const flags = takeInjectionFlags();
  for (const [kind, ids] of [['project', flags.projects], ['engineer', flags.engineers]] as const) {
    if (ids.length === 0) continue;
    const label = kind === 'project' ? '案件' : '要員';
    try {
      await markItemsInjectionSuspected(kind, ids);
      recordHealEvent('warn', `AI判定がAIへの指示らしき記載を見つけた${label}${ids.length}件に「指示混入疑い」を付けました（内容を人が確かめてください）`);
    } catch (err) {
      console.error(`SESマッチング: 指示混入疑いの記録に失敗: ${safeErr(err)}`);
      recordHealEvent('warn', `AI判定がAIへの指示らしき記載を見つけた${label}${ids.length}件に「指示混入疑い」を記録できませんでした（この実行の残りの組は要確認にしました）`);
    }
  }
}

async function markMatched(groups: Group[]): Promise<void> {
  for (const kind of ['project', 'engineer'] as const) {
    const ids = groups.filter((g) => g.kind === kind).map((g) => g.id);
    if (ids.length === 0) continue;
    try {
      await markItemsMatched(kind, ids);
    } catch (err) {
      // 印を付けられなくても、次回は判定済みのペアを除いて同じ組を見直すだけなので続ける
      console.error(`SESマッチング: 突合済の記録に失敗: ${safeErr(err)}`);
      recordHealEvent('warn', `${kind === 'project' ? '案件' : '要員'}${ids.length}件に「突合済」を記録できませんでした（次回の実行で判定済みの組を除いて見直します）`);
    }
  }
}

// 一次選抜を選び直す回数の上限（不適合・低評価で空いた枠を、上限であふれた次点の組で同じ実行のうちに埋める）
const MAX_SELECTION_ROUNDS = 3;

type UnfinishedCause = 'budget' | 'transient' | 'draft' | 'deadline' | 'backfill';

export async function matchIncrementally(
  projects: Project[],
  engineers: Engineer[],
  scope: PairScope,
  opts: IncrementalMatchOptions = {},
): Promise<IncrementalMatchResult> {
  const fewShot = await prepareJudging();
  // 最終判定と紹介文面の生成のコストを、この突合の開始から数える
  const budget = startJudgeBudget();
  const tallyBefore = judgeTallySnapshot();
  // この実行で判定した組を控え、選び直しの一次選抜で判定済み・枠を使わない組として扱う
  const judged = new Set(scope.judgedMatchIds);
  const capFree = new Set(scope.capFreeMatchIds ?? []);
  const pending = new Set(scope.pendingMatchIds ?? []);
  const roundScope = (): PairScope => ({ ...scope, judgedMatchIds: judged, capFreeMatchIds: capFree, pendingMatchIds: pending });

  const saved = opts.saved ?? [];
  // 判定待ちの組の相手（対象期間の外）も、文面の作成・保存で案件・要員を引けるようにする
  const pendingItems = opts.pendingItems ?? { projects: [], engineers: [] };
  const allProjects = uniqueById([...projects, ...pendingItems.projects]);
  const allEngineers = uniqueById([...engineers, ...pendingItems.engineers]);
  const causes = new Map<string, UnfinishedCause>(); // 突合し終えなかった案件・要員 → 理由
  let unmarked: Group[] = [];
  let lastCheckpoint = Date.now();
  const checkpoint = async (): Promise<void> => {
    const batch = unmarked;
    unmarked = [];
    await markMatched(batch);
    if (opts.checkpoint) {
      try {
        await opts.checkpoint(saved);
      } catch (err) {
        console.error(`SESマッチング: 途中経過の記録に失敗: ${safeErr(err)}`);
      }
    }
    lastCheckpoint = Date.now();
  };

  let firstStats: PrimarySelectStats | null = null;
  let closedPending = 0;
  let lastGroups: Group[] = [];
  try {
    for (let round = 0; round < MAX_SELECTION_ROUNDS; round += 1) {
      if (round > 0 && pastRunDeadline()) break;
      // 集計（メトリクス）は最初の回だけ数える。選び直しの回は追加で判定に回す組の数だけ足す
      const primary = primarySelectDetailed(projects, engineers, roundScope(), {
        suppression: opts.suppression,
        pendingItems: opts.pendingItems,
        tally: round === 0,
      });
      if (round === 0) {
        firstStats = primary.stats;
        closedPending = await closePending(primary.closedPending);
        for (const id of primary.closedPending) pending.delete(id);
      }
      // 選び直しの回は、空いた枠の次点を待つ案件・要員のグループだけを扱う（予算・失敗で残った組は次回の実行に回す）
      const groups = groupPairs(projects, engineers, scope, primary.pairs, new Date(), pendingItems).filter(
        (g) => round === 0 || causes.get(groupKey(g)) === 'backfill',
      );
      if (round > 0) addSelectedToTally(groups.reduce((n, g) => n + g.pairs.length, 0));
      lastGroups = round === 0 ? groups : lastGroups;
      if (round === 0) {
        const pairCount = groups.reduce((n, g) => n + g.pairs.length, 0);
        console.log(`SESマッチング: ${formatPrimaryStats(primary.stats)}`);
        console.log(`SESマッチング: 突合前の案件・要員${groups.length}件・判定するペア${pairCount}件`);
      } else if (groups.some((g) => g.pairs.length > 0)) {
        console.log(`SESマッチング: 不適合・低評価で空いた枠に次点の組${groups.reduce((n, g) => n + g.pairs.length, 0)}件を判定します`);
      }
      let freedSlots = false;
      let index = 0;
      while (index < groups.length) {
        if (pastRunDeadline()) {
          for (const g of groups.slice(index)) causes.set(groupKey(g), 'deadline');
          break;
        }
        // 候補の無いグループは判定なしで突合済にする。候補のあるグループは目安の件数までまとめて判定・保存する
        const step: Group[] = [];
        let pairsInStep = 0;
        while (index < groups.length && (step.length === 0 || pairsInStep + groups[index].pairs.length <= PAIRS_PER_STEP)) {
          step.push(groups[index]);
          pairsInStep += groups[index].pairs.length;
          index += 1;
        }
        // 次回の実行では対象期間を外れる案件・要員の組は、判定の予算に達していても判定する（取りこぼさない）
        const exempt = step.filter((g) => isLastChance(new Date(g.receivedAt), matchLookbackDays())).flatMap((g) => g.pairs);
        const normal = step.filter((g) => !isLastChance(new Date(g.receivedAt), matchLookbackDays())).flatMap((g) => g.pairs);
        // 期限を過ぎたら判定し残したペアは次回へ（そのペアを持つ案件・要員は突合済にしない）
        const judgedStep = [
          ...(await judgePairs(exempt, fewShot, { stopAtDeadline: true })),
          ...(await judgePairs(normal, fewShot, { stopAtDeadline: true, budget })),
        ];
        const drafted = await createDrafts(judgedStep, allProjects, allEngineers);
        const { saved: stepSaved } = await persistMatches(drafted, allProjects, allEngineers);
        saved.push(...stepSaved);
        const byId = new Map(stepSaved.map((m) => [m.id, m] as const));
        for (const m of stepSaved) {
          if (m.category === 'deferred') continue;
          judged.add(m.id);
          pending.delete(m.id);
          if (m.verdict === 'rejected' || m.verdict === 'low') capFree.add(m.id);
        }
        // 文面を用意できなかった組・AI判定を次回に回した組のある案件・要員は突合済にしない（次回判定し直す）。
        // 上限であふれた組のある案件・要員は、自分の組が不適合・低評価で枠を空けたら、次点の組を判定するまで突合済にしない
        for (const g of step) {
          const results = g.pairs.map((p) => byId.get(matchIdOf(p.project.id, p.engineer.id)));
          const cause = unfinishedCause(results);
          if (cause) {
            causes.set(groupKey(g), cause);
            continue;
          }
          if (primary.cappedItems.has(groupKey(g)) && results.some((r) => r?.verdict === 'rejected' || r?.verdict === 'low')) {
            causes.set(groupKey(g), 'backfill');
            freedSlots = true;
            continue;
          }
          causes.delete(groupKey(g));
          unmarked.push(g);
        }
        if (Date.now() - lastCheckpoint >= CHECKPOINT_INTERVAL_MS) await checkpoint();
      }
      if (!freedSlots) break;
    }
  } finally {
    await checkpoint();
    await persistInjectionFlags();
    reportJudgeTally(tallyBefore);
  }

  const unfinished = [...causes.entries()];
  if (unfinished.some(([, c]) => c === 'deadline')) {
    recordHealEvent(
      'warn',
      `1回の実行時間の上限（SES_RUN_DEADLINE_MINUTES）に達したため、案件・要員${unfinished.length}件の突合を次回の実行に回しました`,
    );
  }
  // 次回の実行では突合の対象期間を外れる（＝今回が最後の機会だった）のに突合し終えなかったもの
  const receivedByKey = new Map(lastGroups.map((g) => [groupKey(g), g.receivedAt] as const));
  const lastChanceKeys = unfinished.filter(([key]) => isLastChance(new Date(receivedByKey.get(key) ?? Date.now()), matchLookbackDays()));
  // 空いた枠の次点を選び直しの回数の上限まで判定したもの（判定・保存は正常に終わっている）は異常にしない
  const backfillOnly = lastChanceKeys.filter(([, c]) => c === 'backfill');
  if (backfillOnly.length > 0) {
    recordHealEvent(
      'warn',
      `不適合・低評価で空いた枠の次点の判定を${MAX_SELECTION_ROUNDS}回まで行いましたが、次回の実行で突合の対象期間を外れる案件・要員${backfillOnly.length}件の残りの候補は判定しませんでした`,
    );
  }
  const expiring = lastChanceKeys.filter(([, c]) => c !== 'backfill');
  if (expiring.length > 0) {
    const kinds = new Set(expiring.map(([, c]) => c));
    const advice = [
      kinds.has('deadline') ? 'SES_RUN_DEADLINE_MINUTES・SES_MAX_MAILS_PER_RUN を見直す' : '',
      kinds.has('budget') ? 'SES_JUDGE_BUDGET_JPY を上げる' : '',
      kinds.has('transient') || kinds.has('draft') ? 'AI判定・文面の生成の失敗（混雑・通信）を確かめる' : '',
    ].filter(Boolean);
    const causeText = [
      kinds.has('deadline') ? '実行時間の上限' : '',
      kinds.has('budget') ? '判定の予算' : '',
      kinds.has('transient') ? 'AI判定の一時的な失敗' : '',
      kinds.has('draft') ? '文面の生成の失敗' : '',
    ].filter(Boolean);
    recordFatal(
      `突合し終えなかった案件・要員のうち${expiring.length}件は、次回の実行時には突合の対象期間（SES_MATCH_LOOKBACK_DAYS）を外れます` +
        `（理由: ${causeText.join('・')}。${advice.length > 0 ? `${advice.join('か、')}か、` : ''}SES_MATCH_LOOKBACK_DAYS を広げて手動で再実行してください）`,
    );
  }
  return {
    saved,
    deferredItems: unfinished.length,
    primaryStats: firstStats ?? primarySelectDetailed([], [], scope).stats,
    closedPending,
  };
}

function groupKey(g: Group): string {
  return `${g.kind}:${g.id}`;
}

// グループの組の保存結果から、突合し終えなかった理由（無ければ null）
function unfinishedCause(results: Array<MatchResult | undefined>): UnfinishedCause | null {
  if (results.some((r) => r === undefined)) return 'deadline';
  if (results.some((r) => r!.category === 'deferred' && r!.reason.startsWith(DEFERRED_BUDGET_CAUSE))) return 'budget';
  if (results.some((r) => r!.category === 'deferred')) return 'transient';
  if (results.some((r) => r!.draftFailed)) return 'draft';
  return null;
}

// 判定待ちのまま対象から外れた組を閉じる（失敗しても次回また閉じ直すだけ）
async function closePending(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  try {
    const n = await closeDeferredMatches(ids);
    if (n > 0) {
      console.log(`SESマッチング: 判定待ちのまま募集・稼働の終了やルールの不一致で対象外になった組${n}件を「ルールのみ」で閉じました`);
      recordHealEvent('info', `判定待ちの組${n}件は対象外になったため、AI判定をせずに閉じました`);
    }
    return n;
  } catch (err) {
    console.warn(`SESマッチング: 判定待ちの組を閉じられませんでした（次回の実行で閉じ直します）: ${safeErr(err)}`);
    return 0;
  }
}
