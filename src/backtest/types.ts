// 実際の株価でルールを検証するためのバックテスト用の型定義。
// docs/stock-trading-automation-review.md の検討結果を、合成データではなく実データで確かめる。

/** 日足バー。価格は分割・配当調整済みの値を入れる */
export interface Bar {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** 銘柄ごとの日足シリーズ */
export interface Series {
  symbol: string;
  bars: Bar[];
}

export type ProviderName = 'stooq' | 'alpaca' | 'csv' | 'synthetic';

/** 決済理由。ギャップ約定は損切り価格で約定できなかったケースを区別する */
export type ExitReason =
  | 'stop'      // 損切り価格で約定
  | 'stop_gap'  // 寄りが損切り価格を割っており、寄り成行で約定（想定より不利）
  | 'target'    // 利確価格で約定
  | 'target_gap'// 寄りが利確価格を超えており、寄り成行で約定（想定より有利）
  | 'timeout'   // 最大保有日数に到達して手仕舞い
  | 'eod';      // バックテスト期間の終了で強制手仕舞い

/** 1トレードの記録 */
export interface Trade {
  sleeve: string;
  symbol: string;
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  shares: number;
  holdingDays: number;
  reason: ExitReason;
  grossReturn: number; // コスト控除前のリターン率
  netReturn: number;   // スリッページ・手数料控除後のリターン率
  pnl: number;         // 金額ベースの損益（コスト控除後）
}

/** 損切り・利確ルール */
export interface SleeveRule {
  name: string;
  /** 資産配分比率（0〜1）。全スリーブの合計が1になるようにする */
  allocation: number;
  /** 損切り幅。0.08 なら −8%。null なら損切りしない（配当貴族枠） */
  stopLoss: number | null;
  /** 利確幅。0.20 なら +20%。null なら利確しない */
  takeProfit: number | null;
  /** 最大保有営業日。null なら無期限（バイ・アンド・ホールド） */
  maxHoldingDays: number | null;
  /** 同時に保有する銘柄数 */
  slots: number;
  /** 銘柄の選び方 */
  selection: SelectionRule;
}

/** 銘柄の自動選定ルール。すべて判定日までのデータのみを使う（ルックアヘッド禁止） */
export interface SelectionRule {
  /** fixed: 固定銘柄を持ち続ける / momentum: 中期モメンタム上位 / pullback: 短期押し目 */
  kind: 'fixed' | 'momentum' | 'pullback';
  /** kind='fixed' のときの銘柄 */
  symbols?: string[];
  /** モメンタムの計測期間（営業日） */
  lookbackDays?: number;
  /** 直近から除外する期間（営業日）。12-1モメンタムの「-1」に相当 */
  skipDays?: number;
  /** このMAを上回っていることを条件にする */
  trendFilterDays?: number;
  /** 年率ボラの上限。高すぎる銘柄は固定%バリアが機能しないため除外 */
  maxAnnualVol?: number;
  /** 最低平均売買代金（ドル）。流動性の低い銘柄を除外 */
  minDollarVolume?: number;
}

export interface BacktestConfig {
  from: string;
  to: string;
  initialCapital: number;
  /** 片道のスリッページ（bps）。往復で2倍かかる */
  slippageBps: number;
  /** 1トレードあたりの手数料（ドル）。Alpacaは0 */
  commission: number;
  /** 実現益への課税率。0.20315 で日本の申告分離課税 */
  taxRate: number;
  /** 比較対象のベンチマーク銘柄 */
  benchmark: string;
  sleeves: SleeveRule[];
  /** 銘柄選定の母集団 */
  universe: string[];
  /** 選定を見直す間隔（営業日） */
  rebalanceDays: number;
}

/** 評価指標 */
export interface Metrics {
  totalReturn: number;
  cagr: number;
  annualVol: number;
  sharpe: number;
  maxDrawdown: number;
  /** ベンチマークに対するベータ */
  beta: number;
  /** ベータ調整後の年率超過収益 */
  alpha: number;
  /** alpha のt値。2未満なら「実力とノイズが区別できない」 */
  alphaTStat: number;
  tradeCount: number;
  winRate: number;
  avgHoldingDays: number;
}

export interface SleeveResult {
  name: string;
  trades: Trade[];
  /** 日次のスリーブ評価額 */
  equity: number[];
}

export interface BacktestResult {
  config: BacktestConfig;
  dates: string[];
  /** ポートフォリオ全体の日次評価額 */
  equity: number[];
  /** ベンチマークを同額投資した場合の日次評価額 */
  benchmarkEquity: number[];
  sleeves: SleeveResult[];
  metrics: Metrics;
  benchmarkMetrics: Metrics;
  /** 課税後の最終リターン（実現益にのみ課税） */
  afterTaxTotalReturn: number;
  /** データが揃わず母集団から外れた銘柄 */
  skippedSymbols: string[];
}
