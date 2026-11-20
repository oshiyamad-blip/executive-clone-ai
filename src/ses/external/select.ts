// 外部マッチ（試行）: 提携先の要員 × すでに抽出した他社の案件の組から、AI判定に回す少数の組を選ぶ（純関数）。
// 商流・再委託で紹介できない要員・案件と、同じ営業元の組は除く。組は合う順に並べ、要員ごと・案件ごとの上限と、
// 1回・1日の上限の内で上から採る
import { primarySelectDetailed, comparePairs, isStartTooLate } from '../match.js';
import { engineerBlocksResale, projectBlocksResale } from './resale.js';
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
  candidates: number;
  selected: number;
}

export function engineerStartsTooLate(e: Engineer, now: Date): boolean {
  return Boolean(e.availableFrom) && isStartTooLate(e.availableFrom as string, now.toISOString(), now, { days: 0, months: 1 });
}

export function selectExternalPairs(input: ExtSelectInput): { pairs: MatchPair[]; stats: ExtSelectStats } {
  const { now } = input;
  const mailTextOf = input.mailTextOf ?? (() => '');
  const usable = input.engineers.filter((e) => e.status === 'available' && !e.injectionSuspected && !engineerStartsTooLate(e, now));
  const engineers = usable.filter((e) => !engineerBlocksResale(e, mailTextOf(e)));
  const openProjects = input.projects.filter((p) => p.status === 'open' && !p.injectionSuspected);
  const projects = openProjects.filter((p) => !projectBlocksResale(p));
  const selection = primarySelectDetailed(projects, engineers, undefined, { now, tally: false });
  const candidates = selection.pairs.filter((p) => !input.existingIds.has(extPairId(p.engineer.id, p.project.id))).sort(comparePairs);
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
      restrictedEngineers: usable.length - engineers.length,
      restrictedProjects: openProjects.length - projects.length,
      sameAgent: selection.stats.reasons.sameAgent,
      candidates: candidates.length,
      selected: pairs.length,
    },
  };
}
