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
// 必須スキルが空の案件は 1.0（誰にでもマッチしうる）とみなす。
export function skillMatchRate(required: string[], have: string[]): number {
  if (required.length === 0) return 1;
  const haveSet = new Set(have.map((s) => s.toLowerCase()));
  const matched = required.filter((r) => isSkillCovered(r, haveSet));
  return matched.length / required.length;
}
