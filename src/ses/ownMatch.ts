import '../env.js';
// 自社社員(候補要員)→ 合いそうな案件を探す機能。
// 外部要員との突合(match.ts)と異なり、金額条件は「案件単価 ≥ 社員の必要案件単価」の閾値方式。
// スキル・勤務地・時期の判定は match.ts と同じヘルパーを流用する。
// 本番=Notion自社社員DB＋案件DBを参照、demo=fixture社員＋fixture案件で外部呼び出しなし。
import { collectSesMail } from './collect.js';
import { parseAttachments } from './parse.js';
import { extractItems } from './extract.js';
import { skillMatchRate } from './pricing.js';
import { isAdjacentOrSame } from './prefecture.js';
import { loadSkillEquivalences } from './skillEquiv.js';
import { isTimingWithinGrace } from './match.js';
import { writeReviewOwnMatches } from './review.js';
import { loadFixtureOwnEngineers } from './fixtures/ownEngineers.js';
import { fetchOwnEngineers, fetchOpenProjects } from '../database/index.js';
import { readDemoArtifact } from './store.js';
import {
  isDemo,
  skillMatchThreshold,
  skillMatchStrongThreshold,
  maxCandidatesPerItem,
} from './config.js';
import type { OwnEngineer, Project, OwnMatch, ExtractedItem, MatchBand } from '../types/index.js';

// 案件単価は上限(rateMax)を優先し、無ければ下限(rateMin)。両方無ければ null。
function projectRateMan(project: Project): number | null {
  return project.rateMax ?? project.rateMin ?? null;
}

function evaluate(own: OwnEngineer, project: Project): OwnMatch | null {
  // スキル: 必須スキルの被覆率が閾値未満なら除外。
  // 外部要員(match.ts)と同じ基準でバンド分けし、参考提案(tentative)は注記を付ける
  const matchRate = skillMatchRate(project.requiredSkills, own.skills);
  if (matchRate < skillMatchThreshold()) return null;
  const band: MatchBand = matchRate >= skillMatchStrongThreshold() ? 'strong' : 'tentative';

  // 勤務地: フルリモート可 または 同一/隣接県。両方不明なら判定不能として通過(要確認)
  const bothPrefectureUnknown = project.prefecture === null && own.prefecture === null;
  const locationOk = project.remote === 'full' || isAdjacentOrSame(project.prefecture, own.prefecture);
  if (!locationOk && !bothPrefectureUnknown) return null;

  // 時期: どちらか不明なら通過(緩め)
  const timingUnknown = project.startDate === null || own.availableFrom === null;
  const timingOk = timingUnknown
    ? true
    : isTimingWithinGrace(project.startDate as string, own.availableFrom as string);
  if (!timingUnknown && !timingOk) return null;

  // 金額: 案件単価 ≥ 必要案件単価。どちらか不明なら要確認、満たさなければ除外
  const rate = projectRateMan(project);
  const required = own.requiredProjectRate;
  const rateUnknown = rate === null || required === null;
  if (!rateUnknown && (rate as number) < (required as number)) return null; // 単価不足は除外
  const meetsRate = !rateUnknown && (rate as number) >= (required as number);
  const rateGapMan = rateUnknown ? null : (rate as number) - (required as number);

  const needsReview = rateUnknown || bothPrefectureUnknown;
  const score = Math.round(matchRate * 70 + (locationOk || bothPrefectureUnknown ? 20 : 0) + (timingOk ? 10 : 0));

  const pct = Math.round(matchRate * 100);
  const tentativeNote = band === 'tentative' ? '【参考提案】スキルは許容範囲内のため人によるご確認を推奨。' : '';
  const reason = needsReview
    ? `${tentativeNote}案件単価または勤務地が不明のため要確認です（スキル一致率${pct}%）。`
    : `${tentativeNote}必要案件単価${required}万円に対し案件単価${rate}万円（差 +${rateGapMan}万円）・スキル一致率${pct}%・勤務地適合・時期${timingOk ? '適合' : '要確認'}。`;

  return {
    id: `ownmatch_${own.id}_${project.id}`,
    ownEngineerId: own.id,
    ownEngineerName: own.displayName,
    projectId: project.id,
    projectTitle: project.title,
    projectRate: rate,
    requiredProjectRate: required,
    rateGapMan,
    meetsRate,
    skillMatchRate: matchRate,
    band,
    locationOk: locationOk || bothPrefectureUnknown,
    timingOk,
    needsReview,
    score,
    reason,
    agentEmail: project.agentEmail,
    detectedAt: new Date(),
  };
}

// 自社社員ごとに、合いそうな案件を上位 maxCandidatesPerItem() 件まで返す（純関数・LLM不使用）。
export function matchOwnEngineersToProjects(own: OwnEngineer[], projects: Project[]): OwnMatch[] {
  const openProjects = projects.filter((p) => p.status === 'open');
  const availableOwn = own.filter((o) => o.status === 'available');

  const results: OwnMatch[] = [];
  for (const engineer of availableOwn) {
    const candidates: OwnMatch[] = [];
    for (const project of openProjects) {
      const m = evaluate(engineer, project);
      if (m) candidates.push(m);
    }
    // 単価充足(meetsRate) 優先 → 単価差(rateGap)降順 → スキル一致率 降順
    candidates.sort(
      (a, b) =>
        Number(b.meetsRate) - Number(a.meetsRate) ||
        (b.rateGapMan ?? -Infinity) - (a.rateGapMan ?? -Infinity) ||
        b.skillMatchRate - a.skillMatchRate,
    );
    results.push(...candidates.slice(0, maxCandidatesPerItem()));
  }
  return results;
}

async function loadOwnEngineers(): Promise<OwnEngineer[]> {
  if (isDemo()) return loadFixtureOwnEngineers();
  try {
    return await fetchOwnEngineers();
  } catch (err) {
    console.error(`自社社員探し: 自社社員の取得に失敗: ${String(err)}`);
    return [];
  }
}

async function loadProjects(): Promise<Project[]> {
  if (isDemo()) {
    // 直前の ses:demo 成果物があれば使う。無ければ fixture メールから抽出して自己完結させる。
    const cached = readDemoArtifact<Project[]>('projects');
    if (cached && cached.length > 0) {
      return cached.map((p) => ({ ...p, receivedAt: new Date(p.receivedAt) }));
    }
    const mails = await parseAttachments(await collectSesMail());
    const { items } = await extractItems(mails);
    return items.filter(isProjectItem).map((i) => i.project);
  }
  try {
    return await fetchOpenProjects();
  } catch (err) {
    console.error(`自社社員探し: 案件の取得に失敗: ${String(err)}`);
    return [];
  }
}

function isProjectItem(item: ExtractedItem): item is { kind: 'project'; project: Project } {
  return item.kind === 'project';
}

// 自社社員探しの実行本体: 社員・案件を読み込み → 突合 → コンソール出力 + レビュー成果書き出し。
export async function runOwnMatch(): Promise<OwnMatch[]> {
  console.log('=== 自社社員→案件探し 開始 ===');
  console.log(`モード: ${isDemo() ? 'DEMO（外部呼び出しなし）' : '本番'}`);

  await loadSkillEquivalences(); // 育てた同義辞書をスキル判定に反映
  const [own, projects] = await Promise.all([loadOwnEngineers(), loadProjects()]);
  console.log(`自社社員: ${own.length}名 / 募集中案件: ${projects.length}件`);

  const matches = matchOwnEngineersToProjects(own, projects);
  writeReviewOwnMatches(matches);

  printSummary(own, matches);
  console.log(`=== 自社社員→案件探し 完了: 提示候補 計${matches.length}件 ===`);
  return matches;
}

function printSummary(own: OwnEngineer[], matches: OwnMatch[]): void {
  console.log('\n=== 自社社員ごとの候補案件 ===');
  for (const engineer of own) {
    const forEngineer = matches.filter((m) => m.ownEngineerId === engineer.id);
    console.log(`\n■ ${engineer.displayName}（必要案件単価: ${engineer.requiredProjectRate ?? '未設定'}万円/月）`);
    if (forEngineer.length === 0) {
      console.log('  条件に合う案件は見つかりませんでした。');
      continue;
    }
    for (const m of forEngineer) {
      const tentative = m.band === 'tentative' ? '[参考提案]' : '';
      const tag = tentative + (m.needsReview ? '[要確認]' : m.meetsRate ? '[単価充足]' : '');
      console.log(`  ${tag} ${m.projectTitle} — 案件単価${m.projectRate ?? '不明'}万円/月, 適合スコア${m.score}点`);
      console.log(`      ${m.reason}`);
    }
  }
  console.log('');
}

runOwnMatch().catch(console.error);
