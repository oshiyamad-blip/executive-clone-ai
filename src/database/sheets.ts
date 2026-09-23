// Googleスプレッドシート版のSESデータ保存層（DB_PROVIDER=sheets）。
// 1つのスプレッドシートにデータ7タブ（案件/要員/マッチ/自社社員/評価/スキル同義/プロパー候補）と
// バッチ横断の状態2タブ（処理済みメール/_状態）を持ち、タブとヘッダー行は初回アクセス時に自動生成する
// （タブ・行キャッシュ・クォータ制御の汎用部分は sheetBook.ts）。
// 認証は既定でサービスアカウント自身（シートをSAのメールアドレスに編集者として共有するだけでよい）。
// SHEETS_DB_IMPERSONATE 指定時のみDWDでそのユーザーになりすます。
// 設定不足時は warn して縮退（保存スキップ/空配列）— Notion版と同じ振る舞い。
import { google } from 'googleapis';
import { getServiceAccountAuth } from '../collectors/googleAuth.js';
import { sheetsDbSpreadsheetId, sheetsDbImpersonate } from '../ses/config.js';
import { normalizeSkills } from '../ses/skillDict.js';
import { normalizePrefecture } from '../ses/prefecture.js';
import { SafeLogError } from '../ses/redact.js';
import { SheetBook, sameCells, type Cell } from './sheetBook.js';
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
    return auth ? google.sheets({ version: 'v4', auth }) : null;
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

function cellNum(cells: string[], idx: number): number | null {
  const v = (cells[idx] ?? '').trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function cellStr(cells: string[], idx: number): string {
  return idx < 0 ? '' : (cells[idx] ?? '').trim();
}

// 文面など改行・前後空白も意味を持つセル（トリムしない）
function rawCell(cells: string[], idx: number): string {
  return idx < 0 ? '' : (cells[idx] ?? '');
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

// 新しい順に並べ、受信日時が since 以降のものに絞って limit 件まで返す（追記順＝古い順のタブから最新を取るため）
function newestFirst<T extends { receivedAt: Date }>(items: T[], limit: number, since?: Date): T[] {
  const sinceMs = since ? since.getTime() : -Infinity;
  return items
    .filter((x) => x.receivedAt.getTime() >= sinceMs)
    .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
    .slice(0, limit);
}

// 募集中の案件を新しい順に limit 件まで返す。receivedSince 指定時はその日時以降に受信した案件に絞る
export async function fetchOpenProjectsSheets(limit = 100, receivedSince?: Date): Promise<Project[]> {
  if (!configured()) {
    console.warn('SheetsDB: 案件なしで継続します');
    return [];
  }
  const rows = await readRows('案件');
  const stCol = colIndex('案件', 'ステータス');
  const open = rows.filter((r) => cellStr(r.cells, stCol) !== '終了').map((r) => rowToProject(r.cells));
  return newestFirst(open, limit, receivedSince);
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

// 提案可の要員を新しい順に limit 件まで返す。receivedSince 指定時はその日時以降に受信した要員に絞る
export async function fetchAvailableEngineersSheets(limit = 100, receivedSince?: Date): Promise<Engineer[]> {
  if (!configured()) {
    console.warn('SheetsDB: 要員なしで継続します');
    return [];
  }
  const rows = await readRows('要員');
  const stCol = colIndex('要員', 'ステータス');
  const available = rows.filter((r) => cellStr(r.cells, stCol) !== '決定済').map((r) => rowToEngineer(r.cells));
  return newestFirst(available, limit, receivedSince);
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

export async function saveMatchSheets(match: MatchResult): Promise<string> {
  if (!configured()) return '';
  const idCol = colIndex('マッチ', 'ID');
  // 再実行で行が増殖しないよう、同じペアのマッチID（案件ID×要員IDから作る安定ID）の既存行があれば更新（upsert）。
  // タイトル（案件名×イニシャル）は別ペアと重なり得るため鍵にしない。
  // 人が編集する列（ステータス・担当者メール・下書き状態）は既存値を保持し、機械の初期値で巻き戻さない
  const row = await upsertRow('マッチ', 'ID', match.id, (existing) => {
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

// 判定済みのマッチID（通常バッチで同じペアをLLMで判定し直さないため）
export async function fetchJudgedMatchIdsSheets(): Promise<Set<string>> {
  if (!configured()) return new Set();
  const rows = await readRows('マッチ');
  const idCol = colIndex('マッチ', 'ID');
  return new Set(rows.map((r) => cellStr(r.cells, idCol)).filter(Boolean));
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
  senderEmail: string; // 担当者メール（ログに出さないこと）
  projectState: string;
  engineerState: string;
  draftData: string; // 下書きデータ列のJSON（mapping.parseDraftData で読む）
}

function toDraftRequestRow(tab: string, cells: string[]): DraftRequestRow {
  const c = (name: string) => cellStr(cells, colIndex(tab, name));
  // 状態列の無い側は「不要」とみなし、作成対象にも書き込み対象にもしない
  const state = (side: DraftSide) =>
    colIndex(tab, DRAFT_STATE_COLUMNS[side]) >= 0 ? c(DRAFT_STATE_COLUMNS[side]) : DRAFT_STATE.notNeeded;
  return {
    tab,
    id: c('ID'),
    senderEmail: c('担当者メール'),
    projectState: state('project'),
    engineerState: state('engineer'),
    draftData: c('下書きデータ'),
  };
}

// 担当者メールが入っている行（行キャッシュから。状態による絞り込みは呼び出し側）
export async function listDraftRequestRowsSheets(tab: string): Promise<DraftRequestRow[]> {
  if (!configured() || !draftRequestTabs().includes(tab)) return [];
  const rows = await readRows(tab);
  if (book.hasHeaderConflict(tab)) {
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
  states: Partial<Record<DraftSide, string>>,
): Promise<boolean> {
  const hit = await locateRow(tab, 'ID', id);
  if (!hit) return false;
  const updates: Array<[string, Cell]> = [];
  for (const side of Object.keys(DRAFT_STATE_COLUMNS) as DraftSide[]) {
    const value = states[side];
    if (value !== undefined) updates.push([DRAFT_STATE_COLUMNS[side], value]);
  }
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
  const drafts = mergeDraftColumns(existing ? readDraftColumns(tab, existing) : null, c.draftToProject, undefined);
  return [
    c.id, c.properLabel, c.projectTitle, round1(c.projectRate), round1(c.requiredProjectRate), round1(c.rateGapMan),
    Math.round(c.skillMatchRate * 100), c.band === 'strong' ? '強マッチ' : '参考提案', properVerdict(c), c.score,
    c.reason, c.projectId, c.agentEmail,
    keep('検出日時') || c.detectedAt.toISOString(), // 初回検出日時を保つ（毎回の書き直しを避ける）
    keep('ステータス') || matchStatusLabel('unconfirmed'),
    senderEmail, drafts.projectState, drafts.projectText, drafts.data,
  ];
}

// 候補を ID で upsert する。人の列（ステータス・担当者メール・案件側下書き状態）は保持し、
// 内容が変わらない行は書き込まない（毎回の実行で候補数ぶんのAPI呼び出しをしないため）。新規行はまとめて追記。
// 保存（追記・更新）した行数を返す
export async function saveProperCandidatesSheets(candidates: ProperCandidate[]): Promise<number> {
  if (!configured() || candidates.length === 0) return 0;
  const tab = PROPER_CANDIDATE_TAB;
  await readRows(tab); // タブの自動生成とヘッダー検証を先に済ませる
  if (book.hasHeaderConflict(tab)) {
    throw new SafeLogError(`SheetsDB: 「${tab}」タブのヘッダー行が定義と異なるため、プロパー候補を保存しません`);
  }
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
