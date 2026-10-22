// ラベルストアの控えを表計算の A 列に置き、読み戻して機械で1行ずつ照合する（npm run ses:labels:sheet）。
// 担当が中身を写して送る Drive の create_file は写し間違いを確かめにくいため、表計算に update_values で書き、get_values の保存結果と突き合わせる。
// 個人データを含むため標準出力は件数だけ。
//   plan   <読み戻しのファイル> <出力フォルダ> [sheetName=ラベル控え] [fileBytes=40000]  → <出力フォルダ>/lsNN.json（update_values の要素の配列）
//   export <読み戻しのファイル> <出力フォルダ>                                         → <出力フォルダ>/labels_sheet.tsv（ses:labels:restore に渡せる）
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKUP_HEADER, backupLineOf, labelsDir, parseBackup, readLabelStore } from './labels.js';
import { packElements, sheetRowsOf, type WriteElement } from '../trial/writePlan.js';

export interface LabelSheetPlan {
  elements: WriteElement[];
  append: number;
  rewrite: number;
  inSheet: number;
}

export const DEFAULT_SHEET_NAME = 'ラベル控え';

const clean = (s: string): string => s.replace(/\r$/, '');
const keyOfLine = (line: string): string | null => {
  const cols = line.split('\t');
  return cols[0] === 'v1' && cols.length === 10 && cols[1] ? (cols[1] as string) : null;
};

const rangeOf = (sheetName: string, from: number, to: number): string => `'${sheetName.replace(/'/g, "''")}'!A${from}:A${to}`;

// storeLines: ストアの全組の控えの行（backupLineOf）。sheetRows: 表計算の A 列（添字0が1行目。空の行は ''）
export function planLabelSheet(storeLines: string[], sheetRows: string[], sheetName = DEFAULT_SHEET_NAME): LabelSheetPlan {
  const rows = sheetRows.map(clean);
  const rowOfKey = new Map<string, number>(); // key → 行番号（1始まり）
  let lastFilled = 0;
  rows.forEach((r, i) => {
    if (r.trim()) lastFilled = i + 1;
    const k = keyOfLine(r);
    if (k && !rowOfKey.has(k)) rowOfKey.set(k, i + 1);
  });
  const writes = new Map<number, string>(); // 行番号 → 書く行
  if (!rows[0]?.trim()) writes.set(1, BACKUP_HEADER);
  let next = Math.max(lastFilled, 1) + 1;
  let append = 0;
  let rewrite = 0;
  let inSheet = 0;
  const seen = new Set<string>();
  for (const line of storeLines) {
    const key = keyOfLine(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const at = rowOfKey.get(key);
    if (at === undefined) {
      writes.set(next++, line);
      append += 1;
      continue;
    }
    inSheet += 1;
    const current = rows[at - 1] as string;
    const valid = parseBackup(current).rows.length === 1;
    if (!valid || current !== line) {
      writes.set(at, line);
      rewrite += 1;
    }
  }
  const elements: WriteElement[] = [];
  const nos = [...writes.keys()].sort((a, b) => a - b);
  let i = 0;
  while (i < nos.length) {
    let j = i;
    while (j + 1 < nos.length && (nos[j + 1] as number) === (nos[j] as number) + 1) j++;
    const from = nos[i] as number;
    const to = nos[j] as number;
    elements.push({ range: rangeOf(sheetName, from, to), values: nos.slice(i, j + 1).map((n) => [writes.get(n) as string]) });
    i = j + 1;
  }
  return { elements, append, rewrite, inSheet };
}

// 大きい連続範囲は行ごとに分け、fileBytes ごとのファイルにまとめる
export function packLabelElements(elements: WriteElement[], fileBytes: number): WriteElement[][] {
  const pieces: WriteElement[] = [];
  for (const e of elements) {
    const m = /^(.*!A)(\d+):A\d+$/.exec(e.range);
    if (!m) {
      pieces.push(e);
      continue;
    }
    const prefix = m[1] as string;
    const start = Number(m[2]);
    let from = 0;
    while (from < e.values.length) {
      let to = from;
      let size = 60 + e.range.length;
      while (to < e.values.length && (to === from || size + JSON.stringify(e.values[to]).length + 1 <= fileBytes)) {
        size += JSON.stringify(e.values[to]).length + 1;
        to++;
      }
      pieces.push({ range: `${prefix}${start + from}:A${start + to - 1}`, values: e.values.slice(from, to) });
      from = to;
    }
  }
  return packElements(pieces, fileBytes);
}

function sheetColumnA(readBackFile: string): string[] {
  const map = sheetRowsOf(JSON.parse(readFileSync(readBackFile, 'utf8')));
  const max = Math.max(0, ...map.keys());
  const out: string[] = [];
  for (let n = 1; n <= max; n++) {
    const v = (map.get(n) ?? [])[0];
    out.push(v === undefined || v === null ? '' : String(v));
  }
  return out;
}

export function planCli(readBackFile: string, outDir: string, sheetName: string, fileBytes: number) {
  const store = readLabelStore(labelsDir()).pairs.map(backupLineOf);
  const plan = planLabelSheet(store, sheetColumnA(readBackFile), sheetName);
  mkdirSync(outDir, { recursive: true });
  for (const n of readdirSync(outDir)) if (/^ls\d+\.json$/.test(n)) rmSync(join(outDir, n));
  const files = packLabelElements(plan.elements, fileBytes);
  files.forEach((els, i) => writeFileSync(join(outDir, `ls${String(i).padStart(2, '0')}.json`), JSON.stringify(els)));
  return { stored: store.length, inSheet: plan.inSheet, append: plan.append, rewrite: plan.rewrite, elements: plan.elements.length, files: files.length };
}

export function exportCli(readBackFile: string, outDir: string): { lines: number } {
  const lines = sheetColumnA(readBackFile).map(clean).filter((l) => l.trim());
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'labels_sheet.tsv'), lines.length > 0 ? `${lines.join('\n')}\n` : '');
  return { lines: lines.length };
}

function main(): void {
  const [mode, readBack, outDir, a, b] = process.argv.slice(2);
  if (!readBack || !outDir || !existsSync(readBack)) {
    console.error('使い方: npm run --silent ses:labels:sheet -- plan <読み戻しのファイル> <出力フォルダ> [sheetName=ラベル控え] [fileBytes=40000]\n        npm run --silent ses:labels:sheet -- export <読み戻しのファイル> <出力フォルダ>');
    process.exitCode = 1;
    return;
  }
  if (mode === 'plan') {
    const bytes = Number(b);
    console.log(JSON.stringify(planCli(resolve(readBack), resolve(outDir), a || DEFAULT_SHEET_NAME, Number.isFinite(bytes) && bytes > 0 ? bytes : 40_000)));
  } else if (mode === 'export') {
    console.log(JSON.stringify(exportCli(resolve(readBack), resolve(outDir)).lines));
  } else {
    console.error('plan か export を指定してください');
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`ラベル控えの処理に失敗しました: ${err instanceof Error ? err.constructor.name : 'Error'}`);
    process.exitCode = 1;
  }
}
