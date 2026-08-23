import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Bar, ProviderName, Series } from './types.js';

const CACHE_DIR = 'data/prices';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 日足データの取得元。
 * - stooq:  APIキー不要・無料。まずこれで十分（分割調整済み）
 * - alpaca: APIキーが必要。実運用と同じ配信元で検証したい場合
 * - csv:    data/prices/*.csv を読むだけ。オフラインでの再実行用
 * - synthetic: ネットワークなしでエンジンの挙動を確かめる自己テスト用
 *
 * 一度取得したものは data/prices/ にキャッシュするため、2回目以降はオフラインで動く。
 */

function parseCsv(text: string, symbol: string): Bar[] {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const header = lines[0]!.toLowerCase().split(',').map((h) => h.trim());
  const idx = (name: string) => header.indexOf(name);
  const [iD, iO, iH, iL, iC, iV] = [idx('date'), idx('open'), idx('high'), idx('low'), idx('close'), idx('volume')];
  if (iD < 0 || iO < 0 || iH < 0 || iL < 0 || iC < 0) {
    throw new Error(`${symbol}: CSVのヘッダーに date/open/high/low/close が必要です`);
  }

  const bars: Bar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split(',');
    const bar: Bar = {
      date: (cols[iD] ?? '').trim(),
      open: Number(cols[iO]),
      high: Number(cols[iH]),
      low: Number(cols[iL]),
      close: Number(cols[iC]),
      volume: iV >= 0 ? Number(cols[iV]) : 0,
    };
    // 欠損・ゼロ価格の行は捨てる（配当調整前の空行が混ざることがある）
    if (!bar.date || !Number.isFinite(bar.close) || bar.close <= 0) continue;
    if (!Number.isFinite(bar.open) || !Number.isFinite(bar.high) || !Number.isFinite(bar.low)) continue;
    bars.push(bar);
  }
  bars.sort((a, b) => a.date.localeCompare(b.date));
  return bars;
}

function toCsv(bars: Bar[]): string {
  const rows = bars.map((b) => `${b.date},${b.open},${b.high},${b.low},${b.close},${b.volume}`);
  return ['Date,Open,High,Low,Close,Volume', ...rows].join('\n');
}

async function readCache(symbol: string): Promise<Bar[] | null> {
  const path = join(CACHE_DIR, `${symbol.toUpperCase()}.csv`);
  if (!existsSync(path)) return null;
  try {
    return parseCsv(await readFile(path, 'utf8'), symbol);
  } catch {
    return null;
  }
}

async function writeCache(symbol: string, bars: Bar[]): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(join(CACHE_DIR, `${symbol.toUpperCase()}.csv`), toCsv(bars), 'utf8');
}

async function fetchStooq(symbol: string): Promise<Bar[]> {
  // Stooqの米国株は末尾に .us が付く（例: AAPL → aapl.us）
  const s = symbol.toLowerCase();
  const code = s.includes('.') ? s : `${s}.us`;
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(code)}&i=d`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Stooq ${symbol}: HTTP ${res.status}`);
  const text = await res.text();
  if (text.trim().startsWith('<') || text.includes('Exceeded')) {
    throw new Error(`Stooq ${symbol}: データが返りませんでした（レート制限か銘柄コード誤り）`);
  }
  return parseCsv(text, symbol);
}

async function fetchAlpaca(symbol: string, from: string, to: string): Promise<Bar[]> {
  const key = process.env.ALPACA_API_KEY ?? '';
  const secret = process.env.ALPACA_API_SECRET ?? '';
  if (!key || !secret) throw new Error('ALPACA_API_KEY / ALPACA_API_SECRET が未設定です');

  const bars: Bar[] = [];
  let pageToken = '';
  do {
    const url = new URL(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars`);
    url.searchParams.set('timeframe', '1Day');
    url.searchParams.set('start', from);
    url.searchParams.set('end', to);
    url.searchParams.set('adjustment', 'all'); // 分割・配当調整
    url.searchParams.set('limit', '10000');
    if (pageToken) url.searchParams.set('page_token', pageToken);

    const res = await fetch(url, {
      headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret },
    });
    if (!res.ok) throw new Error(`Alpaca ${symbol}: HTTP ${res.status}`);
    const json = (await res.json()) as {
      bars?: { t: string; o: number; h: number; l: number; c: number; v: number }[];
      next_page_token?: string | null;
    };
    for (const b of json.bars ?? []) {
      bars.push({ date: b.t.slice(0, 10), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });
    }
    pageToken = json.next_page_token ?? '';
  } while (pageToken);

  bars.sort((a, b) => a.date.localeCompare(b.date));
  return bars;
}

/**
 * 幾何ブラウン運動で合成した日足。ネットワークなしでエンジンの挙動を検証するためだけのもので、
 * これで出た数字を実際の成績として扱ってはいけない。
 */
export function syntheticSeries(symbol: string, days: number, seed: number, drift = 0.08, vol = 0.30): Series {
  let state = seed >>> 0;
  const rnd = () => ((state = (state * 1664525 + 1013904223) >>> 0) + 0.5) / 4294967296;
  const norm = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());

  const bars: Bar[] = [];
  let price = 100;
  const start = Date.UTC(2015, 0, 5);
  let d = 0;
  for (let i = 0; i < days; i++) {
    // 土日を飛ばして営業日だけ進める
    let ts = start + d * 86400000;
    while (new Date(ts).getUTCDay() === 0 || new Date(ts).getUTCDay() === 6) {
      d++;
      ts = start + d * 86400000;
    }
    d++;

    const dt = 1 / 252;
    const open = price;
    price = open * Math.exp((drift - 0.5 * vol * vol) * dt + vol * Math.sqrt(dt) * norm());
    const wick = open * vol * Math.sqrt(dt) * Math.abs(norm()) * 0.8;
    bars.push({
      date: new Date(ts).toISOString().slice(0, 10),
      open,
      high: Math.max(open, price) + wick,
      low: Math.max(0.01, Math.min(open, price) - wick),
      close: price,
      volume: 5_000_000,
    });
  }
  return { symbol, bars };
}

/** 母集団のティッカー一覧を読む。1行1銘柄、# 以降はコメント */
export async function loadUniverse(path: string): Promise<string[]> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim().toUpperCase())
    .filter((l) => l.length > 0);
}

/** キャッシュ済みの銘柄一覧 */
export async function cachedSymbols(): Promise<string[]> {
  if (!existsSync(CACHE_DIR)) return [];
  const files = await readdir(CACHE_DIR);
  return files.filter((f) => f.endsWith('.csv')).map((f) => f.replace(/\.csv$/, ''));
}

export interface LoadOptions {
  provider: ProviderName;
  from: string;
  to: string;
  /** キャッシュがあってもデータ取得元に取りに行く */
  refresh?: boolean;
}

/**
 * 銘柄の日足を取得する。取得できなかった銘柄は null を返し、呼び出し側で母集団から外す。
 * 外部APIは1銘柄ずつ順に叩く（並列にするとStooqがレート制限で弾く）。
 */
export async function loadSeries(symbol: string, opts: LoadOptions): Promise<Series | null> {
  const sym = symbol.toUpperCase();

  if (opts.provider === 'synthetic') {
    // シンボル名から決定的にシードを作り、毎回同じ系列が出るようにする
    const seed = [...sym].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0;
    return syntheticSeries(sym, 2600, seed);
  }

  if (!opts.refresh) {
    const cached = await readCache(sym);
    if (cached && cached.length > 0) return { symbol: sym, bars: cached };
  }
  if (opts.provider === 'csv') return null;

  // Stooqは短時間に連続で叩くと弾くため、間隔を空けつつ1度だけ再試行する
  const attempts = 2;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const bars =
        opts.provider === 'alpaca'
          ? await fetchAlpaca(sym, opts.from, opts.to)
          : await fetchStooq(sym);
      if (bars.length === 0) return null;
      await writeCache(sym, bars);
      return { symbol: sym, bars };
    } catch (err) {
      if (attempt < attempts) {
        await sleep(3000);
        continue;
      }
      console.warn(`  ⚠ ${sym}: 取得に失敗しました（${(err as Error).message}）`);
      return null;
    }
  }
  return null;
}
