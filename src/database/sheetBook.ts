// Googleスプレッドシートを「ヘッダー行つきのタブ＝表」として読み書きする汎用層。
// SESデータ保存（sheets.ts・メインのスプレッドシート）とプロパー管理表（別テナントのスプレッドシート）が
// それぞれ SheetBook のインスタンスを持ち、認証・タブ定義だけを差し替えて同じ仕組みを使う。
// - タブとヘッダー行は初回アクセス時に自動生成し、定義の末尾に増えた列は既存シートにも自動追記する
// - タブ単位の行キャッシュ（更新前に対象行を1回読み直し、人の並べ替え・手入力とのズレを防ぐ）
// - 全呼び出しを直列化して書き込みクォータ（ユーザーあたり60回/分）を守り、429/5xxは待って再試行する
// - 書き込みは常に valueInputOption=RAW（メール件名・LLM出力・氏名など外部由来の文字列が '=' '+' '-' '@' で
//   始まっても数式として解釈させない。USER_ENTERED に変える場合はセル先頭のエスケープが必要）
import type { sheets_v4 } from 'googleapis';
import { safeErr, SafeLogError } from '../ses/redact.js';

// 書き込みはユーザーあたり60リクエスト/分のクォータがあるため、全呼び出しを直列化して間隔を空ける。
// 複数のスプレッドシート（別テナント含む）でも同じSAを使い得るため、インスタンス間で共有する
const MIN_INTERVAL_MS = 1100;
let lastCall = Promise.resolve();

async function throttle<T>(fn: () => Promise<T>): Promise<T> {
  const prev = lastCall;
  let release: () => void = () => {};
  lastCall = new Promise<void>((res) => (release = res));
  await prev;
  try {
    return await withGoogleRetry(fn);
  } finally {
    setTimeout(release, MIN_INTERVAL_MS);
  }
}

// クォータ超過(429)・一時障害(5xx)のみ待って再試行する（権限不足等の恒久エラーは即失敗）
const RETRY_DELAYS_MS = [2000, 8000, 30000];

export async function withGoogleRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const e = err as { status?: unknown; response?: { status?: unknown } };
      const status = Number(e.response?.status ?? e.status);
      const retryable = status === 429 || (status >= 500 && status < 600);
      if (!retryable || attempt >= RETRY_DELAYS_MS.length) throw err;
      await new Promise((res) => setTimeout(res, RETRY_DELAYS_MS[attempt]));
    }
  }
}

export type Cell = string | number | null;

// A1表記のタブ名。日本語・記号・先頭アンダースコアのタブ名でも誤解釈されないよう常に引用する
export function quoteTab(tab: string): string {
  return `'${tab.replace(/'/g, "''")}'`;
}

// 0起点の列番号 → A1列文字（0→A, 25→Z, 26→AA）
export function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export type HeaderPlan =
  | { kind: 'ok' }
  | { kind: 'append'; fromIndex: number; cells: string[] }
  | { kind: 'conflict'; index: number };

// 既存タブのヘッダー行と現行定義の突き合わせ。既存が定義の先頭部分なら不足列を末尾へ追記、
// 定義の後ろに人が足した列があるだけなら互換、それ以外（列の並び替え・改名）は自動修正しない
export function planHeaderMigration(existing: string[], definition: string[]): HeaderPlan {
  const overlap = Math.min(existing.length, definition.length);
  for (let i = 0; i < overlap; i++) {
    if (existing[i] !== definition[i]) return { kind: 'conflict', index: i };
  }
  if (existing.length >= definition.length) return { kind: 'ok' };
  return { kind: 'append', fromIndex: existing.length, cells: definition.slice(existing.length) };
}

export interface CachedRow {
  rowNumber: number; // シート上の行番号（1=ヘッダー）
  cells: string[];
}

interface TabCache {
  rows: CachedRow[];
  loadedAt: number;
  indexes: Map<number, Map<string, CachedRow>>; // 列番号 → セル値 → 最初に現れる行
}

// 長時間動くプロセス（確認UI）でも他プロセスの書き込みを取り込めるよう、一定時間で読み直す
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface SheetBookOptions {
  label: string; // ログの接頭辞（例: 'SheetsDB'）
  tabs: Record<string, string[]>; // タブ名 → 列定義（列順は読み書きの両方が依存する。追加は末尾のみ）
  spreadsheetId: () => string;
  createApi: () => sheets_v4.Sheets | null; // 認証情報が無ければ null
  missingIdMessage: string; // スプレッドシートID未設定時の説明
  missingAuthMessage: string; // 認証未設定時の説明
  accessHint: string; // スプレッドシートを開けないときの確認事項
  // タブを新規作成するときに付ける入力規則（列名 → 選択肢のプルダウン）
  dropdowns?: Record<string, Record<string, string[]>>;
}

function normalizeCells(cells: unknown[], width: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.max(width, cells.length); i++) out.push(String(cells[i] ?? ''));
  return out;
}

function toCells(row: Cell[]): Array<string | number> {
  return row.map((v) => (v === null ? '' : v));
}

// 追記先の行番号を応答の updatedRange（例: 'タブ'!A12:K13）から得てキャッシュへ反映する
function firstRowOf(updatedRange: string | null | undefined): number | null {
  const m = (updatedRange ?? '').match(/![A-Z]+(\d+)/);
  return m ? Number(m[1]) : null;
}

export class SheetBook {
  private client: sheets_v4.Sheets | null = null;
  private warnedUnconfigured = false;
  // 並行に初回アクセスされてもタブを二重作成しないよう、実行中の Promise を共有する
  private tabsEnsured: Promise<void> | null = null;
  // ヘッダー行が定義と食い違うタブ（列の意味を取り違えるため、呼び出し側で書き込み対象から外す）
  private readonly headerConflicts = new Set<string>();
  private readonly tabCache = new Map<string, TabCache>();
  private readonly tabLoading = new Map<string, Promise<TabCache>>();

  constructor(private readonly opts: SheetBookOptions) {}

  private api(): sheets_v4.Sheets {
    this.client ??= this.opts.createApi();
    if (!this.client) throw new SafeLogError(`${this.opts.label}: ${this.opts.missingAuthMessage}`);
    return this.client;
  }

  private id(): string {
    return this.opts.spreadsheetId();
  }

  // 設定が揃っているか。不足時の警告はプロセス内で初回のみ
  configured(): boolean {
    this.client ??= this.opts.createApi();
    const reason = !this.id() ? this.opts.missingIdMessage : !this.client ? this.opts.missingAuthMessage : '';
    if (!reason) return true;
    if (!this.warnedUnconfigured) {
      this.warnedUnconfigured = true;
      console.warn(`${this.opts.label}: ${reason} — 保存・読出をスキップします`);
    }
    return false;
  }

  columns(tab: string): string[] {
    return this.opts.tabs[tab] ?? [];
  }

  tabNames(): string[] {
    return Object.keys(this.opts.tabs);
  }

  colIndex(tab: string, name: string): number {
    return this.columns(tab).indexOf(name);
  }

  hasHeaderConflict(tab: string): boolean {
    return this.headerConflicts.has(tab);
  }

  // バッチ開始時に呼ぶ（前回実行の状態を持ち越さない）
  reset(): void {
    this.tabCache.clear();
    this.tabLoading.clear();
    this.tabsEnsured = null;
    this.headerConflicts.clear();
  }

  // タブとヘッダー行を必要に応じて自動生成・追記する（プロセス内で初回のみ実行）
  ensureTabs(): Promise<void> {
    this.tabsEnsured ??= this.ensureTabsOnce().catch((err) => {
      this.tabsEnsured = null; // 失敗時は次回呼び出しで再試行
      throw err;
    });
    return this.tabsEnsured;
  }

  private async ensureTabsOnce(): Promise<void> {
    const sheetsApi = this.api();
    const spreadsheetId = this.id();
    const label = this.opts.label;
    let meta: sheets_v4.Schema$Spreadsheet;
    try {
      meta = (await throttle(() => sheetsApi.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' }))).data;
    } catch (err) {
      throw new SafeLogError(`${label}: スプレッドシートにアクセスできません。${this.opts.accessHint}（${safeErr(err)}）`);
    }
    const existing = new Set((meta.sheets ?? []).map((sh) => sh.properties?.title ?? ''));
    this.headerConflicts.clear();
    const tabNames = this.tabNames();
    const missing = tabNames.filter((t) => !existing.has(t));
    const present = tabNames.filter((t) => existing.has(t));
    const headerWrites: sheets_v4.Schema$ValueRange[] = [];

    if (missing.length > 0) {
      const res = await throttle(() =>
        sheetsApi.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) },
        }),
      );
      for (const title of missing) headerWrites.push({ range: `${quoteTab(title)}!A1`, values: [this.columns(title)] });
      await this.addDropdowns(missing, res.data.replies ?? []);
    }

    if (present.length > 0) {
      const res = await throttle(() =>
        sheetsApi.spreadsheets.values.batchGet({ spreadsheetId, ranges: present.map((t) => `${quoteTab(t)}!1:1`) }),
      );
      const ranges = res.data.valueRanges ?? [];
      present.forEach((tab, i) => {
        const header = (ranges[i]?.values?.[0] ?? []).map((c) => String(c ?? '').trim());
        const plan = planHeaderMigration(header, this.columns(tab));
        if (plan.kind === 'append') {
          headerWrites.push({ range: `${quoteTab(tab)}!${columnLetter(plan.fromIndex)}1`, values: [plan.cells] });
          if (plan.fromIndex > 0) console.log(`${label}: 「${tab}」タブに列を追加します（${plan.cells.join(', ')}）`);
        } else if (plan.kind === 'conflict') {
          this.headerConflicts.add(tab);
          console.warn(
            `${label}: 「${tab}」タブのヘッダー行が想定と異なります（${columnLetter(plan.index)}列: 「${this.columns(tab)[plan.index]}」を想定）。` +
              '列の並びに依存して読み書きするため、ヘッダー行を定義どおりに戻してください（自動修正はしません）',
          );
        }
      });
    }

    if (headerWrites.length > 0) {
      await throttle(() =>
        sheetsApi.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: { valueInputOption: 'RAW', data: headerWrites },
        }),
      );
    }
    if (missing.length > 0) console.log(`${label}: タブを自動生成しました（${missing.join(', ')}）`);
  }

  // 新規作成したタブの指定列に選択肢のプルダウンを付ける（人の入力ゆれで判定を外さないため。失敗しても続行）
  private async addDropdowns(created: string[], replies: sheets_v4.Schema$Response[]): Promise<void> {
    const requests: sheets_v4.Schema$Request[] = [];
    created.forEach((tab, i) => {
      const sheetId = replies[i]?.addSheet?.properties?.sheetId;
      const rules = this.opts.dropdowns?.[tab];
      if (sheetId === undefined || sheetId === null || !rules) return;
      for (const [colName, options] of Object.entries(rules)) {
        const col = this.colIndex(tab, colName);
        if (col < 0) continue;
        requests.push({
          setDataValidation: {
            range: { sheetId, startRowIndex: 1, startColumnIndex: col, endColumnIndex: col + 1 },
            rule: {
              condition: { type: 'ONE_OF_LIST', values: options.map((v) => ({ userEnteredValue: v })) },
              showCustomUi: true,
              strict: false,
            },
          },
        });
      }
    });
    if (requests.length === 0) return;
    try {
      await throttle(() => this.api().spreadsheets.batchUpdate({ spreadsheetId: this.id(), requestBody: { requests } }));
    } catch (err) {
      console.warn(`${this.opts.label}: 入力規則（プルダウン）の設定に失敗しました（手動で設定できます）: ${safeErr(err)}`);
    }
  }

  // ===== タブ単位の行キャッシュ =====
  // 保存のたびにタブ全体を読み直すとAPI呼び出しが O(n^2) になるため、プロセス内で行をキャッシュし
  // 追記・更新時に同期する。人の手編集（並べ替え・行削除）とのズレは、更新直前に対象行を読み直して
  // 検証し、ずれていればタブを読み直すことで防ぐ（別行の上書き事故を避ける）。

  private loadTab(tab: string): Promise<TabCache> {
    const hit = this.tabCache.get(tab);
    if (hit && Date.now() - hit.loadedAt < CACHE_TTL_MS) return Promise.resolve(hit);
    let pending = this.tabLoading.get(tab);
    if (!pending) {
      pending = this.fetchTab(tab).finally(() => this.tabLoading.delete(tab));
      this.tabLoading.set(tab, pending);
    }
    return pending;
  }

  private async fetchTab(tab: string): Promise<TabCache> {
    await this.ensureTabs();
    const res = await throttle(() => this.api().spreadsheets.values.get({ spreadsheetId: this.id(), range: quoteTab(tab) }));
    const values = (res.data.values ?? []) as unknown[][];
    const width = this.columns(tab).length;
    const rows = values
      .slice(1)
      .map((cells, i) => ({ rowNumber: i + 2, cells: normalizeCells(cells ?? [], width) }))
      .filter((r) => r.cells.some((c) => c.trim() !== '')); // 途中の空行は読み飛ばす（行番号は保持）
    const cache: TabCache = { rows, loadedAt: Date.now(), indexes: new Map() };
    this.tabCache.set(tab, cache);
    return cache;
  }

  // タブの全データ行（ヘッダー除く）。呼び出し側が並べ替え等をしてもキャッシュが壊れないようコピーを返す
  async readRows(tab: string): Promise<CachedRow[]> {
    return (await this.loadTab(tab)).rows.slice();
  }

  private indexFor(cache: TabCache, col: number): Map<string, CachedRow> {
    let idx = cache.indexes.get(col);
    if (!idx) {
      idx = new Map();
      for (const r of cache.rows) {
        const key = (r.cells[col] ?? '').trim();
        if (key && !idx.has(key)) idx.set(key, r);
      }
      cache.indexes.set(col, idx);
    }
    return idx;
  }

  // キー列で行を探す（キャッシュから。位置の検証はしない）
  async findRow(tab: string, colName: string, key: string): Promise<CachedRow | null> {
    const k = key.trim(); // 索引側もトリム済み
    if (!k) return null;
    const cache = await this.loadTab(tab);
    return this.indexFor(cache, this.colIndex(tab, colName)).get(k) ?? null;
  }

  async appendRows(tab: string, rows: Cell[][]): Promise<void> {
    if (rows.length === 0) return;
    await this.ensureTabs();
    const res = await throttle(() =>
      this.api().spreadsheets.values.append({
        spreadsheetId: this.id(),
        range: `${quoteTab(tab)}!A1`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: rows.map(toCells) },
      }),
    );
    const cache = this.tabCache.get(tab);
    if (!cache) return; // 未読込なら次回の読込で取り込まれる
    const first = firstRowOf(res.data.updates?.updatedRange);
    if (first === null) {
      this.tabCache.delete(tab); // 位置が分からなければ次回読み直す
      return;
    }
    const width = this.columns(tab).length;
    rows.forEach((row, i) => {
      const cached: CachedRow = { rowNumber: first + i, cells: normalizeCells(toCells(row), width) };
      cache.rows.push(cached);
      for (const [col, idx] of cache.indexes) {
        const key = (cached.cells[col] ?? '').trim();
        if (key && !idx.has(key)) idx.set(key, cached);
      }
    });
  }

  // キャッシュ上の行が今もシート上の同じ位置にあるかを、その行を1回読んで確かめる。
  // 同じ位置なら読んだ最新値でキャッシュを更新する（実行中に人が入力した担当者メール・ステータス等を
  // 古いキャッシュで上書きしないため。呼び出し回数はキー1セルだけ読む場合と同じ）
  private async refreshRowAt(tab: string, row: CachedRow, colName: string, key: string): Promise<boolean> {
    const width = this.columns(tab).length;
    const range = `${quoteTab(tab)}!A${row.rowNumber}:${columnLetter(width - 1)}${row.rowNumber}`;
    const res = await throttle(() => this.api().spreadsheets.values.get({ spreadsheetId: this.id(), range }));
    const fresh = normalizeCells((res.data.values?.[0] ?? []) as unknown[], width);
    if (fresh[this.colIndex(tab, colName)].trim() !== key.trim()) return false;
    if (fresh.some((c, i) => c !== (row.cells[i] ?? ''))) {
      row.cells = fresh;
      this.tabCache.get(tab)?.indexes.clear(); // キー以外の列の値も変わり得るため索引は次回参照時に作り直す
    }
    return true;
  }

  // キー列で行を探し、位置を検証（＋最新値へ更新）してから返す。ずれていればタブを読み直して探し直す
  async locateRow(tab: string, colName: string, key: string): Promise<CachedRow | null> {
    const hit = await this.findRow(tab, colName, key);
    if (!hit || (await this.refreshRowAt(tab, hit, colName, key))) return hit;
    this.tabCache.delete(tab);
    return this.findRow(tab, colName, key);
  }

  async writeRow(tab: string, target: CachedRow, row: Cell[]): Promise<void> {
    await throttle(() =>
      this.api().spreadsheets.values.update({
        spreadsheetId: this.id(),
        range: `${quoteTab(tab)}!A${target.rowNumber}`,
        valueInputOption: 'RAW',
        requestBody: { values: [toCells(row)] },
      }),
    );
    const cache = this.tabCache.get(tab);
    if (cache) {
      target.cells = normalizeCells(toCells(row), this.columns(tab).length);
      cache.indexes.clear(); // キー値が変わり得るため索引は次回参照時に作り直す
    }
  }

  // 行の指定列だけを書き込む（人が編集する他の列と競合させないため。存在しない列名は無視）
  async writeCells(tab: string, target: CachedRow, updates: Array<[string, Cell]>): Promise<void> {
    const resolved = updates
      .map(([name, value]) => [this.colIndex(tab, name), value] as const)
      .filter(([col]) => col >= 0);
    if (resolved.length === 0) return;
    await throttle(() =>
      this.api().spreadsheets.values.batchUpdate({
        spreadsheetId: this.id(),
        requestBody: {
          valueInputOption: 'RAW',
          data: resolved.map(([col, value]) => ({
            range: `${quoteTab(tab)}!${columnLetter(col)}${target.rowNumber}`,
            values: [[value === null ? '' : value]],
          })),
        },
      }),
    );
    for (const [col, value] of resolved) target.cells[col] = value === null ? '' : String(value);
    this.tabCache.get(tab)?.indexes.clear();
  }

  // キー列で一致する行があれば更新、無ければ追記（build には既存行の最新セルが渡る）
  async upsertRow(tab: string, keyCol: string, key: string, build: (existing: string[] | null) => Cell[]): Promise<Cell[]> {
    const hit = await this.locateRow(tab, keyCol, key);
    const row = build(hit ? hit.cells : null);
    if (hit) await this.writeRow(tab, hit, row);
    else await this.appendRows(tab, [row]);
    return row;
  }
}

// 行の値が既存セルと同じか（同じなら書き込みを省く。数値は文字列化して比べる）
export function sameCells(row: Cell[], existing: string[]): boolean {
  return row.every((v, i) => String(v ?? '') === (existing[i] ?? ''));
}
