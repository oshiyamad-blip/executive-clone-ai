// プロパー管理表（スプレッドシートの「プロパー管理」タブ。スキルシート1ファイル＝1行）の同期と読み出し。
// 人が入力する列（氏名・提案用表記・稼働状況・必要案件単価・稼働可能日）は、入力済みの値を決して書き換えない。
// 機械が書く列（スキル〜抽出メモ）は、スキルシートが新規・更新されたときだけ抽出し直して更新する
// （変更のないファイルはLLMを呼ばない。1回の実行で抽出する件数には上限があり、残りは次回以降）。
// ログにはファイルIDと件数だけを出す（氏名・ファイル名・抽出内容は出さない）。
import { createHash } from 'crypto';
import { google } from 'googleapis';
import { SheetBook, googleTransientKind, GOOGLE_REQUEST_TIMEOUT_MS, type Cell, type CachedRow } from '../../database/sheetBook.js';
import { properEngineerIdOf } from '../../database/sheets.js';
import { joinList, splitList, remoteLabel, labelToRemote } from '../../database/mapping.js';
import { properMasterSpreadsheetId, properMaxExtractPerRun } from '../config.js';
import { normalizeSkills } from '../skillDict.js';
import { normalizePrefecture } from '../prefecture.js';
import { jstStamp } from '../pendingDrafts.js';
import { healLlmCall, isRetryableLlmError } from '../heal/retry.js';
import { recordHealEvent } from '../heal/events.js';
import { errKind, safeErr, SafeLogError } from '../redact.js';
import { properGoogleAuth } from './auth.js';
import {
  listSkillSheetFiles,
  loadSkillSheetContent,
  precheckSkillSheet,
  skillSheetFormat,
  type SkillSheetFile,
  type SkillSheetContent,
} from './drive.js';
import { extractSkillSheet, sanitizeInitials, type SkillSheetProfile } from './extractSkillSheet.js';
import { pastRunDeadline } from '../schedule.js';
import type { ProperEngineer } from '../../types/index.js';

export const PROPER_MASTER_TAB = 'プロパー管理';

export const PROPER_MASTER_COLUMNS = [
  '氏名', '提案用表記', '稼働状況', '必要案件単価', '稼働可能日',
  'スキル', '経験年数', '居住地', 'リモート希望', 'スキルシート', 'ファイルID', 'ファイル更新日時', '抽出日時', '抽出メモ',
];

export const PROPER_STATUS = { available: '稼働可', assigned: 'アサイン済', excluded: '対象外' } as const;

export const MISSING_FILE_MEMO = 'ファイルが見つかりません';

// 一時的な失敗（API障害等）で再試行する回数の上限。超えたらファイルが更新されるまで再抽出しない
const MAX_EXTRACT_ATTEMPTS = 3;

const SHEETS_SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

const book = new SheetBook({
  label: 'プロパー管理',
  tabs: { [PROPER_MASTER_TAB]: PROPER_MASTER_COLUMNS },
  spreadsheetId: properMasterSpreadsheetId,
  createApi: () => {
    const auth = properGoogleAuth(SHEETS_SCOPES);
    return auth ? google.sheets({ version: 'v4', auth, timeout: GOOGLE_REQUEST_TIMEOUT_MS }) : null;
  },
  missingIdMessage: 'PROPER_MASTER_SPREADSHEET_ID が未設定',
  missingAuthMessage:
    'Google認証（GOOGLE_SA_KEY_JSON 等）が未設定、または PROPER_GOOGLE_IMPERSONATE に対応する PROPER_GOOGLE_SA_KEY_JSON が未設定',
  accessHint:
    'IDが正しいか、サービスアカウント（PROPER_GOOGLE_SA_* 未設定ならメインのSA）のメールアドレスに編集者として共有済みか' +
    '（PROPER_GOOGLE_IMPERSONATE 指定時はそのユーザーが編集できるか）を確認してください',
  dropdowns: { [PROPER_MASTER_TAB]: { 稼働状況: Object.values(PROPER_STATUS) } },
});

export function properMasterConfigured(): boolean {
  return book.configured();
}

export function resetProperMasterCache(): void {
  book.reset();
}

function cell(cells: string[] | null, name: string): string {
  return cells?.[PROPER_MASTER_COLUMNS.indexOf(name)] ?? '';
}

// ログ用のファイルの参照（DriveのファイルIDはそのままURLになり、リンク共有のスキルシートを開けてしまうため一方向の短いハッシュにする。
// 元のIDは管理表の「ファイルID」列にある）
export function fileRef(fileId: string): string {
  return createHash('sha256').update(fileId).digest('hex').slice(0, 8);
}

// ===== セル値の解釈（人が入力する列は表記ゆれを許す） =====

// 必要案件単価: 「65」「65万」「６５万円」「650,000円」などを万円/月の数値にする（範囲なら先頭の値）
export function parseManYen(raw: string): number | null {
  const s = raw.normalize('NFKC').replace(/[,\s]/g, '');
  const m = s.match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const yen = n >= 1000 || (/円/.test(s) && !/万/.test(s));
  return yen ? n / 10000 : n;
}

// 稼働可能日: 「2026-10-01」「2026/10/1」「2026年10月1日」「2026年10月」（→1日）をISO日付にする。
// 「即日」「10月〜」など年の無い表記は判定不能として null（時期の条件では除外しない）
export function parseAvailableFrom(raw: string): string | null {
  const s = raw.normalize('NFKC').trim();
  const m = s.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})(?:\s*[-/.月]\s*(\d{1,2}))?/);
  if (!m) return null;
  const month = Number(m[2]);
  const day = m[3] ? Number(m[3]) : 1;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${m[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseNumberCell(raw: string): number | null {
  const m = raw.normalize('NFKC').match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

// ===== 行の組み立て（純関数） =====

export type ExtractionOutcome =
  | { kind: 'ok'; profile: SkillSheetProfile }
  | { kind: 'error'; memo: string; retry: boolean };

function successMemo(p: SkillSheetProfile): string {
  const notes: string[] = [];
  if (!p.initials) notes.push('提案用表記（イニシャル）を読み取れませんでした。入力してください');
  if (p.skills.length === 0) notes.push('スキルを読み取れませんでした');
  if (p.desiredRateMan !== null) notes.push(`シート記載の希望単価: ${p.desiredRateMan}万円（参考）`);
  return notes.join(' / ');
}

// 新規・更新されたファイルについて書き込むセル（列名と値）。機械の列は毎回更新する。
// 人の列は、まだ一度も抽出に成功していない行の空欄だけを抽出結果で埋める（入力済みの値は変えない）
export function planMasterCells(
  existing: string[] | null,
  file: SkillSheetFile,
  outcome: ExtractionOutcome,
  now: Date,
): Array<[string, Cell]> {
  const updates: Array<[string, Cell]> = [];
  if (outcome.kind === 'ok') {
    const p = outcome.profile;
    if (cell(existing, '抽出日時').trim() === '') {
      const fill = (name: string, value: string) => {
        if (value && cell(existing, name).trim() === '') updates.push([name, value]);
      };
      fill('氏名', p.displayName);
      fill('提案用表記', p.initials);
      fill('稼働状況', PROPER_STATUS.available);
      fill('稼働可能日', p.availableFromIso ?? p.availableDateText);
    }
    updates.push(
      ['スキル', joinList(p.skills)],
      ['経験年数', p.experienceYears],
      ['居住地', p.residence],
      ['リモート希望', remoteLabel(p.remoteWish)],
      ['ファイル更新日時', file.modifiedTime],
      ['抽出日時', jstStamp(now)],
      ['抽出メモ', successMemo(p)],
    );
  } else {
    // 再試行する失敗は更新日時を記録しない（次回の実行で「変更あり」として抽出し直す）
    updates.push(
      ['ファイル更新日時', outcome.retry ? cell(existing, 'ファイル更新日時') : file.modifiedTime],
      ['抽出メモ', outcome.memo],
    );
  }
  updates.push(['スキルシート', file.webViewLink], ['ファイルID', file.id]);
  return updates;
}

function toRow(updates: Array<[string, Cell]>): Cell[] {
  const row: Cell[] = PROPER_MASTER_COLUMNS.map(() => '');
  for (const [name, value] of updates) row[PROPER_MASTER_COLUMNS.indexOf(name)] = value;
  return row;
}

// Drive はレート制限を 403（rateLimitExceeded）でも返すため、429・5xx・通信断と同じく一時的な失敗として扱う
function isTransientGoogleError(err: unknown): boolean {
  if (googleTransientKind(err) !== null) return true;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && ['ENOTFOUND', 'EAI_AGAIN'].includes(code);
}

// 失敗の記録。抽出メモに「N回目」を残し、一時的な失敗は上限回数まで次回の実行で再試行する
export function failureOutcome(prevMemo: string, err: unknown, stage: 'load' | 'extract'): ExtractionOutcome {
  const prev = prevMemo.startsWith('エラー') ? Number(prevMemo.match(/（(\d+)回目）/)?.[1] ?? 0) : 0;
  const attempts = prev + 1;
  const transient = stage === 'extract' ? isRetryableLlmError(err) : isTransientGoogleError(err);
  const retry = transient && attempts < MAX_EXTRACT_ATTEMPTS;
  const reason =
    err instanceof SafeLogError
      ? err.message
      : `${stage === 'extract' ? '抽出' : 'ファイルの読み込み'}に失敗しました（${errKind(err)}）`;
  const next = retry ? '次回の実行で再試行します' : 'ファイルを更新すると再抽出します';
  return { kind: 'error', memo: `エラー: ${reason}（${attempts}回目）— ${next}`, retry };
}

type SkillSheetExtractor = typeof extractSkillSheet;

// オフライン自己検証（npm run ses:flow:check）用のLLM抽出の差し替え口（本番コードからは呼ばない）
let testExtractor: SkillSheetExtractor | null = null;

export function __setSkillSheetExtractorForTest(fn: SkillSheetExtractor | null): void {
  testExtractor = fn;
}

async function extractFile(file: SkillSheetFile, prevMemo: string): Promise<ExtractionOutcome> {
  let content: SkillSheetContent;
  try {
    content = await loadSkillSheetContent(file);
  } catch (err) {
    console.error(`プロパー: スキルシートを読み込めません (file ${fileRef(file.id)}): ${safeErr(err)}`);
    return failureOutcome(prevMemo, err, 'load');
  }
  if (content.kind === 'text' && !content.text.trim()) {
    return {
      kind: 'error',
      memo: 'エラー: 文字を取り出せませんでした（画像だけのファイル等。PDFで保存し直すと読み取れます）',
      retry: false,
    };
  }
  const extract = testExtractor ?? extractSkillSheet;
  try {
    return { kind: 'ok', profile: await extract(content) };
  } catch (err) {
    const healed = await healLlmCall(`プロパー抽出(file ${fileRef(file.id)})`, err, (a) => extract(content, a));
    if (healed) return { kind: 'ok', profile: healed };
    console.error(`プロパー: スキルシートの抽出に失敗 (file ${fileRef(file.id)}): ${safeErr(err)}`);
    return failureOutcome(prevMemo, err, 'extract');
  }
}

// ===== 同期 =====

export interface ProperSyncResult {
  listed: number; // 対応形式のファイル数
  added: number; // 管理表に追加した行
  updated: number; // 更新した行
  unchanged: number; // 変更がなく抽出しなかったファイル
  extracted: number; // 抽出に成功したファイル
  failed: number; // 抽出・読み込みに失敗したファイル（抽出メモに理由）
  deferred: number; // 1回の上限を超えたため次回以降に回したファイル
  missing: number; // 今回「ファイルが見つかりません」にした行
  writeFailed: number; // 管理表への書き込みに失敗した行
  unsupportedNames: string[]; // 未対応形式のファイル名（サマリメール用。ログに出さない）
  // 一覧を取得できたときのファイルID。取得できなければ null（ファイルの有無で候補を絞らない）
  presentFileIds: Set<string> | null;
}

function emptySyncResult(): ProperSyncResult {
  return {
    listed: 0, added: 0, updated: 0, unchanged: 0, extracted: 0, failed: 0, deferred: 0, missing: 0, writeFailed: 0,
    unsupportedNames: [], presentFileIds: null,
  };
}

async function writeMasterRow(file: SkillSheetFile, known: boolean, outcome: ExtractionOutcome): Promise<'added' | 'updated'> {
  const now = new Date();
  // 書き込み直前に行を読み直し、人の最新の入力を見てから空欄だけを埋める
  const fresh = known ? await book.locateRow(PROPER_MASTER_TAB, 'ファイルID', file.id) : null;
  if (!fresh) {
    await book.appendRows(PROPER_MASTER_TAB, [toRow(planMasterCells(null, file, outcome, now))]);
    return 'added';
  }
  await book.writeCells(PROPER_MASTER_TAB, fresh, planMasterCells(fresh.cells, file, outcome, now));
  return 'updated';
}

// 一覧から消えたファイルの行に「ファイルが見つかりません」を付け、戻ってきたら外す（行は消さない）
async function reconcileMissing(rows: CachedRow[], present: Set<string>, touched: Set<string>, result: ProperSyncResult): Promise<void> {
  const withFile = rows.filter((r) => cell(r.cells, 'ファイルID').trim());
  for (const r of withFile) {
    const id = cell(r.cells, 'ファイルID').trim();
    if (touched.has(id)) continue;
    const gone = !present.has(id);
    if (gone === cell(r.cells, '抽出メモ').startsWith(MISSING_FILE_MEMO)) continue;
    try {
      const fresh = await book.locateRow(PROPER_MASTER_TAB, 'ファイルID', id);
      if (!fresh) continue;
      const memo = cell(fresh.cells, '抽出メモ');
      const marked = memo.startsWith(MISSING_FILE_MEMO);
      if (gone && !marked) {
        await book.writeCells(PROPER_MASTER_TAB, fresh, [['抽出メモ', memo ? `${MISSING_FILE_MEMO} / ${memo}` : MISSING_FILE_MEMO]]);
        result.missing += 1;
      } else if (!gone && marked) {
        await book.writeCells(PROPER_MASTER_TAB, fresh, [['抽出メモ', memo.slice(MISSING_FILE_MEMO.length).replace(/^ \/ /, '')]]);
      }
    } catch (err) {
      console.error(`プロパー: 管理表の更新に失敗 (file ${fileRef(id)}): ${safeErr(err)}`);
      result.writeFailed += 1;
    }
  }
}

// Driveのスキルシートと管理表を突き合わせ、新規は行追加・更新は機械の列を更新・消えたファイルは印を付ける
export async function syncProperMaster(): Promise<ProperSyncResult> {
  const result = emptySyncResult();
  if (!book.configured()) return result;

  let files: SkillSheetFile[];
  try {
    files = await listSkillSheetFiles();
  } catch (err) {
    console.error(`プロパー: スキルシートの一覧を取得できません: ${safeErr(err)}`);
    recordHealEvent('warn', 'プロパーのスキルシート一覧を取得できませんでした（管理表の既存の内容で候補を探します）');
    return result;
  }
  const supported = files.filter((f) => skillSheetFormat(f) !== null);
  // ショートカットの参照先はフォルダの外のファイルのため、名前をサマリに載せない
  result.unsupportedNames = files.filter((f) => skillSheetFormat(f) === null && !f.viaShortcut).map((f) => f.name);
  result.listed = supported.length;
  result.presentFileIds = new Set(supported.map((f) => f.id));

  const rows = await book.readRows(PROPER_MASTER_TAB);
  const knownFiles = rows.filter((r) => cell(r.cells, 'ファイルID').trim()).length;
  if (supported.length === 0 && knownFiles > 0) {
    // フォルダIDの設定違い・共有の解除などで空に見えている可能性が高いため、全員を所在不明にせず前回までの内容で続ける
    recordHealEvent(
      'warn',
      `プロパーのスキルシートのフォルダが空のため、管理表の${knownFiles}行を「${MISSING_FILE_MEMO}」にしませんでした（フォルダの設定・共有を確認してください）`,
    );
    result.presentFileIds = null;
    return result;
  }
  const byFileId = new Map<string, CachedRow>();
  for (const r of rows) {
    const id = cell(r.cells, 'ファイルID').trim();
    if (id && !byFileId.has(id)) byFileId.set(id, r);
  }

  // 新規・更新（記録済みの更新日時と異なる）ファイルだけを、更新の新しい順に処理する
  const work = supported
    .filter((f) => {
      const row = byFileId.get(f.id);
      return !row || cell(row.cells, 'ファイル更新日時') !== f.modifiedTime;
    })
    .sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
  result.unchanged = supported.length - work.length;

  const cap = properMaxExtractPerRun();
  let attempts = 0;
  const touched = new Set<string>();
  for (const file of work) {
    const known = byFileId.get(file.id);
    const precheck = precheckSkillSheet(file);
    let outcome: ExtractionOutcome;
    if (precheck) {
      outcome = { kind: 'error', memo: `エラー: ${precheck}`, retry: false };
    } else if (attempts >= cap || pastRunDeadline()) {
      result.deferred += 1;
      continue;
    } else {
      attempts += 1;
      outcome = await extractFile(file, cell(known?.cells ?? null, '抽出メモ'));
    }
    if (outcome.kind === 'ok') result.extracted += 1;
    else result.failed += 1;
    try {
      result[await writeMasterRow(file, Boolean(known), outcome)] += 1;
      touched.add(file.id);
    } catch (err) {
      console.error(`プロパー: 管理表への書き込みに失敗 (file ${fileRef(file.id)}): ${safeErr(err)}`);
      result.writeFailed += 1;
    }
  }

  await reconcileMissing(rows, result.presentFileIds, touched, result);
  return result;
}

// ===== 突合用の読み出し =====

// 案件スプレッドシート（営業の誰もが編集できる）の「プロパー」列とサマリメールに出す社員の表記。
// 氏名は編集者を人事・運用担当に限ったプロパー管理表にだけ置き、ここでは提案用表記（イニシャル）だけにする
export function properLabelOf(e: Pick<ProperEngineer, 'proposalLabel'>): string {
  return e.proposalLabel || '（提案用表記未入力。プロパー管理表で確認）';
}

// 管理表の1行 → 突合対象の自社社員。稼働状況が「稼働可」でスキルのある行だけ（それ以外は null）
export function rowToProperEngineer(cells: string[]): ProperEngineer | null {
  const c = (name: string) => cell(cells, name).trim();
  const fileId = c('ファイルID');
  if (!fileId || c('稼働状況') !== PROPER_STATUS.available) return null;
  const skills = normalizeSkills(splitList(c('スキル')));
  if (skills.length === 0) return null;
  const residence = c('居住地');
  const available = c('稼働可能日');
  const fullName = c('氏名');
  // 人が手で入れた値も含め、イニシャルの形でなければ使わない（社外に出る提案文面に氏名が載らないように）
  const proposalLabel = sanitizeInitials(c('提案用表記'), fullName);
  return {
    id: properEngineerIdOf(fileId),
    displayName: fullName || proposalLabel,
    fullName,
    proposalLabel,
    fileId,
    skillSheetUrl: c('スキルシート'),
    skills,
    experienceYears: parseNumberCell(c('経験年数')),
    requiredProjectRate: parseManYen(c('必要案件単価')),
    residence,
    prefecture: normalizePrefecture(residence),
    availableDate: available,
    availableFrom: parseAvailableFrom(available),
    remoteWish: labelToRemote(c('リモート希望')),
    status: 'available',
  };
}

// 突合対象の自社社員。presentFileIds があれば、フォルダから消えたスキルシートの行は除く。
// 人が行を複製して同じファイルIDの行が複数あるときは、同期が更新する行と同じく先頭の行だけを使う
export async function loadProperEngineers(presentFileIds: Set<string> | null): Promise<ProperEngineer[]> {
  if (!book.configured()) return [];
  const rows = await book.readRows(PROPER_MASTER_TAB);
  const seen = new Set<string>();
  const firstRows = rows.filter((r) => {
    const id = cell(r.cells, 'ファイルID').trim();
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return firstRows
    .map((r) => rowToProperEngineer(r.cells))
    .filter((e): e is ProperEngineer => e !== null && (!presentFileIds || presentFileIds.has(e.fileId)));
}
