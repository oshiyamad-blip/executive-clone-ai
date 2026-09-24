// オフライン自己検証（npm run ses:flow:check）用の、Google Sheets v4 / Drive v3 のインメモリ偽物と偽のメール送受信。
// 本番コードが使う範囲だけを、実APIと同じ振る舞いで再現する:
// - 値の読み出しは末尾の空セル・末尾の空行を返さない（途中の空行は []）。範囲が空なら values 自体が無い。
//   既定（FORMATTED_VALUE）は人が付けた表示形式（formatColumn）を通した文字列、UNFORMATTED_VALUE は数値を数値のまま返す
// - 書き込みは valueInputOption=RAW 以外を拒否し、null のセルは「変更しない」、'' は「消去」として扱う
// - append は範囲の先頭行から続く表（空行で途切れる）の直後に行を挿入し（INSERT_ROWS。下の行はずれる）、
//   updates.updatedRange（'タブ'!A12:K13 の形）を返す
// - A1表記は引用符付きタブ名（'' のエスケープ込み）・A5:K5・1:1・タブ名だけに対応。存在しないタブは 400
// - 1セル50,000文字を超える書き込み・シートの列数（グリッド）を超える書き込みは 400
// - タブの作成時の行数・列数（gridProperties）を持ち、列の追加（appendDimension）・行の削除（deleteDimension）に対応
import type { sheets_v4, drive_v3 } from 'googleapis';
import type { MailTransport, CollectOptions, CollectOutcome } from '../mail/index.js';
import { pickForRun } from '../schedule.js';
import { collectDays } from '../config.js';
import type { DraftRef, SesMailMeta, SesRawMail } from '../../types/index.js';

type Stored = string | number | boolean;
type Row = Array<Stored | undefined>;

const CELL_MAX_CHARS = 50_000;

// googleapis（gaxios）のエラーと同じく code と response.status を持つ
export class FakeApiError extends Error {
  readonly code: number;
  readonly response: { status: number };
  constructor(status: number, message: string) {
    super(message);
    this.name = 'FakeApiError';
    this.code = status;
    this.response = { status };
  }
}

interface A1 {
  tab: string;
  r1: number; // 1起点
  c1: number; // 0起点
  r2: number; // Infinity = 末尾まで
  c2: number;
}

function letterToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function indexToLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function parseA1(range: string): A1 {
  let tab: string;
  let rest: string;
  if (range.startsWith("'")) {
    let i = 1;
    let name = '';
    for (;;) {
      if (i >= range.length) throw new FakeApiError(400, `Unable to parse range: ${range}`);
      const ch = range[i];
      if (ch === "'") {
        if (range[i + 1] === "'") {
          name += "'";
          i += 2;
          continue;
        }
        i += 1;
        break;
      }
      name += ch;
      i += 1;
    }
    tab = name;
    rest = range.slice(i);
  } else {
    const bang = range.indexOf('!');
    tab = bang < 0 ? range : range.slice(0, bang);
    rest = bang < 0 ? '' : range.slice(bang);
  }
  if (!rest) return { tab, r1: 1, c1: 0, r2: Infinity, c2: Infinity };
  const m = rest.match(/^!([A-Z]*)(\d*)(?::([A-Z]*)(\d*))?$/);
  if (!m || (!m[1] && !m[2])) throw new FakeApiError(400, `Unable to parse range: ${range}`);
  const c1 = m[1] ? letterToIndex(m[1]) : 0;
  const r1 = m[2] ? Number(m[2]) : 1;
  if (m[3] === undefined && m[4] === undefined) return { tab, r1, c1, r2: m[2] ? r1 : Infinity, c2: m[1] ? c1 : Infinity };
  return { tab, r1, c1, r2: m[4] ? Number(m[4]) : Infinity, c2: m[3] ? letterToIndex(m[3]) : Infinity };
}

function quote(tab: string): string {
  return `'${tab.replace(/'/g, "''")}'`;
}

// FORMATTED_VALUE 相当（数値は文字列、未入力は ''）
function formatted(v: Stored | undefined): string {
  if (v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

function isEmptyRow(row: Row | undefined): boolean {
  return !row || row.every((c) => c === undefined || c === '');
}

interface FakeTab {
  sheetId: number;
  title: string;
  rows: Row[];
  columnCount: number;
  rowCount: number;
  formats: Map<number, (v: number) => string>; // 列番号 → 数値の表示形式（人が付けた「0"万円"」等）
}

// 既定のグリッド（Googleスプレッドシートでタブを作ったときと同じ 1000行×26列）
const DEFAULT_ROWS = 1000;
const DEFAULT_COLUMNS = 26;

export interface FakeCall {
  method: string;
  spreadsheetId: string;
  ranges: string[];
}

interface FailRule {
  method: string;
  tab?: string;
  status: number;
  times: number;
  afterCommit?: boolean; // 実行してから失敗を返す（書き込みは済んだのに応答が 5xx になった状況の再現）
}

interface ValueRangeInput {
  range?: string | null;
  values?: unknown[][] | null;
}

export class FakeSheets {
  private readonly books = new Map<string, Map<string, FakeTab>>();
  private nextSheetId = 100;
  readonly calls: FakeCall[] = [];
  readonly validations: Array<{ spreadsheetId: string; sheetId: number; column: number; options: string[] }> = [];
  // タブ全体の保護範囲（addProtectedRange）。editors は編集できるアカウント
  readonly protections: Array<{ spreadsheetId: string; sheetId: number; editors: string[]; warningOnly?: boolean }> = [];

  // タブが保護されているか（タブ全体の保護範囲があるか）
  isProtected(spreadsheetId: string, title: string): boolean {
    const t = this.book(spreadsheetId).get(title);
    return Boolean(t && this.protections.some((p) => p.spreadsheetId === spreadsheetId && p.sheetId === t.sheetId));
  }
  readonly violations: string[] = []; // 実APIなら拒否される・本番で起きてはならない呼び方
  deletedRows = 0;
  private readonly failRules: FailRule[] = [];
  // 次のAPI呼び出しの直前に1回だけ実行する処理（実行中に人がシートを編集した状況の再現用）
  private readonly beforeHooks: Array<{ method: string; fn: () => void }> = [];

  createBook(spreadsheetId: string): void {
    if (!this.books.has(spreadsheetId)) this.books.set(spreadsheetId, new Map());
  }

  // 既存のタブ（人が作った・旧バージョンのヘッダー等）を用意する
  seedTab(spreadsheetId: string, title: string, values: Stored[][], columnCount = DEFAULT_COLUMNS): void {
    this.createBook(spreadsheetId);
    this.book(spreadsheetId).set(title, {
      sheetId: this.nextSheetId++,
      title,
      rows: values.map((r) => [...r]),
      columnCount,
      rowCount: DEFAULT_ROWS,
      formats: new Map(),
    });
  }

  // 人が列に数値の表示形式を付ける（見出しの名前で列を指定。表示形式を通した値は FORMATTED_VALUE の読み出しにだけ現れる）
  formatColumn(spreadsheetId: string, title: string, header: string, format: (v: number) => string): void {
    const t = this.tab(spreadsheetId, title);
    const col = this.header(spreadsheetId, title).indexOf(header);
    if (col < 0) throw new Error(`fake: 列がありません (${header})`);
    t.formats.set(col, format);
  }

  // タブのグリッドの大きさ（セル数の上限の検証用）
  grid(spreadsheetId: string, title: string): { rows: number; columns: number } {
    const t = this.tab(spreadsheetId, title);
    return { rows: t.rowCount, columns: t.columnCount };
  }

  // 人の列の挿入（index の位置に列を差し込み、以降の列を右へずらす。見出しは header）
  insertColumnAt(spreadsheetId: string, title: string, index: number, header: string): void {
    const t = this.tab(spreadsheetId, title);
    t.rows.forEach((r, i) => {
      if (!r) return;
      while (r.length < index) r.push(undefined);
      r.splice(index, 0, i === 0 ? header : undefined);
    });
    t.columnCount += 1;
  }

  // 人（オーナー）のタブの削除（タブの保護も一緒に消える）
  deleteTab(spreadsheetId: string, title: string): void {
    const t = this.tab(spreadsheetId, title);
    this.book(spreadsheetId).delete(title);
    for (let i = this.protections.length - 1; i >= 0; i -= 1) {
      if (this.protections[i].spreadsheetId === spreadsheetId && this.protections[i].sheetId === t.sheetId) this.protections.splice(i, 1);
    }
  }

  // 人がタブを保護する（編集者を editors にした保護・警告だけの保護）
  protectAs(spreadsheetId: string, title: string, editors: string[], warningOnly = false): void {
    const t = this.tab(spreadsheetId, title);
    this.protections.push({ spreadsheetId, sheetId: t.sheetId, editors, warningOnly });
  }

  // バッチが付けた保護の数（タブ単位）
  protectionCount(spreadsheetId: string, title: string): number {
    const t = this.book(spreadsheetId).get(title);
    return t ? this.protections.filter((p) => p.spreadsheetId === spreadsheetId && p.sheetId === t.sheetId).length : 0;
  }

  // 人の見出しの変更
  renameHeader(spreadsheetId: string, title: string, from: string, to: string): void {
    const t = this.tab(spreadsheetId, title);
    const i = (t.rows[0] ?? []).findIndex((c) => formatted(c) === from);
    if (i < 0) throw new Error(`fake: 見出しがありません (${from})`);
    t.rows[0][i] = to;
  }

  failNext(method: string, status: number, tab?: string, times = 1, afterCommit = false): void {
    this.failRules.push({ method, tab, status, times, afterCommit });
  }

  beforeNext(method: string, fn: () => void): void {
    this.beforeHooks.push({ method, fn });
  }

  // ===== 人の操作・検証用のヘルパー =====

  tabNames(spreadsheetId: string): string[] {
    return [...this.book(spreadsheetId).keys()];
  }

  hasTab(spreadsheetId: string, title: string): boolean {
    return this.books.get(spreadsheetId)?.has(title) ?? false;
  }

  header(spreadsheetId: string, title: string): string[] {
    return (this.tab(spreadsheetId, title).rows[0] ?? []).map(formatted);
  }

  rawRows(spreadsheetId: string, title: string): string[][] {
    return this.tab(spreadsheetId, title).rows.map((r) => (r ?? []).map(formatted));
  }

  // ヘッダー行の列名をキーにしたデータ行（空行は除く）
  records(spreadsheetId: string, title: string): Array<Record<string, string>> {
    const header = this.header(spreadsheetId, title);
    return this.tab(spreadsheetId, title)
      .rows.slice(1)
      .filter((r) => !isEmptyRow(r))
      .map((r) => Object.fromEntries(header.map((h, i) => [h, formatted(r[i])])));
  }

  record(spreadsheetId: string, title: string, keyCol: string, key: string): Record<string, string> | undefined {
    return this.records(spreadsheetId, title).find((r) => r[keyCol] === key);
  }

  // 人のセル入力（キー列の値で行を探し、列名で書き込む）
  setByKey(spreadsheetId: string, title: string, keyCol: string, key: string, col: string, value: Stored): void {
    const t = this.tab(spreadsheetId, title);
    const header = this.header(spreadsheetId, title);
    const kc = header.indexOf(keyCol);
    const vc = header.indexOf(col);
    if (kc < 0 || vc < 0) throw new Error(`fake: 列がありません (${keyCol} / ${col})`);
    const row = t.rows.findIndex((r, i) => i > 0 && formatted(r?.[kc]) === key);
    if (row < 0) throw new Error(`fake: 行がありません (${key})`);
    const r = t.rows[row];
    while (r.length <= vc) r.push(undefined);
    r[vc] = value === '' ? undefined : value;
  }

  // 人の行挿入（rowNumber の位置に行を差し込み、以降の行を下へずらす。values が空なら空行）
  insertRowAt(spreadsheetId: string, title: string, rowNumber: number, values: Stored[]): void {
    this.tab(spreadsheetId, title).rows.splice(rowNumber - 1, 0, [...values]);
  }

  // 途中の行を空にする（人が行の内容だけを消した状態）
  blankRow(spreadsheetId: string, title: string, rowNumber: number): void {
    this.tab(spreadsheetId, title).rows[rowNumber - 1] = [];
  }

  // 書き込み系の呼び出し回数（スプレッドシート・タブ単位）
  writeCount(spreadsheetId: string, tab?: string): number {
    const writes = new Set(['values.update', 'values.append', 'values.batchUpdate']);
    return this.calls.filter(
      (c) => c.spreadsheetId === spreadsheetId && writes.has(c.method) && (!tab || c.ranges.some((r) => parseA1(r).tab === tab)),
    ).length;
  }

  callCount(spreadsheetId?: string): number {
    return this.calls.filter((c) => !spreadsheetId || c.spreadsheetId === spreadsheetId).length;
  }

  // googleapis の sheets_v4.Sheets として渡す
  asApi(): sheets_v4.Sheets {
    const api = {
      spreadsheets: {
        get: (p: sheets_v4.Params$Resource$Spreadsheets$Get) => this.run('get', p.spreadsheetId, [], () => this.getMeta(p)),
        batchUpdate: (p: sheets_v4.Params$Resource$Spreadsheets$Batchupdate) =>
          this.run('batchUpdate', p.spreadsheetId, [], () => this.batchUpdate(p)),
        values: {
          get: (p: sheets_v4.Params$Resource$Spreadsheets$Values$Get) =>
            this.run('values.get', p.spreadsheetId, [p.range ?? ''], () => ({
              data: this.readRange(p.spreadsheetId!, p.range ?? '', p.valueRenderOption),
            })),
          batchGet: (p: sheets_v4.Params$Resource$Spreadsheets$Values$Batchget) =>
            this.run('values.batchGet', p.spreadsheetId, p.ranges ?? [], () => ({
              data: {
                spreadsheetId: p.spreadsheetId,
                valueRanges: (p.ranges ?? []).map((r) => this.readRange(p.spreadsheetId!, r, p.valueRenderOption)),
              },
            })),
          update: (p: sheets_v4.Params$Resource$Spreadsheets$Values$Update) =>
            this.run('values.update', p.spreadsheetId, [p.range ?? ''], () => {
              this.requireRaw('values.update', p.valueInputOption);
              return { data: this.writeRange(p.spreadsheetId!, p.range ?? '', p.requestBody?.values ?? []) };
            }),
          append: (p: sheets_v4.Params$Resource$Spreadsheets$Values$Append) =>
            this.run('values.append', p.spreadsheetId, [p.range ?? ''], () => {
              this.requireRaw('values.append', p.valueInputOption);
              if (p.insertDataOption !== 'INSERT_ROWS') this.violations.push('values.append: INSERT_ROWS 以外（下の行を上書きし得る）');
              return { data: this.append(p.spreadsheetId!, p.range ?? '', p.requestBody?.values ?? []) };
            }),
          batchUpdate: (p: sheets_v4.Params$Resource$Spreadsheets$Values$Batchupdate) =>
            this.run(
              'values.batchUpdate',
              p.spreadsheetId,
              (p.requestBody?.data ?? []).map((d) => d.range ?? ''),
              () => {
                this.requireRaw('values.batchUpdate', p.requestBody?.valueInputOption);
                const data = (p.requestBody?.data ?? []) as ValueRangeInput[];
                // 実APIと同じく、いずれかの範囲が不正なら何も書かない
                for (const d of data) this.tab(p.spreadsheetId!, parseA1(d.range ?? '').tab);
                const responses = data.map((d) => this.writeRange(p.spreadsheetId!, d.range ?? '', d.values ?? []));
                return { data: { spreadsheetId: p.spreadsheetId, totalUpdatedCells: responses.length, responses } };
              },
            ),
        },
      },
    };
    return api as unknown as sheets_v4.Sheets;
  }

  // ===== 内部 =====

  private book(spreadsheetId: string): Map<string, FakeTab> {
    const b = this.books.get(spreadsheetId);
    if (!b) throw new FakeApiError(404, 'Requested entity was not found.');
    return b;
  }

  private tab(spreadsheetId: string, title: string): FakeTab {
    const t = this.book(spreadsheetId).get(title);
    if (!t) throw new FakeApiError(400, `Unable to parse range: ${quote(title)}`);
    return t;
  }

  private async run<T>(method: string, spreadsheetId: string | undefined, ranges: string[], fn: () => T): Promise<T> {
    this.calls.push({ method, spreadsheetId: spreadsheetId ?? '', ranges });
    const hook = this.beforeHooks.findIndex((h) => h.method === method);
    if (hook >= 0) this.beforeHooks.splice(hook, 1)[0].fn();
    const rule = this.failRules.find(
      (r) => r.times > 0 && r.method === method && (!r.tab || ranges.some((x) => x && parseA1(x).tab === r.tab)),
    );
    if (rule) {
      rule.times -= 1;
      if (rule.afterCommit && spreadsheetId) fn();
      throw new FakeApiError(rule.status, `fake failure (${method})`);
    }
    if (!spreadsheetId) throw new FakeApiError(400, 'spreadsheetId is required');
    return fn();
  }

  private requireRaw(method: string, option: string | null | undefined): void {
    if (option !== 'RAW') this.violations.push(`${method}: valueInputOption=${option ?? '(なし)'}`);
    if (!option) throw new FakeApiError(400, "'valueInputOption' is required but not specified");
  }

  private getMeta(p: sheets_v4.Params$Resource$Spreadsheets$Get): { data: sheets_v4.Schema$Spreadsheet } {
    const tabs = [...this.book(p.spreadsheetId!).values()];
    return {
      data: {
        spreadsheetId: p.spreadsheetId,
        sheets: tabs.map((t, index) => ({
          properties: {
            sheetId: t.sheetId,
            title: t.title,
            index,
            gridProperties: { rowCount: Math.max(t.rowCount, t.rows.length), columnCount: t.columnCount },
          },
          protectedRanges: this.protections
            .filter((pr) => pr.spreadsheetId === p.spreadsheetId && pr.sheetId === t.sheetId)
            .map((pr) => ({ range: { sheetId: pr.sheetId }, warningOnly: pr.warningOnly ?? false, editors: { users: pr.editors } })),
        })),
      },
    };
  }

  private batchUpdate(p: sheets_v4.Params$Resource$Spreadsheets$Batchupdate): { data: sheets_v4.Schema$BatchUpdateSpreadsheetResponse } {
    const id = p.spreadsheetId!;
    const book = this.book(id);
    const requests = p.requestBody?.requests ?? [];
    // 実APIと同じく全体を検証してから適用する（1件でも不正なら何も変えない）
    const adding = new Set<string>();
    for (const r of requests) {
      if (r.addSheet) {
        const title = r.addSheet.properties?.title ?? '';
        if (!title || book.has(title) || adding.has(title)) {
          throw new FakeApiError(400, `Invalid requests[0].addSheet: A sheet with the name "${title}" already exists.`);
        }
        adding.add(title);
      } else if (r.appendDimension) {
        if (r.appendDimension.dimension !== 'COLUMNS') throw new FakeApiError(400, 'fake: unsupported appendDimension');
        if (![...book.values()].some((t) => t.sheetId === r.appendDimension!.sheetId)) throw new FakeApiError(400, 'fake: no such sheetId');
      } else if (r.deleteDimension) {
        const range = r.deleteDimension.range;
        if (range?.dimension !== 'ROWS') throw new FakeApiError(400, 'fake: unsupported deleteDimension');
        if (![...book.values()].some((t) => t.sheetId === range.sheetId)) throw new FakeApiError(400, 'fake: no such sheetId');
      } else if (r.addProtectedRange) {
        const sheetId = r.addProtectedRange.protectedRange?.range?.sheetId ?? -1;
        if (![...book.values()].some((t) => t.sheetId === sheetId)) throw new FakeApiError(400, 'fake: no such sheetId');
      } else if (!r.setDataValidation) {
        throw new FakeApiError(400, 'fake: unsupported request');
      }
    }
    const replies: sheets_v4.Schema$Response[] = [];
    for (const r of requests) {
      if (r.addSheet) {
        const title = r.addSheet.properties!.title!;
        const sheetId = this.nextSheetId++;
        const grid = r.addSheet.properties?.gridProperties;
        book.set(title, {
          sheetId,
          title,
          rows: [],
          columnCount: grid?.columnCount ?? DEFAULT_COLUMNS,
          rowCount: grid?.rowCount ?? DEFAULT_ROWS,
          formats: new Map(),
        });
        replies.push({ addSheet: { properties: { sheetId, title } } });
      } else if (r.appendDimension) {
        const t = [...book.values()].find((x) => x.sheetId === r.appendDimension!.sheetId)!;
        t.columnCount += r.appendDimension.length ?? 0;
        replies.push({});
      } else if (r.deleteDimension) {
        const range = r.deleteDimension.range!;
        const t = [...book.values()].find((x) => x.sheetId === range.sheetId)!;
        const start = range.startIndex ?? 0;
        const end = range.endIndex ?? t.rows.length;
        t.rows.splice(start, end - start);
        this.deletedRows += end - start;
        replies.push({});
      } else if (r.addProtectedRange) {
        const pr = r.addProtectedRange.protectedRange!;
        this.protections.push({ spreadsheetId: id, sheetId: pr.range!.sheetId!, editors: pr.editors?.users ?? [], warningOnly: pr.warningOnly ?? false });
        replies.push({ addProtectedRange: { protectedRange: pr } });
      } else if (r.setDataValidation) {
        const v = r.setDataValidation;
        const sheetId = v.range?.sheetId ?? -1;
        if (![...book.values()].some((t) => t.sheetId === sheetId)) throw new FakeApiError(400, 'fake: no such sheetId');
        this.validations.push({
          spreadsheetId: id,
          sheetId,
          column: v.range?.startColumnIndex ?? -1,
          options: (v.rule?.condition?.values ?? []).map((x) => x.userEnteredValue ?? ''),
        });
        replies.push({});
      }
    }
    return { data: { spreadsheetId: id, replies } };
  }

  private readRange(spreadsheetId: string, range: string, render?: string | null): sheets_v4.Schema$ValueRange {
    const a = parseA1(range);
    const t = this.tab(spreadsheetId, a.tab);
    const out: Array<Array<string | number | boolean>> = [];
    const last = Math.min(a.r2, t.rows.length);
    const cellOut = (v: Stored | undefined, col: number): string | number | boolean => {
      if (render === 'UNFORMATTED_VALUE') return v === undefined ? '' : v;
      const format = t.formats.get(col);
      return typeof v === 'number' && format ? format(v) : formatted(v);
    };
    for (let r = a.r1; r <= last; r++) {
      const row = t.rows[r - 1] ?? [];
      const cells = row.slice(a.c1, a.c2 === Infinity ? undefined : a.c2 + 1).map((v, j) => cellOut(v, a.c1 + j));
      while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
      out.push(cells);
    }
    while (out.length > 0 && out[out.length - 1].length === 0) out.pop();
    return { range, majorDimension: 'ROWS', ...(out.length > 0 ? { values: out } : {}) };
  }

  private writeCell(t: FakeTab, row: number, col: number, v: unknown): void {
    if (col >= t.columnCount) {
      throw new FakeApiError(400, `Range (${quote(t.title)}!${indexToLetter(col)}${row}) exceeds grid limits. Max columns: ${t.columnCount}`);
    }
    if (v === null || v === undefined) return; // 実APIと同じく null は「変更しない」
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      throw new FakeApiError(400, 'Invalid value');
    }
    if (typeof v === 'string' && v.length > CELL_MAX_CHARS) {
      throw new FakeApiError(400, `Your input contains more than the maximum of ${CELL_MAX_CHARS} characters in a single cell.`);
    }
    while (t.rows.length < row) t.rows.push([]);
    const r = t.rows[row - 1];
    while (r.length <= col) r.push(undefined);
    r[col] = v === '' ? undefined : v;
  }

  private writeRange(spreadsheetId: string, range: string, values: unknown[][]): sheets_v4.Schema$UpdateValuesResponse {
    const a = parseA1(range);
    const t = this.tab(spreadsheetId, a.tab);
    values.forEach((row, i) => (row ?? []).forEach((v, j) => this.writeCell(t, a.r1 + i, a.c1 + j, v)));
    const width = Math.max(1, ...values.map((r) => (r ?? []).length));
    return {
      spreadsheetId,
      updatedRange: `${quote(a.tab)}!${indexToLetter(a.c1)}${a.r1}:${indexToLetter(a.c1 + width - 1)}${a.r1 + values.length - 1}`,
      updatedRows: values.length,
    };
  }

  private append(spreadsheetId: string, range: string, values: unknown[][]): sheets_v4.Schema$AppendValuesResponse {
    const a = parseA1(range);
    const t = this.tab(spreadsheetId, a.tab);
    // 範囲の先頭行から続く表の末尾（空行で途切れる）を探す
    let end = a.r1 - 1;
    while (end < t.rows.length && !isEmptyRow(t.rows[end])) end += 1;
    const start = end + 1; // 追記先の先頭行（1起点）
    const inserted: Row[] = values.map(() => []);
    t.rows.splice(end, 0, ...inserted);
    values.forEach((row, i) => (row ?? []).forEach((v, j) => this.writeCell(t, start + i, a.c1 + j, v)));
    const width = Math.max(1, ...values.map((r) => (r ?? []).length));
    const updatedRange = `${quote(a.tab)}!${indexToLetter(a.c1)}${start}:${indexToLetter(a.c1 + width - 1)}${start + values.length - 1}`;
    return {
      spreadsheetId,
      tableRange: `${quote(a.tab)}!A${a.r1}:${indexToLetter(width - 1)}${end}`,
      updates: { spreadsheetId, updatedRange, updatedRows: values.length },
    };
  }
}

// ===== Drive v3 =====

export interface FakeDriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  parents: string[];
  content?: string; // 本文（PDF・Word等は「ダウンロードした中身」、Googleドキュメントは書き出したテキスト）
  data?: Buffer; // バイナリの中身（docx・xlsx 等。あれば content より優先してダウンロードで返す）
  trashed?: boolean;
  shortcutTarget?: string; // ショートカット（application/vnd.google-apps.shortcut）の参照先ID
  owners?: string[]; // 所有者のアドレス（共有ドライブのファイルは空）
  sharingUser?: string; // サービスアカウントに共有した人
  driveId?: string; // 共有ドライブのID
  metaError?: number; // メタデータの取得をこの status で失敗させる（Drive の一時的な失敗・権限の再現）
}

const GOOGLE_TYPES = 'application/vnd.google-apps.';

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

export class FakeDrive {
  readonly files = new Map<string, FakeDriveFile>();
  readonly downloads: string[] = []; // get(alt=media)・export したファイルID
  listCalls = 0;
  // 1ページの件数（実APIは pageSize より少なく返すことがあるため、ページ送りを確かめられるよう小さくする）
  pageLimit = 2;

  put(file: FakeDriveFile): void {
    this.files.set(file.id, { ...file });
  }

  asApi(): drive_v3.Drive {
    const api = {
      files: {
        list: async (p: drive_v3.Params$Resource$Files$List) => {
          this.listCalls += 1;
          const m = (p.q ?? '').match(/^'([^']+)' in parents and trashed = false$/);
          if (!m) throw new FakeApiError(400, 'fake: unsupported query');
          if (!p.supportsAllDrives || !p.includeItemsFromAllDrives) throw new FakeApiError(400, 'fake: shared drive flags missing');
          const all = [...this.files.values()].filter((f) => f.parents.includes(m[1]) && !f.trashed);
          const offset = Number(p.pageToken ?? 0);
          const page = all.slice(offset, offset + Math.min(this.pageLimit, p.pageSize ?? 100));
          const next = offset + page.length < all.length ? String(offset + page.length) : undefined;
          return {
            data: {
              files: page.map((f) => ({
                id: f.id,
                name: f.name,
                mimeType: f.mimeType,
                modifiedTime: f.modifiedTime,
                webViewLink: `https://drive.example.invalid/file/${f.id}`,
                ...(f.mimeType.startsWith(GOOGLE_TYPES) ? {} : { size: String(f.data ? f.data.length : Buffer.byteLength(f.content ?? '')) }),
                ...(f.owners ? { owners: f.owners.map((emailAddress) => ({ emailAddress })) } : {}),
                ...(f.shortcutTarget
                  ? { shortcutDetails: { targetId: f.shortcutTarget, targetMimeType: this.files.get(f.shortcutTarget)?.mimeType ?? '' } }
                  : {}),
              })),
              ...(next ? { nextPageToken: next } : {}),
            },
          };
        },
        get: async (p: drive_v3.Params$Resource$Files$Get, opts?: { responseType?: string }) => {
          const f = this.files.get(p.fileId ?? '');
          if (!p.alt && p.fields) {
            // メタデータの取得（ショートカットの参照先の確認等）
            if (!f) throw new FakeApiError(404, 'File not found');
            if (f.metaError) throw new FakeApiError(f.metaError, 'fake: metadata failure');
            return {
              data: {
                ...(f.owners ? { owners: f.owners.map((emailAddress) => ({ emailAddress })) } : {}),
                ...(f.sharingUser ? { sharingUser: { emailAddress: f.sharingUser } } : {}),
                ...(f.driveId ? { driveId: f.driveId } : {}),
                id: f.id,
                name: f.name,
                mimeType: f.mimeType,
                modifiedTime: f.modifiedTime,
                webViewLink: `https://drive.example.invalid/file/${f.id}`,
                trashed: Boolean(f.trashed),
                parents: f.parents,
                ...(f.mimeType.startsWith(GOOGLE_TYPES) ? {} : { size: String(f.data ? f.data.length : Buffer.byteLength(f.content ?? '')) }),
              },
            };
          }
          if (!f || f.trashed) throw new FakeApiError(404, 'File not found');
          if (p.alt !== 'media' || opts?.responseType !== 'arraybuffer') throw new FakeApiError(400, 'fake: unsupported get');
          if (f.mimeType.startsWith(GOOGLE_TYPES)) throw new FakeApiError(403, 'fileNotDownloadable');
          this.downloads.push(f.id);
          return { data: toArrayBuffer(f.data ?? Buffer.from(f.content ?? '', 'utf-8')) };
        },
        export: async (p: drive_v3.Params$Resource$Files$Export, opts?: { responseType?: string }) => {
          const f = this.files.get(p.fileId ?? '');
          if (!f || f.trashed) throw new FakeApiError(404, 'File not found');
          if (!f.mimeType.startsWith(GOOGLE_TYPES)) throw new FakeApiError(403, 'fileNotExportable');
          if (p.mimeType !== 'text/plain' || opts?.responseType !== 'arraybuffer') throw new FakeApiError(400, 'fake: unsupported export');
          this.downloads.push(f.id);
          return { data: toArrayBuffer(f.data ?? Buffer.from(f.content ?? '', 'utf-8')) };
        },
      },
    };
    return api as unknown as drive_v3.Drive;
  }
}

// ===== メール送受信（MAIL_PROVIDER の差し替え） =====

export class FakeMailTransport implements MailTransport {
  inbox: SesRawMail[] = [];
  // 原文を解析できなかったメールのID（プロバイダが「解析不可」として返す分）
  unparsable: string[] = [];
  collectCalls = 0;
  skippedAsProcessed: string[] = [];
  downloaded: string[] = []; // 本文を取得したメールID
  drafts: Array<{ ref: DraftRef; from: string }> = [];
  // 作成は済んだのに応答だけ失敗する（APPENDの応答待ちで接続が切れた状況の再現）送信元
  ambiguousDraftFrom = new Set<string>();
  sent: Array<{ to: string; subject: string; body: string }> = [];
  // サマリ等の送信を失敗させる（SMTPのタイムアウトの再現）
  failSend = false;
  // この送信元での下書き作成を失敗させる（エラー文に宛先を含め、秘匿されるかを確かめる）
  failDraftFrom = new Set<string>();

  collectReady(): boolean {
    return true;
  }

  async collect(isProcessed: (mailId: string) => boolean, opts: CollectOptions): Promise<CollectOutcome> {
    this.collectCalls += 1;
    const unprocessed: SesRawMail[] = [];
    for (const m of this.inbox) {
      if (isProcessed(m.id)) this.skippedAsProcessed.push(m.id);
      else unprocessed.push(m);
    }
    // 実際のプロバイダと同じく、上限まで選んだメールだけ本文を取得する
    const pick = pickForRun(unprocessed, opts.limit, collectDays(), opts.now);
    this.downloaded.push(...pick.picked.map((m) => m.id));
    return {
      mails: pick.picked.map((m) => ({ ...m })),
      deferred: pick.deferred.map((m) => m.receivedAt),
      unparsable: this.unparsable.filter((id) => !isProcessed(id)),
    };
  }

  draftReady(): boolean {
    return true;
  }

  async createReplyDraft(ref: DraftRef, fromEmail: string): Promise<DraftRef> {
    if (this.failDraftFrom.has(fromEmail)) {
      throw new Error(`IMAP APPEND failed: mailbox rejected message from ${fromEmail} to ${ref.to}`);
    }
    const created = { ...ref, from: fromEmail, draftId: `fake_draft_${this.drafts.length + 1}`, url: 'imap://fake/Drafts' };
    this.drafts.push({ ref: created, from: fromEmail });
    if (this.ambiguousDraftFrom.has(fromEmail)) throw Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT' });
    return created;
  }

  async draftExists(draftKey: string): Promise<boolean | null> {
    return this.drafts.some((d) => d.ref.draftKey === draftKey);
  }

  sendReady(): boolean {
    return true;
  }

  async sendPlainMail(to: string, subject: string, body: string): Promise<void> {
    if (this.failSend) throw Object.assign(new Error('smtp timeout'), { code: 'ETIMEDOUT' });
    this.sent.push({ to, subject, body });
  }

  async scanMeta(_since: Date): Promise<SesMailMeta[]> {
    return [];
  }
}
