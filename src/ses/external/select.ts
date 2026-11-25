// 外部マッチ（試行）: 提携先の要員 × すでに抽出した他社の案件の組から、AI判定に回す少数の組を選ぶ（純関数）。
// 商流・再委託で紹介できない要員・案件と、同じ営業元の組は除く。組は合う順に並べ、要員ごと・案件ごとの上限と、
// 1回・1日の上限の内で上から採る
import { properHighRateGapMan } from '../config.js';
import { primarySelectDetailed, comparePairs, isStartTooLate } from '../match.js';
import { engineerBlocksResale, engineerDepth, engineerIsIndividual, projectAllowedDepth, projectAllowsOnlyEmployeeAtDepth1, projectBlocksResale } from './resale.js';
import { externalHardMismatches, type HardRule } from './hardRules.js';
import type { Engineer, MatchPair, Project } from '../../types/index.js';

export const extPairId = (engineerId: string, projectId: string): string => `ext_${engineerId}_${projectId}`;

// 再送で案件IDが変わっても同じ案件名とみなすための正規化（記号・空白・全角半角の違いを除く）
export function extTitleKey(title: string): string {
  return title.normalize('NFKC').toLowerCase().replace(/[\s\u3000【】\[\]［］()（）「」『』・/／\-ー_~〜★☆※!！?？:：、。]/g, '');
}

// 人のキー: イニシャル（NFKC・大文字・英字のみ）|送信元ドメイン。イニシャルが空・不明なら空文字（照合しない）。要員IDは再送で変わるのでこちらで同じ人を探す
export function extPersonKey(initials: string, agentEmail: string): string {
  const ini = initials.normalize('NFKC').replace(/[^A-Za-z]/g, '').toUpperCase();
  const domain = (agentEmail.split('@')[1] ?? '').trim().toLowerCase();
  if (!ini || !domain) return '';
  return `${ini}|${domain}`;
}

// 同じ人か: ドメインが同じで、イニシャルが一致するか一方が他方の先頭で、短い方が2文字以上（G.W. と G.W.Q.）
export function samePersonKey(a: string, b: string): boolean {
  if (!a || !b) return false;
  const [ia, da] = a.split('|');
  const [ib, db] = b.split('|');
  if (!ia || !ib || da !== db) return false;
  if (ia === ib) return ia.length >= 1;
  const [short, long] = ia.length <= ib.length ? [ia, ib] : [ib, ia];
  return short.length >= 2 && long.startsWith(short);
}

export interface ExtSelectInput {
  projects: Project[];
  engineers: Engineer[];
  now: Date;
  existingIds: Set<string>; // すでにシートにある・判定済みの組の ID（ext_<要員ID>_<案件ID>）
  judgedTitleKeys?: Set<string>; // 前の回までに判定した「要員ID|正規化した案件名」（再送で案件IDが替わった組を外す）
  sheetPersonTitles?: Array<{ person: string; title: string }>; // シートにある行の extPersonKey と extTitleKey(案件名)（要員メールの再送で要員IDが変わった同じ人×同じ案件を外す）
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
  depthExceeded: number; // 要員の商流の段数が案件の許す段数（「1社先まで」など）を超えて外した組の数
  hardExcluded: Record<HardRule, number>; // 国籍・稼働率・リモート・ハイブリッド・年齢・勤務地と住まいで決まりごとに外した組の数
  judgedBefore: number; // 前の回までに判定した同じ要員×同じ案件名で外した組の数
  onSheetSamePerson: number; // シートにある同じ人（記号・イニシャルの揺れを含む）×同じ案件名で外した組の数
  samePersonInRun: number; // 同じ回の中で、同じ人×同じ案件名の組が複数あり1つだけ残して外した数
  candidates: number;
  selected: number;
}

export function engineerStartsTooLate(e: Engineer, now: Date): boolean {
  return Boolean(e.availableFrom) && isStartTooLate(e.availableFrom as string, now.toISOString(), now, { days: 0, months: 1 });
}

// 同じ人: 送信元ドメイン・イニシャル（英字のみ大文字）・希望単価が一致（どれか空なら別人）。年齢と場所（最寄駅、無ければ居住地）は両方に値があれば一致すること（片方が空なら比べない）
function samePersonBase(e: Engineer): string | null {
  const domain = (e.agentEmail.split('@')[1] ?? '').trim().toLowerCase();
  const initials = e.displayName.normalize('NFKC').replace(/[^A-Za-z]/g, '').toUpperCase();
  if (!domain || !initials || e.desiredRate === null) return null;
  return [domain, initials, e.desiredRate].join('|');
}

function placeOf(e: Engineer): string {
  return (e.nearestStation || e.residence || '').normalize('NFKC').replace(/\s/g, '');
}

function isSamePerson(a: Engineer, b: Engineer): boolean {
  if (a.age !== null && b.age !== null && a.age !== b.age) return false;
  const pa = placeOf(a);
  const pb = placeOf(b);
  return !(pa && pb && pa !== pb);
}

export function dedupeSamePerson(engineers: Engineer[]): { kept: Engineer[]; removed: number } {
  const groups = new Map<string, Engineer[][]>();
  for (const e of engineers) {
    const k = samePersonBase(e);
    if (k === null) continue;
    const list = groups.get(k) ?? [];
    const g = list.find((m) => m.every((x) => isSamePerson(x, e)));
    if (g) g.push(e);
    else list.push([e]);
    groups.set(k, list);
  }
  const drop = new Set<Engineer>();
  for (const list of groups.values()) {
    for (const g of list) {
      const newest = g.reduce((a, b) => (b.receivedAt.getTime() > a.receivedAt.getTime() ? b : a));
      for (const e of g) if (e !== newest) drop.add(e);
    }
  }
  const kept = engineers.filter((e) => !drop.has(e));
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
  const hardExcluded: Record<HardRule, number> = { nationality: 0, utilization: 0, remote: 0, hybrid: 0, age: 0, area: 0 };
  let depthExceeded = 0;
  let judgedBefore = 0;
  let onSheetSamePerson = 0;
  let samePersonInRun = 0;
  const sheetPT = (input.sheetPersonTitles ?? []).filter((x) => x.person);
  const personOf = (e: Engineer): string => extPersonKey(e.displayName, e.agentEmail);
  const candidates = selection.pairs
    .filter((p) => !input.existingIds.has(extPairId(p.engineer.id, p.project.id)))
    .filter((p) => {
      const judged = input.judgedTitleKeys?.has(`${p.engineer.id}|${extTitleKey(p.project.title)}`) ?? false;
      if (judged) judgedBefore += 1;
      return !judged;
    })
    .filter((p) => {
      const person = personOf(p.engineer);
      if (!person || sheetPT.length === 0) return true;
      const tk = extTitleKey(p.project.title);
      const hit = sheetPT.some((x) => x.title === tk && samePersonKey(x.person, person));
      if (hit) onSheetSamePerson += 1;
      return !hit;
    })
    .filter((p) => {
      const allowed = projectAllowedDepth(p.project);
      const depth = engineerDepth(p.engineer, mailTextOf(p.engineer));
      const individualOver = projectAllowsOnlyEmployeeAtDepth1(p.project) && depth !== null && depth >= 1 && engineerIsIndividual(p.engineer, mailTextOf(p.engineer));
      const over = (allowed !== null && depth !== null && depth > allowed) || individualOver;
      if (over) depthExceeded += 1;
      return !over;
    })
    .filter((p) => {
      const hits = externalHardMismatches(p.engineer, mailTextOf(p.engineer), p.project);
      for (const h of hits) hardExcluded[h.rule] += 1;
      return hits.length === 0;
    })
    .sort(comparePairs)
    .filter(
      (() => {
        // 年齢・希望単価が両方にあって違えば別の人（既存の dedupeSamePerson と同じ見方）
        const seen: Array<{ person: string; title: string; e: Engineer }> = [];
        const differs = (a: Engineer, b: Engineer): boolean =>
          (a.age !== null && b.age !== null && a.age !== b.age) || (a.desiredRate !== null && b.desiredRate !== null && a.desiredRate !== b.desiredRate);
        return (p: MatchPair): boolean => {
          const person = personOf(p.engineer);
          if (!person) return true;
          const title = extTitleKey(p.project.title);
          if (seen.some((x) => x.title === title && x.e.id !== p.engineer.id && !differs(x.e, p.engineer) && samePersonKey(x.person, person))) {
            samePersonInRun += 1;
            return false;
          }
          seen.push({ person, title, e: p.engineer });
          return true;
        };
      })(),
    );
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
      depthExceeded,
      hardExcluded,
      judgedBefore,
      onSheetSamePerson,
      samePersonInRun,
      candidates: candidates.length,
      selected: pairs.length,
    },
  };
}
