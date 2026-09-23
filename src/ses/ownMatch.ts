// 自社社員(候補要員)→ 合いそうな案件を探す機能。
// 外部要員との突合(match.ts)と異なり、金額条件は「案件単価 ≥ 社員の必要案件単価」の閾値方式。
// スキル・勤務地・時期の判定は match.ts と同じヘルパーを流用する。
// 本番=自社社員DB＋案件DBを参照、demo=fixture社員＋fixture案件で外部呼び出しなし。
// 他モジュールから import しても副作用が無いよう、CLI起動は ownMatchCli.ts に分離している。
import { collectSesMail } from './collect.js';
import { parseAttachments } from './parse.js';
import { extractItems } from './extract.js';
import { assessSkills, impliedSkillNote, fmtMan, roundManDown } from './pricing.js';
import { isAdjacentOrSame, isFullRemoteLocation } from './prefecture.js';
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
  logRedact,
} from './config.js';
import { safeErr } from './redact.js';
import type { OwnEngineer, Project, OwnMatch, ExtractedItem, MatchBand } from '../types/index.js';

// 案件単価は上限(rateMax)を優先し、無ければ下限(rateMin)。両方無ければ null。
export function projectRateMan(project: Project): number | null {
  return project.rateMax ?? project.rateMin ?? null;
}

// 自社社員1名×案件1件の適合判定（純関数）。条件外なら null
export function evaluateOwnMatch(own: OwnEngineer, project: Project): OwnMatch | null {
  const reviewReasons: string[] = [];
  // スキル: 外部要員(match.ts)と同じ基準でバンド分けし、参考提案(tentative)は注記を付ける。
  // 必須スキルが空の案件は尚可スキルで参考判定、どちらも空なら案件名に社員のスキルが現れる場合だけ要確認
  // 含意だけで満たした必須（Spring Boot の経験で Java 必須）がある組は参考提案に一段下げる
  const skill = assessSkills(project, own.skills);
  let band: MatchBand = 'tentative';
  const implied = impliedSkillNote(skill.breakdown);
  if (skill.basis === 'unknown') {
    if (skill.titleHits.length === 0) return null;
    reviewReasons.push('必須スキル不明');
  } else {
    if (skill.rate < skillMatchThreshold()) return null;
    if (skill.basis === 'required' && skill.rate >= skillMatchStrongThreshold() && !implied) band = 'strong';
  }

  // 勤務地: フルリモート可なら不問。両方わかれば同一/隣接のみ通過、片方でも不明なら判定不能として要確認
  const fullRemote = project.remote === 'full' || isFullRemoteLocation(project.location);
  const locationKnownOk = isAdjacentOrSame(project.prefecture, own.prefecture);
  const locationUnknown = !fullRemote && (project.prefecture === null || own.prefecture === null);
  if (!fullRemote && !locationUnknown && !locationKnownOk) return null;
  if (locationUnknown) reviewReasons.push('勤務地不明');
  const locationOk = fullRemote || locationKnownOk;

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
  if (rateUnknown) reviewReasons.push('単価不明');
  const meetsRate = !rateUnknown && (rate as number) >= (required as number);
  // 表示用に0.5万円刻みへ切り下げる（「+5.200000000000003万円」を出さない。多めには見せない）
  const rateGapMan = rateUnknown ? null : roundManDown((rate as number) - (required as number));

  const needsReview = reviewReasons.length > 0;
  const score = Math.round(skill.rate * 70 + (locationOk ? 20 : 0) + (timingOk ? 10 : 0));

  const pct = Math.round(skill.rate * 100);
  const notes =
    (band === 'tentative' && skill.basis !== 'unknown' ? '【参考提案】スキルは許容範囲内のため人によるご確認を推奨。' : '') +
    (skill.basis === 'preferred' ? '必須スキルの記載がないため尚可スキルで判定。' : '') +
    (implied ? `${implied}。` : '') +
    (!rateUnknown && project.rateMax === null ? '案件単価は下限の記載のみ。' : '');
  const skillText =
    skill.basis === 'unknown' ? `案件名に社員のスキル（${skill.titleHits.join('、')}）の記載あり` : `スキル一致率${pct}%`;
  const reason = needsReview
    ? `${notes}${reviewReasons.join('・')}のため要確認です（${skillText}）。`
    : `${notes}必要案件単価${fmtMan(required as number)}万円に対し案件単価${fmtMan(rate as number)}万円（差 +${fmtMan(rateGapMan as number)}万円）・${skillText}・勤務地適合・時期${timingOk ? '適合' : '要確認'}。`;

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
    skillMatchRate: skill.rate,
    band,
    locationOk,
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
      const m = evaluateOwnMatch(engineer, project);
      if (m) candidates.push(m);
    }
    // 強マッチ → 参考提案 → 要確認 の順（単価差の大きい参考提案が強マッチを押し出さないように）→ 単価差 降順 → スキル一致率 降順
    const rank = (m: OwnMatch) => (m.needsReview ? 2 : m.band === 'strong' ? 0 : 1);
    candidates.sort(
      (a, b) =>
        rank(a) - rank(b) ||
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
    console.error(`自社社員探し: 自社社員の取得に失敗: ${safeErr(err)}`);
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
    const mails = await parseAttachments((await collectSesMail()).mails);
    const { items } = await extractItems(mails);
    return items.filter(isProjectItem).map((i) => i.project);
  }
  try {
    return await fetchOpenProjects();
  } catch (err) {
    console.error(`自社社員探し: 案件の取得に失敗: ${safeErr(err)}`);
    return [];
  }
}

function isProjectItem(item: ExtractedItem): item is { kind: 'project'; project: Project } {
  return item.kind === 'project';
}

// 自社社員探しの実行本体: 社員・案件を読み込み → 突合 → コンソール出力 + レビュー成果書き出し。
// 読み込んだ案件も返す（ses:own-match の demo でプロパー候補探しに同じ案件を使うため）
export async function runOwnMatch(): Promise<{ matches: OwnMatch[]; projects: Project[] }> {
  console.log('=== 自社社員→案件探し 開始 ===');
  console.log(`モード: ${isDemo() ? 'DEMO（外部呼び出しなし）' : '本番'}`);

  await loadSkillEquivalences(); // 育てた同義辞書をスキル判定に反映
  const [own, projects] = await Promise.all([loadOwnEngineers(), loadProjects()]);
  console.log(`自社社員: ${own.length}名 / 募集中案件: ${projects.length}件`);

  const matches = matchOwnEngineersToProjects(own, projects);
  writeReviewOwnMatches(matches);

  printSummary(own, matches);
  console.log(`=== 自社社員→案件探し 完了: 提示候補 計${matches.length}件 ===`);
  return { matches, projects };
}

function printSummary(own: OwnEngineer[], matches: OwnMatch[]): void {
  if (logRedact()) {
    // 公開ログには社員名・案件名・単価を出さない（通し番号と件数のみ）
    console.log('\n=== 自社社員ごとの候補件数（ログ秘匿モード） ===');
    own.forEach((engineer, i) => {
      const n = matches.filter((m) => m.ownEngineerId === engineer.id).length;
      console.log(`  社員${i + 1}: 候補${n}件`);
    });
    console.log('');
    return;
  }
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

