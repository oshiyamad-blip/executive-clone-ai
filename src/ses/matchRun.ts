// 通常バッチ（本番）のマッチング段: 一次選抜 → 最終判定 → 文面 → 保存を、案件・要員ごとの小分けで進める。
// - 判定したマッチはその場でまとめて保存し、候補ペアをすべて保存し終えた案件・要員にだけ「突合済」を付ける
//   （印はまとめて数分ごとと最後に付ける。付け損ねても、次回は判定済みのペアを除くので費用はかからない）
// - 実行時間の期限（SES_RUN_DEADLINE_MINUTES）を過ぎたら新しい判定を始めず、文面は定型文にする。突合済でない案件・要員は
//   次回の実行でも突合の対象に残るため、時間切れ・途中の失敗で判定し損ねたペアを取りこぼさない
// - 保存できなかったマッチ・文面を用意できなかったマッチのある案件・要員は突合済にしない（次回判定し直す）
// - 次回の実行では突合の対象期間（SES_MATCH_LOOKBACK_DAYS）を外れる案件・要員を先に突合し、それでも残れば異常終了で知らせる
import { primarySelect, prepareJudging, judgePairs, matchIdOf, type PairScope } from './match.js';
import { createDrafts } from './draft.js';
import { persistMatches } from './notify.js';
import { markItemsMatched } from '../database/index.js';
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
}

export interface IncrementalMatchOptions {
  // 保存できたマッチを積む配列（途中で例外になっても、それまでに保存した分を呼び出し側が失わないように）
  saved?: MatchResult[];
  // 途中経過の記録（数分ごとと最後に、それまでに保存できたマッチを渡す）
  checkpoint?: (saved: MatchResult[]) => Promise<void>;
}

// 候補ペアを「その組を受け持つ突合前の案件・要員」ごとにまとめる（案件が突合前ならその案件、そうでなければ要員）
export function groupPairs(projects: Project[], engineers: Engineer[], scope: PairScope, pairs: MatchPair[], now = new Date()): Group[] {
  const groups = new Map<string, Group>();
  const received = new Map<string, number>([
    ...projects.map((p) => [`project:${p.id}`, p.receivedAt.getTime()] as const),
    ...engineers.map((e) => [`engineer:${e.id}`, e.receivedAt.getTime()] as const),
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
    if (scope.newProjectIds.has(pair.project.id)) ensure('project', pair.project.id).pairs.push(pair);
    else ensure('engineer', pair.engineer.id).pairs.push(pair);
  }
  // 次回の実行では突合の対象期間を外れるものを先に、残りは新しく届いたものから（期限で打ち切られても、
  // 取りこぼしを防ぎつつ鮮度の高い組を先に判定する）
  const lastChance = (g: Group) => (isLastChance(new Date(g.receivedAt), matchLookbackDays(), now) ? 1 : 0);
  return [...groups.values()].sort((a, b) => lastChance(b) - lastChance(a) || b.receivedAt - a.receivedAt);
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

export async function matchIncrementally(
  projects: Project[],
  engineers: Engineer[],
  scope: PairScope,
  opts: IncrementalMatchOptions = {},
): Promise<IncrementalMatchResult> {
  const fewShot = await prepareJudging();
  const groups = groupPairs(projects, engineers, scope, primarySelect(projects, engineers, scope));
  const pairCount = groups.reduce((n, g) => n + g.pairs.length, 0);
  console.log(`SESマッチング: 突合前の案件・要員${groups.length}件・判定するペア${pairCount}件`);

  const saved = opts.saved ?? [];
  const completed = new Set<Group>();
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

  try {
    let index = 0;
    while (index < groups.length) {
      if (pastRunDeadline()) break;
      // 候補の無いグループは判定なしで突合済にする。候補のあるグループは目安の件数までまとめて判定・保存する
      const step: Group[] = [];
      let pairsInStep = 0;
      while (index < groups.length && (step.length === 0 || pairsInStep + groups[index].pairs.length <= PAIRS_PER_STEP)) {
        step.push(groups[index]);
        pairsInStep += groups[index].pairs.length;
        index += 1;
      }
      // 期限を過ぎたら判定し残したペアは次回へ（そのペアを持つ案件・要員は突合済にしない）
      const judged = await judgePairs(step.flatMap((g) => g.pairs), fewShot, { stopAtDeadline: true });
      const drafted = await createDrafts(judged, projects, engineers);
      const { saved: stepSaved } = await persistMatches(drafted, projects, engineers);
      saved.push(...stepSaved);
      const ok = new Set(stepSaved.filter((m) => !m.draftFailed).map((m) => m.id));
      for (const g of step) {
        if (!g.pairs.every((p) => ok.has(matchIdOf(p.project.id, p.engineer.id)))) continue;
        completed.add(g);
        unmarked.push(g);
      }
      if (Date.now() - lastCheckpoint >= CHECKPOINT_INTERVAL_MS) await checkpoint();
    }
  } finally {
    await checkpoint();
  }

  const unfinished = groups.filter((g) => !completed.has(g));
  if (unfinished.length > 0 && pastRunDeadline()) {
    recordHealEvent(
      'warn',
      `1回の実行時間の上限（SES_RUN_DEADLINE_MINUTES）に達したため、案件・要員${unfinished.length}件の突合を次回の実行に回しました`,
    );
  }
  // 次回の実行では突合の対象期間を外れる（＝今回が最後の機会だった）のに突合し終えなかったもの
  const expiring = unfinished.filter((g) => isLastChance(new Date(g.receivedAt), matchLookbackDays())).length;
  if (expiring > 0) {
    recordFatal(
      `突合し終えなかった案件・要員のうち${expiring}件は、次回の実行時には突合の対象期間（SES_MATCH_LOOKBACK_DAYS）を外れます` +
        '（実行時間の上限・判定の失敗が続いています。SES_RUN_DEADLINE_MINUTES・SES_MAX_MAILS_PER_RUN を見直すか、SES_MATCH_LOOKBACK_DAYS を広げて手動で再実行してください）',
    );
  }
  return { saved, deferredItems: unfinished.length };
}
