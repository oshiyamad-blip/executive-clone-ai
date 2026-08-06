// Googleスプレッドシート版のSESデータ保存層（DB_PROVIDER=sheets）。
// 1つのスプレッドシートに6タブ（案件/要員/マッチ/自社社員/評価/スキル同義）を持ち、
// タブとヘッダー行は初回アクセス時に自動生成する（Notionのような手動DB作成は不要）。
// 認証はサービスアカウント+DWD（DWD側に spreadsheets スコープの登録が必要）。
// 設定不足時は warn して縮退（保存スキップ/空配列）— Notion版と同じ振る舞い。
import { google, type sheets_v4 } from 'googleapis';
import { getGoogleAuth } from '../collectors/googleAuth.js';
import { sheetsDbSpreadsheetId } from '../ses/config.js';
import { normalizeSkills } from '../ses/skillDict.js';
import { normalizePrefecture } from '../ses/prefecture.js';
import {
  remoteLabel,
  labelToRemote,
  matchStatusLabel,
  FB_VERDICT_LABEL,
  replyMetaJson,
  parseReplyMeta,
  joinList,
  splitList,
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
    return await fn();
  } finally {
    setTimeout(release, MIN_INTERVAL_MS);
  }
}

const SHEETS_RW_SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

let _api: sheets_v4.Sheets | null = null;
function api(): sheets_v4.Sheets | null {
  if (_api) return _api;
  const auth = getGoogleAuth(SHEETS_RW_SCOPES);
  if (!auth) return null;
  _api = google.sheets({ version: 'v4', auth });
  return _api;
}

function configured(): boolean {
  if (!sheetsDbSpreadsheetId()) {
    console.warn('SheetsDB: SHEETS_DB_SPREADSHEET_ID が未設定 — 保存・読出をスキップします');
    return false;
  }
  if (!api()) {
    console.warn('SheetsDB: Google認証(GOOGLE_SA_*)が未設定 — 保存・読出をスキップします');
    return false;
  }
  return true;
}

// タブ定義（列順は保存・読出の両方が依存する。変更時は既存シートの移行が必要）
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
    '案件側下書きURL', '要員側下書きURL', 'ステータス', '検出日時',
  ],
  自社社員: ['ID', '表示名', 'スキル', '経験年数', '必要案件単価', '居住地', 'リモート希望', '稼働可能日', 'ステータス'],
  評価: ['日時', '元マッチID', 'マッチ名', '評価', 'メモ', '評価者', 'バンド'],
  スキル同義: ['スキルA', 'スキルB', '追加者', '日時'],
};

let tabsEnsured = false;

// タブとヘッダー行を必要に応じて自動生成する（初回のみ実行）
async function ensureTabs(): Promise<void> {
  if (tabsEnsured) return;
  const sheetsApi = api()!;
  const spreadsheetId = sheetsDbSpreadsheetId();
  const meta = await throttle(() =>
    sheetsApi.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' }),
  );
  const existing = new Set((meta.data.sheets ?? []).map((s) => s.properties?.title ?? ''));
  const missing = Object.keys(TABS).filter((t) => !existing.has(t));
  if (missing.length > 0) {
    await throttle(() =>
      sheetsApi.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) },
      }),
    );
    for (const title of missing) {
      await throttle(() =>
        sheetsApi.spreadsheets.values.update({
          spreadsheetId,
          range: `${title}!A1`,
          valueInputOption: 'RAW',
          requestBody: { values: [TABS[title]] },
        }),
      );
    }
    console.log(`SheetsDB: タブを自動生成しました（${missing.join(', ')}）`);
  }
  tabsEnsured = true;
}

// タブの全データ行を読む（ヘッダー行を除く）。戻り値は [rowIndex(シート上の行番号), cells[]]
async function readRows(tab: string): Promise<Array<{ rowNumber: number; cells: string[] }>> {
  await ensureTabs();
  const res = await throttle(() =>
    api()!.spreadsheets.values.get({ spreadsheetId: sheetsDbSpreadsheetId(), range: tab }),
  );
  const values = (res.data.values ?? []) as string[][];
  return values.slice(1).map((cells, i) => ({ rowNumber: i + 2, cells: cells.map((c) => String(c ?? '')) }));
}

async function appendRow(tab: string, row: Array<string | number | null>): Promise<void> {
  await ensureTabs();
  await throttle(() =>
    api()!.spreadsheets.values.append({
      spreadsheetId: sheetsDbSpreadsheetId(),
      range: `${tab}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row.map((v) => (v === null ? '' : v))] },
    }),
  );
}

async function updateRow(tab: string, rowNumber: number, row: Array<string | number | null>): Promise<void> {
  await throttle(() =>
    api()!.spreadsheets.values.update({
      spreadsheetId: sheetsDbSpreadsheetId(),
      range: `${tab}!A${rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [row.map((v) => (v === null ? '' : v))] },
    }),
  );
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

function projectToRow(p: Project): Array<string | number | null> {
  return [
    p.id, p.title, joinList(p.requiredSkills), joinList(p.preferredSkills), p.rateMin, p.rateMax,
    p.location, remoteLabel(p.remote), p.startPeriod, p.startDate ?? '', p.duration, p.businessFlow,
    p.agentCompany, p.agentContact, p.agentEmail, p.sourceMailId, replyMetaJson(p.replyTarget),
    p.receivedAt.toISOString(), p.status === 'closed' ? '終了' : '募集中',
  ];
}

export async function saveProjectSheets(project: Project): Promise<string> {
  if (!configured()) return '';
  const rows = await readRows('案件');
  const idCol = colIndex('案件', 'ID');
  const hit = rows.find((r) => cellStr(r.cells, idCol) === project.id);
  if (hit) await updateRow('案件', hit.rowNumber, projectToRow(project));
  else await appendRow('案件', projectToRow(project));
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

function engineerToRow(e: Engineer): Array<string | number | null> {
  return [
    e.id, e.displayName, joinList(e.skills), e.experienceYears, e.desiredRate, e.residence,
    remoteLabel(e.remoteWish), e.availableFrom ?? '', e.agentCompany, e.agentContact, e.agentEmail,
    e.sourceMailId, replyMetaJson(e.replyTarget), e.receivedAt.toISOString(),
    e.status === 'assigned' ? '決定済' : '提案可',
  ];
}

export async function saveEngineerSheets(engineer: Engineer): Promise<string> {
  if (!configured()) return '';
  const rows = await readRows('要員');
  const idCol = colIndex('要員', 'ID');
  const hit = rows.find((r) => cellStr(r.cells, idCol) === engineer.id);
  if (hit) await updateRow('要員', hit.rowNumber, engineerToRow(engineer));
  else await appendRow('要員', engineerToRow(engineer));
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

export async function saveMatchSheets(match: MatchResult): Promise<string> {
  if (!configured()) return '';
  const rows = await readRows('マッチ');
  const titleCol = colIndex('マッチ', 'マッチ名');
  const idCol = colIndex('マッチ', 'ID');
  const stCol = colIndex('マッチ', 'ステータス');
  // 再実行で行が増殖しないよう、同タイトルの既存行があれば更新（upsert）。
  // 人が進めたステータスを機械の「未確認」で巻き戻さないため、更新時は既存ステータスを保持する
  const hit = rows.find((r) => cellStr(r.cells, titleCol) === match.title);
  const status = hit ? cellStr(hit.cells, stCol) || matchStatusLabel(match.status) : matchStatusLabel(match.status);
  const id = hit ? cellStr(hit.cells, idCol) || match.id : match.id;
  const row: Array<string | number | null> = [
    id, match.title, match.grossMarginJpy, match.score, match.reason, match.projectId, match.engineerId,
    match.draftToProject?.url ?? '', match.draftToEngineer?.url ?? '', status, match.detectedAt.toISOString(),
  ];
  if (hit) await updateRow('マッチ', hit.rowNumber, row);
  else await appendRow('マッチ', row);
  return id;
}

export async function updateMatchStatusSheets(id: string, status: MatchStatus): Promise<void> {
  if (!configured()) return;
  const rows = await readRows('マッチ');
  const idCol = colIndex('マッチ', 'ID');
  const hit = rows.find((r) => cellStr(r.cells, idCol) === id);
  if (!hit) {
    console.warn(`SheetsDB: ステータス更新対象のマッチが見つかりません (${id})`);
    return;
  }
  const stColLetter = String.fromCharCode(65 + colIndex('マッチ', 'ステータス')); // A起点の列文字
  await throttle(() =>
    api()!.spreadsheets.values.update({
      spreadsheetId: sheetsDbSpreadsheetId(),
      range: `マッチ!${stColLetter}${hit.rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[matchStatusLabel(status)]] },
    }),
  );
}

// ===== 自社社員 =====

export async function saveOwnEngineerSheets(own: OwnEngineer): Promise<string> {
  if (!configured()) return '';
  const rows = await readRows('自社社員');
  const idCol = colIndex('自社社員', 'ID');
  const row: Array<string | number | null> = [
    own.id, own.displayName, joinList(own.skills), own.experienceYears, own.requiredProjectRate,
    own.residence, remoteLabel(own.remoteWish), own.availableFrom ?? '',
    own.status === 'assigned' ? 'アサイン済' : '稼働可',
  ];
  const hit = rows.find((r) => cellStr(r.cells, idCol) === own.id);
  if (hit) await updateRow('自社社員', hit.rowNumber, row);
  else await appendRow('自社社員', row);
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
  await appendRow('評価', [fb.at, fb.matchId, fb.matchTitle, FB_VERDICT_LABEL[fb.verdict], fb.note, fb.reviewer, fb.band ?? '']);
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
  await appendRow('スキル同義', [e.a, e.b, e.addedBy, e.at]);
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
