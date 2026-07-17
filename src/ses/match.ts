// マッチング。一次選抜（純コード・無料、primarySelect）→ 通過ペアのみ最終判定
// （本番=Sonnet 5、demo/要確認枠=ヒューリスティック）。
import { generateJson } from '../llm/index.js';
import { skillMatchRate } from './pricing.js';
import { isAdjacentOrSame } from './prefecture.js';
import {
  isDemo,
  maxCandidatesPerItem,
  matchModel,
  matchTimingGraceDays,
  minGrossMarginJpy,
  skillMatchThreshold,
  enableNegotiation,
  maxNegotiationRaiseMan,
  maxNegotiationCutMan,
} from './config.js';
import type { Project, Engineer, MatchPair, MatchResult, NegotiationProposal } from '../types/index.js';

// 一次選抜のみ（LLM不使用・純関数。demo/本番共通で使う）
export function primarySelect(projects: Project[], engineers: Engineer[]): MatchPair[] {
  const openProjects = projects.filter((p) => p.status === 'open');
  const availableEngineers = engineers.filter((e) => e.status === 'available');

  const results: MatchPair[] = [];
  for (const project of openProjects) {
    const candidates: MatchPair[] = [];
    for (const engineer of availableEngineers) {
      const pair = evaluatePair(project, engineer);
      if (pair) candidates.push(pair);
    }
    // 粗利額 降順 → スキル一致率 降順 でソートし、上位 maxCandidatesPerItem() 件に制限
    candidates.sort((a, b) => b.grossMarginJpy - a.grossMarginJpy || b.skillMatchRate - a.skillMatchRate);
    results.push(...candidates.slice(0, maxCandidatesPerItem()));
  }
  return results;
}

function evaluatePair(project: Project, engineer: Engineer): MatchPair | null {
  // 3. スキル一致（必須スキルの被覆率）。閾値未満は候補から除外
  const matchRate = skillMatchRate(project.requiredSkills, engineer.skills);
  if (matchRate < skillMatchThreshold()) return null;

  // 4. 勤務地。フルリモート可 または 都道府県が同一/隣接ならOK。両方不明なら判定不能として通過(要確認)
  const bothPrefectureUnknown = project.prefecture === null && engineer.prefecture === null;
  const locationOk = project.remote === 'full' || isAdjacentOrSame(project.prefecture, engineer.prefecture);
  if (!locationOk && !bothPrefectureUnknown) return null;

  // 5. 時期。どちらか不明なら通過（時期は緩めに扱う。needsReviewは立てない）
  const timingUnknown = project.startDate === null || engineer.availableFrom === null;
  const timingOk = timingUnknown ? true : isTimingWithinGrace(project.startDate as string, engineer.availableFrom as string);
  if (!timingUnknown && !timingOk) return null;

  // 2. 粗利条件。どちらかの単金が不明なら判定不能→要確認枠として通過候補に含める
  const rateUnknown = project.rateMax === null || engineer.desiredRate === null;
  const grossMarginJpy = rateUnknown ? 0 : Math.round((project.rateMax! - engineer.desiredRate!) * 10000);

  // 粗利が下限未満でも、両者の単金交渉で下限に届く見込みがあれば「交渉提案」として拾い上げる。
  // 交渉幅（案件の値上げ上限＋要員の値下げ上限）を超えて届かない場合のみ除外する。
  let negotiation: NegotiationProposal | undefined;
  if (!rateUnknown && grossMarginJpy < minGrossMarginJpy()) {
    const proposal = buildNegotiation(project.rateMax!, engineer.desiredRate!, minGrossMarginJpy());
    if (!proposal) return null; // 交渉幅を超える＝除外
    negotiation = proposal;
  }

  const needsReview = rateUnknown || bothPrefectureUnknown;

  return {
    project,
    engineer,
    grossMarginJpy,
    skillMatchRate: matchRate,
    locationOk: locationOk || bothPrefectureUnknown,
    timingOk,
    needsReview,
    negotiation,
  };
}

// 現状粗利が下限未満のペアについて、案件単金の値上げと要員単金の値下げで下限に届く提案を作る。
// 不足分をできるだけ両者で折半し、各交渉上限で頭打ちにする。交渉幅を超える場合は null（＝除外）。
function buildNegotiation(
  projectRateMan: number,
  engineerRateMan: number,
  minMarginJpy: number,
): NegotiationProposal | null {
  if (!enableNegotiation()) return null;
  const currentMarginJpy = Math.round((projectRateMan - engineerRateMan) * 10000);
  const shortfallJpy = minMarginJpy - currentMarginJpy;
  if (shortfallJpy <= 0) return null; // 既に充足（交渉不要）

  const neededMan = shortfallJpy / 10000;
  const raiseMax = maxNegotiationRaiseMan();
  const cutMax = maxNegotiationCutMan();
  if (neededMan > raiseMax + cutMax + 1e-9) return null; // 交渉幅を超える

  const totalMan = Math.ceil(neededMan); // 万円単位に切り上げ（下限を確実に満たす）
  let raise = Math.min(Math.ceil(totalMan / 2), raiseMax);
  let cut = totalMan - raise;
  if (cut > cutMax) {
    cut = cutMax;
    raise = totalMan - cut;
  }
  const targetProjectRateMan = projectRateMan + raise;
  const targetEngineerRateMan = engineerRateMan - cut;
  const resultingGrossMarginJpy = Math.round((targetProjectRateMan - targetEngineerRateMan) * 10000);
  return {
    projectRaiseMan: raise,
    engineerCutMan: cut,
    targetProjectRateMan,
    targetEngineerRateMan,
    resultingGrossMarginJpy,
  };
}

function isTimingWithinGrace(startDateIso: string, availableFromIso: string): boolean {
  const start = new Date(startDateIso).getTime();
  const available = new Date(availableFromIso).getTime();
  if (Number.isNaN(start) || Number.isNaN(available)) return true; // パース不能は緩めに扱う
  const graceMs = matchTimingGraceDays() * 24 * 60 * 60 * 1000;
  return available <= start + graceMs;
}

// 一次選抜 → 通過ペアのみ最終判定（本番=Sonnet / demo・要確認枠=ヒューリスティック）
export async function matchAll(projects: Project[], engineers: Engineer[]): Promise<MatchResult[]> {
  const pairs = primarySelect(projects, engineers);

  const results: MatchResult[] = [];
  for (const pair of pairs) {
    // 要確認枠（単金/勤務地不明）と交渉提案枠はLLM節約のため最終判定に回さない。demoも同様にLLM不使用。
    // 交渉提案は提案内容（値上げ/値下げ額）が主眼なので、根拠は決定的に生成する。
    if (pair.needsReview || pair.negotiation || isDemo()) {
      results.push(buildHeuristicResult(pair));
      continue;
    }
    try {
      results.push(await judgeWithLlm(pair));
    } catch (err) {
      console.error(`SESマッチ: 最終判定に失敗 (${pair.project.title} × ${pair.engineer.displayName}): ${String(err)}`);
      results.push(buildHeuristicResult(pair)); // 判定失敗時はヒューリスティックにフォールバック
    }
  }
  return results;
}

function buildHeuristicResult(pair: MatchPair): MatchResult {
  const score = Math.round(pair.skillMatchRate * 70 + (pair.locationOk ? 20 : 0) + (pair.timingOk ? 10 : 0));
  const pct = Math.round(pair.skillMatchRate * 100);
  let reason: string;
  if (pair.needsReview) {
    reason = `単金または勤務地情報が不足しているため要確認です（スキル一致率${pct}%）。`;
  } else if (pair.negotiation) {
    const n = pair.negotiation;
    reason =
      `現状の粗利は${(pair.grossMarginJpy / 10000).toFixed(1)}万円ですが、` +
      `案件単金を+${n.projectRaiseMan}万円（→${n.targetProjectRateMan}万円）・` +
      `要員単金を−${n.engineerCutMan}万円（→${n.targetEngineerRateMan}万円）で交渉すれば` +
      `粗利${(n.resultingGrossMarginJpy / 10000).toFixed(1)}万円/月を確保できます（スキル一致率${pct}%）。`;
  } else {
    reason = `スキル一致率${pct}%・勤務地${pair.locationOk ? '適合' : '要確認'}・時期${pair.timingOk ? '適合' : '要確認'}に基づく機械判定です。`;
  }
  return buildMatchResult(pair, score, reason);
}

function buildMatchResult(pair: MatchPair, score: number, reason: string): MatchResult {
  return {
    id: `match_${pair.project.id}_${pair.engineer.id}`,
    projectId: pair.project.id,
    engineerId: pair.engineer.id,
    title: `${pair.project.title} × ${pair.engineer.displayName}`,
    grossMarginJpy: pair.grossMarginJpy,
    score,
    reason,
    needsReview: pair.needsReview,
    negotiation: pair.negotiation,
    status: 'unconfirmed',
    detectedAt: new Date(),
  };
}

const MATCH_SYSTEM = `あなたはSES案件と要員のマッチング精度を判定する専門家です。
案件情報と要員情報を読み、適合度を0〜100のスコアと、根拠となる簡潔な日本語の説明文で返してください。
スコアはスキルの文脈適合・勤務地・時期・単金の妥当性を総合的に考慮してください。`;

const MATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    score: { type: 'integer' },
    reason: { type: 'string' },
  },
  required: ['score', 'reason'],
} as const;

async function judgeWithLlm(pair: MatchPair): Promise<MatchResult> {
  const parsed = await generateJson<{ score: number; reason: string }>(
    MATCH_SYSTEM,
    buildMatchPrompt(pair),
    MATCH_SCHEMA,
    { model: matchModel(), maxTokens: 1024 },
  );
  const score = Math.max(0, Math.min(100, Math.round(parsed.score)));
  return buildMatchResult(pair, score, parsed.reason);
}

function buildMatchPrompt(pair: MatchPair): string {
  const { project, engineer, grossMarginJpy, skillMatchRate: rate, locationOk, timingOk } = pair;
  return `【案件】
案件名: ${project.title}
必須スキル: ${project.requiredSkills.join(', ') || 'なし'}
尚可スキル: ${project.preferredSkills.join(', ') || 'なし'}
単金: ${project.rateMin ?? '不明'}〜${project.rateMax ?? '不明'}万円/月
勤務地: ${project.location}（リモート: ${project.remote}）
開始時期: ${project.startPeriod}

【要員】
表示名: ${engineer.displayName}
スキル: ${engineer.skills.join(', ') || 'なし'}
経験年数: ${engineer.experienceYears ?? '不明'}年
希望単金: ${engineer.desiredRate ?? '不明'}万円/月
居住地: ${engineer.residence}（リモート希望: ${engineer.remoteWish}）
稼働開始可能日: ${engineer.availableDate}

【一次選抜結果】
粗利額: ${grossMarginJpy}円/月
スキル一致率: ${Math.round(rate * 100)}%
勤務地適合: ${locationOk ? 'OK' : '要確認'}
時期適合: ${timingOk ? 'OK' : '要確認'}`;
}
