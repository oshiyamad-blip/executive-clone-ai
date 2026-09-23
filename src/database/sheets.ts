// Googleスプレッドシート版のSESデータ保存層（DB_PROVIDER=sheets）。
// 1つのスプレッドシートにデータ6タブ（案件/要員/マッチ/自社社員/評価/スキル同義）と
// バッチ横断の状態2タブ（処理済みメール/_状態）を持ち、タブとヘッダー行は初回アクセス時に自動生成する。
// 認証は既定でサービスアカウント自身（シートをSAのメールアドレスに編集者として共有するだけでよい）。
// SHEETS_DB_IMPERSONATE 指定時のみDWDでそのユーザーになりすます。
// 設定不足時は warn して縮退（保存スキップ/空配列）— Notion版と同じ振る舞い。
import { google, type sheets_v4 } from 'googleapis';
import { getServiceAccountAuth } from '../collectors/googleAuth.js';
import { sheetsDbSpreadsheetId, sheetsDbImpersonate } from '../ses/config.js';
import { normalizeSkills } from '../ses/skillDict.js';
import { normalizePrefecture } from '../ses/prefecture.js';
import { safeErr, SafeLogError } from '../ses/redact.js';
import {
  remoteLabel,
  labelToRemote,
  matchStatusLabel,
  FB_VERDICT_LABEL,
  replyMetaJson,
  parseReplyMeta,
  joinList,
  splitList,
  mergeDraftColumns,
  type DraftColumns,
} from './mapping.js';
import type {
  Project,
  Engineer,
  MatchResult,
  MatchStatus,
  OwnEngineer,
  MatchFeedback,
  SkillEquivalence,
} from '../types/index.js';

// 書き込みはユーザーあたり60リクエスト/分のクォータがあるため、全呼び出しを直列化して間隔を空ける
const MIN_INTERVAL_MS = 1100;
let lastCall = Promise.resolve();

async function throttle<T>(fn: () => Promise<T>): Promise<T> {
  const prev = lastCall;
  let release: () => void = () => {};
  lastCall = new Promise<void>((res) => (release = res));
  await prev;
  try {
    return await withRetry(fn);
  } finally {
    setTimeout(release, MIN_INTERVAL_MS);
  }
}

// クォータ超過(429)・一時障害(5xx)のみ待って再試行する（権限不足等の恒久エラーは即失敗）
const RETRY_DELAYS_MS = [2000, 8000, 30000];

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
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

const SHEETS_RW_SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

let _api: sheets_v4.Sheets | null = null;
function api(): sheets_v4.Sheets | null {
  if (_api) return _api;
  const auth = getServiceAccountAuth(SHEETS_RW_SCOPES, sheetsDbImpersonate() || undefined);
  if (!auth) return null;
  _api = google.sheets({ version: 'v4', auth });
  return _api;
}

let warnedUnconfigured = false;

function configured(): boolean {
  const reason = !sheetsDbSpreadsheetId()
    ? 'SHEETS_DB_SPREADSHEET_ID が未設定'
    : !api()
      ? 'Google認証（GOOGLE_SA_KEY_JSON または GOOGLE_SA_CLIENT_EMAIL/GOOGLE_SA_PRIVATE_KEY）が未設定'
      : '';
  if (!reason) return true;
  if (!warnedUnconfigured) {
    warnedUnconfigured = true;
    console.warn(`SheetsDB: ${reason} — 保存・読出をスキップします`);
  }
  return false;
}

// 設定が揃っているか（処理済みID等の状態保存先の判定用。未設定時の警告は初回のみ）
export function sheetsDbConfigured(): boolean {
  return configured();
}

// 担当者メール列による下書き依頼の列。これを全て持つタブは materializePendingDrafts の対象になる
// （担当者が送信元アドレスを入れると、次回バッチがそのアドレスで全員に返信の下書きを作成し状態列に結果を書く）
export const DRAFT_REQUEST_COLUMNS = [
  '担当者メール', '案件側下書き状態', '要員側下書き状態', '案件側文面', '要員側文面', '下書きデータ',
];

// タブ定義（列順は保存・読出の両方が依存する。列の追加は末尾のみ＝既存シートは ensureTabs が自動で追記する）
const TABS: Record<string, string[]> = {
  案件: [
    'ID', '案件名', '必須スキル', '尚可スキル', '単金下限', '単金上限', '勤務地', 'リモート',
    '開始時期', '開始日', '期間', '商流メモ', '営業元会社', '営業元担当', '営業元メール',
    '元メールID', '返信メタ', '受信日', 'ステータス',
  ],
  要員: [
    'ID', '表示名', 'スキル', '経験年数', '希望単金', '居住地', 'リモート希望', '稼働開始可能日',
    '営業元会社', '営業元担当', '営業元メール', '元メールID', '返信メタ', '受信日', 'ステータス',
  ],
  マッチ: [
    'ID', 'マッチ名', '粗利額', '適合スコア', '判定根拠', '案件ID', '要員ID',
    '案件側下書きURL', '要員側下書きURL', 'ステータス', '検出日時', ...DRAFT_REQUEST_COLUMNS,
  ],
  自社社員: ['ID', '表示名', 'スキル', '経験年数', '必要案件単価', '居住地', 'リモート希望', '稼働可能日', 'ステータス'],
  評価: ['日時', '元マッチID', 'マッチ名', '評価', 'メモ', '評価者', 'バンド'],
  スキル同義: ['スキルA', 'スキルB', '追加者', '日時'],
  処理済みメール: ['メールID', '処理日時', '結果'],
  _状態: ['キー', 'JSON', '更新日時'],
};

type Cell = string | number | null;

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

// 並行に初回アクセスされてもタブを二重作成しないよう、実行中の Promise を共有する
let tabsEnsured: Promise<void> | null = null;
// ヘッダー行が定義と食い違うタブ（列の意味を取り違えるため、下書き依頼の読み取り対象から外す）
const headerConflicts = new Set<string>();

// タブとヘッダー行を必要に応じて自動生成・追記する（プロセス内で初回のみ実行）
function ensureTabs(): Promise<void> {
  tabsEnsured ??= ensureTabsOnce().catch((err) => {
    tabsEnsured = null; // 失敗時は次回呼び出しで再試行
    throw err;
  });
  return tabsEnsured;
}

async function ensureTabsOnce(): Promise<void> {
  const sheetsApi = api()!;
  const spreadsheetId = sheetsDbSpreadsheetId();
  let meta: sheets_v4.Schema$Spreadsheet;
  try {
    meta = (await throttle(() => sheetsApi.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' }))).data;
  } catch (err) {
    throw new SafeLogError(
      `SheetsDB: スプレッドシートにアクセスできません。IDが正しいか、サービスアカウントのメールアドレスに` +
        `編集者として共有済みかを確認してください（${safeErr(err)}）`,
    );
  }
  const existing = new Set((meta.sheets ?? []).map((sh) => sh.properties?.title ?? ''));
  headerConflicts.clear();
  const tabNames = Object.keys(TABS);
  const missing = tabNames.filter((t) => !existing.has(t));
  const present = tabNames.filter((t) => existing.has(t));
  const headerWrites: sheets_v4.Schema$ValueRange[] = [];

  if (missing.length > 0) {
    await throttle(() =>
      sheetsApi.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) },
      }),
    );
    for (const title of missing) headerWrites.push({ range: `${quoteTab(title)}!A1`, values: [TABS[title]] });
  }

  if (present.length > 0) {
    const res = await throttle(() =>
      sheetsApi.spreadsheets.values.batchGet({ spreadsheetId, ranges: present.map((t) => `${quoteTab(t)}!1:1`) }),
    );
    const ranges = res.data.valueRanges ?? [];
    present.forEach((tab, i) => {
      const header = (ranges[i]?.values?.[0] ?? []).map((c) => String(c ?? '').trim());
      const plan = planHeaderMigration(header, TABS[tab]);
      if (plan.kind === 'append') {
        headerWrites.push({ range: `${quoteTab(tab)}!${columnLetter(plan.fromIndex)}1`, values: [plan.cells] });
        if (plan.fromIndex > 0) console.log(`SheetsDB: 「${tab}」タブに列を追加します（${plan.cells.join(', ')}）`);
      } else if (plan.kind === 'conflict') {
        headerConflicts.add(tab);
        console.warn(
          `SheetsDB: 「${tab}」タブのヘッダー行が想定と異なります（${columnLetter(plan.index)}列: 「${TABS[tab][plan.index]}」を想定）。` +
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
  if (missing.length > 0) console.log(`SheetsDB: タブを自動生成しました（${missing.join(', ')}）`);
}

// ===== タブ単位の行キャッシュ =====
// 保存のたびにタブ全体を読み直すとAPI呼び出しが O(n^2) になるため、プロセス内で行をキャッシュし
// 追記・更新時に同期する。人の手編集（並べ替え・行削除）とのズレは、更新直前にキー列を1セルだけ
// 読んで検証し、ずれていれば読み直すことで防ぐ（別行の上書き事故を避ける）。
interface CachedRow {
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
const tabCache = new Map<string, TabCache>();
const tabLoading = new Map<string, Promise<TabCache>>();

// バッチ開始時に呼ぶ（前回実行の状態を持ち越さない）
export function resetSheetsCache(): void {
  tabCache.clear();
  tabLoading.clear();
  tabsEnsured = null;
  headerConflicts.clear();
}

function normalizeCells(cells: unknown[], width: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.max(width, cells.length); i++) out.push(String(cells[i] ?? ''));
  return out;
}

function loadTab(tab: string): Promise<TabCache> {
  const hit = tabCache.get(tab);
  if (hit && Date.now() - hit.loadedAt < CACHE_TTL_MS) return Promise.resolve(hit);
  let pending = tabLoading.get(tab);
  if (!pending) {
    pending = fetchTab(tab).finally(() => tabLoading.delete(tab));
    tabLoading.set(tab, pending);
  }
  return pending;
}

async function fetchTab(tab: string): Promise<TabCache> {
  await ensureTabs();
  const res = await throttle(() =>
    api()!.spreadsheets.values.get({ spreadsheetId: sheetsDbSpreadsheetId(), range: quoteTab(tab) }),
  );
  const values = (res.data.values ?? []) as unknown[][];
  const width = TABS[tab].length;
  const rows = values
    .slice(1)
    .map((cells, i) => ({ rowNumber: i + 2, cells: normalizeCells(cells ?? [], width) }))
    .filter((r) => r.cells.some((c) => c.trim() !== '')); // 途中の空行は読み飛ばす（行番号は保持）
  const cache: TabCache = { rows, loadedAt: Date.now(), indexes: new Map() };
  tabCache.set(tab, cache);
  return cache;
}

// タブの全データ行（ヘッダー除く）。呼び出し側が並べ替え等をしてもキャッシュが壊れないようコピーを返す
async function readRows(tab: string): Promise<CachedRow[]> {
  return (await loadTab(tab)).rows.slice();
}

function indexFor(cache: TabCache, col: number): Map<string, CachedRow> {
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

async function findRow(tab: string, colName: string, key: string): Promise<CachedRow | null> {
  const k = key.trim(); // 索引側もトリム済み
  if (!k) return null;
  const cache = await loadTab(tab);
  return indexFor(cache, colIndex(tab, colName)).get(k) ?? null;
}

function toCells(row: Cell[]): Array<string | number> {
  return row.map((v) => (v === null ? '' : v));
}

// 追記先の行番号を応答の updatedRange（例: 'タブ'!A12:K13）から得てキャッシュへ反映する
function firstRowOf(updatedRange: string | null | undefined): number | null {
  const m = (updatedRange ?? '').match(/![A-Z]+(\d+)/);
  return m ? Number(m[1]) : null;
}

async function appendRows(tab: string, rows: Cell[][]): Promise<void> {
  if (rows.length === 0) return;
  await ensureTabs();
  const res = await throttle(() =>
    api()!.spreadsheets.values.append({
      spreadsheetId: sheetsDbSpreadsheetId(),
      range: `${quoteTab(tab)}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rows.map(toCells) },
    }),
  );
  const cache = tabCache.get(tab);
  if (!cache) return; // 未読込なら次回の読込で取り込まれる
  const first = firstRowOf(res.data.updates?.updatedRange);
  if (first === null) {
    tabCache.delete(tab); // 位置が分からなければ次回読み直す
    return;
  }
  const width = TABS[tab].length;
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
// 同じ位置なら読んだ最新値でキャッシュを更新する（バッチ実行中に人が入力した担当者メール・ステータス等を
// 古いキャッシュで上書きしないため。呼び出し回数はキー1セルだけ読む場合と同じ）
async function refreshRowAt(tab: string, row: CachedRow, colName: string, key: string): Promise<boolean> {
  const width = TABS[tab].length;
  const range = `${quoteTab(tab)}!A${row.rowNumber}:${columnLetter(width - 1)}${row.rowNumber}`;
  const res = await throttle(() => api()!.spreadsheets.values.get({ spreadsheetId: sheetsDbSpreadsheetId(), range }));
  const fresh = normalizeCells((res.data.values?.[0] ?? []) as unknown[], width);
  if (fresh[colIndex(tab, colName)].trim() !== key.trim()) return false;
  if (fresh.some((c, i) => c !== (row.cells[i] ?? ''))) {
    row.cells = fresh;
    tabCache.get(tab)?.indexes.clear(); // キー以外の列の値も変わり得るため索引は次回参照時に作り直す
  }
  return true;
}

// キー列で行を探し、位置を検証（＋最新値へ更新）してから返す。ずれていればタブを読み直して探し直す
async function locateRow(tab: string, colName: string, key: string): Promise<CachedRow | null> {
  const hit = await findRow(tab, colName, key);
  if (!hit || (await refreshRowAt(tab, hit, colName, key))) return hit;
  tabCache.delete(tab);
  return findRow(tab, colName, key);
}

async function writeRow(tab: string, target: CachedRow, row: Cell[]): Promise<void> {
  await throttle(() =>
    api()!.spreadsheets.values.update({
      spreadsheetId: sheetsDbSpreadsheetId(),
      range: `${quoteTab(tab)}!A${target.rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [toCells(row)] },
    }),
  );
  const cache = tabCache.get(tab);
  if (cache) {
    target.cells = normalizeCells(toCells(row), TABS[tab].length);
    cache.indexes.clear(); // キー値が変わり得るため索引は次回参照時に作り直す
  }
}

// キー列で一致する行があれば更新、無ければ追記（build には既存行のセルが渡る）
async function upsertRow(
  tab: string,
  keyCol: string,
  key: string,
  build: (existing: string[] | null) => Cell[],
): Promise<Cell[]> {
  const hit = await locateRow(tab, keyCol, key);
  const row = build(hit ? hit.cells : null);
  if (hit) await writeRow(tab, hit, row);
  else await appendRows(tab, [row]);
  return row;
}

function colIndex(tab: string, name: string): number {
  return TABS[tab].indexOf(name);
}

function cellNum(cells: string[], idx: number): number | null {
  const v = (cells[idx] ?? '').trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function cellStr(cells: string[], idx: number): string {
  return (cells[idx] ?? '').trim();
}

// ===== 案件 =====

function projectToRow(p: Project): Cell[] {
  return [
    p.id, p.title, joinList(p.requiredSkills), joinList(p.preferredSkills), p.rateMin, p.rateMax,
    p.location, remoteLabel(p.remote), p.startPeriod, p.startDate ?? '', p.duration, p.businessFlow,
    p.agentCompany, p.agentContact, p.agentEmail, p.sourceMailId, replyMetaJson(p.replyTarget),
    p.receivedAt.toISOString(), p.status === 'closed' ? '終了' : '募集中',
  ];
}

export async function saveProjectSheets(project: Project): Promise<string> {
  if (!configured()) return '';
  await upsertRow('案件', 'ID', project.id, () => projectToRow(project));
  return project.id;
}

function rowToProject(cells: string[]): Project {
  const c = (name: string) => cellStr(cells, colIndex('案件', name));
  const n = (name: string) => cellNum(cells, colIndex('案件', name));
  const location = c('勤務地');
  return {
    id: c('ID'),
    title: c('案件名'),
    requiredSkills: normalizeSkills(splitList(c('必須スキル'))),
    preferredSkills: normalizeSkills(splitList(c('尚可スキル'))),
    rateMin: n('単金下限'),
    rateMax: n('単金上限'),
    location,
    prefecture: normalizePrefecture(location),
    remote: labelToRemote(c('リモート')),
    startPeriod: c('開始時期'),
    startDate: c('開始日') || null,
    duration: c('期間'),
    businessFlow: c('商流メモ'),
    agentCompany: c('営業元会社'),
    agentContact: c('営業元担当'),
    agentEmail: c('営業元メール'),
    sourceMailId: c('元メールID'),
    replyTarget: parseReplyMeta(c('返信メタ')),
    receivedAt: new Date(c('受信日') || Date.now()),
    status: c('ステータス') === '終了' ? 'closed' : 'open',
    notionPageId: c('ID'), // ステータス更新等の参照ID（Sheets版では自IDを流用）
  };
}

export async function fetchOpenProjectsSheets(limit = 100): Promise<Project[]> {
  if (!configured()) {
    console.warn('SheetsDB: 案件なしで継続します');
    return [];
  }
  const rows = await readRows('案件');
  const stCol = colIndex('案件', 'ステータス');
  return rows
    .filter((r) => cellStr(r.cells, stCol) !== '終了')
    .slice(0, limit)
    .map((r) => rowToProject(r.cells));
}

// ===== 要員 =====

function engineerToRow(e: Engineer): Cell[] {
  return [
    e.id, e.displayName, joinList(e.skills), e.experienceYears, e.desiredRate, e.residence,
    remoteLabel(e.remoteWish), e.availableFrom ?? '', e.agentCompany, e.agentContact, e.agentEmail,
    e.sourceMailId, replyMetaJson(e.replyTarget), e.receivedAt.toISOString(),
    e.status === 'assigned' ? '決定済' : '提案可',
  ];
}

export async function saveEngineerSheets(engineer: Engineer): Promise<string> {
  if (!configured()) return '';
  await upsertRow('要員', 'ID', engineer.id, () => engineerToRow(engineer));
  return engineer.id;
}

function rowToEngineer(cells: string[]): Engineer {
  const c = (name: string) => cellStr(cells, colIndex('要員', name));
  const n = (name: string) => cellNum(cells, colIndex('要員', name));
  const residence = c('居住地');
  return {
    id: c('ID'),
    displayName: c('表示名'),
    age: null,
    skills: normalizeSkills(splitList(c('スキル'))),
    experienceYears: n('経験年数'),
    desiredRate: n('希望単金'),
    residence,
    prefecture: normalizePrefecture(residence),
    nearestStation: '',
    availableDate: '',
    availableFrom: c('稼働開始可能日') || null,
    utilization: '',
    remoteWish: labelToRemote(c('リモート希望')),
    agentCompany: c('営業元会社'),
    agentContact: c('営業元担当'),
    agentEmail: c('営業元メール'),
    sourceMailId: c('元メールID'),
    replyTarget: parseReplyMeta(c('返信メタ')),
    receivedAt: new Date(c('受信日') || Date.now()),
    status: c('ステータス') === '決定済' ? 'assigned' : 'available',
    notionPageId: c('ID'),
  };
}

export async function fetchAvailableEngineersSheets(limit = 100): Promise<Engineer[]> {
  if (!configured()) {
    console.warn('SheetsDB: 要員なしで継続します');
    return [];
  }
  const rows = await readRows('要員');
  const stCol = colIndex('要員', 'ステータス');
  return rows
    .filter((r) => cellStr(r.cells, stCol) !== '決定済')
    .slice(0, limit)
    .map((r) => rowToEngineer(r.cells));
}

// ===== マッチ結果 =====

function readDraftColumns(tab: string, cells: string[]): DraftColumns {
  const c = (name: string) => cellStr(cells, colIndex(tab, name));
  return {
    projectState: c('案件側下書き状態'),
    engineerState: c('要員側下書き状態'),
    projectText: cells[colIndex(tab, '案件側文面')] ?? '',
    engineerText: cells[colIndex(tab, '要員側文面')] ?? '',
    data: c('下書きデータ'),
  };
}

export async function saveMatchSheets(match: MatchResult): Promise<string> {
  if (!configured()) return '';
  const idCol = colIndex('マッチ', 'ID');
  // 再実行で行が増殖しないよう、同タイトルの既存行があれば更新（upsert）。
  // 人が編集する列（ステータス・担当者メール・下書き状態）は既存値を保持し、機械の初期値で巻き戻さない
  const row = await upsertRow('マッチ', 'マッチ名', match.title, (existing) => {
    const keep = (name: string) => (existing ? cellStr(existing, colIndex('マッチ', name)) : '');
    const senderEmail = existing?.[colIndex('マッチ', '担当者メール')] ?? ''; // 人の入力をそのまま（トリムもしない）
    const drafts = mergeDraftColumns(
      existing ? readDraftColumns('マッチ', existing) : null,
      match.draftToProject,
      match.draftToEngineer,
    );
    return [
      keep('ID') || match.id, match.title, match.grossMarginJpy, match.score, match.reason, match.projectId,
      match.engineerId, match.draftToProject?.url ?? '', match.draftToEngineer?.url ?? '',
      keep('ステータス') || matchStatusLabel(match.status), match.detectedAt.toISOString(),
      senderEmail, drafts.projectState, drafts.engineerState, drafts.projectText, drafts.engineerText, drafts.data,
    ];
  });
  return String(row[idCol]);
}

export async function updateMatchStatusSheets(id: string, status: MatchStatus): Promise<void> {
  if (!configured()) return;
  const hit = await locateRow('マッチ', 'ID', id);
  if (!hit) {
    console.warn(`SheetsDB: ステータス更新対象のマッチが見つかりません (${id})`);
    return;
  }
  const stCol = colIndex('マッチ', 'ステータス');
  const label = matchStatusLabel(status);
  await throttle(() =>
    api()!.spreadsheets.values.update({
      spreadsheetId: sheetsDbSpreadsheetId(),
      range: `${quoteTab('マッチ')}!${columnLetter(stCol)}${hit.rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[label]] },
    }),
  );
  hit.cells[stCol] = label;
}

// ===== 担当者メール列による下書き依頼（マッチ等、DRAFT_REQUEST_COLUMNS を持つタブ共通） =====

export function draftRequestTabs(): string[] {
  return Object.keys(TABS).filter((tab) => ['ID', ...DRAFT_REQUEST_COLUMNS].every((c) => TABS[tab].includes(c)));
}

export interface DraftRequestRow {
  tab: string;
  id: string;
  senderEmail: string; // 担当者メール（ログに出さないこと）
  projectState: string;
  engineerState: string;
  draftData: string; // 下書きデータ列のJSON（mapping.parseDraftData で読む）
}

function toDraftRequestRow(tab: string, cells: string[]): DraftRequestRow {
  const c = (name: string) => cellStr(cells, colIndex(tab, name));
  return {
    tab,
    id: c('ID'),
    senderEmail: c('担当者メール'),
    projectState: c('案件側下書き状態'),
    engineerState: c('要員側下書き状態'),
    draftData: c('下書きデータ'),
  };
}

// 担当者メールが入っている行（行キャッシュから。状態による絞り込みは呼び出し側）
export async function listDraftRequestRowsSheets(tab: string): Promise<DraftRequestRow[]> {
  if (!configured() || !draftRequestTabs().includes(tab)) return [];
  const rows = await readRows(tab);
  if (headerConflicts.has(tab)) {
    console.warn(`SheetsDB: 「${tab}」タブのヘッダー行が定義と異なるため、担当者メールによる下書き依頼を処理しません`);
    return [];
  }
  return rows.map((r) => toDraftRequestRow(tab, r.cells)).filter((r) => r.id && r.senderEmail);
}

// 作成直前に行を読み直す（一覧取得後に人が担当者メール・状態を変えていても最新値で判断するため）。
// 行が消えていれば null
export async function reloadDraftRequestRowSheets(tab: string, id: string): Promise<DraftRequestRow | null> {
  const hit = await locateRow(tab, 'ID', id);
  return hit ? toDraftRequestRow(tab, hit.cells) : null;
}

// 下書き状態列だけを書き込む（他の列は人の編集と競合させないため触らない）。対象行が無ければ false
export async function writeDraftStatesSheets(
  tab: string,
  id: string,
  states: { project?: string; engineer?: string },
): Promise<boolean> {
  const hit = await locateRow(tab, 'ID', id);
  if (!hit) return false;
  const updates: Array<[number, string]> = [];
  if (states.project !== undefined) updates.push([colIndex(tab, '案件側下書き状態'), states.project]);
  if (states.engineer !== undefined) updates.push([colIndex(tab, '要員側下書き状態'), states.engineer]);
  if (updates.length === 0) return true;
  await throttle(() =>
    api()!.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetsDbSpreadsheetId(),
      requestBody: {
        valueInputOption: 'RAW',
        data: updates.map(([col, value]) => ({
          range: `${quoteTab(tab)}!${columnLetter(col)}${hit.rowNumber}`,
          values: [[value]],
        })),
      },
    }),
  );
  for (const [col, value] of updates) hit.cells[col] = value;
  return true;
}

// ===== 自社社員 =====

export async function saveOwnEngineerSheets(own: OwnEngineer): Promise<string> {
  if (!configured()) return '';
  await upsertRow('自社社員', 'ID', own.id, () => [
    own.id, own.displayName, joinList(own.skills), own.experienceYears, own.requiredProjectRate,
    own.residence, remoteLabel(own.remoteWish), own.availableFrom ?? '',
    own.status === 'assigned' ? 'アサイン済' : '稼働可',
  ]);
  return own.id;
}

export async function fetchOwnEngineersSheets(limit = 100): Promise<OwnEngineer[]> {
  if (!configured()) {
    console.warn('SheetsDB: 自社社員なしで継続します');
    return [];
  }
  const rows = await readRows('自社社員');
  const c = (cells: string[], name: string) => cellStr(cells, colIndex('自社社員', name));
  const n = (cells: string[], name: string) => cellNum(cells, colIndex('自社社員', name));
  return rows
    .filter((r) => c(r.cells, 'ステータス') === '稼働可')
    .slice(0, limit)
    .map((r) => {
      const residence = c(r.cells, '居住地');
      return {
        id: c(r.cells, 'ID'),
        displayName: c(r.cells, '表示名'),
        skills: normalizeSkills(splitList(c(r.cells, 'スキル'))),
        experienceYears: n(r.cells, '経験年数'),
        requiredProjectRate: n(r.cells, '必要案件単価'),
        residence,
        prefecture: normalizePrefecture(residence),
        availableDate: '',
        availableFrom: c(r.cells, '稼働可能日') || null,
        remoteWish: labelToRemote(c(r.cells, 'リモート希望')),
        status: 'available' as const,
        notionPageId: c(r.cells, 'ID'),
      };
    });
}

// ===== 評価（人間フィードバック） =====

export async function saveMatchFeedbackSheets(fb: MatchFeedback): Promise<string> {
  if (!configured()) return '';
  await appendRows('評価', [[fb.at, fb.matchId, fb.matchTitle, FB_VERDICT_LABEL[fb.verdict], fb.note, fb.reviewer, fb.band ?? '']]);
  return fb.matchId;
}

export async function fetchRecentFeedbackSheets(limit = 200): Promise<MatchFeedback[]> {
  if (!configured()) return [];
  const rows = await readRows('評価');
  const c = (cells: string[], name: string) => cellStr(cells, colIndex('評価', name));
  // 追記順（古い順）なので反転して新しい順で返す（Notion版のdescendingソートと揃える）
  return rows
    .reverse()
    .slice(0, limit)
    .map((r) => {
      const bandRaw = c(r.cells, 'バンド');
      return {
        matchId: c(r.cells, '元マッチID'),
        matchTitle: c(r.cells, 'マッチ名'),
        verdict: c(r.cells, '評価') === 'ズレ' ? ('bad' as const) : ('good' as const),
        note: c(r.cells, 'メモ'),
        reviewer: c(r.cells, '評価者'),
        band: bandRaw === 'strong' || bandRaw === 'tentative' ? bandRaw : undefined,
        at: c(r.cells, '日時') || new Date().toISOString(),
      };
    });
}

// ===== スキル同義辞書 =====

export async function saveSkillEquivalenceSheets(e: SkillEquivalence): Promise<string> {
  if (!configured()) return '';
  await appendRows('スキル同義', [[e.a, e.b, e.addedBy, e.at]]);
  return e.a;
}

export async function fetchSkillEquivalencesSheets(limit = 500): Promise<SkillEquivalence[]> {
  if (!configured()) return [];
  const rows = await readRows('スキル同義');
  const c = (cells: string[], name: string) => cellStr(cells, colIndex('スキル同義', name));
  return rows.slice(0, limit).map((r) => ({
    a: c(r.cells, 'スキルA'),
    b: c(r.cells, 'スキルB'),
    addedBy: c(r.cells, '追加者'),
    at: c(r.cells, '日時') || new Date().toISOString(),
  }));
}

// ===== バッチ横断の状態（スケジュール実行はローカルファイルが残らないためシートに置く） =====

export type ProcessedMailResult = '抽出済' | '隔離';

export async function loadProcessedMailIdsSheets(): Promise<Set<string>> {
  const rows = await readRows('処理済みメール');
  const col = colIndex('処理済みメール', 'メールID');
  return new Set(rows.map((r) => cellStr(r.cells, col)).filter(Boolean));
}

// 1回のAPI呼び出しあたりの追記行数（リクエストサイズ上限の手前で区切る）
const APPEND_CHUNK = 500;

export async function markMailProcessedSheets(ids: string[], result: ProcessedMailResult): Promise<void> {
  const known = await loadProcessedMailIdsSheets();
  const fresh = [...new Set(ids)].filter((id) => id && !known.has(id));
  const at = new Date().toISOString();
  for (let i = 0; i < fresh.length; i += APPEND_CHUNK) {
    await appendRows(
      '処理済みメール',
      fresh.slice(i, i + APPEND_CHUNK).map((id) => [id, at, result]),
    );
  }
}

// 1セルの文字数上限（50,000）に対して余裕を持たせた上限
export const STATE_JSON_MAX_CHARS = 45_000;

// 「_状態」タブのキーに対応するJSONを読む。未設定・未保存・破損時は null
export async function readStateJson<T>(key: string): Promise<T | null> {
  if (!configured()) return null;
  const hit = await findRow('_状態', 'キー', key);
  const raw = hit ? cellStr(hit.cells, colIndex('_状態', 'JSON')) : '';
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    console.warn(`SheetsDB: 状態「${key}」のJSONが壊れているため無視します`);
    return null;
  }
}

export async function writeStateJson(key: string, value: unknown): Promise<void> {
  if (!configured()) return;
  const json = JSON.stringify(value);
  if (json.length > STATE_JSON_MAX_CHARS) {
    throw new SafeLogError(`SheetsDB: 状態「${key}」が大きすぎます（${json.length}文字 > ${STATE_JSON_MAX_CHARS}）`);
  }
  await upsertRow('_状態', 'キー', key, () => [key, json, new Date().toISOString()]);
}
