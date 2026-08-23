import type { Bar, SelectionRule, Series } from './types.js';

/**
 * 銘柄の自動選定。
 *
 * ここでの絶対条件は「判定日までのバーしか見ない」こと。1本でも先のバーを覗くと
 * ルックアヘッドバイアスが入り、バックテストの成績は現実には再現できない数字になる。
 * そのため各指標は必ず endIdx（判定日のインデックス）以前だけで計算する。
 */

/** 銘柄ごとに、日付→バー番号の索引を持たせたもの */
export interface IndexedSeries {
  symbol: string;
  bars: Bar[];
  idxByDate: Map<string, number>;
}

export function indexSeries(series: Series): IndexedSeries {
  const idxByDate = new Map<string, number>();
  series.bars.forEach((b, i) => idxByDate.set(b.date, i));
  return { symbol: series.symbol, bars: series.bars, idxByDate };
}

/** 判定日以前で最も新しいバー番号。まだ上場していない・データがない場合は -1 */
export function barIndexAsOf(s: IndexedSeries, date: string): number {
  const exact = s.idxByDate.get(date);
  if (exact !== undefined) return exact;
  // 休場日などで一致しない場合は二分探索で直前の営業日を探す
  let lo = 0;
  let hi = s.bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s.bars[mid]!.date <= date) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** 単純移動平均（endIdx を含む直近 n 本） */
export function sma(bars: Bar[], endIdx: number, n: number): number | null {
  if (endIdx + 1 < n) return null;
  let sum = 0;
  for (let i = endIdx - n + 1; i <= endIdx; i++) sum += bars[i]!.close;
  return sum / n;
}

/** 年率換算ボラティリティ（対数リターンの標準偏差） */
export function annualVol(bars: Bar[], endIdx: number, n: number): number | null {
  if (endIdx + 1 < n + 1) return null;
  const rets: number[] = [];
  for (let i = endIdx - n + 1; i <= endIdx; i++) {
    rets.push(Math.log(bars[i]!.close / bars[i - 1]!.close));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varSum = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(varSum * 252);
}

/** 平均売買代金（終値 × 出来高） */
export function avgDollarVolume(bars: Bar[], endIdx: number, n: number): number | null {
  if (endIdx + 1 < n) return null;
  let sum = 0;
  for (let i = endIdx - n + 1; i <= endIdx; i++) sum += bars[i]!.close * bars[i]!.volume;
  return sum / n;
}

/**
 * モメンタム。lookback 本前から skip 本前までのリターンを見る。
 * skip=21 で「直近1ヶ月を除いた12ヶ月モメンタム（12-1）」になる。
 * 直近を除くのは、短期の反転が中期のトレンドを打ち消すため。
 */
export function momentum(bars: Bar[], endIdx: number, lookback: number, skip: number): number | null {
  const from = endIdx - lookback;
  const to = endIdx - skip;
  if (from < 0 || to <= from) return null;
  return bars[to]!.close / bars[from]!.close - 1;
}

/** ATR（真の値幅の平均）を終値に対する割合で返す */
export function atrPct(bars: Bar[], endIdx: number, n: number): number | null {
  if (endIdx + 1 < n + 1) return null;
  let sum = 0;
  for (let i = endIdx - n + 1; i <= endIdx; i++) {
    const prevClose = bars[i - 1]!.close;
    const tr = Math.max(
      bars[i]!.high - bars[i]!.low,
      Math.abs(bars[i]!.high - prevClose),
      Math.abs(bars[i]!.low - prevClose),
    );
    sum += tr;
  }
  return sum / n / bars[endIdx]!.close;
}

interface Candidate {
  symbol: string;
  score: number;
}

/**
 * 判定日 date 時点で、ルールに合う銘柄を score の高い順に返す。
 * 返る銘柄数は呼び出し側が slots で絞る。
 */
export function selectSymbols(
  rule: SelectionRule,
  universe: IndexedSeries[],
  date: string,
): string[] {
  if (rule.kind === 'fixed') return rule.symbols ?? [];

  const lookback = rule.lookbackDays ?? (rule.kind === 'momentum' ? 252 : 20);
  const skip = rule.skipDays ?? (rule.kind === 'momentum' ? 21 : 0);
  const trendDays = rule.trendFilterDays ?? (rule.kind === 'momentum' ? 200 : 50);

  const candidates: Candidate[] = [];

  for (const s of universe) {
    const i = barIndexAsOf(s, date);
    if (i < 0) continue;

    // 判定日から極端に古いバーしかない銘柄（上場廃止・データ欠損）は対象外
    if (s.bars[i]!.date < shiftDays(date, -10)) continue;

    const close = s.bars[i]!.close;

    // トレンドフィルタ: 移動平均を上回っていること
    const trend = sma(s.bars, i, trendDays);
    if (trend === null || close < trend) continue;

    // ボラフィルタ: 固定%のバリアは高ボラ銘柄で機能しないため上限を設ける
    if (rule.maxAnnualVol !== undefined) {
      const vol = annualVol(s.bars, i, 60);
      if (vol === null || vol > rule.maxAnnualVol) continue;
    }

    // 流動性フィルタ
    if (rule.minDollarVolume !== undefined) {
      const adv = avgDollarVolume(s.bars, i, 20);
      if (adv === null || adv < rule.minDollarVolume) continue;
    }

    if (rule.kind === 'momentum') {
      const m = momentum(s.bars, i, lookback, skip);
      if (m === null) continue;
      candidates.push({ symbol: s.symbol, score: m });
    } else {
      // 押し目: 中期は上向き（50日線超）だが、短期は売られている銘柄を拾う。
      // 直近 lookback 本の下落率が大きいほど高スコア。
      const short = sma(s.bars, i, 5);
      if (short === null || close > short) continue; // まだ押していない
      const m = momentum(s.bars, i, lookback, 0);
      if (m === null || m >= 0) continue;
      candidates.push({ symbol: s.symbol, score: -m });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.map((c) => c.symbol);
}

/** YYYY-MM-DD を n 日ずらす（カレンダー日ベース） */
export function shiftDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
