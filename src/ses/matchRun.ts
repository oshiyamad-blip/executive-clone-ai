// 通常バッチ（本番）のマッチング段: 一次選抜 → 最終判定 → 文面 → 保存を、案件・要員ごとの小分けで進める。
// - 判定したマッチはその場でまとめて保存し、候補ペアをすべて保存し終えた案件・要員にだけ「突合済」を付ける
// - 実行時間の期限（SES_RUN_DEADLINE_MINUTES）を過ぎたら新しい判定を始めない。突合済でない案件・要員は
//   次回の実行でも突合の対象に残るため、時間切れ・途中の失敗で判定し損ねたペアを取りこぼさない
// - 保存できなかったマッチ・文面を用意できなかったマッチのある案件・要員は突合済にしない（次回判定し直す）
import { primarySelect, prepareJudging, judgePairs, matchIdOf, type PairScope } from './match.js';
import { createDrafts } from './draft.js';
import { persistMatches } from './notify.js';
import { markItemsMatched } from '../database/index.js';
import { recordHealEvent } from './heal/events.js';
import { pastRunDeadline } from './schedule.js';
import { safeErr } from './redact.js';
import type { Project, Engineer, MatchPair, MatchResult } from '../types/index.js';

// 1回の判定・保存でまとめて扱うペア数の目安（保存の呼び出しを減らしつつ、途中で止まったときの手戻りを小さくする）
const PAIRS_PER_STEP = 20;

interface Group {
  kind: 'project' | 'engineer';
  id: string;
  receivedAt: number;
  pairs: MatchPair[];
}

export interface IncrementalMatchResult {
  saved: MatchResult[]; // 保存できたマッチ（サマリに載せる）
  deferredItems: number; // 期限切れで次回に回した案件・要員の数
}

// 候補ペアを「その組を受け持つ突合前の案件・要員」ごとにまとめる（案件が突合前ならその案件、そうでなければ要員）
export function groupPairs(projects: Project[], engineers: Engineer[], scope: PairScope, pairs: MatchPair[]): Group[] {
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
  // 新しく届いたものから（期限で打ち切られても、鮮度の高い組を先に判定する）
  return [...groups.values()].sort((a, b) => b.receivedAt - a.receivedAt);
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
): Promise<IncrementalMatchResult> {
  const fewShot = await prepareJudging();
  const groups = groupPairs(projects, engineers, scope, primarySelect(projects, engineers, scope));
  const pairCount = groups.reduce((n, g) => n + g.pairs.length, 0);
  console.log(`SESマッチング: 突合前の案件・要員${groups.length}件・判定するペア${pairCount}件`);

  const saved: MatchResult[] = [];
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
    const judged = await judgePairs(step.flatMap((g) => g.pairs), fewShot);
    const drafted = await createDrafts(judged, projects, engineers);
    const { saved: stepSaved } = await persistMatches(drafted, projects, engineers);
    saved.push(...stepSaved);
    const ok = new Set(stepSaved.filter((m) => !m.draftFailed).map((m) => m.id));
    const complete = step.filter((g) => g.pairs.every((p) => ok.has(matchIdOf(p.project.id, p.engineer.id))));
    await markMatched(complete);
  }

  const deferredItems = groups.length - index;
  if (deferredItems > 0) {
    recordHealEvent(
      'warn',
      `1回の実行時間の上限（SES_RUN_DEADLINE_MINUTES）に達したため、案件・要員${deferredItems}件の突合を次回の実行に回しました`,
    );
  }
  return { saved, deferredItems };
}
