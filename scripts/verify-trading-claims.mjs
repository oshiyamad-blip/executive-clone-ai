#!/usr/bin/env node
// docs/stock-trading-automation-review.md の数値を再現するスクリプト。
// 依存なし: node scripts/verify-trading-claims.mjs
//
// 検証内容:
//   1. 3週間+4.19% → 年利101% の換算再現
//   2. 損切り/利確ルールの期待値と、ドリフトゼロ（実力ゼロ）での基準勝率
//   3. +4.19% がノイズと区別できるかの t 検定
//   4. 真の超過収益を検出するのに必要な観測年数
//   5. モンテカルロ: 執行方式・ドリフト・ボラごとの1トレード期待値

const p = (x) => (x * 100).toFixed(2) + '%';
const ev = (win, tp, sl) => win * tp + (1 - win) * -sl;
// ドリフトゼロの価格過程では、利確に先に到達する確率は 損切り幅/(損切り幅+利確幅)
const breakevenWinRate = (tp, sl) => sl / (sl + tp);

function erf(x) {
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const [a1, a2, a3, a4, a5, k] = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429, 0.3275911];
  const t = 1 / (1 + k * x);
  return s * (1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x));
}
const normCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

// 再現性のため線形合同法で乱数を固定する
let seed = 20260823;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) + 0.5) / 4294967296;
const norm = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());

/**
 * 幾何ブラウン運動で損切り/利確ルールを回し、1トレードあたりの損益分布を返す。
 * mode='broker': ブローカー側にstop/limitを置き日中タッチで約定
 * mode='cron'  : 日次バッチが終値で判定し翌日寄りで成行（＝GitHub Actions方式）
 */
function simulate(mode, mu, sigma, takeProfit, stopLoss, maxDays, trials = 200000) {
  const DT = 1 / 252;
  const results = [];
  let wins = 0, totalDays = 0;
  for (let i = 0; i < trials; i++) {
    let logPrice = 0, exited = false;
    for (let d = 1; d <= maxDays && !exited; d++) {
      const prev = logPrice;
      logPrice += (mu - 0.5 * sigma * sigma) * DT + sigma * Math.sqrt(DT) * norm();
      // 日中の高値・安値をブラウン橋で近似
      const wick = sigma * Math.sqrt(DT) * Math.abs(norm()) * 0.8;
      const high = Math.max(prev, logPrice) + wick;
      const low = Math.min(prev, logPrice) - wick;
      let r = null;
      if (mode === 'broker') {
        if (low <= Math.log(1 - stopLoss)) r = -stopLoss;
        else if (high >= Math.log(1 + takeProfit)) r = takeProfit;
      } else {
        const close = Math.exp(logPrice) - 1;
        if (close <= -stopLoss || close >= takeProfit) {
          const gap = (mu - 0.5 * sigma * sigma) * DT + sigma * Math.sqrt(DT) * norm() * 0.6;
          r = Math.exp(logPrice + gap) - 1;
        }
      }
      if (r !== null) { results.push(r); if (r > 0) wins++; totalDays += d; exited = true; }
    }
    if (!exited) {
      const r = Math.exp(logPrice) - 1;
      results.push(r); if (r > 0) wins++; totalDays += maxDays;
    }
  }
  results.sort((a, b) => a - b);
  const q = (x) => results[Math.floor(x * results.length)];
  return {
    ev: results.reduce((a, b) => a + b, 0) / results.length,
    winRate: wins / trials,
    p5: q(0.05), p1: q(0.01),
    avgDays: totalDays / trials,
  };
}

console.log('== 1. 年利換算の再現 ==');
const monthly = 0.0419 / 0.7;
console.log(`3週間 +4.19% → 月利 ${p(monthly)} → 年利 ${p(Math.pow(1 + monthly, 12) - 1)}`);

console.log('\n== 2. 期待値とノーエッジ基準勝率 ==');
for (const [name, win, tp, sl] of [['中期', 0.33, 0.20, 0.08], ['短期', 0.50, 0.09, 0.03]]) {
  const be = breakevenWinRate(tp, sl);
  console.log(`${name} 損切り${p(sl)}/利確${p(tp)}: 記事の期待値 ${p(ev(win, tp, sl))}`
    + ` / ノーエッジ勝率 ${p(be)}（期待値 ${p(ev(be, tp, sl))}）`
    + ` / 必要な実力 +${((win - be) * 100).toFixed(1)}pt`);
}

console.log('\n== 3. +4.19% はノイズと区別できるか（15営業日）==');
for (const vol of [0.14, 0.17, 0.20, 0.25]) {
  const sd = vol * Math.sqrt(15 / 252);
  const t = 0.0419 / sd;
  console.log(`年率ボラ ${p(vol)} → 3週間の標準偏差 ${p(sd)} / t=${t.toFixed(2)} / 実力ゼロでも起きる確率 ${p(1 - normCdf(t))}`);
}

console.log('\n== 4. 真の超過収益(α)の検出に必要な年数（t=2、年率ボラ17%）==');
for (const alpha of [0.03, 0.06, 0.12, 0.20]) {
  console.log(`α=${p(alpha)} → ${Math.pow(2 * 0.17 / alpha, 2).toFixed(1)} 年`);
}

console.log('\n== 5-a. 執行方式の比較（中期 −8%/+20%, ボラ35%, ドリフト8%）==');
for (const mode of ['broker', 'cron']) {
  const r = simulate(mode, 0.08, 0.35, 0.20, 0.08, 60);
  console.log(`${mode.padEnd(7)} 期待値 ${p(r.ev).padStart(7)} / 勝率 ${p(r.winRate)} / 下位5% ${p(r.p5).padStart(7)} / 下位1% ${p(r.p1).padStart(7)}`);
}

console.log('\n== 5-b. ドリフト感応度（中期, ブローカー執行）==');
for (const mu of [-0.10, -0.05, 0, 0.04, 0.08, 0.15]) {
  const r = simulate('broker', mu, 0.35, 0.20, 0.08, 60);
  console.log(`ドリフト ${p(mu).padStart(7)} → 期待値 ${p(r.ev).padStart(7)} / 勝率 ${p(r.winRate)}`);
}

console.log('\n== 5-c. 短期ルール −3%/+9% の実力（記事の前提勝率は50%）==');
for (const mu of [0, 0.08, 0.20]) {
  const r = simulate('broker', mu, 0.35, 0.09, 0.03, 20);
  console.log(`ドリフト ${p(mu).padStart(6)} → 期待値 ${p(r.ev).padStart(7)} / 実際の勝率 ${p(r.winRate)}`);
}

console.log('\n== 5-d. ボラ感応度（固定%バリアの弱点、中期, ドリフト8%）==');
for (const sigma of [0.20, 0.35, 0.50]) {
  const r = simulate('broker', 0.08, sigma, 0.20, 0.08, 60);
  console.log(`年率ボラ ${p(sigma)} → 期待値 ${p(r.ev).padStart(7)} / 勝率 ${p(r.winRate)} / 平均保有 ${r.avgDays.toFixed(0)}営業日`);
}

console.log('\n== 6. コスト控除後の年率寄与（往復スリッページ0.1%＋実現益に20.315%課税）==');
for (const [name, tp, sl, maxDays] of [['中期', 0.20, 0.08, 60], ['短期', 0.09, 0.03, 20]]) {
  const r = simulate('broker', 0.08, 0.35, tp, sl, maxDays);
  const afterSlippage = r.ev - 0.001;
  const afterTax = afterSlippage > 0 ? afterSlippage * (1 - 0.20315) : afterSlippage;
  const turnsPerYear = 252 / r.avgDays;
  console.log(`${name}: 税前 ${p(r.ev)} → 手数料後 ${p(afterSlippage)} → 税後 ${p(afterTax)}`
    + ` / 年間約${turnsPerYear.toFixed(1)}回転 → 年率寄与 ${p(afterTax * turnsPerYear)}`);
}
