// 候補の鮮度・並べ方・割り当て（一次選抜 match.ts と自社社員探し ownMatch.ts で共用。純関数）。
// 並びは「合う順」: 区分 → バンド → スキルの適合度（完全一致を含意より先に）→ 尚可 → 粗利 → 受信の新しい順 → ID。
// 割り当ては双方向の上限つき貪欲法（案件ごと・要員ごとの上限を超えない組を上から採り、あふれた枠は次点で埋まる）
import { staleDays } from './config.js';
import type { Freshness, FreshnessLevel, PairBreakdown } from '../types/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// 受信からこの日数を超えたら、同じ適合度の中で並びを少し下げる（募集・稼働の状況が変わっている恐れが増すため）
export const AGING_DAYS = 14;

// 鮮度によるスキル適合度（％）の減点。同率なら新しい方を先にし、1技術分の差（数十％）は覆さない小ささにする
const FRESHNESS_PENALTY: Record<FreshnessLevel, number> = { fresh: 0, aging: 5, stale: 10 };

export function freshnessOf(receivedAt: Date, now: Date): Freshness {
  const ms = now.getTime() - new Date(receivedAt).getTime();
  const ageDays = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / DAY_MS)) : 0;
  const level: FreshnessLevel = ageDays > staleDays() ? 'stale' : ageDays > AGING_DAYS ? 'aging' : 'fresh';
  return { level, ageDays };
}

// 2つのうち古い方（組の鮮度は古い側で決まる）
export function olderFreshness(a: Freshness, b: Freshness): Freshness {
  return a.ageDays >= b.ageDays ? a : b;
}

export function staleCaution(side: '案件' | '要員'): string {
  return `${side}は要再確認（受信から${staleDays()}日超）`;
}

// スキルの適合度（並びの主キー）: 一致率（％）から鮮度の減点を引いたもの
export function skillFitScore(skill: PairBreakdown['skill'], freshness: Freshness): number {
  return Math.round(skill.rate * 100) - FRESHNESS_PENALTY[freshness.level];
}

// 同じ適合度なら、完全一致の多い組 → 同義で満たした組 → 含意（推定）で満たした組 の順
export function directnessKeys(skill: PairBreakdown['skill']): [number, number] {
  if (skill.total === 0) return [0, 0];
  return [skill.exact / skill.total, (skill.exact + skill.equiv) / skill.total];
}

export function preferredShare(skill: PairBreakdown['skill']): number {
  return skill.preferred.total > 0 ? skill.preferred.matched / skill.preferred.total : 0;
}

// 鮮度の減点をヒューリスティックの適合スコアにも反映する（0〜100）
export function freshnessScorePenalty(freshness: Freshness): number {
  return FRESHNESS_PENALTY[freshness.level];
}

export interface AllocationCap<T> {
  key: (item: T) => string;
  max: number;
}

// 並べ替え済みの候補を上から採り、どの上限も超えないものだけを残す（上限であふれた枠は次点の候補で埋まる）
export function allocateWithCaps<T>(sorted: T[], caps: AllocationCap<T>[]): T[] {
  const counts = caps.map(() => new Map<string, number>());
  const out: T[] = [];
  for (const item of sorted) {
    const keys = caps.map((c) => c.key(item));
    if (keys.some((k, i) => (counts[i].get(k) ?? 0) >= caps[i].max)) continue;
    keys.forEach((k, i) => counts[i].set(k, (counts[i].get(k) ?? 0) + 1));
    out.push(item);
  }
  return out;
}

// 数値キーの比較（大きい方を先に）。キーの配列を前から順に比べる
export function compareDesc(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === b[i]) continue; // -Infinity 同士（単価差不明）も同順位
    return b[i] > a[i] ? 1 : -1;
  }
  return 0;
}

// 一次選抜の内訳の簡潔な表記（判定根拠・サマリ・最終判定の入力用。人名・社名を含まない）
export function formatBreakdown(b: PairBreakdown, grossMarginJpy: number, resultingMarginJpy?: number): string {
  const man = (jpy: number) => `${Math.round(jpy / 1000) / 10}万円`;
  const s = b.skill;
  const pct = Math.round(s.rate * 100);
  const covered = s.exact + s.equiv + s.implied;
  const how =
    covered === s.exact
      ? `一致${s.exact}/${s.total}`
      : `${covered}/${s.total}: ${[`一致${s.exact}`, s.equiv > 0 ? `同義${s.equiv}` : '', s.implied > 0 ? `推定${s.implied}` : ''].filter(Boolean).join('・')}`;
  const parts: string[] = [];
  if (s.basis === 'unknown') parts.push('必須スキル不明（案件名に要員のスキルあり）');
  else parts.push(`${s.basis === 'preferred' ? '尚可スキルで判定' : 'スキル'}${pct}%（${how}）`);
  if (s.basis === 'required' && s.preferred.total > 0) parts.push(`尚可${s.preferred.matched}/${s.preferred.total}`);
  parts.push(`勤務地 ${{ same: '同一都道府県', adjacent: '隣接県', remote: 'フルリモート', unknown: '不明' }[b.location]}`);
  parts.push(`時期 ${b.timing === 'ok' ? '適合' : '不明'}`);
  if (b.rate === 'unknown') parts.push('単金 不明');
  else if (b.rate === 'negotiable' && resultingMarginJpy !== undefined) parts.push(`粗利${man(grossMarginJpy)}（交渉で${man(resultingMarginJpy)}）`);
  else parts.push(`粗利${man(grossMarginJpy)}${b.rate === 'lowerOnly' ? '（案件単金の下限で計算）' : ''}`);
  const f = b.freshness;
  parts.push(`${f.ageDays === 0 ? '受信当日' : `受信${f.ageDays}日前`}${f.level === 'stale' ? '（要再確認）' : ''}`);
  return parts.join('・');
}
