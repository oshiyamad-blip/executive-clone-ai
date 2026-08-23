import '../env.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadSeries, loadUniverse, sleep, type LoadOptions } from './data.js';
import { loadDividends } from './dividends.js';
import { runBacktest } from './engine.js';
import { yearsToSignificance } from './metrics.js';
import type {
  BacktestConfig, BacktestResult, DividendSeries, Metrics,
  PriceAdjustment, ProviderName, Series, SleeveRule,
} from './types.js';

/**
 * 実際の株価で「−8%損切り / +20%利確」ルールを検証するCLI。
 *
 *   npm run backtest -- --selftest                      ネット不要の自己テスト
 *   npm run backtest -- --from 2015-01-01 --to 2026-08-01
 *   npm run backtest -- --provider alpaca --refresh
 */

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;
const pad = (s: string, n: number): string => {
  // 全角を2文字ぶんとして数え、日本語混じりでも列を揃える
  const width = [...s].reduce((w, c) => w + (/[\u3000-\u9fff\uff00-\uffef]/.test(c) ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, n - width));
};

function buildConfig(): BacktestConfig {
  const midAlloc = Number(arg('mid', '0.20'));
  const shortAlloc = Number(arg('short', '0.10'));
  const coreAlloc = Number(arg('core', String(1 - midAlloc - shortAlloc)));

  const sleeves: SleeveRule[] = [
    {
      // 記事の「資産の70%：配当貴族、損切りせず長期」。個別銘柄を並べると
      // 現在の構成銘柄で過去を検証することになり生存者バイアスが入るため、
      // 既定では指数構成の入れ替えを織り込んだETF（NOBL）そのものを買う。
      name: '配当貴族（長期保有）',
      allocation: coreAlloc,
      stopLoss: null,
      takeProfit: null,
      maxHoldingDays: null,
      slots: 1,
      selection: { kind: 'fixed', symbols: [arg('core-symbol', 'NOBL')!] },
    },
    {
      name: '中期成長株（−8% / +20%）',
      allocation: midAlloc,
      stopLoss: Number(arg('mid-stop', '0.08')),
      takeProfit: Number(arg('mid-target', '0.20')),
      maxHoldingDays: Number(arg('mid-maxdays', '60')),
      slots: Number(arg('mid-slots', '5')),
      selection: {
        kind: 'momentum',
        lookbackDays: 252,
        skipDays: 21,
        trendFilterDays: 200,
        maxAnnualVol: Number(arg('max-vol', '0.60')),
        minDollarVolume: 20_000_000,
      },
    },
    {
      name: '短期（−3% / +9%）',
      allocation: shortAlloc,
      stopLoss: Number(arg('short-stop', '0.03')),
      takeProfit: Number(arg('short-target', '0.09')),
      maxHoldingDays: Number(arg('short-maxdays', '20')),
      slots: Number(arg('short-slots', '3')),
      selection: {
        kind: 'pullback',
        lookbackDays: 5,
        trendFilterDays: 50,
        maxAnnualVol: Number(arg('max-vol', '0.60')),
        minDollarVolume: 20_000_000,
      },
    },
  ];

  return {
    from: arg('from', '2015-01-01')!,
    to: arg('to', new Date().toISOString().slice(0, 10))!,
    initialCapital: Number(arg('capital', '100000')),
    slippageBps: Number(arg('slippage', '5')),
    commission: Number(arg('commission', '0')),
    taxRate: Number(arg('tax', '0.20315')),
    benchmark: arg('benchmark', 'SPY')!.toUpperCase(),
    sleeves,
    universe: [],
    rebalanceDays: Number(arg('rebalance', '5')),
    // 既定は split。配当を価格に埋め込まず現金として受け取るので、
    // 「配当がいくら入ったか」「源泉税でいくら引かれたか」が金額で見える。
    priceAdjustment: (arg('price-adjustment', 'split') as PriceAdjustment),
    dividendWithholding: Number(arg('dividend-withholding', '0.10')),
    dividendTaxRate: Number(arg('dividend-tax', '0.20315')),
  };
}

function printMetrics(label: string, m: Metrics, afterTax?: number): void {
  console.log(`\n  ${label}`);
  console.log(`    総リターン        ${pct(m.totalReturn)}`);
  console.log(`    年率（CAGR）      ${pct(m.cagr)}`);
  console.log(`    年率ボラ          ${pct(m.annualVol)}`);
  console.log(`    シャープレシオ    ${m.sharpe.toFixed(2)}`);
  console.log(`    最大ドローダウン  ${pct(m.maxDrawdown)}`);
  if (afterTax !== undefined) console.log(`    課税後総リターン  ${pct(afterTax)}`);
}

function printReport(r: BacktestResult): void {
  const { metrics: m, benchmarkMetrics: b, config: cfg } = r;

  console.log('\n' + '='.repeat(70));
  console.log(`  バックテスト結果  ${r.dates[0]} 〜 ${r.dates[r.dates.length - 1]}（${r.dates.length}営業日）`);
  console.log('='.repeat(70));

  printMetrics('ポートフォリオ', m, r.afterTaxTotalReturn);
  printMetrics(`ベンチマーク（${cfg.benchmark} 買って持つだけ）`, b);

  console.log('\n  ── 実力の検定 ──');
  console.log(`    ベータ            ${m.beta.toFixed(2)}`);
  console.log(`    年率アルファ      ${pct(m.alpha)}   ※ベータで説明できない部分`);
  console.log(`    アルファのt値     ${m.alphaTStat.toFixed(2)}`);
  if (Math.abs(m.alphaTStat) < 2) {
    console.log(`    → t値が2未満。この期間の成績は運とルールの実力を区別できない。`);
    const need = yearsToSignificance(m.alpha, m.annualVol);
    if (need !== null) {
      console.log(`       このアルファ(${pct(m.alpha)})が本物だとしても、確認には約${need.toFixed(1)}年かかる。`);
    }
  } else {
    console.log(`    → t値が2以上。この期間に限れば偶然では説明しにくい差が出ている。`);
  }

  console.log('\n  ── スリーブ別 ──');
  console.log(`    ${pad('スリーブ', 26)}${pad('トレード', 10)}${pad('勝率', 9)}${pad('平均保有', 10)}${pad('損益', 12)}`);
  for (const s of r.sleeves) {
    const wins = s.trades.filter((t) => t.netReturn > 0).length;
    const pnl = s.trades.reduce((a, t) => a + t.pnl, 0);
    const days = s.trades.length > 0 ? s.trades.reduce((a, t) => a + t.holdingDays, 0) / s.trades.length : 0;
    const winRate = s.trades.length > 0 ? `${((wins / s.trades.length) * 100).toFixed(1)}%` : '—';
    console.log(
      `    ${pad(s.name, 26)}${pad(String(s.trades.length), 10)}${pad(winRate, 9)}` +
      `${pad(days > 0 ? `${days.toFixed(0)}日` : '—', 10)}${pad(`$${pnl.toFixed(0)}`, 12)}`,
    );
  }

  // 損切りが想定どおりの価格で約定したかを見る。ギャップで飛んだ割合が高いほど
  // 「−8%で止まる」という前提が崩れている。
  const stops = r.sleeves.flatMap((s) => s.trades).filter((t) => t.reason === 'stop' || t.reason === 'stop_gap');
  const gapped = stops.filter((t) => t.reason === 'stop_gap');
  if (stops.length > 0) {
    const worst = Math.min(...stops.map((t) => t.grossReturn));
    console.log('\n  ── 損切りの実際 ──');
    console.log(`    損切り回数        ${stops.length}回`);
    console.log(`    うちギャップ約定  ${gapped.length}回（${((gapped.length / stops.length) * 100).toFixed(1)}%）`);
    console.log(`    最悪の1トレード   ${pct(worst)}   ※ルール上の損切り幅を超えた分がギャップの実害`);
  }

  const d = r.dividends;
  console.log('\n  ── 配当 ──');
  if (cfg.priceAdjustment === 'total') {
    console.log('    価格が配当込みで調整されているため、配当は上のリターンに含まれています。');
    console.log('    金額の内訳を見たい場合は --price-adjustment split で実行してください。');
  } else if (d.gross === 0) {
    console.log('    ⚠ 配当データが読み込まれていません。配当収入がゼロとして計算されています。');
    console.log('      → 配当貴族スリーブのリターンが実際より低く出ます。');
    console.log('      → --provider alpaca で実行するか、data/dividends/<SYMBOL>.csv を用意してください。');
  } else {
    console.log(`    受取総額（税引前）  $${d.gross.toFixed(0)}`);
    console.log(`    米国源泉税（${(cfg.dividendWithholding * 100).toFixed(0)}%）   -$${d.withheld.toFixed(0)}`);
    console.log(`    日本の追加課税      -$${d.japanTax.toFixed(0)}   ※外国税額控除で源泉分を相殺した差額`);
    console.log(`    手取り              $${d.net.toFixed(0)}`);
    console.log(`    総リターンに占める割合  ${pct(d.shareOfReturn)}`);
    console.log('\n    スリーブ別の受取（税引前）');
    for (const s of r.sleeves) {
      if (s.dividendGross > 0) console.log(`      ${pad(s.name, 26)}$${s.dividendGross.toFixed(0)}`);
    }
  }

  if (r.skippedSymbols.length > 0) {
    console.log(`\n  ⚠ データが取れず母集団から除外: ${r.skippedSymbols.join(', ')}`);
  }
  console.log('');
}

async function main(): Promise<void> {
  const selftest = flag('selftest');
  const cfg = buildConfig();
  const provider = (selftest ? 'synthetic' : arg('provider', 'stooq')) as ProviderName;

  if (selftest) {
    console.log('⚠ 自己テストモード: 合成データでエンジンの挙動だけを確認します。');
    console.log('  ここで出る数字は実際の成績ではありません。\n');
  }

  const universePath = arg('universe', 'data/universe/us-liquid.txt')!;
  let universe: string[];
  if (selftest) {
    universe = Array.from({ length: 24 }, (_, i) => `SYN${String(i + 1).padStart(2, '0')}`);
  } else {
    universe = await loadUniverse(universePath);
    console.log(`母集団: ${universe.length}銘柄（${universePath}）`);
  }

  // --limit は疎通確認用。母集団を先頭N銘柄に絞って短時間で1周させる
  const limit = Number(arg('limit', '0'));
  if (limit > 0) {
    universe = universe.slice(0, limit);
    console.log(`  --limit ${limit} により母集団を${universe.length}銘柄に絞りました（疎通確認用）`);
  }

  const coreSymbols = cfg.sleeves.flatMap((s) => s.selection.symbols ?? []);
  const needed = Array.from(new Set([cfg.benchmark, ...coreSymbols, ...universe]));

  const opts: LoadOptions = {
    provider, from: cfg.from, to: cfg.to,
    refresh: flag('refresh'), priceAdjustment: cfg.priceAdjustment,
  };
  const seriesList: Series[] = [];
  const skipped: string[] = [];

  console.log(`日足を取得します（provider=${provider}）…`);
  for (let i = 0; i < needed.length; i++) {
    const symbol = needed[i]!;
    const s = await loadSeries(symbol, opts);
    if (s && s.bars.length > 0) seriesList.push(s);
    else skipped.push(symbol);
    if ((i + 1) % 20 === 0) console.log(`  ${i + 1}/${needed.length} …`);
    // キャッシュから読めた場合は待たない
    if (provider !== 'csv' && provider !== 'synthetic' && i < needed.length - 1) await sleep(250);
  }
  console.log(`  取得できた銘柄: ${seriesList.length} / ${needed.length}`);

  // 配当。priceAdjustment='split' のときだけ現金として計上する
  let dividendSeries: DividendSeries[] = [];
  if (cfg.priceAdjustment === 'split' && !selftest) {
    console.log('現金配当を取得します…');
    dividendSeries = await loadDividends(seriesList.map((s) => s.symbol), {
      provider, from: cfg.from, to: cfg.to, refresh: flag('refresh'),
    });
    const withDivs = dividendSeries.filter((d) => d.dividends.length > 0).length;
    console.log(`  配当データがある銘柄: ${withDivs} / ${seriesList.length}`);
    if (withDivs === 0) {
      console.warn('  ⚠ 配当データが1件も取れませんでした。配当収入ゼロとして計算されます。');
      console.warn('    Stooqは配当を配信しません。--provider alpaca を使うか、');
      console.warn('    data/dividends/<SYMBOL>.csv（ex_date,amount）を用意してください。');
    }
  }

  if (!seriesList.some((s) => s.symbol === cfg.benchmark)) {
    console.error(`\n❌ ベンチマーク ${cfg.benchmark} のデータが取得できませんでした。`);
    console.error('   ネットワークが遮断されている場合は、CSVを data/prices/ に置いて --provider csv で実行してください。');
    console.error('   CSVの形式: Date,Open,High,Low,Close,Volume（1行目はヘッダー）');
    process.exit(1);
  }

  // 母集団は取得できた銘柄だけに絞る
  const available = new Set(seriesList.map((s) => s.symbol));
  cfg.universe = universe.filter((s) => available.has(s.toUpperCase()));

  const result = runBacktest({ config: cfg, seriesList, dividendSeries, skippedSymbols: skipped });
  printReport(result);

  const tradesPath = arg('trades');
  if (tradesPath) {
    const rows = result.sleeves.flatMap((s) => s.trades);
    const csv = [
      'sleeve,symbol,entryDate,entryPrice,exitDate,exitPrice,shares,holdingDays,reason,grossReturn,netReturn,pnl',
      ...rows.map((t) =>
        [t.sleeve, t.symbol, t.entryDate, t.entryPrice.toFixed(4), t.exitDate, t.exitPrice.toFixed(4),
         t.shares, t.holdingDays, t.reason, t.grossReturn.toFixed(6), t.netReturn.toFixed(6), t.pnl.toFixed(2)].join(','),
      ),
    ].join('\n');
    await mkdir(dirname(tradesPath), { recursive: true });
    await writeFile(tradesPath, csv, 'utf8');
    console.log(`  全トレードを ${tradesPath} に書き出しました（${rows.length}件）`);
  }

  const jsonPath = arg('json');
  if (jsonPath) {
    await mkdir(dirname(jsonPath), { recursive: true });
    await writeFile(jsonPath, JSON.stringify(result, null, 2), 'utf8');
    console.log(`  結果を ${jsonPath} に書き出しました`);
  }

  if (!selftest) {
    console.log('  ※ 母集団に現在の上場銘柄だけを使うと生存者バイアスが入ります（docs/backtest.md 参照）。\n');
  }
}

main().catch((err) => {
  console.error('❌ バックテストに失敗しました:', (err as Error).message);
  process.exit(1);
});
