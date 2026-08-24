import type { AlpacaDividend, AlpacaFill, AlpacaPosition } from './alpaca.js';

/** 日次レポート1本ぶんの内容 */
export interface DailyReport {
  date: string;
  /** デモデータで組み立てたレポートかどうか。真なら見出しに明示する */
  demo: boolean;
  benchmark: string;

  equity: number;
  dayChange: number;
  dayChangeAmount: number;
  benchDayChange: number;

  sinceInception: number;
  benchSinceInception: number;
  maxDrawdown: number;

  /** ベンチマークに対するベータ */
  beta: number;
  /** ベータで説明できない年率超過収益 */
  alpha: number;
  /** alpha のt値。2未満なら実力とノイズを区別できない */
  alphaTStat: number;
  /** アルファの算出に使った営業日数 */
  observationDays: number;

  /** 当日の下落がこれを超えたら停止を促す。null なら判定しない */
  riskLimit: number | null;
  /** 含み損がこの値以下なら損切り接近として印を付ける */
  stopWarnAt: number;
  /** 含み益がこの値以上なら利確接近として印を付ける */
  targetWarnAt: number;

  positions: AlpacaPosition[];
  fills: AlpacaFill[];
  dividends: AlpacaDividend[];
  notes: string[];
}
