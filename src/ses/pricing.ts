// 単金正規化（万円/月・円/時・円/月 → 万円/月）とスキル一致率の計算。extract/match の双方が参照する。
import { hourlyToMonthlyHours } from './config.js';
import { skillCoverage, type CoverageHit } from './skillEquiv.js';
import { parseRequirements } from './skillDict.js';
import type { SkillBreakdown, PreferredMatch } from '../types/index.js';

export type RateUnit = 'manYenPerMonth' | 'yenPerHour' | 'yenPerMonth';

// 各種表記を「万円/月」の number に正規化する。「スキル見合い」等は抽出段で null を返す（ここには来ない）。
export function normalizeRate(value: number, unit: RateUnit): number {
  if (unit === 'manYenPerMonth') return value;
  if (unit === 'yenPerHour') return (value * hourlyToMonthlyHours()) / 10000;
  return value / 10000; // yenPerMonth
}

export interface SkillMatch {
  rate: number; // 0〜1（完全一致・同義・含意のいずれかで満たした割合）
  breakdown: SkillBreakdown;
}

// スキルの被覆率と内訳。required は要件の表記（normalizeRequirementLists 済み。'AWS(EC2/RDS)' 'Java / C#（いずれか）' は
// どれか1つを満たせば1要件を満たす）、have は normalizeSkills 済みの前提。
// 完全一致に加え、育てた同義辞書（skillEquiv）と含意（skillGraph。下位の技術の経験で上位の必須を満たす）も
// 「満たす」とみなす。確実な含意（Spring Boot ⇒ Spring 等）は同等（equiv）に数え、それ以外の含意は implied（推定）に数える。
// 対象が空なら null（＝不明。添付の解析失敗などで空になった案件を「誰にでも100%一致」とはみなさない）
export function skillMatch(required: string[], have: string[]): SkillMatch | null {
  const targets = [
    ...new Map(required.flatMap((r) => parseRequirements(r)).map((r) => [r.label.toLowerCase(), r] as const)).values(),
  ];
  if (targets.length === 0) return null;
  const haveByKey = new Map(have.map((h) => [h.toLowerCase(), h] as const));
  const haveKeys = new Set(haveByKey.keys());
  const breakdown: SkillBreakdown = { exact: [], implied: [], equiv: [], missing: [], via: {} };
  for (const r of targets) {
    const hit = bestCoverage(r.members, haveKeys);
    if (!hit) {
      breakdown.missing.push(r.label);
      continue;
    }
    const kind = hit.kind === 'implied' && hit.strong ? 'equiv' : hit.kind;
    breakdown[kind].push(r.label);
    if (kind !== 'exact' || hit.member.toLowerCase() !== r.label.toLowerCase()) {
      breakdown.via[r.label] = haveByKey.get(hit.via) ?? hit.via;
    }
  }
  return { rate: (targets.length - breakdown.missing.length) / targets.length, breakdown };
}

const COVERAGE_ORDER = (h: CoverageHit): number => (h.kind === 'exact' ? 0 : h.kind === 'equiv' ? 1 : h.strong ? 2 : 3);

// 要件のどれか1つの満たし方のうち、最も直接的なもの
function bestCoverage(members: string[], haveKeys: ReadonlySet<string>): (CoverageHit & { member: string }) | null {
  let best: (CoverageHit & { member: string }) | null = null;
  for (const m of members) {
    const hit = skillCoverage(m, haveKeys);
    if (hit && (!best || COVERAGE_ORDER(hit) < COVERAGE_ORDER(best))) best = { ...hit, member: m };
  }
  return best;
}

// 直接の記載（完全一致・同義・確実な含意）で満たした必須の割合。強マッチかどうかはこの割合で決める
// （推定の含意で満たした必須は一致率と並びには効くが、満たさない場合より組を悪くしない）
export function directSkillRate(b: SkillBreakdown | null): number {
  if (!b) return 0;
  const total = b.exact.length + b.equiv.length + b.implied.length + b.missing.length;
  return total > 0 ? (b.exact.length + b.equiv.length) / total : 0;
}

// スキル判定の根拠。required=必須スキルで判定、preferred=必須が空のため尚可スキルで判定（参考扱い）、
// unknown=どちらも空のため判定不能（案件名に要員のスキルが現れる場合だけ要確認として残す）
export type SkillBasis = 'required' | 'preferred' | 'unknown';

export interface SkillAssessment {
  rate: number; // 判定に使った一致率 0〜1（unknown は 0）
  basis: SkillBasis;
  titleHits: string[]; // unknown のとき、案件名に現れた要員のスキル
  breakdown: SkillBreakdown | null; // 判定に使ったスキルの満たし方（unknown は null）
  preferred: PreferredMatch; // 尚可スキルの一致数（total=0 は記載なし）
}

export function assessSkills(
  project: { title: string; requiredSkills: string[]; preferredSkills: string[] },
  have: string[],
): SkillAssessment {
  const preferredMatch = skillMatch(project.preferredSkills, have);
  const preferred = preferredCount(preferredMatch);
  const required = skillMatch(project.requiredSkills, have);
  if (required) return { rate: required.rate, basis: 'required', titleHits: [], breakdown: required.breakdown, preferred };
  if (preferredMatch) return { rate: preferredMatch.rate, basis: 'preferred', titleHits: [], breakdown: preferredMatch.breakdown, preferred };
  const title = project.title.normalize('NFKC').toLowerCase();
  const titleHits = have.filter((s) => mentions(title, s.normalize('NFKC').toLowerCase().trim()));
  return { rate: 0, basis: 'unknown', titleHits, breakdown: null, preferred };
}

function preferredCount(m: SkillMatch | null): PreferredMatch {
  if (!m) return { matched: 0, total: 0 };
  const b = m.breakdown;
  const matched = b.exact.length + b.equiv.length + b.implied.length;
  return { matched, total: matched + b.missing.length };
}

// 含意だけで満たした必須スキルの注記（「Java は Spring Boot の経験から推定」）。無ければ null
export function impliedSkillNote(breakdown: SkillBreakdown | null): string | null {
  if (!breakdown || breakdown.implied.length === 0) return null;
  const parts = breakdown.implied.map((r) => `${r}（${breakdown.via[r] ?? '関連技術'}の経験から推定）`);
  return `${parts.join('、')}は直接の記載がありません`;
}

// 英数字のスキル名は単語の境界で照合する（'go' が 'google' に、'c' が 'cobol' に当たらないように）
function mentions(text: string, skill: string): boolean {
  if (!skill) return false;
  if (!/^[\x20-\x7e]+$/.test(skill)) return text.includes(skill);
  const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(text);
}

// 万円/月の金額を step 刻みに丸める（交渉額・単価差を「64.47999…万円」のような端数で見せない）
export function roundManUp(x: number, step = 0.5): number {
  return Math.round(Math.ceil(x / step - 1e-9) * step * 10) / 10;
}
export function roundManDown(x: number, step = 0.5): number {
  return Math.round(Math.floor(x / step + 1e-9) * step * 10) / 10;
}

// 表示用（小数第1位まで。整数なら小数点なし）
export function fmtMan(x: number): string {
  return String(Math.round(x * 10) / 10);
}
