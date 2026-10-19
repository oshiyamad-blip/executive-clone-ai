// 試運転: 似た要員への判定の使い回し（PHASE=fanout）の中心。ファイルの読み書きは harness.ts、ここは純関数
import { adaptJudgment } from '../proper/group.js';
import { judgeUserPrompt, type RawProperJudgment } from '../proper/judge.js';
import type { OwnEngineer, Project } from '../../types/index.js';

export interface PendingPair {
  engineer: string; // 判定を使い回す要員のラベル
  projectId: string;
  from: string; // 代表（判定した要員）のラベル
}

export interface JudgedRow {
  projectId: string;
  judgment: RawProperJudgment;
}

export interface FanoutPlan {
  // 要員ラベル → judged_<要員>.json に足す行
  additions: Record<string, JudgedRow[]>;
  // 要員ラベル → 個別に判定し直す組（pairs.json と同じ形）
  fallback: Record<string, Array<{ projectId: string; title: string; user: string }>>;
  shared: number;
  fallbackCount: number;
}

// 代表の生の判定を、各要員の経歴で照合し直す。合えば使い回し、合わない・代表の判定が無い組は個別に判定する組へ回す。
// すでに同じ案件の判定がある要員の組は足さない
export function planFanout(
  pending: PendingPair[],
  judgedByLabel: Map<string, JudgedRow[]>,
  engineersByLabel: Map<string, OwnEngineer>,
  projectsById: Map<string, Project>,
): FanoutPlan {
  const plan: FanoutPlan = { additions: {}, fallback: {}, shared: 0, fallbackCount: 0 };
  const has = (label: string, projectId: string) =>
    (judgedByLabel.get(label) ?? []).some((r) => r.projectId === projectId) || (plan.additions[label] ?? []).some((r) => r.projectId === projectId);
  for (const p of pending) {
    if (has(p.engineer, p.projectId)) continue;
    const origin = engineersByLabel.get(p.from);
    const member = engineersByLabel.get(p.engineer);
    const project = projectsById.get(p.projectId);
    const raw = (judgedByLabel.get(p.from) ?? []).find((r) => r.projectId === p.projectId)?.judgment;
    if (!project) continue;
    if (raw && origin && member && adaptJudgment(raw, origin, member, project)) {
      (plan.additions[p.engineer] ??= []).push({ projectId: p.projectId, judgment: raw });
      plan.shared += 1;
    } else {
      (plan.fallback[p.engineer] ??= []).push({ projectId: p.projectId, title: project.title, user: judgeUserPrompt(project) });
      plan.fallbackCount += 1;
    }
  }
  return plan;
}
