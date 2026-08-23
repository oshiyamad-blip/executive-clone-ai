import type { Metrics, Trade } from './types.js';

/** 日次評価額の系列から日次リターンを作る */
function toReturns(equity: number[]): number[] {
  const rets: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1]!;
    rets.push(prev > 0 ? equity[i]! / prev - 1 : 0);
  }
  return rets;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

function maxDrawdown(equity: number[]): number {
  let peak = equity[0] ?? 0;
  let worst = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    if (peak > 0) worst = Math.min(worst, v / peak - 1);
  }
  return worst;
}

/**
 * ポートフォリオをベンチマークに回帰し、ベータと年率アルファ、そのt値を出す。
 *
 * ここが検証の本体になる。総リターンが何%だったかではなく、
 * 「ベータで説明できない部分（アルファ）が、ノイズと区別できるほど大きいか」を見る。
 * t値が2に届かないうちは、成績が良くても実力の証明にはならない。
 */
function regress(port: number[], bench: number[]): { beta: number; alpha: number; tStat: number } {
  const n = Math.min(port.length, bench.length);
  if (n < 30) return { beta: 0, alpha: 0, tStat: 0 };

  const p = port.slice(0, n);
  const b = bench.slice(0, n);
  const mp = mean(p);
  const mb = mean(b);

  let cov = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    cov += (p[i]! - mp) * (b[i]! - mb);
    varB += (b[i]! - mb) ** 2;
  }
  const beta = varB > 0 ? cov / varB : 0;
  const alphaDaily = mp - beta * mb;

  // 残差の標準誤差から切片のt値を求める
  const resid: number[] = [];
  for (let i = 0; i < n; i++) resid.push(p[i]! - (alphaDaily + beta * b[i]!));
  const se = stdev(resid) / Math.sqrt(n);

  return {
    beta,
    alpha: alphaDaily * 252,
    tStat: se > 0 ? alphaDaily / se : 0,
  };
}

export function computeMetrics(equity: number[], benchmark: number[], trades: Trade[]): Metrics {
  const rets = toReturns(equity);
  const benchRets = toReturns(benchmark);

  const start = equity[0] ?? 0;
  const end = equity[equity.length - 1] ?? 0;
  const totalReturn = start > 0 ? end / start - 1 : 0;
  const years = rets.length / 252;
  const cagr = years > 0 && start > 0 ? (end / start) ** (1 / years) - 1 : 0;
  const annualVol = stdev(rets) * Math.sqrt(252);
  const { beta, alpha, tStat } = regress(rets, benchRets);

  const wins = trades.filter((t) => t.netReturn > 0).length;

  return {
    totalReturn,
    cagr,
    annualVol,
    sharpe: annualVol > 0 ? (mean(rets) * 252) / annualVol : 0,
    maxDrawdown: maxDrawdown(equity),
    beta,
    alpha,
    alphaTStat: tStat,
    tradeCount: trades.length,
    winRate: trades.length > 0 ? wins / trades.length : 0,
    avgHoldingDays: trades.length > 0 ? mean(trades.map((t) => t.holdingDays)) : 0,
  };
}

/**
 * アルファがノイズと区別できるまでに必要な観測年数。
 * 検討メモの「年6%のアルファでも32年」を、実測のボラで置き換えて出す。
 */
export function yearsToSignificance(alpha: number, annualVol: number): number | null {
  if (alpha <= 0 || annualVol <= 0) return null;
  return (2 * annualVol / alpha) ** 2;
}
