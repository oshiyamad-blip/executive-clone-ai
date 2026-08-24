/**
 * Alpacaの口座情報を読むクライアント。
 *
 * ここでは**読み取りしか行わない**。発注は一切しない。
 * レポート用途でも取引権限のあるキーを使うことになるため、
 * 実行環境（GitHub Actions のシークレット等）の管理は docs/daily-report.md を参照。
 */

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export interface AlpacaAccount {
  equity: number;
  lastEquity: number;
  cash: number;
  currency: string;
}

export interface AlpacaPosition {
  symbol: string;
  qty: number;
  avgEntryPrice: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPl: number;
  unrealizedPlpc: number;
  /** 当日の含み損益 */
  intradayPl: number;
}

export interface AlpacaFill {
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  filledAt: string;
}

export interface AlpacaDividend {
  symbol: string;
  date: string;
  netAmount: number;
  perShare: number;
}

export interface PortfolioHistory {
  dates: string[];
  equity: number[];
}

export class AlpacaClient {
  private readonly tradingBase: string;
  private readonly dataBase = 'https://data.alpaca.markets';
  private readonly headers: Record<string, string>;

  constructor(key: string, secret: string, paper: boolean) {
    this.tradingBase = paper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets';
    this.headers = { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret };
  }

  private async get<T>(base: string, path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(path, base);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Alpaca ${path}: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  async account(): Promise<AlpacaAccount> {
    const a = await this.get<Record<string, unknown>>(this.tradingBase, '/v2/account');
    return {
      equity: num(a['equity']),
      lastEquity: num(a['last_equity']),
      cash: num(a['cash']),
      currency: String(a['currency'] ?? 'USD'),
    };
  }

  async positions(): Promise<AlpacaPosition[]> {
    const rows = await this.get<Record<string, unknown>[]>(this.tradingBase, '/v2/positions');
    return rows.map((p) => ({
      symbol: String(p['symbol'] ?? ''),
      qty: num(p['qty']),
      avgEntryPrice: num(p['avg_entry_price']),
      currentPrice: num(p['current_price']),
      marketValue: num(p['market_value']),
      unrealizedPl: num(p['unrealized_pl']),
      unrealizedPlpc: num(p['unrealized_plpc']),
      intradayPl: num(p['unrealized_intraday_pl']),
    }));
  }

  /** 日次の評価額推移。ベータ・アルファの算出に使う */
  async portfolioHistory(period = '1A'): Promise<PortfolioHistory> {
    const h = await this.get<{ timestamp?: number[]; equity?: (number | null)[] }>(
      this.tradingBase,
      '/v2/account/portfolio/history',
      { period, timeframe: '1D' },
    );
    const dates: string[] = [];
    const equity: number[] = [];
    const ts = h.timestamp ?? [];
    const eq = h.equity ?? [];
    for (let i = 0; i < ts.length; i++) {
      const v = eq[i];
      if (v === null || v === undefined || v <= 0) continue; // 休場日の空データを飛ばす
      dates.push(new Date(ts[i]! * 1000).toISOString().slice(0, 10));
      equity.push(v);
    }
    return { dates, equity };
  }

  /** 指定日以降に約定した注文 */
  async fills(afterIso: string): Promise<AlpacaFill[]> {
    const rows = await this.get<Record<string, unknown>[]>(this.tradingBase, '/v2/orders', {
      status: 'closed',
      after: afterIso,
      limit: '200',
      direction: 'asc',
    });
    return rows
      .filter((o) => num(o['filled_qty']) > 0)
      .map((o) => ({
        symbol: String(o['symbol'] ?? ''),
        side: String(o['side'] ?? 'buy') === 'sell' ? 'sell' : 'buy',
        qty: num(o['filled_qty']),
        price: num(o['filled_avg_price']),
        filledAt: String(o['filled_at'] ?? ''),
      }));
  }

  /** 指定日以降の配当入金 */
  async dividends(afterDate: string): Promise<AlpacaDividend[]> {
    const rows = await this.get<Record<string, unknown>[]>(
      this.tradingBase,
      '/v2/account/activities/DIV',
      { after: afterDate },
    );
    return rows.map((d) => ({
      symbol: String(d['symbol'] ?? ''),
      date: String(d['date'] ?? '').slice(0, 10),
      netAmount: num(d['net_amount']),
      perShare: num(d['per_share_amount']),
    }));
  }

  /** ベンチマークの日足終値。ポートフォリオと同じ期間で超過収益を出すために使う */
  async benchmarkCloses(symbol: string, from: string, to: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    let pageToken = '';
    do {
      const params: Record<string, string> = {
        timeframe: '1Day',
        start: from,
        end: to,
        adjustment: 'all',
        limit: '10000',
      };
      if (pageToken) params['page_token'] = pageToken;
      const json = await this.get<{
        bars?: { t: string; c: number }[];
        next_page_token?: string | null;
      }>(this.dataBase, `/v2/stocks/${encodeURIComponent(symbol)}/bars`, params);
      for (const b of json.bars ?? []) out.set(b.t.slice(0, 10), b.c);
      pageToken = json.next_page_token ?? '';
    } while (pageToken);
    return out;
  }
}
