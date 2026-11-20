// 外部マッチ（試行）: 提携先の要員 × すでに抽出した他社の案件の組から、AI判定に回す少数の組を選ぶ（純関数）。
// 商流・再委託で紹介できない要員・案件と、同じ営業元の組は除く。組は合う順に並べ、要員ごと・案件ごとの上限と、
// 1回・1日の上限の内で上から採る
import { properHighRateGapMan } from '../config.js';
import { primarySelectDetailed, comparePairs, isStartTooLate } from '../match.js';
import { engineerBlocksResale, projectBlocksResale } from './resale.js';
import { externalHardMismatches, type HardRule } from './hardRules.js';
import type { Engineer, MatchPair, Project } from '../../types/index.js';

export const extPairId = (engineerId: string, projectId: string): string => `ext_${engineerId}_${projectId}`;

export interface ExtSelectInput {
  projects: Project[];
  engineers: Engineer[];
  now: Date;
  existingIds: Set<string>; // すでにシートにある・判定済みの組の ID（ext_<要員ID>_<案件ID>）
  addedToday: number; // 今日（JST）すでに判定した組の数
  perRun: number;
  dailyCap: number;
  perEngineer?: number;
  perProject?: number;
  mailTextOf?: (e: Engineer) => string; // 要員メールの本文（商流の照合用）
}

export interface ExtSelectStats {
  engineers: number;
  projects: number;
  restrictedEngineers: number;
  restrictedProjects: number;
  sameAgent: number;
  samePerson: number; // 同じ会社の別の営業担当が送ってきた同じ要員（新しい1通だけ残して外した数）
  hardExcluded: Record<HardRule, number>; // 国籍・稼働率・リモート・ハイブリッド・年齢で決まりごとに外した組の数
  candidates: number;
  selected: number;
}

export function engineerStartsTooLate(e: Engineer, now: Date): boolean {
  return Boolean(e.availableFrom) && isStartTooLate(e.availableFrom as string, now.toISOString(), now, { days: 0, months: 1 });
}

// 同じ人の判定キー: 送信元ドメイン・イニシャル（英字のみ大文字）・年齢・希望単価・最寄駅（無ければ居住地）。どれか空なら同じ人とみなさない
function samePersonKey(e: Engineer): string | null {
  const domain = (e.agentEmail.split('@')[1] ?? '').trim().toLowerCase();
  const initials = e.displayName.normalize('NFKC').replace(/[^A-Za-z]/g, '').toUpperCase();
  const place = (e.nearestStation || e.residence || '').normalize('NFKC').replace(/\s/g, '');
  if (!domain || !initials || e.age === null || e.desiredRate === null || !place) return null;
  return [domain, initials, e.age, e.desiredRate, place].join('|');
}

export function dedupeSamePerson(engineers: Engineer[]): { kept: Engineer[]; removed: number } {
  const newest = new Map<string, Engineer>();
  for (const e of engineers) {
    const k = samePersonKey(e);
    if (k === null) continue;
    const cur = newest.get(k);
    if (!cur || e.receivedAt.getTime() > cur.receivedAt.getTime()) newest.set(k, e);
  }
  const kept = engineers.filter((e) => {
    const k = samePersonKey(e);
    return k === null || newest.get(k) === e;
  });
  return { kept, removed: engineers.length - kept.length };
}

export function selectExternalPairs(input: ExtSelectInput): { pairs: MatchPair[]; stats: ExtSelectStats } {
  const { now } = input;
  const mailTextOf = input.mailTextOf ?? (() => '');
  const usable = input.engineers.filter((e) => e.status === 'available' && !e.injectionSuspected && !engineerStartsTooLate(e, now));
  const unrestricted = usable.filter((e) => !engineerBlocksResale(e, mailTextOf(e)));
  const { kept: engineers, removed: samePerson } = dedupeSamePerson(unrestricted);
  const openProjects = input.projects.filter((p) => p.status === 'open' && !p.injectionSuspected);
  const projects = openProjects.filter((p) => !projectBlocksResale(p));
  const selection = primarySelectDetailed(projects, engineers, undefined, { now, tally: false });
  const hardExcluded: Record<HardRule, number> = { nationality: 0, utilization: 0, remote: 0, hybrid: 0, age: 0 };
  const candidates = selection.pairs
    .filter((p) => !input.existingIds.has(extPairId(p.engineer.id, p.project.id)))
    .filter((p) => {
      const hits = externalHardMismatches(p.engineer, mailTextOf(p.engineer), p.project);
      for (const h of hits) hardExcluded[h.rule] += 1;
      return hits.length === 0;
    })
    .sort(comparePairs);
  // 判定のあとで高単価×必須△の規則に落ちる組が多いので、単価差が額未満の組を先にする（各グループの中は comparePairs のまま）
  const gap = properHighRateGapMan();
  if (gap > 0) {
    const high = (p: MatchPair): boolean => {
      const rate = p.project.rateMax ?? p.project.rateMin;
      return typeof rate === 'number' && typeof p.engineer.desiredRate === 'number' && rate - p.engineer.desiredRate >= gap;
    };
    candidates.sort((a, b) => Number(high(a)) - Number(high(b)));
  }
  const perEngineer = input.perEngineer ?? 2;
  const perProject = input.perProject ?? 2;
  const limit = Math.max(0, Math.min(input.perRun, input.dailyCap - input.addedToday));
  const engineerCount = new Map<string, number>();
  const projectCount = new Map<string, number>();
  const pairs: MatchPair[] = [];
  for (const p of candidates) {
    if (pairs.length >= limit) break;
    if ((engineerCount.get(p.engineer.id) ?? 0) >= perEngineer || (projectCount.get(p.project.id) ?? 0) >= perProject) continue;
    engineerCount.set(p.engineer.id, (engineerCount.get(p.engineer.id) ?? 0) + 1);
    projectCount.set(p.project.id, (projectCount.get(p.project.id) ?? 0) + 1);
    pairs.push(p);
  }
  return {
    pairs,
    stats: {
      engineers: engineers.length,
      projects: projects.length,
      restrictedEngineers: usable.length - unrestricted.length,
      restrictedProjects: openProjects.length - projects.length,
      sameAgent: selection.stats.reasons.sameAgent,
      samePerson,
      hardExcluded,
      candidates: candidates.length,
      selected: pairs.length,
    },
  };
}
