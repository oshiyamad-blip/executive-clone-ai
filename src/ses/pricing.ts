// 単金正規化（万円/月・円/時・円/月 → 万円/月）とスキル一致率の計算。extract/match の双方が参照する。
import { hourlyToMonthlyHours } from './config.js';
import { isSkillCovered } from './skillEquiv.js';

export type RateUnit = 'manYenPerMonth' | 'yenPerHour' | 'yenPerMonth';

// 各種表記を「万円/月」の number に正規化する。「スキル見合い」等は抽出段で null を返す（ここには来ない）。
export function normalizeRate(value: number, unit: RateUnit): number {
  if (unit === 'manYenPerMonth') return value;
  if (unit === 'yenPerHour') return (value * hourlyToMonthlyHours()) / 10000;
  return value / 10000; // yenPerMonth
}

// 必須スキルの被覆率（0〜1）。required/have は既に normalizeSkills 済みの前提。
// 完全一致に加え、育てた同義辞書（skillEquiv）でのヒットも「満たす」とみなす（許容範囲を広げる）。
// 必須スキルが空なら null（＝不明。添付の解析失敗などで空になった案件を「誰にでも100%一致」とはみなさない）
export function skillMatchRate(required: string[], have: string[]): number | null {
  if (required.length === 0) return null;
  const haveSet = new Set(have.map((s) => s.toLowerCase()));
  const matched = required.filter((r) => isSkillCovered(r, haveSet));
  return matched.length / required.length;
}

// スキル判定の根拠。required=必須スキルで判定、preferred=必須が空のため尚可スキルで判定（参考扱い）、
// unknown=どちらも空のため判定不能（案件名に要員のスキルが現れる場合だけ要確認として残す）
export type SkillBasis = 'required' | 'preferred' | 'unknown';

export interface SkillAssessment {
  rate: number; // 判定に使った一致率 0〜1（unknown は 0）
  basis: SkillBasis;
  titleHits: string[]; // unknown のとき、案件名に現れた要員のスキル
}

export function assessSkills(
  project: { title: string; requiredSkills: string[]; preferredSkills: string[] },
  have: string[],
): SkillAssessment {
  const required = skillMatchRate(project.requiredSkills, have);
  if (required !== null) return { rate: required, basis: 'required', titleHits: [] };
  const preferred = skillMatchRate(project.preferredSkills, have);
  if (preferred !== null) return { rate: preferred, basis: 'preferred', titleHits: [] };
  const title = project.title.normalize('NFKC').toLowerCase();
  const titleHits = have.filter((s) => mentions(title, s.normalize('NFKC').toLowerCase().trim()));
  return { rate: 0, basis: 'unknown', titleHits };
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
