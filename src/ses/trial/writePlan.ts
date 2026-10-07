// 試運転の書き込みを軽くする。PHASE=final の writes/*.json を、シートの今の値と1セルずつ比べて変わったセルだけにし、
// 大きめのファイル（既定 60KB）にまとめ直す（担当の数を減らす）。書いた後は verify で読み戻しと突き合わせる。
// 個人データを扱うので標準出力は件数だけ。
//   plan   <RUN_DIR> <A:AB の読み取り> <AC:AF の読み取り> [fileBytes=60000]  → <RUN_DIR>/wf/wNN.json
//   verify <RUN_DIR> <書いた後の A:AF の読み取り>                             → <RUN_DIR>/wf/fixNN.json（1セル1ファイル）
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SALES_COLUMNS } from '../proper/salesList.js';

export interface WriteElement {
  range: string;
  values: Array<Array<string | number>>;
}

export interface PlanResult {
  elements: WriteElement[];
  appendRows: number;
  updateRows: number;
  cellsWritten: number;
  cellsSkippedSame: number;
}

const NCOLS = SALES_COLUMNS.length;
const HUMAN = SALES_COLUMNS.flatMap((c, i) => (c.human ? [i] : []));
const HUMAN_FIRST = Math.min(...HUMAN); // M
const HUMAN_LAST = Math.max(...HUMAN); // R
const STATUS_COL = HUMAN_FIRST; // 対応状況
const NOT_STARTED = '未着手';
// 読み戻しの照合で除く機械の列（受信日時・追加日時・最終更新）
const VERIFY_SKIP = new Set(['受信日時', '追加日時', '最終更新'].map((n) => SALES_COLUMNS.findIndex((c) => c.name === n)));

export function colLetter(i: number): string {
  let n = i;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

export function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

interface ParsedRange {
  sheet: string;
  col: number;
  row: number;
  endRow: number;
}

function parseRange(range: string): ParsedRange | null {
  const m = /^(.*)!([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(range);
  if (!m) return null;
  return { sheet: m[1], col: colIndex(m[2]), row: Number(m[3]), endRow: m[5] ? Number(m[5]) : Number(m[3]) };
}

// NBSP・前後の空白・数値の表記（"60" と 60、"60.0"）の違いは同じとみなす
export function normCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = (typeof v === 'number' ? String(v) : String(v).replace(/ /g, ' ')).trim();
  return /^-?\d+(\.\d+)?$/.test(s) ? String(Number(s)) : s;
}

// get_values の保存結果（{range, values}）から、シートの行番号 → 値の配列。range の開始行（無ければ1行目）から数える
export function sheetRowsOf(dump: unknown): Map<number, unknown[]> {
  const rows = new Map<number, unknown[]>();
  const d = (Array.isArray(dump) ? { values: dump, range: '' } : dump) as { range?: unknown; values?: unknown };
  const values = Array.isArray(d.values) ? (d.values as unknown[][]) : [];
  const m = /!?[A-Z]+(\d+)/.exec(typeof d.range === 'string' ? d.range.split('!').pop() ?? '' : '');
  const start = m ? Number(m[1]) : 1;
  values.forEach((r, i) => rows.set(start + i, Array.isArray(r) ? r : []));
  return rows;
}

// 読み取りは左（A:AB）と右（AC:AF の4列）の2つに分ける。左の列数は全列数から求める
export const RIGHT_READ_COLS = 4;
// A:AB と AC:AF の2つの読み取りを、1行32列に合わせる
export function joinSheetRows(a: Map<number, unknown[]>, b: Map<number, unknown[]>, split = NCOLS - RIGHT_READ_COLS): Map<number, unknown[]> {
  const rows = new Map<number, unknown[]>();
  for (const n of new Set([...a.keys(), ...b.keys()])) {
    const left = [...(a.get(n) ?? [])];
    while (left.length < split) left.push('');
    rows.set(n, [...left.slice(0, split), ...(b.get(n) ?? [])]);
  }
  return rows;
}

function pushDiffRanges(out: WriteElement[], sheet: string, row: number, startCol: number, values: Array<string | number>, current: unknown[], stat: { written: number; same: number }): boolean {
  let changed = false;
  let i = 0;
  while (i < values.length) {
    const col = startCol + i;
    if (col >= HUMAN_FIRST && col <= HUMAN_LAST) {
      i += 1;
      continue;
    }
    if (normCell(values[i]) === normCell(current[col])) {
      stat.same += 1;
      i += 1;
      continue;
    }
    let j = i;
    while (j < values.length && !(startCol + j >= HUMAN_FIRST && startCol + j <= HUMAN_LAST) && normCell(values[j]) !== normCell(current[startCol + j])) j += 1;
    const from = `${colLetter(col)}${row}`;
    out.push({ range: `${sheet}!${j - i === 1 ? from : `${from}:${colLetter(startCol + j - 1)}${row}`}`, values: [values.slice(i, j)] });
    stat.written += j - i;
    changed = true;
    i = j;
  }
  return changed;
}

// 新しい行（32列）は「A:M（M は 未着手）」と「S:AF」の2つにする（N〜R は書かない）。既存の行は今の値と違うセルだけ
export function planWrites(writes: WriteElement[], sheet: Map<number, unknown[]>): PlanResult {
  const elements: WriteElement[] = [];
  const stat = { written: 0, same: 0 };
  let appendRows = 0;
  const updated = new Set<string>();
  for (const w of writes) {
    const pr = parseRange(w.range);
    const row = w.values[0];
    if (!pr || !row || w.values.length !== 1) {
      elements.push(w);
      stat.written += w.values.reduce((n, r) => n + r.length, 0);
      continue;
    }
    const sheetName = w.range.slice(0, w.range.lastIndexOf('!'));
    if (pr.col === 0 && row.length === NCOLS && !w.range.includes(':')) {
      const head = row.slice(0, STATUS_COL + 1);
      head[STATUS_COL] = NOT_STARTED;
      const tail = row.slice(HUMAN_LAST + 1);
      elements.push({ range: `${sheetName}!A${pr.row}:${colLetter(STATUS_COL)}${pr.row}`, values: [head] });
      elements.push({ range: `${sheetName}!${colLetter(HUMAN_LAST + 1)}${pr.row}:${colLetter(NCOLS - 1)}${pr.row}`, values: [tail] });
      stat.written += head.length + tail.length;
      appendRows += 1;
      continue;
    }
    if (pushDiffRanges(elements, sheetName, pr.row, pr.col, row, sheet.get(pr.row) ?? [], stat)) updated.add(`${sheetName}|${pr.row}`);
  }
  return { elements, appendRows, updateRows: updated.size, cellsWritten: stat.written, cellsSkippedSame: stat.same };
}

// 書く要素を fileBytes 以下のまとまりに分ける（1要素で超えるものは単独）
export function packElements(elements: WriteElement[], fileBytes: number): WriteElement[][] {
  const files: WriteElement[][] = [];
  let size = 2;
  for (const e of elements) {
    const n = JSON.stringify(e).length + 1;
    const cur = files[files.length - 1];
    if (!cur || size + n > fileBytes) {
      files.push([e]);
      size = 2 + n;
    } else {
      cur.push(e);
      size += n;
    }
  }
  return files;
}

// 書いた要素の各セルを書いた後のシートと比べ、違うセルを1セルの書き直しにする（受信日時・追加日時・最終更新の列は除く）
export function verifyWrites(elements: WriteElement[], sheet: Map<number, unknown[]>): { checked: number; fixes: WriteElement[] } {
  let checked = 0;
  const fixes: WriteElement[] = [];
  for (const w of elements) {
    const pr = parseRange(w.range);
    if (!pr) continue;
    w.values.forEach((vals, r) => {
      const rowNo = pr.row + r;
      const sheetName = w.range.slice(0, w.range.lastIndexOf('!'));
      vals.forEach((v, i) => {
        const col = pr.col + i;
        if (VERIFY_SKIP.has(col)) return;
        checked += 1;
        if (normCell(v) !== normCell((sheet.get(rowNo) ?? [])[col])) fixes.push({ range: `${sheetName}!${colLetter(col)}${rowNo}`, values: [[v]] });
      });
    });
  }
  return { checked, fixes };
}

const readJson = (f: string): unknown => JSON.parse(readFileSync(f, 'utf8'));

function listFiles(dir: string, re: RegExp): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((n) => re.test(n)).sort() : [];
}

function readWritesDir(runDir: string): WriteElement[] {
  const out: WriteElement[] = [];
  for (const f of listFiles(join(runDir, 'writes'), /^w.*\.json$/)) out.push(...(readJson(join(runDir, 'writes', f)) as WriteElement[]));
  return out;
}

export function planRunDir(runDir: string, fileA: string, fileB: string, fileBytes = 60_000) {
  const sheet = joinSheetRows(sheetRowsOf(readJson(fileA)), sheetRowsOf(readJson(fileB)));
  const res = planWrites(readWritesDir(runDir), sheet);
  const wf = join(runDir, 'wf');
  mkdirSync(wf, { recursive: true });
  for (const f of listFiles(wf, /^(w|fix)\d+\.json$/)) rmSync(join(wf, f));
  const files = packElements(res.elements, Number.isFinite(fileBytes) && fileBytes > 0 ? fileBytes : 60_000);
  files.forEach((els, i) => writeFileSync(join(wf, `w${String(i).padStart(2, '0')}.json`), JSON.stringify(els)));
  return { appendRows: res.appendRows, updateRows: res.updateRows, cellsWritten: res.cellsWritten, cellsSkippedSame: res.cellsSkippedSame, files: files.length };
}

export function verifyRunDir(runDir: string, afterFile: string) {
  const wf = join(runDir, 'wf');
  const elements: WriteElement[] = [];
  for (const f of listFiles(wf, /^w\d+\.json$/)) elements.push(...(readJson(join(wf, f)) as WriteElement[]));
  const { checked, fixes } = verifyWrites(elements, sheetRowsOf(readJson(afterFile)));
  for (const f of listFiles(wf, /^fix\d+\.json$/)) rmSync(join(wf, f));
  fixes.forEach((fx, i) => writeFileSync(join(wf, `fix${String(i).padStart(2, '0')}.json`), JSON.stringify([fx])));
  return { checked, mismatch: fixes.length };
}

function main(): void {
  const [mode, runDirArg, a, b, c] = process.argv.slice(2);
  if (mode === 'plan' && runDirArg && a && b) {
    console.log(JSON.stringify(planRunDir(resolve(runDirArg), resolve(a), resolve(b), c ? Number(c) : 60_000)));
  } else if (mode === 'verify' && runDirArg && a) {
    console.log(JSON.stringify(verifyRunDir(resolve(runDirArg), resolve(a))));
  } else {
    console.error('使い方: npm run ses:trial:writeplan -- plan <RUN_DIR> <A:AB の読み取り> <AC:AF の読み取り> [fileBytes=60000]\n        npm run ses:trial:writeplan -- verify <RUN_DIR> <書いた後の A:AF の読み取り>');
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`書き込みの計画に失敗しました: ${err instanceof Error ? err.constructor.name : 'Error'}`);
    process.exitCode = 1;
  }
}
