// 試運転: 再送で代表の案件IDが替わっても中身が同じ案件は、前の判定を使い回す（判定の組を減らす）。純関数だけ（ファイルは harness が読む）
import { createHash } from 'node:crypto';
import type { Project } from '../../types/index.js';
import { norm } from '../proper/judge.js';

export interface ReusedPair {
  engineer: string;
  projectId: string;
  fromProjectId: string;
}

type KeyedProject = Pick<Project, 'title' | 'requiredSkills' | 'rateMin' | 'rateMax' | 'prefecture' | 'startDate' | 'startPeriod'>;

// 案件の中身のキー。案件名・必須スキル・単価の幅・都道府県・開始（年月）が同じなら同じ案件とみなす
export function contentKeyOf(p: KeyedProject): string {
  const start = p.startDate ? p.startDate.slice(0, 7) : norm(p.startPeriod ?? '');
  const parts = [
    norm(p.title),
    p.requiredSkills.map(norm).sort().join(','),
    `${p.rateMin ?? ''}-${p.rateMax ?? ''}`,
    norm(p.prefecture ?? ''),
    start,
  ];
  return createHash('sha1').update(parts.join('\u0001')).digest('hex');
}

// （要員, 中身のキー）→ 判定のある案件ID。同じキーが複数あれば先のものを使う
export function indexJudgedByContent(
  judged: Array<{ engineer: string; projectId: string }>,
  projectById: Map<string, KeyedProject>,
): Map<string, string> {
  const index = new Map<string, string>();
  for (const j of judged) {
    const p = projectById.get(j.projectId);
    if (!p) continue;
    const k = `${j.engineer}|${contentKeyOf(p)}`;
    if (!index.has(k)) index.set(k, j.projectId);
  }
  return index;
}

// 判定に回す組のうち、中身が同じ案件の判定が前にあるものを reused に分ける
export function splitReused<T extends { engineer: string; projectId: string }>(
  pairs: T[],
  index: Map<string, string>,
  projectById: Map<string, KeyedProject>,
): { toJudge: T[]; reused: ReusedPair[] } {
  const toJudge: T[] = [];
  const reused: ReusedPair[] = [];
  for (const p of pairs) {
    const proj = projectById.get(p.projectId);
    const from = proj ? index.get(`${p.engineer}|${contentKeyOf(proj)}`) : undefined;
    if (from && from !== p.projectId) reused.push({ engineer: p.engineer, projectId: p.projectId, fromProjectId: from });
    else toJudge.push(p);
  }
  return { toJudge, reused };
}

// 判定を projectId で引けないとき、reused の fromProjectId の判定を使う（判定の中身はそのまま）
export function judgmentFor<J>(judgedByProject: Map<string, J>, projectId: string, reused: ReusedPair[], engineer: string): J | undefined {
  const direct = judgedByProject.get(projectId);
  if (direct) return direct;
  const r = reused.find((x) => x.engineer === engineer && x.projectId === projectId);
  return r ? judgedByProject.get(r.fromProjectId) : undefined;
}
