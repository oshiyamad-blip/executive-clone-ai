// Googleスプレッドシートを「ヘッダー行つきのタブ＝表」として読み書きする汎用層。
// SESデータ保存（sheets.ts・メインのスプレッドシート）とプロパー管理表（別テナントのスプレッドシート）が
// それぞれ SheetBook のインスタンスを持ち、認証・タブ定義だけを差し替えて同じ仕組みを使う。
// - 列は見出し（1行目）の名前で対応付ける。人が列を並べ替えたり、途中にメモ列を挿入したりしても、
//   定義の列には正しい列の値を読み書きする（呼び出し側には常に定義順の配列で渡す）
// - タブとヘッダー行は初回アクセス時に自動生成し、定義の末尾に増えた列は既存シートの見出しの右端に自動追記する
// - 見出しはタブを読み直すたび・行を更新する直前に確かめ、実行中に人が列を挿入しても別の列に書かない
// - タブ単位の行キャッシュ（更新前に対象行を1回読み直し、人の並べ替え・手入力とのズレを防ぐ）
// - 全呼び出しを直列化して書き込みクォータ（ユーザーあたり60回/分）を守り、429/5xxは待って再試行する。
//   追記（values.append）・行の削除・タブの作成は冪等でないため、5xx・通信断の後は同じ要求を再送せず、
//   読み直して「既に反映されていないか」を確かめてから（削除は消す行を選び直して）再試行する
// - 書き込みは常に valueInputOption=RAW（メール件名・LLM出力・氏名など外部由来の文字列が '=' '+' '-' '@' で
//   始まっても数式として解釈させない。USER_ENTERED に変える場合はセル先頭のエスケープが必要）
import type { sheets_v4 } from 'googleapis';
import { safeErr, SafeLogError } from '../ses/redact.js';

// 書き込みはユーザーあたり60リクエスト/分のクォータがあるため、全呼び出しを直列化して間隔を空ける。
// 複数のスプレッドシート（別テナント含む）でも同じSAを使い得るため、インスタンス間で共有する
const MIN_INTERVAL_MS = 1100;
let lastCall = Promise.resolve();

// オフライン自己検証（npm run ses:flow:check）用の差し替え口。設定中は全インスタンスがこのAPIを使い、
// クォータ待ちもしない（本番コードからは呼ばない）
let testApi: sheets_v4.Sheets | null = null;

export function __setSheetsApiForTest(api: sheets_v4.Sheets | null): void {
  testApi = api;
}

async function throttle<T>(fn: () => Promise<T>, retry = true): Promise<T> {
  const prev = lastCall;
  let release: () => void = () => {};
  lastCall = new Promise<void>((res) => (release = res));
  await prev;
  try {
    return await (retry ? withGoogleRetry(fn) : fn());
  } finally {
    setTimeout(release, testApi ? 0 : MIN_INTERVAL_MS);
  }
}

// クォータ超過(429・Driveの403 rateLimitExceeded)・一時障害(5xx)のみ待って再試行する（権限不足等の恒久エラーは即失敗）
const RETRY_DELAYS_MS = [2000, 8000, 30000];

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

// Google APIクライアントの1リクエストの待ち時間の上限。未設定だと応答の無い接続で全呼び出しが止まる
// （呼び出しは直列化しているため、1件の詰まりで以降のSheets操作がすべて待たされる）
export const GOOGLE_REQUEST_TIMEOUT_MS = 60_000;

// 処理されたか分からない通信の失敗（接続断・タイムアウト。gaxios はタイムアウトを TimeoutError/AbortError の code で返す）
const AMBIGUOUS_NETWORK_CODES = ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED', 'TimeoutError', 'AbortError'];

// 既存のタブ全体の保護が、バッチの付けた保護と同じ強さか（警告だけでない・ドメイン全員・グループが編集できない・
// バッチのアカウントが編集者に入っている・それ以外の編集者はスプレッドシートのオーナー（APIが常に編集者として返す）の1人まで）
export function isBatchProtection(pr: sheets_v4.Schema$ProtectedRange, editor: string): boolean {
  if (pr.warningOnly) return false;
  const e = pr.editors;
  if (!e || e.domainUsersCanEdit || (e.groups ?? []).length > 0) return false;
  const users = (e.users ?? []).map((u) => u.trim().toLowerCase()).filter(Boolean);
  const me = editor.trim().toLowerCase();
  if (me && !users.includes(me)) return false;
  return users.filter((u) => u !== me).length <= 1;
}

function statusOf(err: unknown): number {
  const e = err as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  return Number(e.response?.status ?? e.status ?? (typeof e.code === 'number' ? e.code : NaN));
}

// Google APIのエラー理由（errors[0].reason）。Drive v3 はレート制限を 403 + この理由で返す
function reasonOf(err: unknown): string {
  const e = err as {
    errors?: Array<{ reason?: unknown }>;
    response?: { data?: { error?: { errors?: Array<{ reason?: unknown }> } } };
  };
  const reason = e.response?.data?.error?.errors?.[0]?.reason ?? e.errors?.[0]?.reason;
  return typeof reason === 'string' ? reason : '';
}

// 待って再試行してよい種類か。rate = 受け付けられなかった（そのまま再送してよい）、
// ambiguous = 処理されたか分からない（冪等でない書き込みは確かめてから再送する）
export function googleTransientKind(err: unknown): 'rate' | 'ambiguous' | null {
  const status = statusOf(err);
  if (status === 429 || (status === 403 && RATE_LIMIT_REASONS.has(reasonOf(err)))) return 'rate';
  if (status >= 500 && status < 600) return 'ambiguous';
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && AMBIGUOUS_NETWORK_CODES.includes(code)) return 'ambiguous';
  return null;
}

// withGoogleRetry が待って再試行する種類（書き込みにも使うため、状態の分からない通信断は含めない）
export function isRetryableGoogleError(err: unknown): boolean {
  const kind = googleTransientKind(err);
  return kind === 'rate' || (kind === 'ambiguous' && !Number.isNaN(statusOf(err)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export async function withGoogleRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryableGoogleError(err) || attempt >= RETRY_DELAYS_MS.length) throw err;
      await sleep(RETRY_DELAYS_MS[attempt]);
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
  | { kind: 'ok'; defToLive: number[] }
  | { kind: 'append'; fromIndex: number; cells: string[]; defToLive: number[] }
  | { kind: 'conflict'; index: number; reason: 'missing' | 'duplicate' | 'blankFirst' };

// 既存タブのヘッダー行と現行定義の突き合わせ（列は見出しの名前で対応付ける）。
// - 定義の列がすべて見出しにあれば ok（並べ替え・途中へのメモ列の挿入は可）
// - 足りないのが定義の末尾の列だけ（＝定義が増えた）なら、見出しの右端の後ろに追記する
// - 定義の途中の列が見当たらない（改名・削除）・同じ見出しが2つある場合は、どの列に読み書きすべきか
//   決められないため自動修正しない（conflict）
// - A列の見出しが空（先頭に見出しの無い列を挿入した等）も conflict。追記（values.append）は表の先頭の列から
//   書き込むため、A列が空だと表がB列から始まると判定され、追記した行の値が右にずれる
export function planHeaderMigration(existing: string[], definition: string[]): HeaderPlan {
  const header = existing.map((c) => String(c ?? '').trim());
  if (header.length > 0 && header[0] === '' && header.some(Boolean)) return { kind: 'conflict', index: 0, reason: 'blankFirst' };
  const first = new Map<string, number>();
  const duplicated = new Set<string>();
  header.forEach((h, i) => {
    if (!h) return;
    if (first.has(h)) duplicated.add(h);
    else first.set(h, i);
  });
  const dupIndex = definition.findIndex((d) => duplicated.has(d));
  if (dupIndex >= 0) return { kind: 'conflict', index: dupIndex, reason: 'duplicate' };
  const present = definition.map((d) => first.get(d) ?? -1);
  const missing = present.map((p, i) => (p < 0 ? i : -1)).filter((i) => i >= 0);
  if (missing.length === 0) return { kind: 'ok', defToLive: present };
  const lastPresentDef = present.reduce((acc, p, i) => (p >= 0 ? i : acc), -1);
  if (missing[0] < lastPresentDef) return { kind: 'conflict', index: missing[0], reason: 'missing' };
  let lastUsed = -1;
  header.forEach((h, i) => {
    if (h) lastUsed = i;
  });
  const fromIndex = lastUsed + 1;
  const defToLive = present.map((p, i) => (p >= 0 ? p : fromIndex + missing.indexOf(i)));
  return { kind: 'append', fromIndex, cells: missing.map((i) => definition[i]), defToLive };
}

export interface CachedRow {
  rowNumber: number; // シート上の行番号（1=ヘッダー）
  cells: string[]; // 定義の列順の値
  raw: string[]; // シート上の列順の値（人のメモ列を含む）
}

interface TabLayout {
  header: string[]; // シート上の見出し（前後の空白を除く）
  defToLive: number[]; // 定義の列番号 → シート上の列番号
  checkedAt: number;
}

interface TabCache {
  rows: CachedRow[];
  loadedAt: number;
  indexes: Map<number, Map<string, CachedRow>>; // 列番号（定義順）→ セル値 → 最初に現れる行
}

// 長時間動くプロセス（確認UI）でも他プロセスの書き込み・人の列の挿入を取り込めるよう、一定時間で読み直す
const CACHE_TTL_MS = 5 * 60 * 1000;

// 新規タブの行数（追記で自動的に増える。既定の1000行×26列はセル数の上限を無駄に使うため小さく作る）
const NEW_TAB_ROWS = 100;

// 1回の呼び出しで書き込むセル範囲の上限（リクエストサイズの手前で区切る）
const CELL_WRITE_CHUNK = 500;

// データ行は書式を通さない値で読む（人が単金の列に「0"万円"」等の表示形式を付けたり、ロケールが小数点にカンマを
// 使ったりしても、数値の列を読み違えない）。日付として入力されたセルは表示どおりの文字列で受け取る
const DATA_READ = { valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING' } as const;

export interface SheetBookOptions {
  label: string; // ログの接頭辞（例: 'SheetsDB'）
  tabs: Record<string, string[]>; // タブ名 → 列定義（列は見出しの名前で対応付ける。追加は末尾のみ）
  spreadsheetId: () => string;
  createApi: () => sheets_v4.Sheets | null; // 認証情報が無ければ null
  missingIdMessage: string; // スプレッドシートID未設定時の説明
  missingAuthMessage: string; // 認証未設定時の説明
  accessHint: string; // スプレッドシートを開けないときの確認事項
  // タブを新規作成するときに付ける入力規則（列名 → 選択肢のプルダウン）
  dropdowns?: Record<string, Record<string, string[]>>;
  // 人に編集させないタブ（タブ名 → 保護の説明）。タブ全体を保護範囲にし、編集者をバッチの実行アカウントだけにする
  // （スプレッドシートのオーナーは常に編集できる）
  protectedTabs?: Record<string, string>;
  protectionEditor?: () => string; // 保護範囲の編集者にするアカウント（サービスアカウント・代理のユーザー）
}

function normalizeCells(cells: unknown[], width: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.max(width, cells.length); i++) out.push(String(cells[i] ?? ''));
  return out;
}

function toCells(row: Cell[]): Array<string | number> {
  return row.map((v) => (v === null ? '' : v));
}

function trimHeader(cells: unknown[]): string[] {
  const out = cells.map((c) => String(c ?? '').trim());
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

function sameHeader(a: string[], b: string[]): boolean {
  const x = trimHeader(a);
  const y = trimHeader(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

// 追記先の行番号を応答の updatedRange（例: 'タブ'!A12:K13）から得てキャッシュへ反映する
function firstRowOf(updatedRange: string | null | undefined): number | null {
  const m = (updatedRange ?? '').match(/![A-Z]+(\d+)/);
  return m ? Number(m[1]) : null;
}

// 連続する列番号ごとにまとめる（書き込み範囲の数を減らす）
function contiguousRuns(entries: Array<[number, string | number]>): Array<{ start: number; values: Array<string | number> }> {
  const sorted = [...entries].sort((a, b) => a[0] - b[0]);
  const runs: Array<{ start: number; values: Array<string | number> }> = [];
  for (const [col, value] of sorted) {
    const last = runs[runs.length - 1];
    if (last && last.start + last.values.length === col) last.values.push(value);
    else runs.push({ start: col, values: [value] });
  }
  return runs;
}

export class SheetBook {
  private client: sheets_v4.Sheets | null = null;
  private warnedUnconfigured = false;
  // 並行に初回アクセスされてもタブを二重作成しないよう、実行中の Promise を共有する
  private tabsEnsured: Promise<void> | null = null;
  // ヘッダー行から定義の列を特定できないタブ（取り違えて別の列に読み書きしないよう、このタブへの読み書きはすべて例外にする）
  private readonly headerConflicts = new Map<string, string>();
  private readonly unprotected = new Set<string>();
  private readonly created = new Set<string>();
  private readonly layouts = new Map<string, TabLayout>();
  private readonly sheetIds = new Map<string, number>();
  private readonly tabCache = new Map<string, TabCache>();
  private readonly tabLoading = new Map<string, Promise<TabCache>>();
  private readonly warnedDuplicates = new Set<string>();
  private totalCells = 0;

  constructor(private readonly opts: SheetBookOptions) {}

  private api(): sheets_v4.Sheets {
    if (testApi) return testApi;
    this.client ??= this.opts.createApi();
    if (!this.client) throw new SafeLogError(`${this.opts.label}: ${this.opts.missingAuthMessage}`);
    return this.client;
  }

  private id(): string {
    return this.opts.spreadsheetId();
  }

  // 設定が揃っているか。不足時の警告はプロセス内で初回のみ
  configured(): boolean {
    if (!testApi) this.client ??= this.opts.createApi();
    const reason = !this.id() ? this.opts.missingIdMessage : !(testApi ?? this.client) ? this.opts.missingAuthMessage : '';
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

  // 定義の列番号（呼び出し側の配列の添字）。シート上の位置ではない
  colIndex(tab: string, name: string): number {
    return this.columns(tab).indexOf(name);
  }

  // スプレッドシート全体のセル数（直近のタブ確認時点。上限は1,000万セル）
  cellCount(): number {
    return this.totalCells;
  }

  private conflictError(tab: string): SafeLogError {
    return new SafeLogError(
      `${this.opts.label}: 「${tab}」タブのヘッダー行から列を特定できないため読み書きしません（${this.headerConflicts.get(tab) ?? ''}。` +
        '見出しの名前を元に戻してください。列の並べ替えやメモ列の追加はできますが、見出しの変更・削除・重複はできません）',
    );
  }

  private assertHeaderMatches(tab: string): void {
    if (this.headerConflicts.has(tab)) throw this.conflictError(tab);
  }

  private markConflict(tab: string, problem: string): void {
    if (!this.headerConflicts.has(tab)) {
      console.warn(`${this.opts.label}: 「${tab}」タブのヘッダー行が想定と異なります（${problem}）。自動修正はしません`);
    }
    this.headerConflicts.set(tab, problem);
    this.layouts.delete(tab);
    this.tabCache.delete(tab);
  }

  private conflictProblem(tab: string, plan: HeaderPlan): string {
    if (plan.kind !== 'conflict') return '実行中に見出しが消されました';
    if (plan.reason === 'blankFirst') return 'A列の見出しが空です。先頭に列を挿入した場合は見出しを入れてください';
    return `「${this.columns(tab)[plan.index]}」列の見出しが${plan.reason === 'duplicate' ? '2つあります' : '見つかりません'}`;
  }

  // バッチ開始時に呼ぶ（前回実行の状態を持ち越さない）
  reset(): void {
    this.tabCache.clear();
    this.tabLoading.clear();
    this.tabsEnsured = null;
    this.headerConflicts.clear();
    this.layouts.clear();
    this.sheetIds.clear();
    this.warnedDuplicates.clear();
    this.created.clear();
    this.totalCells = 0;
  }

  // 次の読み出しでタブ全体を読み直す
  invalidate(tab: string): void {
    this.tabCache.delete(tab);
  }

  // タブとヘッダー行を必要に応じて自動生成・追記する（プロセス内で初回のみ実行）
  ensureTabs(): Promise<void> {
    this.tabsEnsured ??= this.ensureTabsOnce(0).catch((err) => {
      this.tabsEnsured = null; // 失敗時は次回呼び出しで再試行
      throw err;
    });
    return this.tabsEnsured;
  }

  private async ensureTabsOnce(attempt: number): Promise<void> {
    const sheetsApi = this.api();
    const spreadsheetId = this.id();
    const label = this.opts.label;
    let meta: sheets_v4.Schema$Spreadsheet;
    try {
      meta = (
        await throttle(() =>
          sheetsApi.spreadsheets.get({
            spreadsheetId,
            fields:
              'sheets.properties(title,sheetId,gridProperties(rowCount,columnCount)),' +
              'sheets.protectedRanges(protectedRangeId,range(sheetId,startRowIndex,endRowIndex,startColumnIndex,endColumnIndex),' +
              'warningOnly,editors(users,groups,domainUsersCanEdit))',
          }),
        )
      ).data;
    } catch (err) {
      throw new SafeLogError(`${label}: スプレッドシートにアクセスできません。${this.opts.accessHint}（${safeErr(err)}）`);
    }
    const gridColumns = new Map<string, number>();
    this.totalCells = 0;
    for (const sh of meta.sheets ?? []) {
      const p = sh.properties;
      if (!p?.title) continue;
      if (typeof p.sheetId === 'number') this.sheetIds.set(p.title, p.sheetId);
      const cols = p.gridProperties?.columnCount ?? 0;
      gridColumns.set(p.title, cols);
      this.totalCells += (p.gridProperties?.rowCount ?? 0) * cols;
    }
    this.headerConflicts.clear();
    this.layouts.clear();
    const tabNames = this.tabNames();
    const missing = tabNames.filter((t) => !gridColumns.has(t));
    const present = tabNames.filter((t) => gridColumns.has(t));
    const headerWrites: sheets_v4.Schema$ValueRange[] = [];
    const now = Date.now();

    const created: string[] = [];
    if (missing.length > 0) {
      let res: { data: sheets_v4.Schema$BatchUpdateSpreadsheetResponse };
      try {
        res = await throttle(
          () =>
            sheetsApi.spreadsheets.batchUpdate({
              spreadsheetId,
              requestBody: {
                requests: missing.map((title) => ({
                  addSheet: {
                    properties: { title, gridProperties: { rowCount: NEW_TAB_ROWS, columnCount: this.columns(title).length } },
                  },
                })),
              },
            }),
          false,
        );
      } catch (err) {
        // タブの作成は冪等でない（作成済みのタブをもう一度作ると 400 で失敗する）。処理されたか分からない失敗の後は
        // 同じ要求を再送せず、タブの一覧を読み直してから続ける（作成されていれば空のタブとして見出しを書き込む）
        if (!googleTransientKind(err) || attempt >= RETRY_DELAYS_MS.length) throw err;
        await sleep(testApi ? 0 : RETRY_DELAYS_MS[attempt]);
        return this.ensureTabsOnce(attempt + 1);
      }
      created.push(...missing);
      missing.forEach((title, i) => {
        const sheetId = res.data.replies?.[i]?.addSheet?.properties?.sheetId;
        if (typeof sheetId === 'number') this.sheetIds.set(title, sheetId);
        headerWrites.push({ range: `${quoteTab(title)}!A1`, values: [this.columns(title)] });
        this.layouts.set(title, { header: [...this.columns(title)], defToLive: this.columns(title).map((_, j) => j), checkedAt: now });
        this.totalCells += NEW_TAB_ROWS * this.columns(title).length;
      });
    }

    if (present.length > 0) {
      const res = await throttle(() =>
        sheetsApi.spreadsheets.values.batchGet({ spreadsheetId, ranges: present.map((t) => `${quoteTab(t)}!1:1`) }),
      );
      const ranges = res.data.valueRanges ?? [];
      const widen: sheets_v4.Schema$Request[] = [];
      const appends: Array<{ tab: string; header: string[]; plan: Extract<HeaderPlan, { kind: 'append' }> }> = [];
      present.forEach((tab, i) => {
        const header = trimHeader(ranges[i]?.values?.[0] ?? []);
        const plan = planHeaderMigration(header, this.columns(tab));
        if (plan.kind === 'conflict') {
          this.markConflict(tab, this.conflictProblem(tab, plan));
          return;
        }
        if (plan.kind === 'ok') {
          this.layouts.set(tab, { header, defToLive: plan.defToLive, checkedAt: now });
          return;
        }
        appends.push({ tab, header, plan });
      });
      // 見出しを足す列（見出しが空のタブは全体）に2行目以降の値が既にあれば、その値を新しい列の値として読み違えるため
      // 自動で見出しを書かない（見出しの無いメモ列の上に「突合済」等を足すと、メモのある行がすべて突合済みになる）
      const occupied = await this.occupiedAppendTargets(appends, gridColumns);
      for (const { tab, header, plan } of appends) {
        if (occupied.has(tab)) {
          this.markConflict(
            tab,
            header.length === 0
              ? '見出し行が空ですが2行目以降に値があります。見出しを入れ直してください'
              : `見出しの無い列（${columnLetter(plan.fromIndex)}列〜）に値があるため「${plan.cells.join('」「')}」列を追加できません。` +
                  'その列に見出しを付けるか、値を別の場所へ移してください',
          );
          continue;
        }
        headerWrites.push({ range: `${quoteTab(tab)}!${columnLetter(plan.fromIndex)}1`, values: [plan.cells] });
        if (header.length === 0) created.push(tab); // 空のタブ（前回の作成の応答が失われた等）は新規と同じ扱い
        if (plan.fromIndex > 0) console.log(`${label}: 「${tab}」タブに列を追加します（${plan.cells.join(', ')}）`);
        // 見出しの右端がシートの列数いっぱいなら、書き込む前に列を足す（範囲外への書き込みはAPIが拒否する）
        const needed = plan.fromIndex + plan.cells.length;
        const have = gridColumns.get(tab) ?? 0;
        const sheetId = this.sheetIds.get(tab);
        if (needed > have && sheetId !== undefined) {
          widen.push({ appendDimension: { sheetId, dimension: 'COLUMNS', length: needed - have } });
        }
        const newHeader = [...header];
        plan.cells.forEach((c, j) => (newHeader[plan.fromIndex + j] = c));
        this.layouts.set(tab, { header: newHeader.map((h) => h ?? ''), defToLive: plan.defToLive, checkedAt: now });
      }
      if (widen.length > 0) {
        await throttle(() => sheetsApi.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: widen } }));
      }
    }

    if (headerWrites.length > 0) {
      await throttle(() =>
        sheetsApi.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: { valueInputOption: 'RAW', data: headerWrites },
        }),
      );
    }
    await this.addDropdowns(created);
    this.created.clear();
    created.forEach((t) => this.created.add(t));
    if (created.length > 0) console.log(`${label}: タブを自動生成しました（${created.join(', ')}）`);
    await this.protectTabs(meta);
  }

  // 保護するタブ（protectedTabs）のうち、バッチの保護（タブ全体・警告だけではない・編集者がバッチのアカウントと
  // スプレッドシートのオーナーだけ）が無いものに保護を付ける。付けられなかったタブは unprotectedTabs() で分かる
  // （呼び出し側がそのタブの内容を信用しない・警告する）。編集者が先に同じ名前のタブを作って自分を編集者にした保護・
  // 警告だけの保護は、バッチの保護とみなさない（その人が控えの行を消せるため）
  private async protectTabs(meta: sheets_v4.Schema$Spreadsheet): Promise<void> {
    const wanted = Object.entries(this.opts.protectedTabs ?? {});
    this.unprotected.clear();
    if (wanted.length === 0) return;
    const editor = this.opts.protectionEditor?.() ?? '';
    const whole = new Set<number>();
    // バッチのアカウントが分からない（ADC で SES_GOOGLE_SA_EMAIL が未設定）ときは、APIが編集者に加えて返す依頼元・オーナーの
    // 2人の保護がバッチのものか見分けられない。保護を重ねず（実行のたびに増やさない）、保護できていないタブとして扱う
    const unverifiable = new Set<number>();
    for (const sh of meta.sheets ?? []) {
      for (const pr of sh.protectedRanges ?? []) {
        const r = pr.range;
        if (r && typeof r.sheetId === 'number' && r.startRowIndex == null && r.endRowIndex == null && r.startColumnIndex == null && r.endColumnIndex == null) {
          if (isBatchProtection(pr, editor)) whole.add(r.sheetId);
          else if (!editor && isBatchProtection(pr, (pr.editors?.users ?? [])[0] ?? '')) unverifiable.add(r.sheetId);
        }
      }
    }
    const requests: sheets_v4.Schema$Request[] = [];
    const targets: string[] = [];
    for (const [tab, description] of wanted) {
      const sheetId = this.sheetIds.get(tab);
      if (sheetId === undefined) {
        this.unprotected.add(tab);
        continue;
      }
      if (whole.has(sheetId)) continue;
      if (unverifiable.has(sheetId)) {
        this.unprotected.add(tab);
        continue;
      }
      targets.push(tab);
      requests.push({
        addProtectedRange: {
          protectedRange: {
            range: { sheetId },
            description,
            warningOnly: false,
            editors: { users: editor ? [editor] : [], domainUsersCanEdit: false },
          },
        },
      });
    }
    if (requests.length === 0) return;
    try {
      await throttle(() => this.api().spreadsheets.batchUpdate({ spreadsheetId: this.id(), requestBody: { requests } }));
      console.log(`${this.opts.label}: 「${targets.join('」「')}」タブを保護しました（バッチ専用。人は編集できません）`);
    } catch (err) {
      targets.forEach((t) => this.unprotected.add(t));
      console.warn(`${this.opts.label}: 「${targets.join('」「')}」タブを保護できませんでした: ${safeErr(err)}`);
    }
  }

  // 直近のタブ確認で新しく作った（または見出しの無い空のタブだった）タブ
  createdTabs(): string[] {
    return [...this.created];
  }

  // 保護するタブのうち、保護を確かめられなかったもの（直近のタブ確認時点）
  unprotectedTabs(): string[] {
    return [...this.unprotected];
  }

  // 新規作成したタブの指定列に選択肢のプルダウンを付ける（人の入力ゆれで判定を外さないため。失敗しても続行）
  private async addDropdowns(created: string[]): Promise<void> {
    const requests: sheets_v4.Schema$Request[] = [];
    created.forEach((tab) => {
      const sheetId = this.sheetIds.get(tab);
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

  // 見出しを追記しようとしている列（見出しが空のタブは全体）の2行目以降に値があるタブ
  private async occupiedAppendTargets(
    appends: Array<{ tab: string; header: string[]; plan: Extract<HeaderPlan, { kind: 'append' }> }>,
    gridColumns: Map<string, number>,
  ): Promise<Set<string>> {
    const out = new Set<string>();
    if (appends.length === 0) return out;
    const have = (tab: string) => gridColumns.get(tab) ?? 0;
    // シートの列数より右は値を持てない（読む範囲がシートの外になると API が拒否するため除く）
    const targets = appends
      .map(({ tab, header, plan }) => {
        const from = header.length === 0 ? 0 : plan.fromIndex;
        const to = Math.min(header.length === 0 ? Math.max(have(tab), plan.cells.length) : plan.fromIndex + plan.cells.length, have(tab)) - 1;
        return { tab, from, to };
      })
      .filter((t) => t.to >= t.from);
    if (targets.length === 0) return out;
    const res = await throttle(() =>
      this.api().spreadsheets.values.batchGet({
        spreadsheetId: this.id(),
        ranges: targets.map((t) => `${quoteTab(t.tab)}!${columnLetter(t.from)}2:${columnLetter(t.to)}`),
      }),
    );
    const ranges = res.data.valueRanges ?? [];
    targets.forEach((t, i) => {
      const rows = ranges[i]?.values ?? [];
      if (rows.some((r) => (r ?? []).some((v) => String(v ?? '').trim() !== ''))) out.add(t.tab);
    });
    return out;
  }

  // 見出し行から列の対応を作り直す。定義の列を特定できなければ以後このタブへの読み書きを止める
  private applyHeader(tab: string, headerCells: unknown[]): TabLayout {
    const header = trimHeader(headerCells);
    const plan = planHeaderMigration(header, this.columns(tab));
    if (plan.kind !== 'ok') {
      this.markConflict(tab, this.conflictProblem(tab, plan));
      throw this.conflictError(tab);
    }
    const layout: TabLayout = { header, defToLive: plan.defToLive, checkedAt: Date.now() };
    this.layouts.set(tab, layout);
    return layout;
  }

  // 書き込みに使う列の対応。一定時間たっていれば見出しを読み直す（長時間動くプロセスで人が列を挿入した場合に備える）
  private async layout(tab: string): Promise<TabLayout> {
    await this.ensureTabs();
    this.assertHeaderMatches(tab);
    const known = this.layouts.get(tab);
    if (known && Date.now() - known.checkedAt < CACHE_TTL_MS) return known;
    const res = await throttle(() => this.api().spreadsheets.values.get({ spreadsheetId: this.id(), range: `${quoteTab(tab)}!1:1` }));
    const layout = this.applyHeader(tab, (res.data.values?.[0] ?? []) as unknown[]);
    if (!known || !sameHeader(known.header, layout.header)) this.tabCache.delete(tab); // 行キャッシュの列位置が古い
    return layout;
  }

  private toCachedRow(layout: TabLayout, rowNumber: number, live: unknown[]): CachedRow {
    const raw = normalizeCells(live, layout.header.length);
    return { rowNumber, raw, cells: layout.defToLive.map((c) => raw[c] ?? '') };
  }

  // ===== タブ単位の行キャッシュ =====
  // 保存のたびにタブ全体を読み直すとAPI呼び出しが O(n^2) になるため、プロセス内で行をキャッシュし
  // 追記・更新時に同期する。人の手編集（並べ替え・行削除・列の挿入）とのズレは、更新直前に見出しと対象行を
  // 読み直して検証し、ずれていればタブを読み直すことで防ぐ（別の行・列の上書き事故を避ける）。

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
    this.assertHeaderMatches(tab);
    const res = await throttle(() =>
      this.api().spreadsheets.values.get({ spreadsheetId: this.id(), range: quoteTab(tab), ...DATA_READ }),
    );
    const values = (res.data.values ?? []) as unknown[][];
    const layout = this.applyHeader(tab, values[0] ?? []);
    const rows = values
      .slice(1)
      .map((cells, i) => this.toCachedRow(layout, i + 2, cells ?? []))
      .filter((r) => r.cells.some((c) => c.trim() !== '')); // 途中の空行は読み飛ばす（行番号は保持）
    const cache: TabCache = { rows, loadedAt: Date.now(), indexes: new Map() };
    this.tabCache.set(tab, cache);
    return cache;
  }

  // タブの全データ行（ヘッダー除く）。呼び出し側が並べ替え等をしてもキャッシュが壊れないようコピーを返す
  async readRows(tab: string): Promise<CachedRow[]> {
    return (await this.loadTab(tab)).rows.slice();
  }

  private indexFor(tab: string, cache: TabCache, col: number): Map<string, CachedRow> {
    let idx = cache.indexes.get(col);
    if (!idx) {
      idx = new Map();
      let duplicates = 0;
      for (const r of cache.rows) {
        const key = (r.cells[col] ?? '').trim();
        if (!key) continue;
        if (idx.has(key)) duplicates += 1;
        else idx.set(key, r);
      }
      cache.indexes.set(col, idx);
      if (duplicates > 0 && col === 0 && !this.warnedDuplicates.has(tab)) {
        this.warnedDuplicates.add(tab);
        console.warn(
          `${this.opts.label}: 「${tab}」タブに「${this.columns(tab)[col]}」が重複した行が${duplicates}件あります（更新は先頭の行に対して行います。複製した行は削除してください）`,
        );
      }
    }
    return idx;
  }

  // キー列で行を探す（キャッシュから。位置の検証はしない）
  async findRow(tab: string, colName: string, key: string): Promise<CachedRow | null> {
    const k = key.trim(); // 索引側もトリム済み
    if (!k) return null;
    const cache = await this.loadTab(tab);
    return this.indexFor(tab, cache, this.colIndex(tab, colName)).get(k) ?? null;
  }

  // キー列が一致するすべての行（人が行を複製した場合に、依頼の入った方の行を探すため）
  async findRows(tab: string, colName: string, key: string): Promise<CachedRow[]> {
    const k = key.trim();
    if (!k) return [];
    const col = this.colIndex(tab, colName);
    return (await this.loadTab(tab)).rows.filter((r) => (r.cells[col] ?? '').trim() === k);
  }

  async appendRows(tab: string, rows: Cell[][]): Promise<void> {
    if (rows.length === 0) return;
    const layout = await this.layout(tab);
    const width = Math.max(...layout.defToLive) + 1;
    const liveRows = rows.map((row) => {
      const out: Array<string | number> = new Array(width).fill('');
      toCells(row).forEach((v, i) => (out[layout.defToLive[i]] = v));
      return out;
    });
    const updatedRange = await this.appendIdempotent(tab, liveRows);
    const cache = this.tabCache.get(tab);
    if (!cache) return; // 未読込なら次回の読込で取り込まれる
    const first = updatedRange === null ? null : firstRowOf(updatedRange);
    if (first === null) {
      this.tabCache.delete(tab); // 位置が分からなければ次回読み直す
      return;
    }
    liveRows.forEach((live, i) => {
      const cached = this.toCachedRow(layout, first + i, live);
      cache.rows.push(cached);
      for (const [col, idx] of cache.indexes) {
        const key = (cached.cells[col] ?? '').trim();
        if (key && !idx.has(key)) idx.set(key, cached);
      }
    });
  }

  // 追記は冪等でないため、処理されたか分からない失敗（5xx・通信断）の後は、同じ行が既に書けていないかを
  // 読み直して確かめてから再送する（二重の行を作らない）。書けていた場合は null（行番号は不明）
  private async appendIdempotent(tab: string, liveRows: Array<Array<string | number>>): Promise<string | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await throttle(
          () =>
            this.api().spreadsheets.values.append({
              spreadsheetId: this.id(),
              range: `${quoteTab(tab)}!A1`,
              valueInputOption: 'RAW',
              insertDataOption: 'INSERT_ROWS',
              requestBody: { values: liveRows },
            }),
          false,
        );
        return res.data.updates?.updatedRange ?? '';
      } catch (err) {
        const kind = googleTransientKind(err);
        if (!kind || attempt >= RETRY_DELAYS_MS.length) throw err;
        await sleep(testApi ? 0 : RETRY_DELAYS_MS[attempt]);
        if (kind === 'ambiguous' && (await this.rowsPresent(tab, liveRows))) return null;
      }
    }
  }

  private async rowsPresent(tab: string, liveRows: Array<Array<string | number>>): Promise<boolean> {
    this.tabCache.delete(tab);
    const cache = await this.loadTab(tab);
    const layout = this.layouts.get(tab);
    if (!layout) return false;
    const keyOf = (cells: string[]) => cells.map((c) => c.trim()).join('\u0001');
    const existing = new Set(cache.rows.map((r) => keyOf(r.cells)));
    return liveRows.every((live) => existing.has(keyOf(this.toCachedRow(layout, 0, live).cells)));
  }

  // キャッシュ上の行が今もシート上の同じ位置にあるか（と見出しが変わっていないか）を、見出しとその行を1回で読んで確かめる。
  // 同じ位置なら読んだ最新値でキャッシュを更新する（実行中に人が入力した担当者メール・ステータス等を
  // 古いキャッシュで上書きしないため）
  private async refreshRowAt(tab: string, row: CachedRow, colName: string, key: string): Promise<'ok' | 'moved' | 'layout'> {
    const layout = this.layouts.get(tab);
    if (!layout) return 'layout';
    const width = Math.max(layout.header.length, row.raw.length, 1);
    const q = quoteTab(tab);
    const res = await throttle(() =>
      this.api().spreadsheets.values.batchGet({
        spreadsheetId: this.id(),
        ranges: [`${q}!1:1`, `${q}!A${row.rowNumber}:${columnLetter(width - 1)}${row.rowNumber}`],
        ...DATA_READ,
      }),
    );
    const ranges = res.data.valueRanges ?? [];
    if (!sameHeader((ranges[0]?.values?.[0] ?? []) as string[], layout.header)) return 'layout';
    const fresh = this.toCachedRow(layout, row.rowNumber, (ranges[1]?.values?.[0] ?? []) as unknown[]);
    if (fresh.cells[this.colIndex(tab, colName)].trim() !== key.trim()) return 'moved';
    if (fresh.raw.some((c, i) => c !== (row.raw[i] ?? ''))) {
      row.cells = fresh.cells;
      row.raw = fresh.raw;
      this.tabCache.get(tab)?.indexes.clear(); // キー以外の列の値も変わり得るため索引は次回参照時に作り直す
    }
    layout.checkedAt = Date.now();
    return 'ok';
  }

  // キー列で行を探し、位置を検証（＋最新値へ更新）してから返す。ずれていればタブを読み直して探し直す
  async locateRow(tab: string, colName: string, key: string): Promise<CachedRow | null> {
    const hit = await this.findRow(tab, colName, key);
    if (!hit || (await this.refreshRowAt(tab, hit, colName, key)) === 'ok') return hit;
    this.tabCache.delete(tab);
    return this.findRow(tab, colName, key);
  }

  // 指定の行番号の行が今もそのキーの行か確かめて返す（同じキーの行が複数あるときに、一覧で見つけた行そのものを扱うため）。
  // ずれていれば null
  async rowAt(tab: string, rowNumber: number, colName: string, key: string): Promise<CachedRow | null> {
    const cache = await this.loadTab(tab);
    const hit = cache.rows.find((r) => r.rowNumber === rowNumber);
    if (!hit || (hit.cells[this.colIndex(tab, colName)] ?? '').trim() !== key.trim()) return null;
    return (await this.refreshRowAt(tab, hit, colName, key)) === 'ok' ? hit : null;
  }

  // 定義の列の値だけを書き込む（人のメモ列は触らない）。定義の列が連続していれば1範囲、途中に人の列があれば分けて書く
  async writeRow(tab: string, target: CachedRow, row: Cell[]): Promise<void> {
    const layout = await this.layout(tab);
    const entries = toCells(row).map((v, i) => [layout.defToLive[i], v] as [number, string | number]);
    const runs = contiguousRuns(entries);
    const q = quoteTab(tab);
    if (runs.length === 1) {
      await throttle(() =>
        this.api().spreadsheets.values.update({
          spreadsheetId: this.id(),
          range: `${q}!${columnLetter(runs[0].start)}${target.rowNumber}`,
          valueInputOption: 'RAW',
          requestBody: { values: [runs[0].values] },
        }),
      );
    } else {
      await throttle(() =>
        this.api().spreadsheets.values.batchUpdate({
          spreadsheetId: this.id(),
          requestBody: {
            valueInputOption: 'RAW',
            data: runs.map((r) => ({ range: `${q}!${columnLetter(r.start)}${target.rowNumber}`, values: [r.values] })),
          },
        }),
      );
    }
    for (const [col, value] of entries) target.raw[col] = String(value);
    target.cells = layout.defToLive.map((c) => target.raw[c] ?? '');
    this.tabCache.get(tab)?.indexes.clear(); // キー値が変わり得るため索引は次回参照時に作り直す
  }

  // 行の指定列だけを書き込む（人が編集する他の列と競合させないため。存在しない列名は無視）
  async writeCells(tab: string, target: CachedRow, updates: Array<[string, Cell]>): Promise<void> {
    await this.writeCellsMany(tab, [{ target, updates }]);
  }

  private async writeCellsMany(tab: string, items: Array<{ target: CachedRow; updates: Array<[string, Cell]> }>): Promise<void> {
    const layout = await this.layout(tab);
    const q = quoteTab(tab);
    const data: sheets_v4.Schema$ValueRange[] = [];
    const applied: Array<{ target: CachedRow; col: number; live: number; value: string }> = [];
    for (const { target, updates } of items) {
      for (const [name, value] of updates) {
        const col = this.colIndex(tab, name);
        if (col < 0) continue;
        const live = layout.defToLive[col];
        const v = value === null ? '' : value;
        data.push({ range: `${q}!${columnLetter(live)}${target.rowNumber}`, values: [[v]] });
        applied.push({ target, col, live, value: String(v) });
      }
    }
    for (let i = 0; i < data.length; i += CELL_WRITE_CHUNK) {
      const chunk = data.slice(i, i + CELL_WRITE_CHUNK);
      await throttle(() =>
        this.api().spreadsheets.values.batchUpdate({
          spreadsheetId: this.id(),
          requestBody: { valueInputOption: 'RAW', data: chunk },
        }),
      );
    }
    for (const a of applied) {
      a.target.cells[a.col] = a.value;
      a.target.raw[a.live] = a.value;
    }
    this.tabCache.get(tab)?.indexes.clear();
  }

  // キー列で見つけた複数の行の指定列をまとめて書き込む（行ごとに位置を確かめる読み出しを省き、大量の行の印付けを
  // 少ない呼び出しで済ませる）。書き込んだ行数を返す（見つからないキーは飛ばす）
  async writeCellsByKey(tab: string, keyCol: string, updates: Array<{ key: string; cells: Array<[string, Cell]> }>): Promise<number> {
    if (updates.length === 0) return 0;
    const cache = await this.keyVerifiedCache(tab, keyCol);
    const idx = this.indexFor(tab, cache, this.colIndex(tab, keyCol));
    const items: Array<{ target: CachedRow; updates: Array<[string, Cell]> }> = [];
    for (const u of updates) {
      const target = idx.get(u.key.trim());
      if (target) items.push({ target, updates: u.cells });
    }
    await this.writeCellsMany(tab, items);
    return items.length;
  }

  // キー列で行を特定するための行キャッシュ。キャッシュがあれば見出しとキー列だけを読み直し、どの行も同じ位置にあれば
  // そのまま使う（大きなタブを毎回すべて読み直さない）。人の並べ替え・行の挿入・削除・列の挿入でずれていればタブを読み直す
  private async keyVerifiedCache(tab: string, keyCol: string): Promise<TabCache> {
    const cached = this.tabCache.get(tab);
    const layout = this.layouts.get(tab);
    const col = this.colIndex(tab, keyCol);
    if (cached && layout && col >= 0) {
      await this.ensureTabs();
      this.assertHeaderMatches(tab);
      const q = quoteTab(tab);
      const letter = columnLetter(layout.defToLive[col]);
      const res = await throttle(() =>
        this.api().spreadsheets.values.batchGet({ spreadsheetId: this.id(), ranges: [`${q}!1:1`, `${q}!${letter}:${letter}`], ...DATA_READ }),
      );
      const ranges = res.data.valueRanges ?? [];
      if (sameHeader((ranges[0]?.values?.[0] ?? []) as string[], layout.header)) {
        const live = (ranges[1]?.values ?? []).map((r) => String((r as unknown[] | undefined)?.[0] ?? '').trim());
        const keyed = cached.rows.filter((r) => (r.cells[col] ?? '').trim() !== '');
        const liveKeys = live.slice(1).filter(Boolean).length;
        const inPlace = keyed.every((r) => live[r.rowNumber - 1] === (r.cells[col] ?? '').trim());
        if (inPlace && liveKeys === keyed.length) return cached;
      }
    }
    this.tabCache.delete(tab);
    return this.loadTab(tab);
  }

  // 条件に合う行を削除する（消す直前に読み直した行番号で。下の行から消すので番号はずれない）。削除した行数を返す。
  // 削除は冪等でない（同じ行番号の再送は、繰り上がった別の行を消す）ため自動では再送しない。処理されたか分からない
  // 失敗の後は読み直し、まだ残っている対象の行だけを選び直して消す
  async deleteRowsWhere(tab: string, match: (row: CachedRow) => boolean): Promise<number> {
    let initial: number | null = null;
    for (let attempt = 0; ; attempt++) {
      this.tabCache.delete(tab);
      const targets = (await this.readRows(tab)).filter(match).map((r) => r.rowNumber);
      initial ??= targets.length;
      const sheetId = this.sheetIds.get(tab);
      if (targets.length === 0 || sheetId === undefined) return initial - targets.length;
      try {
        await throttle(
          () =>
            this.api().spreadsheets.batchUpdate({
              spreadsheetId: this.id(),
              requestBody: {
                requests: rowRangesDescending(targets).map((r) => ({
                  deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: r.start - 1, endIndex: r.end - 1 } },
                })),
              },
            }),
          false,
        );
        this.tabCache.delete(tab);
        return initial;
      } catch (err) {
        this.tabCache.delete(tab);
        if (!googleTransientKind(err) || attempt >= RETRY_DELAYS_MS.length) throw err;
        await sleep(testApi ? 0 : RETRY_DELAYS_MS[attempt]);
      }
    }
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

// 行番号（2以上）を、下の行から消すための連続した範囲 [start, end) にまとめる
function rowRangesDescending(rowNumbers: number[]): Array<{ start: number; end: number }> {
  const sorted = [...new Set(rowNumbers)].filter((n) => n >= 2).sort((a, b) => b - a);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const n of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && last.start === n + 1) last.start = n;
    else ranges.push({ start: n, end: n + 1 });
  }
  return ranges;
}

// 行の値が既存セルと同じか（同じなら書き込みを省く。数値は文字列化して比べる）
export function sameCells(row: Cell[], existing: string[]): boolean {
  return row.every((v, i) => String(v ?? '') === (existing[i] ?? ''));
}
