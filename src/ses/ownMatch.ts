// 自社社員(候補要員)→ 合いそうな案件を探す機能。
// 外部要員との突合(match.ts)と異なり、金額条件は「案件単価 ≥ 社員の必要案件単価」の閾値方式。
// 必要案件単価を少し下回る案件（既定5万円まで。PROPER_RATE_TOLERANCE_MAN）は「単価交渉」として候補に残す。
// スキル・時期の判定は match.ts と同じヘルパーを流用する。勤務地・通勤は見ない。
// プロパー候補（proper/index.ts）はここを緩い足切り（ownPairsForJudge）として使い、合うかどうかはAI判定（proper/judge.ts）で決める。
// 本番=自社社員DB＋案件DBを参照、demo=fixture社員＋fixture案件で外部呼び出しなし。
// 他モジュールから import しても副作用が無いよう、CLI起動は ownMatchCli.ts に分離している。
import { flowConstraints, violatesHops } from './constraints.js';
import { collectSesMail } from './collect.js';
import { parseAttachments } from './parse.js';
import { extractItems } from './extract.js';
import { assessSkills, directSkillRate, impliedSkillNote, fmtMan, roundManDown, skillMatch } from './pricing.js';
import { parseRequirements, skillCategory, techNamesIn } from './skillDict.js';
import { loadSkillEquivalences } from './skillEquiv.js';
import { isTimingWithinGrace, ageLimitOf } from './match.js';
import { INJECTION_REVIEW_REASON, OUTGOING_TEXT_REVIEW_REASON, unsafeOutgoingText } from './injection.js';
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
  properRateToleranceMan,
} from './config.js';
import { evaluateLevel } from './level.js';
import { safeErr } from './redact.js';
import {
  allocateWithCaps,
  compareDesc,
  directnessKeys,
  freshnessOf,
  freshnessScorePenalty,
  preferredShare,
  skillFitScore,
  staleCaution,
} from './ranking.js';
import type { OwnEngineer, Project, OwnMatch, ExtractedItem, MatchBand, PairBreakdown, Freshness, SkillBreakdown } from '../types/index.js';

// 案件単価は上限(rateMax)を優先し、無ければ下限(rateMin)。両方無ければ null。
export function projectRateMan(project: Project): number | null {
  return project.rateMax ?? project.rateMin ?? null;
}

// 単価差の表示（+5 / -2.5）
export function signedMan(gap: number): string {
  return gap >= 0 ? `+${fmtMan(gap)}` : `-${fmtMan(-gap)}`;
}

// 並びに使う内部の値（OwnMatch には載せない）
interface OwnRankInfo {
  skill: PairBreakdown['skill'];
  levelGap: number; // 経験年数・工程・立場の足りない度合い（0が最良）
  freshness: Freshness;
  receivedMs: number;
}

// 案件の中心の技術を持っているか。技術（辞書の技術名）の必須があればその過半数を満たし、案件名に技術名があれば
// そのどれかを持っていること（「PowerBI研修」に基本設計・PLの経験だけの社員を付けない）
export function coversCoreTech(project: Pick<Project, 'title' | 'requiredSkills'>, have: string[], b: SkillBreakdown | null): boolean {
  const isTech = (label: string) => parseRequirements(label).some((r) => r.members.some((m) => skillCategory(m) === 'skill'));
  if (b) {
    const techReqs = [...b.exact, ...b.equiv, ...b.implied, ...b.missing].filter(isTech);
    // 技術の必須の過半数を満たすこと（Java開発の案件に Linux だけ合う社員を付けない）
    const techMet = techReqs.filter((l) => !b.missing.includes(l)).length;
    if (techReqs.length > 0 && techMet * 2 <= techReqs.length) return false;
  }
  const titleTech = techNamesIn(project.title);
  if (titleTech.length === 0) return true;
  return titleTech.some((t) => (skillMatch([t], have)?.rate ?? 0) > 0);
}

// AI判定に回す組の足切り: 技術（辞書の技術名）の必須を1つでも満たすか、案件名の技術を1つでも持つ。
// 一致率の閾値より緩くし、実際に合うかはAIが経歴を読んで決める（proper/judge.ts）
export function sharesTech(project: Pick<Project, 'title' | 'requiredSkills'>, have: string[], b: SkillBreakdown | null): boolean {
  const isTech = (label: string) => parseRequirements(label).some((r) => r.members.some((m) => skillCategory(m) === 'skill'));
  if (b && [...b.exact, ...b.equiv, ...b.implied].some(isTech)) return true;
  return techNamesIn(project.title).some((t) => (skillMatch([t], have)?.rate ?? 0) > 0);
}

export interface OwnMatchOptions {
  // AI判定の前段として緩く足切りする（sharesTech で通し、一致率・中心の技術の判定は rulePass に残す）
  forJudge?: boolean;
}

// 自社社員1名×案件1件の適合判定（純関数）。条件外なら null
export function evaluateOwnMatch(own: OwnEngineer, project: Project, now = new Date(), opts: OwnMatchOptions = {}): OwnMatch | null {
  return evaluateOwnMatchDetailed(own, project, now, opts)?.match ?? null;
}

interface Evaluated {
  match: OwnMatch;
  rank: OwnRankInfo;
  rulePass: boolean; // ルールだけの基準（一致率の閾値・中心の技術）も満たすか。AI判定に失敗した組はこれで残すかを決める
}

function evaluateOwnMatchDetailed(own: OwnEngineer, project: Project, now: Date, opts: OwnMatchOptions): Evaluated | null {
  const reviewReasons: string[] = [];
  // スキル: 外部要員(match.ts)と同じ基準でバンド分けし、参考提案(tentative)は注記を付ける。
  // 必須スキルが空の案件は尚可スキルで参考判定、どちらも空なら案件名に社員のスキルが現れる場合だけ要確認
  // 強マッチは直接の記載（完全一致・同義・確実な含意）で満たした割合で決める（推定の含意は一致率・並びにだけ効かせ、
  // 推定で満たした社員が、その必須をまったく持たない社員より下の区分にならないように）
  const skill = assessSkills(project, own.skills);
  let band: MatchBand = 'tentative';
  const implied = impliedSkillNote(skill.breakdown);
  let rulePass = true;
  if (skill.basis === 'unknown') {
    if (skill.titleHits.length === 0) return null;
    reviewReasons.push('必須スキル不明');
  } else {
    // 工程・役割の語だけで一致率を満たした組は除く（技術の必須を1つも満たさない、または案件名の技術を1つも持たない）
    rulePass = skill.rate >= skillMatchThreshold() && coversCoreTech(project, own.skills, skill.breakdown);
    if (!rulePass && !(opts.forJudge && sharesTech(project, own.skills, skill.breakdown))) return null;
    if (skill.basis === 'required' && directSkillRate(skill.breakdown) >= skillMatchStrongThreshold()) band = 'strong';
  }

  // リモート条件: 常駐のみの案件にフルリモート希望の社員は組まない（外部要員と同じ）
  if (project.remote === 'none' && own.remoteWish === 'full') return null;

  // 商流の条件（貴社社員まで等）: パートナーの要員（区分=パートナー）は自社から1社先のため、「貴社社員まで」の案件には組まない。
  // 外国籍・年齢の条件は要員管理表に項目が無いため、確認事項として根拠に載せる
  const affiliation = (own as { affiliation?: 'proper' | 'partner' }).affiliation;
  const flow = flowConstraints(`${project.businessFlow}\n${project.title}`);
  if (violatesHops(flow, affiliation)) return null;
  // 案件の約9割に書かれているため要確認にはせず、提案前に確かめる事項として根拠の先頭に載せる
  const ageLimit = ageLimitOf(project.businessFlow);
  const conditionNote =
    (flow.foreigner === 'ng' ? '［条件］外国籍不可。' : flow.foreigner === 'conditional' ? '［条件］外国籍は条件つき（日本語力など）。' : '') +
    (ageLimit !== null ? `［条件］年齢${ageLimit}歳まで。` : '') +
    (flow.soleProprietor === 'ng' && affiliation === 'partner' ? '［条件］個人事業主不可（所属を確認）。' : '');

  // 勤務地・通勤は判定に使わない（自社社員は通える範囲を本人と相談して決めるため。営業リストに勤務地を出して人が見る）
  const locationOk = true;

  // 時期: どちらか不明なら通過(緩め)
  const timingUnknown = project.startDate === null || own.availableFrom === null;
  const timingOk = timingUnknown
    ? true
    : isTimingWithinGrace(project.startDate as string, own.availableFrom as string, now);
  if (!timingUnknown && !timingOk) return null;

  // 金額: 案件単価 ≥ 必要案件単価。どちらか不明なら要確認。許容幅までの不足は単価交渉として残し、それを超える不足は除外
  const rate = projectRateMan(project);
  const required = own.requiredProjectRate;
  const rateUnknown = rate === null || required === null;
  if (!rateUnknown && (rate as number) < (required as number) - properRateToleranceMan()) return null;
  if (rateUnknown) reviewReasons.push('単価不明');
  // レベル（技術ごとの経験年数・工程・立場）: 技術名が合っていても、別の軸としてはっきり足りなければ除外する（level.ts）
  const level = evaluateLevel(project.level, own.level, own.experienceYears);
  if (level.verdict === 'exclude') return null;

  // 元のメールにAIへの指示らしき記載がある案件は、人が確かめる（提案文面も作らない。proper/index.ts）
  if (project.injectionSuspected) reviewReasons.push(INJECTION_REVIEW_REASON);
  else if (unsafeOutgoingText([project.title, project.agentContact])) reviewReasons.push(OUTGOING_TEXT_REVIEW_REASON);
  const meetsRate = !rateUnknown && (rate as number) >= (required as number);
  // 表示用に0.5万円刻みへ切り下げる（「+5.200000000000003万円」を出さない。多めには見せない）
  const rateGapMan = rateUnknown ? null : roundManDown((rate as number) - (required as number));
  const rateNegotiation = !rateUnknown && !meetsRate;

  // 鮮度: 受信から SES_STALE_DAYS 超の案件は募集が終わっている恐れがあるため強マッチにせず要再確認を付ける
  const freshness = freshnessOf(project.receivedAt, now);
  const stale = freshness.level === 'stale';
  const skillBand = band;
  if (stale) band = 'tentative';
  // 少しだけ足りない軸がある組は参考提案にする（強マッチとして上に並べない）
  if (level.verdict === 'negotiate') band = 'tentative';

  const needsReview = reviewReasons.length > 0;
  const score = Math.max(
    0,
    Math.round(skill.rate * 70 + (locationOk ? 20 : 0) + (timingOk ? 10 : 0) - freshnessScorePenalty(freshness) - level.gapScore * 10),
  );

  const pct = Math.round(skill.rate * 100);
  const notes =
    conditionNote +
    (skillBand === 'tentative' && skill.basis !== 'unknown' ? '【参考提案】スキルは許容範囲内のため人によるご確認を推奨。' : '') +
    (skillBand === 'strong' && stale ? '【参考提案】' : '') +
    (skill.basis === 'preferred' ? '必須スキルの記載がないため尚可スキルで判定。' : '') +
    (implied ? `${implied}。` : '') +
    (stale ? `${staleCaution('案件')}。` : '') +
    (!rateUnknown && project.rateMax === null ? '案件単価は下限の記載のみ。' : '') +
    (rateNegotiation ? `【単価交渉】必要案件単価まで${fmtMan(-(rateGapMan as number))}万円不足（本人の了承が前提）。` : '') +
    (level.gaps.length > 0 ? `【経験交渉】${level.gaps.join('・')}。` : '') +
    (level.yearGaps.length > 0 ? `【年数交渉】${level.yearGaps.join('・')}。` : '') +
    (level.unknowns.length > 0 ? `［確認］${level.unknowns.join('・')}。` : '') +
    (level.bonus.length > 0 ? `（${level.bonus.join('・')}）` : '');
  const skillText =
    skill.basis === 'unknown' ? `案件名に社員のスキル（${skill.titleHits.join('、')}）の記載あり` : `スキル一致率${pct}%`;
  const reason = needsReview
    ? `${notes}${reviewReasons.join('・')}のため要確認です（${skillText}）。`
    : `${notes}必要案件単価${fmtMan(required as number)}万円に対し案件単価${fmtMan(rate as number)}万円（差 ${signedMan(rateGapMan as number)}万円）・${skillText}・時期${timingOk ? '適合' : '要確認'}。`;

  const b = skill.breakdown;
  return {
    match: {
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
      ...(b ? { matchedSkills: [...b.exact, ...b.equiv, ...b.implied], missingSkills: [...b.missing] } : {}),
    },
    rank: {
      skill: {
        basis: skill.basis,
        rate: skill.rate,
        exact: b?.exact.length ?? 0,
        equiv: b?.equiv.length ?? 0,
        implied: b?.implied.length ?? 0,
        total: b ? b.exact.length + b.equiv.length + b.implied.length + b.missing.length : 0,
        preferred: skill.preferred,
      },
      levelGap: level.gapScore,
      freshness,
      receivedMs: Number.isFinite(new Date(project.receivedAt).getTime()) ? new Date(project.receivedAt).getTime() : 0,
    },
    rulePass,
  };
}

// 自社社員ごとに合いそうな案件を最大 maxCandidatesPerItem() 件（案件ごとにも同数まで）返す（純関数・LLM不使用）。
// 並びは適合が先: 強マッチ → 参考提案 → 要確認、同じ区分の中はレベルの合い方（経験年数・工程・立場の不足が小さい順）→
// スキル適合度（一致率−鮮度の減点）→ 完全一致の割合 → 尚可の一致 → 必要案件単価を満たすか → 受信の新しい順 → ID。
// 単価の差の大きさでは並べない（社員は必要案件単価どおりでよく、高単価の案件ほど求めるレベルも高いため）。
// 割り当ては外部要員の一次選抜と同じ上限つき貪欲法
export function matchOwnEngineersToProjects(own: OwnEngineer[], projects: Project[], now = new Date()): OwnMatch[] {
  return rankOwnPairs(own, projects, now, {}, maxCandidatesPerItem()).map((c) => c.match);
}

// AI判定に回す組（緩い足切り＋ルールの並び）。社員ごと・案件ごとに perItem 件まで
export function ownPairsForJudge(own: OwnEngineer[], projects: Project[], perItem: number, now = new Date()): Array<{ match: OwnMatch; rulePass: boolean }> {
  return rankOwnPairs(own, projects, now, { forJudge: true }, perItem).map((c) => ({ match: c.match, rulePass: c.rulePass }));
}

function rankOwnPairs(own: OwnEngineer[], projects: Project[], now: Date, opts: OwnMatchOptions, limit: number): Evaluated[] {
  const openProjects = projects.filter((p) => p.status === 'open');
  const availableOwn = own.filter((o) => o.status === 'available');

  const candidates: Evaluated[] = [];
  for (const engineer of availableOwn) {
    for (const project of openProjects) {
      const m = evaluateOwnMatchDetailed(engineer, project, now, opts);
      if (m) candidates.push(m);
    }
  }
  const category = (m: OwnMatch) => (m.needsReview ? 2 : m.band === 'strong' ? 0 : 1);
  const keys = (c: Evaluated): number[] => [
    -category(c.match),
    -c.rank.levelGap,
    skillFitScore(c.rank.skill, c.rank.freshness),
    ...directnessKeys(c.rank.skill),
    preferredShare(c.rank.skill),
    c.match.meetsRate ? 1 : 0,
    c.rank.receivedMs,
  ];
  candidates.sort((a, b) => compareDesc(keys(a), keys(b)) || (a.match.id < b.match.id ? -1 : a.match.id > b.match.id ? 1 : 0));
  return allocateWithCaps(candidates, [
    { key: (c) => c.match.ownEngineerId, max: limit },
    { key: (c) => c.match.projectId, max: limit },
  ]);
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
      const tag = tentative + (m.needsReview ? '[要確認]' : m.meetsRate ? '[単価充足]' : '[単価交渉]');
      console.log(`  ${tag} ${m.projectTitle} — 案件単価${m.projectRate ?? '不明'}万円/月, 適合スコア${m.score}点`);
      console.log(`      ${m.reason}`);
    }
  }
  console.log('');
}

