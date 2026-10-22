// 再提案抑制。営業がステータスを「見送り」にした組・評価で「ズレ」にした組は、どちらかの側の再送（名寄せで同じと
// みなせる案件・要員。単金・日付の違いは問わない）が届いても提案し直さない（サマリには件数だけを載せる）。
// 単金・リモート条件が有利な方へ大きく変わった再送（「ズレ」はスキルが変わった再送）は、改めて検討する価値があるため
// 「以前見送り」の注意を付けて通す。
// 照合（buildSuppressionIndex 以下）は純関数。読み込み（loadSuppressionIndex）は失敗しても抑制なしで続ける
import { sameProjectIgnoringRate, sameEngineerIgnoringRate } from './store.js';
import { fmtMan, skillMatch } from './pricing.js';
import { requirementMembers } from './skillDict.js';
import { loadFeedback } from './feedback.js';
import { parseMatchId } from './match.js';
import { isDemo } from './config.js';
import { safeErr } from './redact.js';
import { recordHealEvent } from './heal/events.js';
import { fetchRejectedMatchRows, fetchItemsByIds, type RejectedMatchRow } from '../database/index.js';
import type { Project, Engineer, RemoteOption } from '../types/index.js';

export type RejectedPair = RejectedMatchRow;

export type SuppressionVerdict = { kind: 'none' } | { kind: 'suppress' } | { kind: 'changed'; note: string };

// 単金がこれ以上変わった再送は条件が変わったものとして提案し直す（万円/月）
export const MATERIAL_RATE_CHANGE_MAN = 3;

interface Entry {
  source: RejectedPair['source'];
  project: Project;
  engineer: Engineer;
}

export interface SuppressionIndex {
  size: number; // 照合に使える組の数（案件・要員の内容が分かったもの）
  check(project: Project, engineer: Engineer): SuppressionVerdict;
}

const SOURCE_LABEL: Record<RejectedPair['source'], string> = { dropped: '「見送り」', bad: '評価で「ズレ」' };

function rateOf(p: Project): number | null {
  return p.rateMax ?? p.rateMin;
}

// 単金の有利な変更（案件単金は上がった・希望単金は下がった）だけを数える
function rateChange(label: string, before: number | null, after: number | null, favorable: 'up' | 'down'): string | null {
  if (before === null || after === null) return null;
  const delta = favorable === 'up' ? after - before : before - after;
  return delta >= MATERIAL_RATE_CHANGE_MAN ? `${label} ${fmtMan(before)}→${fmtMan(after)}万円` : null;
}

const REMOTE_LEVEL: Record<Exclude<RemoteOption, 'unknown'>, number> = { none: 0, partial: 1, full: 2 };

// リモート条件の有利な変更（案件は緩んだ: 出社→一部→フル、要員の希望は緩んだ: フル→一部→出社可）だけを数える
function remoteChange(label: string, before: RemoteOption, after: RemoteOption, favorable: 'up' | 'down'): string | null {
  if (before === 'unknown' || after === 'unknown' || before === after) return null;
  const up = REMOTE_LEVEL[after] > REMOTE_LEVEL[before];
  return up === (favorable === 'up') ? `${label}の変更` : null;
}

function memberSet(labels: string[]): Set<string> {
  return new Set(requirementMembers(labels).map((s) => s.toLowerCase()));
}

// 判定に使うスキルの要件（必須、無ければ尚可）で満たせなかった要件
function missingRequirements(project: Project, skills: string[]): Set<string> {
  // 記載の無い工程・役割・業種も不足に数える（後から記載された要件を「不足していたスキルの追加」として拾う）
  const opts = { softUnstated: false };
  const m = skillMatch(project.requiredSkills, skills, opts) ?? skillMatch(project.preferredSkills, skills, opts);
  return new Set((m?.breakdown.missing ?? []).map((r) => r.toLowerCase()));
}

// 以前足りなかった要件を満たすようになった・案件の必須スキルの中身が変わったか（評価で「ズレ」にした組はスキルが
// 変わったときだけ提案し直す。関係の無いスキルの追加・抽出の揺れ・表記だけの違いでは提案し直さない）
function skillChanges(before: { project: Project; engineer: Engineer }, project: Project, engineer: Engineer): string[] {
  const out: string[] = [];
  const req = memberSet(before.project.requiredSkills);
  const now = memberSet(project.requiredSkills);
  const requirementChanged = req.size !== now.size || [...now].some((r) => !req.has(r));
  if (requirementChanged) out.push('案件の必須スキルの変更');
  const wasMissing = missingRequirements(before.project, before.engineer.skills);
  const stillMissing = missingRequirements(before.project, engineer.skills);
  if ([...wasMissing].some((r) => !stillMissing.has(r))) out.push('不足していたスキルの追加');
  return out;
}

// 見送り・ズレにしたときから、条件が有利な方へ大きく変わったか（変わった点の短い記述。変わっていなければ空）。
// 不利な変更（案件単金の値下げ・要員の希望単金の値上げ・リモート条件の厳格化）では提案し直さない。
// 評価で「ズレ」にした組はスキルの不一致が理由のため、単金・リモート条件ではなくスキルの変更だけを見る
export function materialChanges(
  before: { project: Project; engineer: Engineer; source?: RejectedPair['source'] },
  project: Project,
  engineer: Engineer,
): string[] {
  if (before.source === 'bad') return skillChanges(before, project, engineer);
  return [
    rateChange('案件単金', rateOf(before.project), rateOf(project), 'up'),
    rateChange('希望単金', before.engineer.desiredRate, engineer.desiredRate, 'down'),
    remoteChange('案件のリモート条件', before.project.remote, project.remote, 'up'),
    remoteChange('要員のリモート希望', before.engineer.remoteWish, engineer.remoteWish, 'down'),
  ].filter((x): x is string => x !== null);
}

// 見送り・ズレの組と、その案件・要員の内容から照合器を作る（内容が分からない組は照合に使わない）
export function buildSuppressionIndex(
  rejected: RejectedPair[],
  projects: Map<string, Project>,
  engineers: Map<string, Engineer>,
): SuppressionIndex {
  const entries: Entry[] = [];
  for (const r of rejected) {
    const project = projects.get(r.projectId);
    const engineer = engineers.get(r.engineerId);
    if (project && engineer) entries.push({ source: r.source, project, engineer });
  }
  // 案件ごとに、同じ案件とみなせる見送りの組を1回だけ探す（一次選抜を通った組ごとに全件と比べない）
  const byProject = new WeakMap<Project, Entry[]>();
  const entriesFor = (project: Project): Entry[] => {
    let hit = byProject.get(project);
    if (!hit) {
      hit = entries.filter((e) => sameProjectIgnoringRate(e.project, project));
      byProject.set(project, hit);
    }
    return hit;
  };
  return {
    size: entries.length,
    check(project: Project, engineer: Engineer): SuppressionVerdict {
      if (entries.length === 0) return { kind: 'none' };
      let changed: string | null = null;
      for (const e of entriesFor(project)) {
        if (!sameEngineerIgnoringRate(e.engineer, engineer)) continue;
        const changes = materialChanges(e, project, engineer);
        if (changes.length === 0) return { kind: 'suppress' };
        changed ??= `以前${SOURCE_LABEL[e.source]}にした組の再送です（${changes.join('・')}）`;
      }
      return changed ? { kind: 'changed', note: changed } : { kind: 'none' };
    },
  };
}

// 見送り・ズレの組を読み、直近の突合の対象（pool）に無い案件・要員は保存先から読み足して照合器を作る。
// 読めなければ抑制なしで続ける（見送りの組が再び候補に出るだけで、取りこぼしにはならないため）
export async function loadSuppressionIndex(pool: { projects: Project[]; engineers: Engineer[] }): Promise<SuppressionIndex | undefined> {
  try {
    const badIds = new Set((await loadFeedback(500)).filter((f) => f.verdict === 'bad').map((f) => f.matchId).filter(Boolean));
    const fromDb = isDemo() ? [] : await fetchRejectedMatchRows(badIds, parseMatchId);
    const known = new Set(fromDb.map((r) => r.matchId));
    // 保存先のマッチに見つからない評価（Notion運用・行の削除）はマッチIDから案件ID・要員IDを取り出す
    const fromFeedback: RejectedPair[] = [...badIds]
      .filter((id) => !known.has(id))
      .flatMap((matchId) => {
        const ids = parseMatchId(matchId);
        return ids ? [{ matchId, ...ids, source: 'bad' as const }] : [];
      });
    const rejected = [...fromDb, ...fromFeedback];
    if (rejected.length === 0) return undefined;

    const projects = new Map(pool.projects.map((p) => [p.id, p]));
    const engineers = new Map(pool.engineers.map((e) => [e.id, e]));
    const missingProjects = new Set(rejected.map((r) => r.projectId).filter((id) => !projects.has(id)));
    const missingEngineers = new Set(rejected.map((r) => r.engineerId).filter((id) => !engineers.has(id)));
    if (!isDemo() && missingProjects.size + missingEngineers.size > 0) {
      const extra = await fetchItemsByIds(missingProjects, missingEngineers);
      for (const p of extra.projects) projects.set(p.id, p);
      for (const e of extra.engineers) engineers.set(e.id, e);
    }
    const index = buildSuppressionIndex(rejected, projects, engineers);
    console.log(`SESマッチング: 再提案抑制の照合に「見送り」「ズレ」の組${index.size}件を使います`);
    return index;
  } catch (err) {
    console.warn(`SESマッチング: 見送り・ズレの組を読めないため、再提案抑制をせずに続けます: ${safeErr(err)}`);
    recordHealEvent('warn', '「見送り」「ズレ」にした組を読めなかったため、この実行では再提案の抑制をしませんでした');
    return undefined;
  }
}
