import '../env.js';
import { AlpacaClient, type AlpacaDividend, type AlpacaFill, type AlpacaPosition } from './alpaca.js';
import { computeMetrics } from '../backtest/metrics.js';
import { postToSlack, toConsole } from './render.js';
import type { DailyReport } from './types.js';

/**
 * その日の運用結果を1本にまとめてSlackへ投げる。
 *
 *   npm run report:daily             口座を読んでSlackへ（未設定ならコンソールのみ）
 *   npm run report:daily -- --demo   ネット不要。整形の確認用のダミーデータ
 *   npm run report:daily -- --dry    口座は読むがSlackへは投げない
 *
 * 出す数字は docs/stock-trading-automation-review.md の結論に合わせてある。
 * 「今日いくら勝ったか」ではなく、ベンチマーク超過とそのt値を先に見せる。
 */

const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const env = (name: string): string => process.env[name] ?? '';

/** 整形を確認するためのダミーデータ。実データではない */
function demoReport(): DailyReport {
  const positions: AlpacaPosition[] = [
    { symbol: 'NOBL', qty: 620, avgEntryPrice: 96.4, currentPrice: 112.85, marketValue: 69967, unrealizedPl: 10199, unrealizedPlpc: 0.1706, intradayPl: 187 },
    { symbol: 'AVGO', qty: 12, avgEntryPrice: 168.2, currentPrice: 199.5, marketValue: 2394, unrealizedPl: 375, unrealizedPlpc: 0.1861, intradayPl: 41 },
    { symbol: 'CAT', qty: 9, avgEntryPrice: 341.7, currentPrice: 318.9, marketValue: 2870, unrealizedPl: -205, unrealizedPlpc: -0.0667, intradayPl: -33 },
  ];
  const fills: AlpacaFill[] = [
    { symbol: 'ORLY', side: 'buy', qty: 3, price: 1104.2, filledAt: '' },
    { symbol: 'XOM', side: 'sell', qty: 41, price: 102.11, filledAt: '' },
  ];
  const dividends: AlpacaDividend[] = [
    { symbol: 'NOBL', date: '2026-08-24', netAmount: 47.3, perShare: 0.0847 },
  ];
  return {
    date: new Date().toISOString().slice(0, 10),
    demo: true,
    benchmark: 'SPY',
    equity: 104231, dayChange: 0.0042, dayChangeAmount: 436, benchDayChange: 0.0031,
    sinceInception: 0.0423, benchSinceInception: 0.0388, maxDrawdown: -0.068,
    beta: 0.83, alpha: 0.031, alphaTStat: 0.94, observationDays: 15,
    riskLimit: 0.03, stopWarnAt: 0.06, targetWarnAt: 0.18,
    positions, fills, dividends,
    notes: ['これはデモデータです。実際の口座の数字ではありません。'],
  };
}

async function buildReport(): Promise<DailyReport> {
  const key = env('ALPACA_API_KEY');
  const secret = env('ALPACA_API_SECRET');
  if (!key || !secret) {
    throw new Error('ALPACA_API_KEY / ALPACA_API_SECRET が未設定です（--demo で整形だけ確認できます）');
  }

  const benchmark = (env('BENCHMARK') || 'SPY').toUpperCase();
  const paper = env('ALPACA_PAPER') !== 'false'; // 既定はペーパー口座。実口座を読むときだけ false
  const client = new AlpacaClient(key, secret, paper);
  const notes: string[] = [];
  if (paper) notes.push('ペーパー口座を読んでいます（実口座を読むには ALPACA_PAPER=false）。');

  const [account, positions, history] = await Promise.all([
    client.account(),
    client.positions(),
    client.portfolioHistory(env('HISTORY_PERIOD') || '1A'),
  ]);

  const today = new Date().toISOString().slice(0, 10);
  // 約定と配当は落ちても致命的ではないので、取れなければ空にして続行する
  const [fills, dividends] = await Promise.all([
    client.fills(`${today}T00:00:00Z`).catch((e: Error) => {
      notes.push(`当日の約定を取得できませんでした（${e.message}）`);
      return [] as AlpacaFill[];
    }),
    client.dividends(today).catch((e: Error) => {
      notes.push(`配当入金を取得できませんでした（${e.message}）`);
      return [] as AlpacaDividend[];
    }),
  ]);

  const dayChangeAmount = account.equity - account.lastEquity;
  const dayChange = account.lastEquity > 0 ? dayChangeAmount / account.lastEquity : 0;

  // ベンチマークをポートフォリオと同じ日付軸に載せ替えてから比較する
  let beta = 0, alpha = 0, alphaTStat = 0, maxDrawdown = 0;
  let sinceInception = 0, benchSinceInception = 0, benchDayChange = 0;

  if (history.equity.length >= 2) {
    const from = history.dates[0]!;
    const closes = await client.benchmarkCloses(benchmark, from, today).catch((e: Error) => {
      notes.push(`${benchmark} の株価を取得できませんでした（${e.message}）。超過収益は0として表示されます。`);
      return new Map<string, number>();
    });

    const portEquity: number[] = [];
    const benchEquity: number[] = [];
    let base = 0;
    for (let i = 0; i < history.dates.length; i++) {
      const close = closes.get(history.dates[i]!);
      if (close === undefined) continue; // ベンチマークの終値が無い日は両方から外す
      if (base === 0) base = close;
      portEquity.push(history.equity[i]!);
      benchEquity.push((history.equity[0]! * close) / base);
    }

    if (portEquity.length >= 2) {
      const m = computeMetrics(portEquity, benchEquity, []);
      beta = m.beta;
      alpha = m.alpha;
      alphaTStat = m.alphaTStat;
      maxDrawdown = m.maxDrawdown;
      sinceInception = portEquity[portEquity.length - 1]! / portEquity[0]! - 1;
      benchSinceInception = benchEquity[benchEquity.length - 1]! / benchEquity[0]! - 1;
      const n = benchEquity.length;
      benchDayChange = n >= 2 ? benchEquity[n - 1]! / benchEquity[n - 2]! - 1 : 0;
    } else {
      notes.push('ベンチマークと突き合わせられる営業日が足りず、超過収益を計算していません。');
    }

    const lastDate = history.dates[history.dates.length - 1];
    if (lastDate !== today) {
      notes.push(`口座の最新データは ${lastDate} です（米国市場が休場か、まだ更新されていません）。`);
    }
  } else {
    notes.push('評価額の履歴が足りないため、ベータ・アルファは計算していません。');
  }

  const riskLimitRaw = env('DAILY_LOSS_LIMIT');
  const riskLimit = riskLimitRaw === '' ? 0.03 : Number(riskLimitRaw);

  return {
    date: today,
    demo: false,
    benchmark,
    equity: account.equity,
    dayChange,
    dayChangeAmount,
    benchDayChange,
    sinceInception,
    benchSinceInception,
    maxDrawdown,
    beta,
    alpha,
    alphaTStat,
    observationDays: history.equity.length,
    riskLimit: Number.isFinite(riskLimit) && riskLimit > 0 ? riskLimit : null,
    stopWarnAt: Number(env('STOP_WARN_AT') || '0.06'),
    targetWarnAt: Number(env('TARGET_WARN_AT') || '0.18'),
    positions,
    fills,
    dividends,
    notes,
  };
}

async function main(): Promise<void> {
  const report = flag('demo') ? demoReport() : await buildReport();
  console.log(toConsole(report));

  const webhook = env('SLACK_WEBHOOK_URL');
  if (flag('dry')) {
    console.log('--dry のためSlackへは投稿しませんでした。');
    return;
  }
  if (!webhook) {
    console.log('SLACK_WEBHOOK_URL が未設定のため、コンソール出力のみです。');
    return;
  }
  await postToSlack(webhook, report);
  console.log('Slackへ投稿しました。');
}

main().catch((err) => {
  console.error('❌ 日次レポートの作成に失敗しました:', (err as Error).message);
  process.exit(1);
});
