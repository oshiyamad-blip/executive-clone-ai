import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Dividend, DividendSeries, ProviderName } from './types.js';

const CACHE_DIR = 'data/dividends';

/**
 * 現金配当の取得。
 *
 * 配当を「価格に織り込む」だけだと、いくら受け取ったのかが見えない。
 * 権利落ち日に現金として計上することで、配当収入・米国源泉税・日本の追加課税を
 * それぞれ金額で出せるようにする。
 *
 * ⚠ 二重計上の注意: 配当込みで調整済みの価格（Alpacaの adjustment=all）と
 * この現金計上を同時に使ってはいけない。呼び出し側が priceAdjustment='split'
 * のときだけ現金計上する。
 */

function parseDividendCsv(text: string): Dividend[] {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const header = lines[0]!.toLowerCase().split(',').map((h) => h.trim());
  // ex_date / exdate / date のどれでも受け付ける
  const iDate = ['ex_date', 'exdate', 'date'].map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
  const iAmt = ['amount', 'rate', 'dividend', 'cash_amount'].map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
  if (iDate < 0 || iAmt < 0) return [];

  const out: Dividend[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split(',');
    const exDate = (cols[iDate] ?? '').trim().slice(0, 10);
    const amount = Number(cols[iAmt]);
    if (!exDate || !Number.isFinite(amount) || amount <= 0) continue;
    out.push({ exDate, amount });
  }
  out.sort((a, b) => a.exDate.localeCompare(b.exDate));
  return out;
}

function toCsv(divs: Dividend[]): string {
  return ['ex_date,amount', ...divs.map((d) => `${d.exDate},${d.amount}`)].join('\n');
}

async function readCache(symbol: string): Promise<Dividend[] | null> {
  const path = join(CACHE_DIR, `${symbol.toUpperCase()}.csv`);
  if (!existsSync(path)) return null;
  try {
    return parseDividendCsv(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function writeCache(symbol: string, divs: Dividend[]): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(join(CACHE_DIR, `${symbol.toUpperCase()}.csv`), toCsv(divs), 'utf8');
}

/**
 * Alpacaのコーポレートアクションから現金配当を取る。複数銘柄をまとめて1リクエストで引く。
 * レスポンス形状の揺れに強くしてある（cash_dividends 配列、ex_date/ex_dividend_date、rate/amount）。
 */
async function fetchAlpacaDividends(
  symbols: string[],
  from: string,
  to: string,
): Promise<Map<string, Dividend[]>> {
  const key = process.env.ALPACA_API_KEY ?? '';
  const secret = process.env.ALPACA_API_SECRET ?? '';
  if (!key || !secret) throw new Error('ALPACA_API_KEY / ALPACA_API_SECRET が未設定です');

  const out = new Map<string, Dividend[]>();
  for (const s of symbols) out.set(s, []);

  let pageToken = '';
  do {
    const url = new URL('https://data.alpaca.markets/v1/corporate-actions');
    url.searchParams.set('symbols', symbols.join(','));
    url.searchParams.set('types', 'cash_dividend');
    url.searchParams.set('start', from);
    url.searchParams.set('end', to);
    url.searchParams.set('limit', '1000');
    if (pageToken) url.searchParams.set('page_token', pageToken);

    const res = await fetch(url, {
      headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret },
    });
    if (!res.ok) throw new Error(`Alpaca配当: HTTP ${res.status}`);
    const json = (await res.json()) as {
      corporate_actions?: Record<string, unknown[]>;
      next_page_token?: string | null;
    };

    // cash_dividends 以外のキーで返ってきても拾えるよう、全配列を走査する
    for (const rows of Object.values(json.corporate_actions ?? {})) {
      for (const row of rows) {
        const r = row as Record<string, unknown>;
        const sym = String(r['symbol'] ?? '').toUpperCase();
        const exDate = String(r['ex_date'] ?? r['ex_dividend_date'] ?? r['process_date'] ?? '').slice(0, 10);
        const amount = Number(r['rate'] ?? r['amount'] ?? r['cash_amount'] ?? NaN);
        if (!sym || !exDate || !Number.isFinite(amount) || amount <= 0) continue;
        const list = out.get(sym);
        if (list) list.push({ exDate, amount });
      }
    }
    pageToken = json.next_page_token ?? '';
  } while (pageToken);

  for (const list of out.values()) list.sort((a, b) => a.exDate.localeCompare(b.exDate));
  return out;
}

export interface DividendLoadOptions {
  provider: ProviderName;
  from: string;
  to: string;
  refresh?: boolean;
}

/**
 * 配当をまとめて取得する。取得できなかった銘柄は結果に含めない。
 * 呼び出し側は「配当ゼロ」と「配当データなし」を区別すること
 * （データなしを0として扱うと、配当貴族枠のリターンを取りこぼす）。
 */
export async function loadDividends(
  symbols: string[],
  opts: DividendLoadOptions,
): Promise<DividendSeries[]> {
  const upper = symbols.map((s) => s.toUpperCase());
  const result: DividendSeries[] = [];
  const missing: string[] = [];

  for (const sym of upper) {
    const cached = opts.refresh ? null : await readCache(sym);
    if (cached) result.push({ symbol: sym, dividends: cached });
    else missing.push(sym);
  }
  if (missing.length === 0 || opts.provider !== 'alpaca') return result;

  // Alpacaは複数銘柄を1リクエストで受け付けるが、URL長を避けて50銘柄ずつに分ける
  const CHUNK = 50;
  for (let i = 0; i < missing.length; i += CHUNK) {
    const chunk = missing.slice(i, i + CHUNK);
    try {
      const fetched = await fetchAlpacaDividends(chunk, opts.from, opts.to);
      for (const [sym, divs] of fetched) {
        await writeCache(sym, divs);
        result.push({ symbol: sym, dividends: divs });
      }
    } catch (err) {
      console.warn(`  ⚠ 配当の取得に失敗しました（${(err as Error).message}）`);
    }
  }
  return result;
}
