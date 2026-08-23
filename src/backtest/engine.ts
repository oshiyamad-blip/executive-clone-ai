import type {
  BacktestConfig,
  BacktestResult,
  Bar,
  ExitReason,
  Series,
  SleeveResult,
  SleeveRule,
  Trade,
} from './types.js';
import { indexSeries, selectSymbols, type IndexedSeries } from './screener.js';
import { computeMetrics } from './metrics.js';

interface Position {
  symbol: string;
  entryDate: string;
  entryPrice: number; // スリッページ込みの実質取得単価
  shares: number;
  holdingDays: number;
}

interface SleeveState {
  rule: SleeveRule;
  cash: number;
  positions: Position[];
  trades: Trade[];
  equity: number[];
  /** 翌営業日の寄りで新規に買う銘柄 */
  pendingEntries: string[];
}

interface ExitDecision {
  price: number;
  reason: ExitReason;
}

/**
 * その日のバーで決済が起きるかを判定する。
 *
 * 実データを使う意味はここにある。合成データの近似ではなく、実際の寄値・高値・安値で
 * 「損切り価格で約定できたのか、それとも寄りが飛んで不利な値で約定したのか」を区別する。
 */
function decideExit(pos: Position, bar: Bar, rule: SleeveRule): ExitDecision | null {
  const stop = rule.stopLoss === null ? null : pos.entryPrice * (1 - rule.stopLoss);
  const target = rule.takeProfit === null ? null : pos.entryPrice * (1 + rule.takeProfit);

  // 寄りの時点ですでにバリアを越えている場合、指値では約定せず寄り成行になる。
  // 決算ギャップで −8% の損切りが −8% で止まらないのはこのケース。
  if (stop !== null && bar.open <= stop) return { price: bar.open, reason: 'stop_gap' };
  if (target !== null && bar.open >= target) return { price: bar.open, reason: 'target_gap' };

  const hitStop = stop !== null && bar.low <= stop;
  const hitTarget = target !== null && bar.high >= target;

  // 日足では両方に触れた日の前後関係が分からない。楽観側に倒すと成績が過大評価に
  // なるため、必ず損切りが先に来たものとして扱う。
  if (hitStop) return { price: stop!, reason: 'stop' };
  if (hitTarget) return { price: target!, reason: 'target' };

  if (rule.maxHoldingDays !== null && pos.holdingDays >= rule.maxHoldingDays) {
    return { price: bar.close, reason: 'timeout' };
  }
  return null;
}

function closePosition(
  state: SleeveState,
  pos: Position,
  exitDate: string,
  exit: ExitDecision,
  cfg: BacktestConfig,
): void {
  const slip = cfg.slippageBps / 10000;
  const fill = exit.price * (1 - slip); // 売りは不利な方向に滑る
  const proceeds = fill * pos.shares - cfg.commission;
  const cost = pos.entryPrice * pos.shares;

  state.cash += proceeds;
  state.trades.push({
    sleeve: state.rule.name,
    symbol: pos.symbol,
    entryDate: pos.entryDate,
    entryPrice: pos.entryPrice,
    exitDate,
    exitPrice: fill,
    shares: pos.shares,
    holdingDays: pos.holdingDays,
    reason: exit.reason,
    grossReturn: exit.price / pos.entryPrice - 1,
    netReturn: cost > 0 ? (proceeds - cost) / cost : 0,
    pnl: proceeds - cost,
  });
}

function sleeveEquity(state: SleeveState, priceOf: (symbol: string) => number | null): number {
  let value = state.cash;
  for (const p of state.positions) {
    const px = priceOf(p.symbol);
    value += (px ?? p.entryPrice) * p.shares;
  }
  return value;
}

export interface RunInput {
  config: BacktestConfig;
  /** ベンチマークを含む全銘柄の日足 */
  seriesList: Series[];
  skippedSymbols: string[];
}

export function runBacktest(input: RunInput): BacktestResult {
  const { config: cfg } = input;
  const indexed = new Map<string, IndexedSeries>();
  for (const s of input.seriesList) indexed.set(s.symbol.toUpperCase(), indexSeries(s));

  const bench = indexed.get(cfg.benchmark.toUpperCase());
  if (!bench) throw new Error(`ベンチマーク ${cfg.benchmark} のデータがありません`);

  // ベンチマークの営業日をマスターカレンダーにする
  const calendar = bench.bars
    .map((b) => b.date)
    .filter((d) => d >= cfg.from && d <= cfg.to);
  if (calendar.length < 60) {
    throw new Error(`対象期間の営業日が ${calendar.length} 日しかありません。期間かデータを確認してください`);
  }

  const universeSeries: IndexedSeries[] = cfg.universe
    .map((s) => indexed.get(s.toUpperCase()))
    .filter((s): s is IndexedSeries => s !== undefined);

  const states: SleeveState[] = cfg.sleeves.map((rule) => ({
    rule,
    cash: cfg.initialCapital * rule.allocation,
    positions: [],
    trades: [],
    equity: [],
    pendingEntries: [],
  }));

  const slip = cfg.slippageBps / 10000;
  const equity: number[] = [];
  const benchmarkEquity: number[] = [];

  // ベンチマークは初日の寄りで買って持ち切る
  const benchFirst = bench.bars.find((b) => b.date === calendar[0])!;
  const benchShares = cfg.initialCapital / benchFirst.open;

  for (let t = 0; t < calendar.length; t++) {
    const date = calendar[t]!;

    const barOf = (symbol: string): Bar | null => {
      const s = indexed.get(symbol.toUpperCase());
      if (!s) return null;
      const i = s.idxByDate.get(date);
      return i === undefined ? null : s.bars[i]!;
    };
    const closeOf = (symbol: string): number | null => barOf(symbol)?.close ?? null;

    for (const state of states) {
      // 1. 前日に決めた新規建てを、今日の寄りで約定させる（判断日の終値では買わない）
      const entries = state.pendingEntries;
      state.pendingEntries = [];
      for (const symbol of entries) {
        if (state.positions.length >= state.rule.slots) break;
        const bar = barOf(symbol);
        if (!bar) continue;
        const price = bar.open * (1 + slip);
        const budget = sleeveEquity(state, closeOf) / state.rule.slots;
        const shares = Math.floor(Math.min(budget, state.cash - cfg.commission) / price);
        if (shares <= 0) continue;
        state.cash -= shares * price + cfg.commission;
        state.positions.push({ symbol, entryDate: date, entryPrice: price, shares, holdingDays: 0 });
      }

      // 2. 保有中のポジションの決済判定
      const surviving: Position[] = [];
      for (const pos of state.positions) {
        const bar = barOf(pos.symbol);
        if (!bar) {
          surviving.push(pos);
          continue;
        }
        const exit = decideExit(pos, bar, state.rule);
        if (exit) {
          closePosition(state, pos, date, exit, cfg);
        } else {
          pos.holdingDays++;
          surviving.push(pos);
        }
      }
      state.positions = surviving;

      // 3. 空きスロットがあれば、今日の終値までの情報で明日の買い候補を決める
      const free = state.rule.slots - state.positions.length;
      const isRebalanceDay = t % cfg.rebalanceDays === 0;
      if (free > 0 && (isRebalanceDay || state.rule.selection.kind !== 'fixed')) {
        const held = new Set(state.positions.map((p) => p.symbol));
        const ranked = selectSymbols(state.rule.selection, universeSeries, date);
        state.pendingEntries = ranked.filter((s) => !held.has(s)).slice(0, free);
      }

      state.equity.push(sleeveEquity(state, closeOf));
    }

    equity.push(states.reduce((sum, s) => sum + s.equity[s.equity.length - 1]!, 0));
    const bBar = barOf(cfg.benchmark);
    benchmarkEquity.push(benchShares * (bBar?.close ?? benchFirst.close));
  }

  // 期間末に残っているポジションは最終営業日の終値で手仕舞い（実現損益を確定させる）
  const lastDate = calendar[calendar.length - 1]!;
  for (const state of states) {
    for (const pos of state.positions) {
      const s = indexed.get(pos.symbol);
      const i = s ? s.idxByDate.get(lastDate) : undefined;
      const px = i !== undefined ? s!.bars[i]!.close : pos.entryPrice;
      closePosition(state, pos, lastDate, { price: px, reason: 'eod' }, cfg);
    }
    state.positions = [];
  }

  const sleeves: SleeveResult[] = states.map((s) => ({
    name: s.rule.name,
    trades: s.trades,
    equity: s.equity,
  }));

  const allTrades = states.flatMap((s) => s.trades);
  const metrics = computeMetrics(equity, benchmarkEquity, allTrades);
  const benchmarkMetrics = computeMetrics(benchmarkEquity, benchmarkEquity, []);

  // 実現益にのみ課税する（含み益は繰り延べ）。損失は同年内で相殺できるものとして扱う
  const realized = allTrades.reduce((sum, t) => sum + t.pnl, 0);
  const tax = realized > 0 ? realized * cfg.taxRate : 0;
  const finalEquity = equity[equity.length - 1]!;
  const afterTaxTotalReturn = (finalEquity - tax - cfg.initialCapital) / cfg.initialCapital;

  return {
    config: cfg,
    dates: calendar,
    equity,
    benchmarkEquity,
    sleeves,
    metrics,
    benchmarkMetrics,
    afterTaxTotalReturn,
    skippedSymbols: input.skippedSymbols,
  };
}
