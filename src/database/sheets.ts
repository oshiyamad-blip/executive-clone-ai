// Googleスプレッドシート版のSESデータ保存層（DB_PROVIDER=sheets）。
// 1つのスプレッドシートにデータ7タブ（案件/要員/マッチ/自社社員/評価/スキル同義/プロパー候補）と
// バッチ横断の状態2タブ（処理済みメール/_状態）を持ち、タブとヘッダー行は初回アクセス時に自動生成する
// （タブ・行キャッシュ・クォータ制御の汎用部分は sheetBook.ts）。
// 認証は既定でサービスアカウント自身（シートをSAのメールアドレスに編集者として共有するだけでよい）。
// SHEETS_DB_IMPERSONATE 指定時のみDWDでそのユーザーになりすます。
// 設定不足時は warn して縮退（保存スキップ/空配列）— Notion版と同じ振る舞い。
import { createHash, randomUUID } from 'crypto';
import { google } from 'googleapis';
import { getServiceAccountAuth } from '../collectors/googleAuth.js';
import { sheetsDbSpreadsheetId, sheetsDbImpersonate, draftSigningKey } from '../ses/config.js';
import { normalizeSkills } from '../ses/skillDict.js';
import { normalizePrefecture } from '../ses/prefecture.js';
import { SafeLogError } from '../ses/redact.js';
import { SheetBook, sameCells, GOOGLE_REQUEST_TIMEOUT_MS, type Cell, type CachedRow } from './sheetBook.js';
import {
  remoteLabel,
  labelToRemote,
  matchStatusLabel,
  FB_VERDICT_LABEL,
  replyMetaJson,
  parseReplyMeta,
  verifyReplyMeta,
  joinList,
  splitList,
  mergeDraftColumns,
  isDraftRegenerationPending,
  isDraftStateLocked,
  MATCH_STATUS_LABEL,
  DRAFT_STATE,
  type DraftColumns,
  type DraftSide,
} from './mapping.js';
import type {
  Project,
  Engineer,
  MatchResult,
  MatchStatus,
  OwnEngineer,
  MatchFeedback,
  SkillEquivalence,
  ProperCandidate,
} from '../types/index.js';

const SHEETS_RW_SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

// 担当者メール列による下書き依頼の列（担当者が送信元アドレスを入れると、次回バッチがそのアドレスで
// 全員に返信の下書きを作成し状態列に結果を書く）。対象タブの判定は draftRequestTabs()
export const DRAFT_REQUEST_COLUMNS = [
  '担当者メール', '案件側下書き状態', '要員側下書き状態', '案件側文面', '要員側文面', '下書きデータ',
];

export const PROPER_CANDIDATE_TAB = 'プロパー候補';

// 突合済 = その案件・要員の候補ペアを判定してマッチタブに保存し終えた日時。空欄の間は次回以降のバッチでも突合する
// （実行が時間切れ・失敗で途中終了しても、判定し損ねたペアを取りこぼさないため）
export const MATCHED_COLUMN = '突合済';

// タブ定義（列は見出しの名前で読み書きする。列の追加は末尾のみ＝既存シートは ensureTabs が見出しの右端へ自動で追記する）
const TABS: Record<string, string[]> = {
  案件: [
    'ID', '案件名', '必須スキル', '尚可スキル', '単金下限', '単金上限', '勤務地', 'リモート',
    '開始時期', '開始日', '期間', '商流メモ', '営業元会社', '営業元担当', '営業元メール',
    '元メールID', '返信メタ', '受信日', 'ステータス', MATCHED_COLUMN,
  ],
  要員: [
    'ID', '表示名', 'スキル', '経験年数', '希望単金', '居住地', 'リモート希望', '稼働開始可能日',
    '営業元会社', '営業元担当', '営業元メール', '元メールID', '返信メタ', '受信日', 'ステータス', MATCHED_COLUMN,
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
  // プロパー（自社社員のスキルシート）× 案件の候補。提案は案件側への1通だけなので要員側の下書き列は持たない
  [PROPER_CANDIDATE_TAB]: [
    'ID', 'プロパー', '案件名', '案件単価', '必要案件単価', '単価差', 'スキル一致率', 'バンド', '判定',
    '適合スコア', '根拠', '案件ID', '営業元メール', '検出日時', 'ステータス',
    '担当者メール', '案件側下書き状態', '案件側文面', '下書きデータ',
  ],
};

const book = new SheetBook({
  label: 'SheetsDB',
  tabs: TABS,
  spreadsheetId: sheetsDbSpreadsheetId,
  createApi: () => {
    const auth = getServiceAccountAuth(SHEETS_RW_SCOPES, sheetsDbImpersonate() || undefined);
    return auth ? google.sheets({ version: 'v4', auth, timeout: GOOGLE_REQUEST_TIMEOUT_MS }) : null;
  },
  missingIdMessage: 'SHEETS_DB_SPREADSHEET_ID が未設定',
  missingAuthMessage: 'Google認証（GOOGLE_SA_KEY_JSON または GOOGLE_SA_CLIENT_EMAIL/GOOGLE_SA_PRIVATE_KEY）が未設定',
  accessHint: 'IDが正しいか、サービスアカウントのメールアドレスに編集者として共有済みかを確認してください',
  dropdowns: { [PROPER_CANDIDATE_TAB]: { ステータス: Object.values(MATCH_STATUS_LABEL) } },
});

function configured(): boolean {
  return book.configured();
}

// 設定が揃っているか（処理済みID等の状態保存先の判定用。未設定時の警告は初回のみ）
export function sheetsDbConfigured(): boolean {
  return configured();
}

// バッチ開始時に呼ぶ（前回実行の状態を持ち越さない）
export function resetSheetsCache(): void {
  book.reset();
}

function colIndex(tab: string, name: string): number {
  return book.colIndex(tab, name);
}

const readRows = (tab: string) => book.readRows(tab);
const findRow = (tab: string, colName: string, key: string) => book.findRow(tab, colName, key);
const locateRow = (tab: string, colName: string, key: string) => book.locateRow(tab, colName, key);
const appendRows = (tab: string, rows: Cell[][]) => book.appendRows(tab, rows);
const upsertRow = (tab: string, keyCol: string, key: string, build: (existing: string[] | null) => Cell[]) =>
  book.upsertRow(tab, keyCol, key, build);

// 数値の列。人が手で「65万」「５年」「1,000」のように入れても読めるよう、全角・桁区切り・末尾の単位（万円・年）を許す
// （「円」は単位が変わるため読まない）
function cellNum(cells: string[], idx: number): number | null {
  const v = (cells[idx] ?? '')
    .normalize('NFKC')
    .replace(/\s/g, '')
    .replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
  if (!v) return null;
  const m = v.match(/^(-?\d+(?:\.\d+)?)(?:万円|万|年)?$/);
  return m ? Number(m[1]) : null;
}

function cellStr(cells: string[], idx: number): string {
  return idx < 0 ? '' : (cells[idx] ?? '').trim();
}

// 文面など改行・前後空白も意味を持つセル（トリムしない）
function rawCell(cells: string[], idx: number): string {
  return idx < 0 ? '' : (cells[idx] ?? '');
}

// 人が進めたステータス（案件の終了・要員の決定済など）と突合済の印は再保存で巻き戻さない。同じメールを再抽出して
// 同じIDを保存し直すことがあるため（Notion版の upsertByStableId と同じ振る舞い）。既存が空欄なら機械の値を入れる
function keepStatus(tab: string, row: Cell[], existing: string[] | null): Cell[] {
  for (const name of ['ステータス', MATCHED_COLUMN]) {
    const col = colIndex(tab, name);
    if (col < 0) continue;
    const prev = existing ? cellStr(existing, col) : '';
    if (prev) row[col] = prev;
  }
  return row;
}

// 受信日の解釈。機械が書くISO形式に加え、人が手で入れた「2026/9/1」「2026年9月1日」「9/1」（年なし＝直近のその日）を受け付ける。
// 空欄・読めない値は null（受信日で絞る突合の対象から外す。「今」とみなして毎回の突合に紛れ込ませない）
export function parseReceivedAt(raw: string, now = new Date()): Date | null {
  const s = raw.normalize('NFKC').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const full = s.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})日?(?:\s+(\d{1,2}):(\d{2}))?$/);
  const short = full ? null : s.match(/^(\d{1,2})\s*[/月]\s*(\d{1,2})日?$/);
  if (!full && !short) return null;
  const month = Number(full ? full[2] : short![1]);
  const day = Number(full ? full[3] : short![2]);
  const hour = full ? Number(full[4] ?? 0) : 0;
  const minute = full ? Number(full[5] ?? 0) : 0;
  const jstYear = new Date(now.getTime() + 9 * 60 * 60 * 1000).getUTCFullYear();
  const exists = (y: number) => {
    const d = new Date(Date.UTC(y, month - 1, day));
    return d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
  };
  // 日本時間の日時として解釈する
  const at = (y: number) => new Date(Date.UTC(y, month - 1, day, hour, minute) - 9 * 60 * 60 * 1000);
  const year = full ? Number(full[1]) : jstYear;
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || !exists(year)) return null;
  // 年なしで未来になる日付は前年（12月の受信を1月に手入力した等）
  if (!full && at(year).getTime() > now.getTime() + 24 * 60 * 60 * 1000) return exists(year - 1) ? at(year - 1) : null;
  return at(year);
}

// 受信日が不明な行の受信日（受信日で絞る突合・プロパー候補の対象から外れる十分古い日時）
const UNKNOWN_RECEIVED_AT = 0;
const warnedUnknownReceivedAt = new Set<string>();

function receivedAtOf(raw: string): Date {
  return parseReceivedAt(raw) ?? new Date(UNKNOWN_RECEIVED_AT);
}

function warnUnknownReceivedAt(tab: string, items: Array<{ receivedAt: Date }>): void {
  const unknown = items.filter((x) => x.receivedAt.getTime() === UNKNOWN_RECEIVED_AT).length;
  if (unknown === 0 || warnedUnknownReceivedAt.has(tab)) return;
  warnedUnknownReceivedAt.add(tab);
  console.warn(`SheetsDB: 「${tab}」タブに受信日が空欄・読めない行が${unknown}件あります（直近の突合の対象から外します。YYYY-MM-DD 等で入力してください）`);
}

// ===== 案件 =====

// 返信メタの署名の対象（タブ・ID・営業元メール）
function replyBinding(tab: string, id: string, agentEmail: string) {
  return { key: draftSigningKey(), tab, id, agentEmail };
}

// 返信メタ・営業元メールが署名どおりのときだけ、下書きの宛先の元として使う（鍵が無ければ検証しない）。
// 書き換えられた・署名の無い行は宛先を空にする（その行の下書きは「宛先が不明」になり作られない）
const untrustedReplyRows = new Map<string, number>();

function trustedReply(tab: string, cells: string[]): { replyTarget: ReturnType<typeof parseReplyMeta>; agentEmail: string } {
  const c = (name: string) => cellStr(cells, colIndex(tab, name));
  const meta = c('返信メタ');
  if (verifyReplyMeta(meta, replyBinding(tab, c('ID'), c('営業元メール')))) {
    return { replyTarget: parseReplyMeta(meta), agentEmail: c('営業元メール') };
  }
  untrustedReplyRows.set(tab, (untrustedReplyRows.get(tab) ?? 0) + 1);
  return { replyTarget: undefined, agentEmail: '' };
}

const warnedUntrustedReply = new Set<string>();

function warnUntrustedReply(tab: string): void {
  const n = untrustedReplyRows.get(tab) ?? 0;
  untrustedReplyRows.delete(tab);
  if (n === 0 || warnedUntrustedReply.has(tab)) return;
  warnedUntrustedReply.add(tab);
  console.warn(
    `SheetsDB: 「${tab}」タブに返信メタ・営業元メールの署名が無い・合わない行が${n}件あります（書き換えられた可能性があるため、` +
      'これらの行の下書きの宛先には使いません。SES_DRAFT_SIGNING_KEY を登録する前に保存した行も含みます）',
  );
}

function projectToRow(p: Project): Cell[] {
  return [
    p.id, p.title, joinList(p.requiredSkills), joinList(p.preferredSkills), p.rateMin, p.rateMax,
    p.location, remoteLabel(p.remote), p.startPeriod, p.startDate ?? '', p.duration, p.businessFlow,
    p.agentCompany, p.agentContact, p.agentEmail, p.sourceMailId,
    replyMetaJson(p.replyTarget, replyBinding('案件', p.id, p.agentEmail)),
    p.receivedAt.toISOString(), p.status === 'closed' ? '終了' : '募集中', '',
  ];
}

export async function saveProjectSheets(project: Project): Promise<string> {
  if (!configured()) return '';
  await upsertRow('案件', 'ID', project.id, (existing) => keepStatus('案件', projectToRow(project), existing));
  return project.id;
}

function rowToProject(cells: string[]): Project {
  const c = (name: string) => cellStr(cells, colIndex('案件', name));
  const n = (name: string) => cellNum(cells, colIndex('案件', name));
  const location = c('勤務地');
  const reply = trustedReply('案件', cells);
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
    agentEmail: reply.agentEmail,
    sourceMailId: c('元メールID'),
    replyTarget: reply.replyTarget,
    receivedAt: receivedAtOf(c('受信日')),
    status: c('ステータス') === '終了' ? 'closed' : 'open',
    notionPageId: c('ID'), // ステータス更新等の参照ID（Sheets版では自IDを流用）
    matched: c(MATCHED_COLUMN) !== '',
  };
}

// 新しい順に並べ、受信日時が since 以降のものに絞って limit 件まで返す（追記順＝古い順のタブから最新を取るため）
function newestFirst<T extends { receivedAt: Date }>(items: T[], limit: number, since?: Date): T[] {
  return newestSince(items, since).slice(0, limit);
}

function newestSince<T extends { receivedAt: Date }>(items: T[], since?: Date): T[] {
  const sinceMs = since ? since.getTime() : -Infinity;
  const time = (x: T) => (Number.isFinite(x.receivedAt.getTime()) ? x.receivedAt.getTime() : UNKNOWN_RECEIVED_AT);
  return items.filter((x) => time(x) >= sinceMs).sort((a, b) => time(b) - time(a));
}

// 募集中の案件を新しい順に limit 件まで返す。receivedSince 指定時はその日時以降に受信した案件に絞る
export async function fetchOpenProjectsSheets(limit = 100, receivedSince?: Date): Promise<Project[]> {
  if (!configured()) {
    console.warn('SheetsDB: 案件なしで継続します');
    return [];
  }
  const open = await openProjects();
  return newestFirst(open, limit, receivedSince);
}

async function openProjects(): Promise<Project[]> {
  const rows = await readRows('案件');
  const stCol = colIndex('案件', 'ステータス');
  const open = rows.filter((r) => cellStr(r.cells, stCol) !== '終了').map((r) => rowToProject(r.cells));
  warnUnknownReceivedAt('案件', open);
  warnUntrustedReply('案件');
  return open;
}

// ===== 要員 =====

function engineerToRow(e: Engineer): Cell[] {
  return [
    e.id, e.displayName, joinList(e.skills), e.experienceYears, e.desiredRate, e.residence,
    remoteLabel(e.remoteWish), e.availableFrom ?? '', e.agentCompany, e.agentContact, e.agentEmail,
    e.sourceMailId, replyMetaJson(e.replyTarget, replyBinding('要員', e.id, e.agentEmail)), e.receivedAt.toISOString(),
    e.status === 'assigned' ? '決定済' : '提案可', '',
  ];
}

export async function saveEngineerSheets(engineer: Engineer): Promise<string> {
  if (!configured()) return '';
  await upsertRow('要員', 'ID', engineer.id, (existing) => keepStatus('要員', engineerToRow(engineer), existing));
  return engineer.id;
}

function rowToEngineer(cells: string[]): Engineer {
  const c = (name: string) => cellStr(cells, colIndex('要員', name));
  const n = (name: string) => cellNum(cells, colIndex('要員', name));
  const residence = c('居住地');
  const reply = trustedReply('要員', cells);
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
    agentEmail: reply.agentEmail,
    sourceMailId: c('元メールID'),
    replyTarget: reply.replyTarget,
    receivedAt: receivedAtOf(c('受信日')),
    status: c('ステータス') === '決定済' ? 'assigned' : 'available',
    notionPageId: c('ID'),
    matched: c(MATCHED_COLUMN) !== '',
  };
}

// 提案可の要員を新しい順に limit 件まで返す。receivedSince 指定時はその日時以降に受信した要員に絞る
export async function fetchAvailableEngineersSheets(limit = 100, receivedSince?: Date): Promise<Engineer[]> {
  if (!configured()) {
    console.warn('SheetsDB: 要員なしで継続します');
    return [];
  }
  const available = await availableEngineers();
  return newestFirst(available, limit, receivedSince);
}

async function availableEngineers(): Promise<Engineer[]> {
  const rows = await readRows('要員');
  const stCol = colIndex('要員', 'ステータス');
  const available = rows.filter((r) => cellStr(r.cells, stCol) !== '決定済').map((r) => rowToEngineer(r.cells));
  warnUnknownReceivedAt('要員', available);
  warnUntrustedReply('要員');
  return available;
}

// 突合前（突合済が空欄）なのに、直近の新しい順 limit 件の突合の対象から押し出された募集中の案件・提案可の要員の数
// （SES_MATCH_POOL_LIMIT を超えて新しいものが届くと、古い突合前のものは判定されないまま残るため知らせる）
export async function countUnmatchedBeyondPoolSheets(limit: number, since: Date): Promise<{ projects: number; engineers: number }> {
  if (!configured()) return { projects: 0, engineers: 0 };
  const beyond = <T extends { receivedAt: Date; matched?: boolean }>(items: T[]) =>
    newestSince(items, since).slice(limit).filter((x) => x.matched === false).length;
  return { projects: beyond(await openProjects()), engineers: beyond(await availableEngineers()) };
}

// 指定のメールから保存した案件・要員（ステータスによらず）。同じメールを抽出し直したときに、保存済みの行と内容で
// 対応付けてIDを決めるために使う
export async function fetchItemsByMailSheets(mailIds: Set<string>): Promise<{ projects: Project[]; engineers: Engineer[] }> {
  if (!configured() || mailIds.size === 0) return { projects: [], engineers: [] };
  const pick = async <T>(tab: string, toItem: (cells: string[]) => T): Promise<T[]> => {
    const col = colIndex(tab, '元メールID');
    const items = (await readRows(tab)).filter((r) => mailIds.has(cellStr(r.cells, col))).map((r) => toItem(r.cells));
    untrustedReplyRows.delete(tab);
    return items;
  };
  return { projects: await pick('案件', rowToProject), engineers: await pick('要員', rowToEngineer) };
}

// ===== 案件・要員・マッチのまとめ保存（1行ずつの追記で API 呼び出しと実行時間が膨らまないように） =====

interface RowsSaveResult {
  failed: Map<string, unknown>; // 保存できなかった ID → エラー
  rows: Map<string, Cell[]>; // 保存できた ID → 書き込んだ行（人が進めたステータス・突合済を引き継いだ値）
}

// 既存の行は1行ずつ更新し、新しい行はまとめて追記する
// （タブを読めない・見出しが食い違う場合は全件が失敗）
async function saveRowsBatch<T extends { id: string }>(
  tab: string,
  items: T[],
  build: (item: T, existing: string[] | null) => Cell[],
): Promise<RowsSaveResult> {
  const out: RowsSaveResult = { failed: new Map(), rows: new Map() };
  if (!configured() || items.length === 0) return out;
  try {
    await readRows(tab); // タブの自動生成とヘッダー検証（食い違いは例外）
  } catch (err) {
    for (const item of items) out.failed.set(item.id, err);
    return out;
  }
  const fresh: Array<{ id: string; row: Cell[] }> = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    try {
      if (!(await findRow(tab, 'ID', item.id))) {
        fresh.push({ id: item.id, row: build(item, null) });
        continue;
      }
      out.rows.set(item.id, await upsertRow(tab, 'ID', item.id, (existing) => build(item, existing)));
    } catch (err) {
      out.failed.set(item.id, err);
    }
  }
  for (let i = 0; i < fresh.length; i += APPEND_CHUNK) {
    const chunk = fresh.slice(i, i + APPEND_CHUNK);
    try {
      await appendRows(tab, chunk.map((f) => f.row));
      for (const f of chunk) out.rows.set(f.id, f.row);
    } catch (err) {
      for (const f of chunk) out.failed.set(f.id, err);
    }
  }
  return out;
}

export interface SheetsSaveResult<T> {
  failed: Map<string, unknown>;
  // 保存できたものの、保存後の状態（人が付けた「終了」「決定済」と突合済の印は、抽出し直した値でなくシートの値）
  saved: Map<string, T>;
}

function rowCell(tab: string, row: Cell[], name: string): string {
  const col = colIndex(tab, name);
  return col < 0 ? '' : String(row[col] ?? '').trim();
}

export async function saveProjectsSheets(projects: Project[]): Promise<SheetsSaveResult<Project>> {
  const { failed, rows } = await saveRowsBatch('案件', projects, (p, existing) => keepStatus('案件', projectToRow(p), existing));
  const saved = new Map<string, Project>();
  for (const p of projects) {
    const row = rows.get(p.id);
    if (!row) continue;
    saved.set(p.id, {
      ...p,
      status: rowCell('案件', row, 'ステータス') === '終了' ? 'closed' : 'open',
      matched: rowCell('案件', row, MATCHED_COLUMN) !== '',
    });
  }
  return { failed, saved };
}

export async function saveEngineersSheets(engineers: Engineer[]): Promise<SheetsSaveResult<Engineer>> {
  const { failed, rows } = await saveRowsBatch('要員', engineers, (e, existing) => keepStatus('要員', engineerToRow(e), existing));
  const saved = new Map<string, Engineer>();
  for (const e of engineers) {
    const row = rows.get(e.id);
    if (!row) continue;
    saved.set(e.id, {
      ...e,
      status: rowCell('要員', row, 'ステータス') === '決定済' ? 'assigned' : 'available',
      matched: rowCell('要員', row, MATCHED_COLUMN) !== '',
    });
  }
  return { failed, saved };
}

export async function saveMatchesSheets(matches: MatchResult[]): Promise<Map<string, unknown>> {
  return (await saveRowsBatch('マッチ', matches, (m, existing) => matchRow(m, existing))).failed;
}

// 候補ペアの判定・保存まで済んだ案件・要員に「突合済」を付ける。付けた行数を返す
export async function markItemsMatchedSheets(kind: 'project' | 'engineer', ids: string[]): Promise<number> {
  if (!configured() || ids.length === 0) return 0;
  const at = new Date().toISOString();
  return book.writeCellsByKey(
    kind === 'project' ? '案件' : '要員',
    'ID',
    [...new Set(ids)].map((id) => ({ key: id, cells: [[MATCHED_COLUMN, at]] })),
  );
}

// ===== マッチ結果 =====

function readDraftColumns(tab: string, cells: string[]): DraftColumns {
  const c = (name: string) => cellStr(cells, colIndex(tab, name));
  return {
    projectState: c('案件側下書き状態'),
    engineerState: c('要員側下書き状態'),
    projectText: rawCell(cells, colIndex(tab, '案件側文面')),
    engineerText: rawCell(cells, colIndex(tab, '要員側文面')),
    data: c('下書きデータ'),
  };
}

// 再実行で行が増殖しないよう、同じペアのマッチID（案件ID×要員IDから作る安定ID）の既存行があれば更新（upsert）。
// タイトル（案件名×イニシャル）は別ペアと重なり得るため鍵にしない。
// 人が編集する列（ステータス・担当者メール・下書き状態）は既存値を保持し、機械の初期値で巻き戻さない
function matchRow(match: MatchResult, existing: string[] | null): Cell[] {
  const keep = (name: string) => (existing ? cellStr(existing, colIndex('マッチ', name)) : '');
  const senderEmail = existing?.[colIndex('マッチ', '担当者メール')] ?? ''; // 人の入力をそのまま（トリムもしない）
  const id = keep('ID') || match.id;
  const drafts = mergeDraftColumns(
    existing ? readDraftColumns('マッチ', existing) : null,
    match.draftToProject,
    match.draftToEngineer,
    { failed: match.draftFailed, signingKey: draftSigningKey(), bind: draftBinding('マッチ', id) },
  );
  return [
    id, match.title, match.grossMarginJpy, match.score, match.reason, match.projectId,
    match.engineerId, match.draftToProject?.url ?? '', match.draftToEngineer?.url ?? '',
    keep('ステータス') || matchStatusLabel(match.status), match.detectedAt.toISOString(),
    senderEmail, drafts.projectState, drafts.engineerState, drafts.projectText, drafts.engineerText, drafts.data,
  ];
}

export async function saveMatchSheets(match: MatchResult): Promise<string> {
  if (!configured()) return '';
  const idCol = colIndex('マッチ', 'ID');
  const row = await upsertRow('マッチ', 'ID', match.id, (existing) => matchRow(match, existing));
  return String(row[idCol]);
}

// 判定済みのマッチID（通常バッチで同じペアをLLMで判定し直さないため）。文面を用意できなかった行
// （下書き状態が「文面を用意できませんでした」）は判定済みに含めず、次回のバッチで判定と文面の作成をやり直す
export async function fetchJudgedMatchIdsSheets(): Promise<Set<string>> {
  if (!configured()) return new Set();
  const rows = await readRows('マッチ');
  const c = (cells: string[], name: string) => cellStr(cells, colIndex('マッチ', name));
  const regenerate = (cells: string[]) =>
    isDraftRegenerationPending(c(cells, '案件側下書き状態')) || isDraftRegenerationPending(c(cells, '要員側下書き状態'));
  return new Set(rows.filter((r) => !regenerate(r.cells)).map((r) => c(r.cells, 'ID')).filter(Boolean));
}

// サマリで知らせ損ねたマッチを次の回のサマリに載せるための要約（保存済みの行から）
export interface MatchSummaryRow {
  id: string;
  title: string;
  grossMarginJpy: number | null;
  score: number | null;
  reason: string;
}

export async function fetchMatchSummariesSheets(ids: string[]): Promise<MatchSummaryRow[]> {
  if (!configured() || ids.length === 0) return [];
  const want = new Set(ids);
  const seen = new Set<string>();
  const c = (cells: string[], name: string) => cellStr(cells, colIndex('マッチ', name));
  const out: MatchSummaryRow[] = [];
  for (const r of await readRows('マッチ')) {
    const id = c(r.cells, 'ID');
    if (!want.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      title: c(r.cells, 'マッチ名'),
      grossMarginJpy: cellNum(r.cells, colIndex('マッチ', '粗利額')),
      score: cellNum(r.cells, colIndex('マッチ', '適合スコア')),
      reason: c(r.cells, '判定根拠'),
    });
  }
  return out;
}

export async function updateMatchStatusSheets(id: string, status: MatchStatus): Promise<void> {
  if (!configured()) return;
  const hit = await locateRow('マッチ', 'ID', id);
  if (!hit) {
    console.warn(`SheetsDB: ステータス更新対象のマッチが見つかりません (${id})`);
    return;
  }
  await book.writeCells('マッチ', hit, [['ステータス', matchStatusLabel(status)]]);
}

// ===== 担当者メール列による下書き依頼（マッチ・プロパー候補等、下書き依頼の列を持つタブ共通） =====

const DRAFT_STATE_COLUMNS: Record<DraftSide, string> = { project: '案件側下書き状態', engineer: '要員側下書き状態' };

// 下書きデータの署名に含める行の識別（署名つきの下書きデータを別の行へ写しても通らないように）
export function draftBinding(tab: string, id: string): string[] {
  return [tab, id.trim()];
}

// ID・担当者メール・下書きデータと、少なくとも片側の状態列を持つタブ（プロパー候補は案件側のみ）
export function draftRequestTabs(): string[] {
  return book.tabNames().filter((tab) => {
    const cols = book.columns(tab);
    return (
      ['ID', '担当者メール', '下書きデータ'].every((c) => cols.includes(c)) &&
      Object.values(DRAFT_STATE_COLUMNS).some((c) => cols.includes(c))
    );
  });
}

export interface DraftRequestRow {
  tab: string;
  id: string;
  rowNumber: number; // 一覧で見つけたシート上の行（同じIDの行が複数あっても、依頼の入った行そのものを扱う）
  senderEmail: string; // 担当者メール（ログに出さないこと）
  projectState: string;
  engineerState: string;
  draftData: string; // 下書きデータ列のJSON（mapping.parseDraftData で読む）
}

function toDraftRequestRow(tab: string, row: CachedRow): DraftRequestRow {
  const cells = row.cells;
  const c = (name: string) => cellStr(cells, colIndex(tab, name));
  // 状態列の無い側は「不要」とみなし、作成対象にも書き込み対象にもしない
  const state = (side: DraftSide) =>
    colIndex(tab, DRAFT_STATE_COLUMNS[side]) >= 0 ? c(DRAFT_STATE_COLUMNS[side]) : DRAFT_STATE.notNeeded;
  return {
    tab,
    id: c('ID'),
    rowNumber: row.rowNumber,
    senderEmail: c('担当者メール'),
    projectState: state('project'),
    engineerState: state('engineer'),
    draftData: c('下書きデータ'),
  };
}

// 担当者メールが入っている行（行キャッシュから。状態による絞り込みは呼び出し側）。
// ヘッダー行が定義と食い違うタブは例外（列を取り違えて別の行・列の依頼として扱わないため）
export async function listDraftRequestRowsSheets(tab: string): Promise<DraftRequestRow[]> {
  if (!configured() || !draftRequestTabs().includes(tab)) return [];
  const rows = await readRows(tab);
  return rows.map((r) => toDraftRequestRow(tab, r)).filter((r) => r.id && r.senderEmail);
}

function normalizedSender(s: string): string {
  return s.normalize('NFKC').trim().toLowerCase();
}

// 一覧で見つけた依頼の行を読み直す（一覧取得後に人が担当者メール・状態を変えていても最新値で判断するため）。
// 行がずれていれば（人が行を挿入した等）タブを読み直し、同じIDの行のうち同じ担当者メールの入った行を探す。
// 見つからなければ null
async function locateRequestRow(listed: Pick<DraftRequestRow, 'tab' | 'id' | 'rowNumber' | 'senderEmail'>): Promise<CachedRow | null> {
  const { tab, id } = listed;
  const exact = await book.rowAt(tab, listed.rowNumber, 'ID', id);
  if (exact) return exact;
  book.invalidate(tab);
  const senderCol = colIndex(tab, '担当者メール');
  const rows = await book.findRows(tab, 'ID', id);
  const want = normalizedSender(listed.senderEmail);
  const hit =
    rows.find((r) => want !== '' && normalizedSender(cellStr(r.cells, senderCol)) === want) ??
    rows.find((r) => cellStr(r.cells, senderCol) !== '') ??
    rows[0];
  return hit ? book.rowAt(tab, hit.rowNumber, 'ID', id) : null;
}

export async function reloadDraftRequestRowSheets(
  listed: Pick<DraftRequestRow, 'tab' | 'id' | 'rowNumber' | 'senderEmail'>,
): Promise<DraftRequestRow | null> {
  const hit = await locateRequestRow(listed);
  return hit ? toDraftRequestRow(listed.tab, hit) : null;
}

function draftStateOf(row: DraftRequestRow, side: DraftSide): string {
  return side === 'project' ? row.projectState : row.engineerState;
}

// 下書き状態列だけを書き込む（他の列は人の編集と競合させないため触らない）。対象行が無ければ false。
// expect を渡すと、書き込む側の状態が読み直した行で expect と同じときだけ書く（別の実行・人が先に状態を変えていたら
// 書かずに false。同時に動いた実行が同じ依頼を二重に作らないための確認）
export async function writeDraftStatesSheets(
  row: Pick<DraftRequestRow, 'tab' | 'id' | 'rowNumber' | 'senderEmail'>,
  states: Partial<Record<DraftSide, string>>,
  expect?: DraftRequestRow,
): Promise<boolean> {
  const tab = row.tab;
  const hit = await locateRequestRow(row);
  if (!hit) return false;
  const sides = (Object.keys(DRAFT_STATE_COLUMNS) as DraftSide[]).filter((side) => states[side] !== undefined);
  if (expect) {
    const current = toDraftRequestRow(tab, hit);
    if (sides.some((side) => draftStateOf(current, side) !== draftStateOf(expect, side))) return false;
  }
  const updates: Array<[string, Cell]> = sides.map((side) => [DRAFT_STATE_COLUMNS[side], states[side]!]);
  await book.writeCells(tab, hit, updates);
  return true;
}

// ===== プロパー候補（自社社員のスキルシート × 案件） =====

function properVerdict(c: ProperCandidate): string {
  return c.needsReview ? '要確認（単価・勤務地が不明）' : '単価充足';
}

// 小数は1桁に丸める（シートの表示値と比べて差分判定するため、桁数の揺れで毎回書き直さない）
function round1(n: number | null): number | null {
  return n === null ? null : Math.round(n * 10) / 10;
}

function properCandidateRow(c: ProperCandidate, existing: string[] | null): Cell[] {
  const tab = PROPER_CANDIDATE_TAB;
  const keep = (name: string) => (existing ? cellStr(existing, colIndex(tab, name)) : '');
  const senderEmail = existing?.[colIndex(tab, '担当者メール')] ?? ''; // 人の入力をそのまま（トリムもしない）
  const drafts = mergeDraftColumns(existing ? readDraftColumns(tab, existing) : null, c.draftToProject, undefined, {
    signingKey: draftSigningKey(),
    bind: draftBinding(tab, c.id),
  });
  return [
    c.id, c.properLabel, c.projectTitle, round1(c.projectRate), round1(c.requiredProjectRate), round1(c.rateGapMan),
    Math.round(c.skillMatchRate * 100), c.band === 'strong' ? '強マッチ' : '参考提案', properVerdict(c), c.score,
    c.reason, c.projectId, c.agentEmail,
    keep('検出日時') || c.detectedAt.toISOString(), // 初回検出日時を保つ（毎回の書き直しを避ける）
    keep('ステータス') || matchStatusLabel('unconfirmed'),
    senderEmail, drafts.projectState, drafts.projectText, drafts.data,
  ];
}

// プロパー候補のID（ownmatch_<社員ID>_<案件ID>）から社員IDを取り出す（案件IDは proj_ で始まる）
export function properEngineerIdOfCandidate(candidateId: string): string {
  const rest = candidateId.startsWith('ownmatch_') ? candidateId.slice('ownmatch_'.length) : '';
  const at = rest.lastIndexOf('_proj_');
  return at > 0 ? rest.slice(0, at) : '';
}

// プロパーの社員ID。スキルシートのDriveのファイルIDはそのままファイルのURLになり、リンク共有のスキルシートを
// 案件スプレッドシートの閲覧者が開けてしまうため、一方向のハッシュにする（元のIDはプロパー管理表にだけ置く）
export function properEngineerIdOf(fileId: string): string {
  return `proper_${createHash('sha256').update(fileId).digest('hex').slice(0, 16)}`;
}

// 以前の版はプロパー候補のIDにDriveのファイルIDをそのまま入れていたため、ハッシュのIDに書き換える
async function migrateLegacyProperIds(): Promise<void> {
  const tab = PROPER_CANDIDATE_TAB;
  const idCol = colIndex(tab, 'ID');
  const updates: Array<{ key: string; cells: Array<[string, Cell]> }> = [];
  for (const r of await readRows(tab)) {
    const id = cellStr(r.cells, idCol);
    const engineerId = properEngineerIdOfCandidate(id);
    if (!engineerId.startsWith('proper_') || /^proper_[0-9a-f]{16}$/.test(engineerId)) continue;
    const fileId = engineerId.slice('proper_'.length);
    updates.push({ key: id, cells: [['ID', `ownmatch_${properEngineerIdOf(fileId)}${id.slice(`ownmatch_${engineerId}`.length)}`]] });
  }
  if (updates.length === 0) return;
  const n = await book.writeCellsByKey(tab, 'ID', updates);
  console.log(`SheetsDB: 「${tab}」タブの${n}行のIDを、スキルシートのファイルIDを含まない形に書き換えました`);
}

// 候補を ID で upsert する。人の列（ステータス・担当者メール・案件側下書き状態）は保持し、
// 内容が変わらない行は書き込まない（毎回の実行で候補数ぶんのAPI呼び出しをしないため）。新規行はまとめて追記。
// 保存（追記・更新）した行数を返す
export async function saveProperCandidatesSheets(candidates: ProperCandidate[]): Promise<number> {
  if (!configured() || candidates.length === 0) return 0;
  const tab = PROPER_CANDIDATE_TAB;
  await readRows(tab); // タブの自動生成とヘッダー検証（食い違いは例外）を先に済ませる
  await migrateLegacyProperIds();
  const fresh: Cell[][] = [];
  let written = 0;
  for (const c of candidates) {
    const cached = await findRow(tab, 'ID', c.id);
    if (!cached) {
      fresh.push(properCandidateRow(c, null));
      continue;
    }
    if (sameCells(properCandidateRow(c, cached.cells), cached.cells)) continue;
    await upsertRow(tab, 'ID', c.id, (existing) => properCandidateRow(c, existing));
    written += 1;
  }
  for (let i = 0; i < fresh.length; i += APPEND_CHUNK) await appendRows(tab, fresh.slice(i, i + APPEND_CHUNK));
  return written + fresh.length;
}

export const RETIRED_PROPER_VERDICT = '対象外（稼働可の社員ではなくなりました）';

// 稼働可でなくなった（対象外・アサイン済・スキルシートの削除等）社員のプロパー候補の行を退役させる。
// 氏名と必要案件単価・提案文面・下書きデータを消し、まだ作っていない側の下書き状態を「不要」にする
// （古いサマリを見た営業が担当者メールを入れても、提案をやめた社員を社外に紹介しないため）。退役させた行数を返す
export async function retireProperCandidatesSheets(activeEngineerIds: Set<string>): Promise<number> {
  if (!configured()) return 0;
  const tab = PROPER_CANDIDATE_TAB;
  await migrateLegacyProperIds();
  const c = (cells: string[], name: string) => cellStr(cells, colIndex(tab, name));
  const updates: Array<{ key: string; cells: Array<[string, Cell]> }> = [];
  for (const r of await readRows(tab)) {
    const id = c(r.cells, 'ID');
    if (!id || activeEngineerIds.has(properEngineerIdOfCandidate(id))) continue;
    if (c(r.cells, '判定') === RETIRED_PROPER_VERDICT) continue;
    const cells: Array<[string, Cell]> = [
      ['プロパー', '（対象外）'], ['必要案件単価', ''], ['単価差', ''], ['判定', RETIRED_PROPER_VERDICT],
      ['案件側文面', ''], ['下書きデータ', ''],
    ];
    if (!isDraftStateLocked(c(r.cells, '案件側下書き状態'))) cells.push(['案件側下書き状態', DRAFT_STATE.retired]);
    updates.push({ key: id, cells });
  }
  if (updates.length === 0) return 0;
  return book.writeCellsByKey(tab, 'ID', updates);
}

// ===== 自社社員 =====

export async function saveOwnEngineerSheets(own: OwnEngineer): Promise<string> {
  if (!configured()) return '';
  await upsertRow('自社社員', 'ID', own.id, (existing) =>
    keepStatus(
      '自社社員',
      [
        own.id, own.displayName, joinList(own.skills), own.experienceYears, own.requiredProjectRate,
        own.residence, remoteLabel(own.remoteWish), own.availableFrom ?? '',
        own.status === 'assigned' ? 'アサイン済' : '稼働可',
      ],
      existing,
    ),
  );
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
  // 追記順（古い順）なので反転し、上限に達したときは新しい登録を優先する
  return rows.reverse().slice(0, limit).map((r) => ({
    a: c(r.cells, 'スキルA'),
    b: c(r.cells, 'スキルB'),
    addedBy: c(r.cells, '追加者'),
    at: c(r.cells, '日時') || new Date().toISOString(),
  }));
}

// ===== バッチ横断の状態（スケジュール実行はローカルファイルが残らないためシートに置く） =====

// 除外 = 自分たちのメール（サマリ・自社ドメイン等）として取り込まなかったもの
export type ProcessedMailResult = '抽出済' | '隔離' | '除外';

export async function loadProcessedMailIdsSheets(): Promise<Set<string>> {
  const rows = await readRows('処理済みメール');
  const col = colIndex('処理済みメール', 'メールID');
  return new Set(rows.map((r) => cellStr(r.cells, col)).filter(Boolean));
}

// 1回のAPI呼び出しあたりの追記行数（リクエストサイズ上限の手前で区切る）
const APPEND_CHUNK = 500;

// 収集期間を十分過ぎた処理済みメールの記録を削除する（収集の窓の外のメールは二度と取得しないため記録は不要。
// 追記だけだとスプレッドシートのセル数の上限に近づく）。少ないうちは消さない（毎回の行削除を避ける）。削除した行数を返す
export async function pruneProcessedMailSheets(before: Date, minRows = 200): Promise<number> {
  if (!configured()) return 0;
  const tab = '処理済みメール';
  const col = colIndex(tab, '処理日時');
  const isOld = (r: CachedRow) => {
    const t = Date.parse(cellStr(r.cells, col));
    return Number.isFinite(t) && t < before.getTime();
  };
  if ((await readRows(tab)).filter(isOld).length < minRows) return 0;
  return book.deleteRowsWhere(tab, isOld); // 消す直前に読み直した行番号で消す
}

// スプレッドシート全体のセル数（直近のタブ確認時点）
export function sheetsCellCount(): number {
  return book.cellCount();
}

// バッチの開始時に、保存先のタブを読めること（共有・見出し）を確かめる。問題があれば例外。
// あわせて「突合済」列の導入前からある案件・要員の行を突合済みにする（migrateMatchedColumn）
export async function checkSheetsTabs(tabs: string[]): Promise<void> {
  for (const tab of tabs) await readRows(tab);
  for (const tab of ['案件', '要員']) {
    if (tabs.includes(tab)) await migrateMatchedColumn(tab);
  }
}

const MIGRATED_MARK = '移行';

interface MigrationState {
  state: 'started' | 'done';
  at: string;
}

// 「突合済」列の導入前からある行を突合済みにする（新しい仕組みに切り替えた最初の実行で、保存済みの全案件・要員の組を
// 判定し直して費用がかさまないように）。列をどのプロセスが追加したか（確認UI・自社社員探し等でも追加される）に依らず、
// _状態タブの印で1回だけ行う。印は書き込みがすべて済んでから「完了」にするため、途中で失敗しても次の実行でやり直す
async function migrateMatchedColumn(tab: string): Promise<void> {
  const key = `migration:${MATCHED_COLUMN}:${tab}`;
  const state = await readStateJson<MigrationState>(key);
  if (state?.state === 'done') return;
  const col = colIndex(tab, MATCHED_COLUMN);
  const rows = await readRows(tab);
  // 以前の版（列を追加したプロセスだけが移行した）で移行済みのタブは、その後に保存した突合前の行（空欄）を触らない
  const migratedBefore = !state && rows.some((r) => cellStr(r.cells, col).startsWith(MIGRATED_MARK));
  const ids = migratedBefore ? [] : rows.filter((r) => !cellStr(r.cells, col)).map((r) => cellStr(r.cells, colIndex(tab, 'ID'))).filter(Boolean);
  const at = new Date().toISOString();
  if (ids.length > 0) {
    await writeStateJson(key, { state: 'started', at } satisfies MigrationState);
    const marked = await book.writeCellsByKey(tab, 'ID', ids.map((id) => ({ key: id, cells: [[MATCHED_COLUMN, `${MIGRATED_MARK} ${at}`]] })));
    if (marked > 0) console.log(`SheetsDB: 「${tab}」タブの既存${marked}行を突合済みにしました（${MATCHED_COLUMN}列の導入に伴う移行）`);
  }
  await writeStateJson(key, { state: 'done', at } satisfies MigrationState);
}

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

// ===== 同時実行の防止（バッチの実行中の印） =====

const LEASE_KEY = 'batchLease';

interface LeaseState {
  token: string;
  until: string; // ISO日時。これを過ぎた印は無効（打ち切られた実行の印が残っても、次の定時実行を止めない）
}

export type LeaseResult = { ok: true; token: string } | { ok: false; until: string };

async function readStateFresh<T>(key: string): Promise<T | null> {
  book.invalidate('_状態');
  return readStateJson<T>(key);
}

// 同時に動くバッチ（定時実行と手元の実行・自前の定期実行など）を1つに限る。_状態タブに期限つきの印を書き、少し待ってから
// 読み直して自分の印が残っていれば実行してよい（ほぼ同時に書いた相手がいれば、後から書いた方だけが残る）
export async function acquireBatchLeaseSheets(ttlMs: number, confirmDelayMs = 5000): Promise<LeaseResult> {
  const now = Date.now();
  const current = await readStateFresh<LeaseState>(LEASE_KEY);
  if (current?.token && Date.parse(current.until) > now) return { ok: false, until: current.until };
  const token = randomUUID();
  await writeStateJson(LEASE_KEY, { token, until: new Date(now + ttlMs).toISOString() } satisfies LeaseState);
  if (confirmDelayMs > 0) await new Promise((res) => setTimeout(res, confirmDelayMs));
  const confirmed = await readStateFresh<LeaseState>(LEASE_KEY);
  return confirmed?.token === token ? { ok: true, token } : { ok: false, until: confirmed?.until ?? '' };
}

// 自分の印のときだけ消す（期限切れの後に別の実行が取った印は消さない）
export async function releaseBatchLeaseSheets(token: string): Promise<void> {
  const current = await readStateFresh<LeaseState>(LEASE_KEY);
  if (current?.token !== token) return;
  await writeStateJson(LEASE_KEY, { token: '', until: new Date(0).toISOString() } satisfies LeaseState);
}
