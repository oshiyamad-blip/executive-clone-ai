// 似たスキルの要員をまとめて判定する。代表の1人の判定（生のAI出力）を、似た要員の経歴で照合し直して使い回し、判定の回数を減らす。
// 単価・開始時期・勤務地などの人ごとの条件は判定の外（ownMatch・優先度）で人ごとに見るため、ここでは変えない
import { properGroupSimilarity } from '../config.js';
import { norm, profileTextOf, verifyJudgment, type RawProperJudgment } from './judge.js';
import type { OwnEngineer, Project, ProperJudgment } from '../../types/index.js';

// 重なり係数 |A∩B| / min(|A|,|B|)。要員リストのスキル欄には人ごとの雑多な語が混ざり、Jaccard だと似た要員でも下がるため
export function skillOverlap(a: string[], b: string[]): number {
  const sa = new Set(a.map(norm).filter(Boolean));
  const sb = new Set(b.map(norm).filter(Boolean));
  if (sa.size === 0 || sb.size === 0) return 0;
  let common = 0;
  for (const s of sa) if (sb.has(s)) common += 1;
  return common / Math.min(sa.size, sb.size);
}

type Groupable = OwnEngineer & { wish?: string };

function similar(a: Groupable, b: Groupable, threshold: number): boolean {
  if (a.requiredProjectRate !== b.requiredProjectRate) return false;
  if ((a.experienceYears === null) !== (b.experienceYears === null)) return false;
  if (a.experienceYears !== null && b.experienceYears !== null && Math.abs(a.experienceYears - b.experienceYears) > 1) return false;
  // 希望が違うと判定の preferenceFit が変わるため、同じものだけをまとめる
  if (norm(a.wish ?? '') !== norm(b.wish ?? '')) return false;
  return skillOverlap(a.skills, b.skills) >= threshold;
}

// id の昇順で貪欲に作る（先頭の人を基準に、基準と条件が合う人を入れる）。threshold 0 以下は全員1人ずつ
export function groupSimilarEngineers<T extends Groupable>(list: T[], threshold = properGroupSimilarity()): Array<{ id: string; members: T[] }> {
  const sorted = [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (threshold <= 0) return sorted.map((e) => ({ id: e.id, members: [e] }));
  const used = new Set<string>();
  const groups: Array<{ id: string; members: T[] }> = [];
  for (const base of sorted) {
    if (used.has(base.id)) continue;
    used.add(base.id);
    const members = [base];
    for (const other of sorted) {
      if (used.has(other.id) || !similar(base, other, threshold)) continue;
      used.add(other.id);
      members.push(other);
    }
    groups.push({ id: base.id, members });
  }
  return groups;
}

// 代表の生の判定を member の経歴で照合し直す。代表で照合した結果（verdict・要件ごとの status）と同じときだけ member の判定を返し、
// 違えば null（個別に判定し直す）
export function adaptJudgment(raw: RawProperJudgment, origin: OwnEngineer, member: OwnEngineer, project: Project): ProperJudgment | null {
  const verify = (e: OwnEngineer) => verifyJudgment(raw, profileTextOf(e), project, { level: e.level, experienceYears: e.experienceYears ?? null });
  const base = verify(origin);
  const mine = verify(member);
  const checksA = base.checks ?? [];
  const checksB = mine.checks ?? [];
  if (base.verdict !== mine.verdict || checksA.length !== checksB.length) return null;
  return checksA.every((c, i) => c.status === checksB[i].status) ? mine : null;
}
