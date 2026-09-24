// 添付・スキルシートの表計算（xlsx/xls）とWord（docx）の形式検査とテキスト化（純関数。解析用のワーカーからも使う）。
// 添付は社外の誰からでも届くため、SheetJS・mammoth に渡す前に次を確かめる:
// - 形式は先頭バイトで判定し、ZIP の中身が通常の OOXML（xlsx は [Content_Types].xml と xl/workbook.xml）だけのときに限る。
//   SheetJS は ZIP の中身で解析器を選ぶため（ODS・Numbers・入れ子の Index.zip・XLSB）、それらの部品があれば渡さない
// - ZIP の各エントリは中央ディレクトリとローカルヘッダの名前・宣言サイズが一致し、実際に展開した大きさと宣言サイズが等しいこと
//   （SheetJS はローカルヘッダの宣言サイズでバッファを確保するため、宣言だけ大きいファイルで数百MBを確保させない）。
//   エントリ数・重なり（同じデータを何度も指すエントリ）にも上限を設け、検査そのものの手間もファイルの大きさで抑える
// - xls（OLE 複合文書）は Workbook / Book のストリームがあるものだけ（暗号化・Quattro Pro 等の別形式の解析器に回さない）
// - CSV 化は行・列・文字数の上限で打ち切る（シートの範囲の宣言（<dimension ref="A1:XFD1999"/>）だけで巨大な文字列を作らせない）
import { inflateRawSync } from 'zlib';
import { read as readXlsx, utils as xlsxUtils, CFB } from 'xlsx';
import type { WorkSheet, CellObject } from 'xlsx';
import { SafeLogError } from './redact.js';

// 表計算の解析上限。これを超えるファイルは解析しない／以降の行・文字を読まない
export const SPREADSHEET_MAX_BYTES = 10 * 1024 * 1024;
// xlsx（ZIP）を展開した後の合計の上限。圧縮後は10MB以内でも展開すると数GBになるファイル（zip bomb）は、
// SheetJS が全エントリを展開するため1通で数十秒・数GBのメモリを使い、実行時間の上限を超えて毎回同じメールで止まる
export const SPREADSHEET_MAX_INFLATED_BYTES = 64 * 1024 * 1024;
// ZIP のエントリ数の上限（通常の xlsx・docx は数十〜数百）。中央ディレクトリの件数（最大65535）で検査を長引かせない
export const ZIP_MAX_ENTRIES = 2000;
export const SPREADSHEET_MAX_ROWS = 2000;
export const SPREADSHEET_MAX_COLS = 200;
export const SPREADSHEET_MAX_TEXT_CHARS = 200_000;

// 先頭バイトで形式を判定する（拡張子・MIMEは送信者が自由に付けられるため）。
// xlsx は ZIP（PK\x03\x04）、旧形式の xls は OLE 複合文書（D0 CF 11 E0 A1 B1 1A E1）
export function spreadsheetKind(data: Buffer): 'xlsx' | 'xls' | null {
  if (data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) return 'xlsx';
  const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (data.length >= 8 && ole.every((b, i) => data[i] === b)) return 'xls';
  return null;
}

interface ZipEntry {
  name: string; // ローカルヘッダの名前（SheetJS と同じく1バイト1文字で読む）
  method: number;
  start: number; // データの先頭（ローカルヘッダの直後）
  compressedSize: number;
  uncompressedSize: number;
}

const EOCD_SIG = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const LOCAL_SIG = 0x04034b50;

// 拡張フィールドに ZIP64 の宣言サイズ（0x0001）があるか。SheetJS はこれでヘッダの宣言サイズを上書きし、そのサイズで確保する
function hasZip64Extra(data: Buffer, from: number, len: number): boolean {
  let p = from;
  const end = from + len;
  while (p <= end - 4) {
    if (data.readUInt16LE(p) === 0x0001) return true;
    p += 4 + data.readUInt16LE(p + 2);
  }
  return false;
}

// ZIP の各エントリ（SheetJS と同じ手順: 末尾の EOCD → 中央ディレクトリの各エントリ → ローカルヘッダ）。
// 次のどれかに当たれば null（解析しない）: 壊れている・エントリ数が上限超・暗号化・ZIP64 の拡張フィールド・
// 中央ディレクトリとローカルヘッダの名前や宣言サイズの食い違い・同じ名前のエントリ・データの重なり（同じ位置を何度も指す）
function zipEntries(data: Buffer): ZipEntry[] | null {
  const eocd = data.lastIndexOf(EOCD_SIG);
  if (eocd < 0 || eocd + 22 > data.length) return null;
  const count = data.readUInt16LE(eocd + 8);
  if (count === 0 || count > ZIP_MAX_ENTRIES) return null;
  const cdStart = data.readUInt32LE(eocd + 16);
  if (cdStart > eocd) return null;
  const out: ZipEntry[] = [];
  const spans: Array<[number, number]> = [];
  const names = new Set<string>();
  let p = cdStart;
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd) return null;
    const csz = data.readUInt32LE(p + 20);
    const usz = data.readUInt32LE(p + 24);
    const nameLen = data.readUInt16LE(p + 28);
    const extraLen = data.readUInt16LE(p + 30);
    const commentLen = data.readUInt16LE(p + 32);
    const offset = data.readUInt32LE(p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > eocd) return null;
    const centralName = data.subarray(p + 46, p + 46 + nameLen);
    if (hasZip64Extra(data, p + 46 + nameLen, extraLen)) return null;
    p += 46 + nameLen + extraLen + commentLen;

    if (offset + 30 > cdStart || data.readUInt32LE(offset) !== LOCAL_SIG) return null;
    const flags = data.readUInt16LE(offset + 6);
    const method = data.readUInt16LE(offset + 8);
    const localCsz = data.readUInt32LE(offset + 18);
    const localUsz = data.readUInt32LE(offset + 22);
    const localNameLen = data.readUInt16LE(offset + 26);
    const localExtraLen = data.readUInt16LE(offset + 28);
    const start = offset + 30 + localNameLen + localExtraLen;
    if (start + csz > cdStart) return null;
    if (flags & 0x2041) return null; // 暗号化
    if (!data.subarray(offset + 30, offset + 30 + localNameLen).equals(centralName)) return null;
    if (hasZip64Extra(data, offset + 30 + localNameLen, localExtraLen)) return null;
    // データ記述子（bit 3）を使う書き出し方では、ローカルヘッダのサイズは 0 のことがある（SheetJS は 0 なら実際の長さで確保する）
    const descriptor = (flags & 0x0008) !== 0;
    const sizeOk = (local: number, central: number) => local === central || (descriptor && local === 0);
    if (!sizeOk(localCsz, csz) || !sizeOk(localUsz, usz)) return null;
    if (method !== 0 && method !== 8) return null;
    if (method === 0 && csz !== usz) return null;

    const name = data.toString('latin1', offset + 30, offset + 30 + localNameLen);
    const key = normalizeZipName(name);
    if (names.has(key)) return null;
    names.add(key);
    spans.push([offset, start + csz]);
    out.push({ name, method, start, compressedSize: csz, uncompressedSize: usz });
  }
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i][0] < spans[i - 1][1]) return null;
  }
  return out;
}

function normalizeZipName(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

// ZIP の各エントリを実際に展開して、合計が maxBytes 以内で、各エントリの宣言サイズと実際の大きさが等しいことを確かめる。
// 展開は各エントリの圧縮データの範囲（宣言した圧縮サイズ）だけを入力にする（重なりは zipEntries で弾くため、
// 検査の手間の合計はファイルの大きさで決まる）。上限超・壊れている・対応しない圧縮方式なら false（解析しない）
export function zipInflatesWithin(data: Buffer, maxBytes: number): boolean {
  const entries = zipEntries(data);
  if (!entries) return false;
  let remaining = maxBytes;
  for (const e of entries) {
    if (e.method === 0) {
      remaining -= e.uncompressedSize;
    } else {
      let length: number;
      try {
        length = inflateRawSync(data.subarray(e.start, e.start + e.compressedSize), { maxOutputLength: Math.max(1, remaining + 1) }).length;
      } catch {
        return false; // 上限超過（ERR_BUFFER_TOO_LARGE）・壊れたデータ・圧縮サイズの範囲で終わらない
      }
      if (length !== e.uncompressedSize) return false;
      remaining -= length;
    }
    if (remaining < 0) return false;
  }
  return true;
}

// ZIP の1エントリの中身（XML等の小さなテキスト。1MBまで）。読めなければ null
function zipEntryText(data: Buffer, e: ZipEntry): string | null {
  try {
    const raw = data.subarray(e.start, e.start + e.compressedSize);
    return (e.method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: 1024 * 1024 })).toString('utf8');
  } catch {
    return null;
  }
}

// 解析してよい .bin（SheetJS が読まない付属物: 印刷設定・埋め込みオブジェクト・マクロ）
const HARMLESS_BIN = /^xl\/(?:printersettings\/[^/]+|embeddings\/[^/]+|vbaproject[^/]*)\.bin$/;

// SheetJS が xlsx 以外の解析器に回す部品（ODS・UOF・Numbers・入れ子の ZIP）
function foreignPart(n: string): boolean {
  return (
    n === 'meta-inf/manifest.xml' ||
    n === 'content.xml' ||
    n === 'objectdata.xml' ||
    n.startsWith('index/') ||
    n.endsWith('.iwa') ||
    n === 'index.zip' ||
    n.endsWith('/index.zip') ||
    n === 'index.xml' ||
    n === 'index.xml.gz'
  );
}

// 通常の xlsx（OOXML の XML 形式のブック）か。ZIP の中身が XLSB（xl/workbook.bin 等のバイナリ形式）・ODS・Numbers・
// 入れ子の ZIP だと、SheetJS はそれぞれ別の解析器に回す。それらの解析器は添付の中の文字列をそのままコンソールに出したり
// （公開の Actions ログ）、展開の検査が及ばない大きさまで展開・セルを作ったりするため、XML 形式のブック以外は解析しない
export function isPlainOoxmlWorkbook(data: Buffer): boolean {
  const entries = zipEntries(data);
  if (!entries) return false;
  const names = entries.map((e) => normalizeZipName(e.name));
  const ctIndex = names.indexOf('[content_types].xml');
  if (ctIndex < 0 || !names.includes('xl/workbook.xml')) return false;
  if (names.some((n) => foreignPart(n) || (n.endsWith('.bin') && !HARMLESS_BIN.test(n)))) return false;
  const text = zipEntryText(data, entries[ctIndex]);
  if (text === null) return false;
  // 部品の種類の個別登録（Override）で、XLSB のブックの種類や .bin の部品（ブック・シートとして読ませる）があれば解析しない
  // （拡張子ごとの既定（Default）の bin は通常の xlsx にもあり、SheetJS はブックの判定に使わない）
  const overrides = text.match(/<(?:[\w-]+:)?Override\b[^>]*>/gi) ?? [];
  // ブックからシート等への参照（xl/_rels/workbook.xml.rels）が .bin を指すものも、バイナリの解析器に回るため解析しない
  const relsIndex = names.indexOf('xl/_rels/workbook.xml.rels');
  const rels = relsIndex < 0 ? '' : zipEntryText(data, entries[relsIndex]);
  if (rels === null || /Target\s*=\s*["'][^"']*\.bin["']/i.test(rels)) return false;
  return !overrides.some((tag) => /sheet\.binary/i.test(tag) || /PartName\s*=\s*["'][^"']*\.bin["']/i.test(tag));
}

// 通常の docx（word/document.xml を持つ OOXML）で、ZIP の検査（宣言サイズ・重なり・展開後の大きさ）を通るか。
// mammoth（jszip）は本文の XML を全部展開してから読むため、スキルシートのフォルダに置かれた zip bomb で止めない
export function isSafeDocx(data: Buffer, maxInflatedBytes = SPREADSHEET_MAX_INFLATED_BYTES): boolean {
  if (spreadsheetKind(data) !== 'xlsx') return false;
  const entries = zipEntries(data);
  if (!entries) return false;
  const names = entries.map((e) => normalizeZipName(e.name));
  if (!names.includes('[content_types].xml') || !names.includes('word/document.xml')) return false;
  return zipInflatesWithin(data, maxInflatedBytes);
}

// 旧形式の xls（OLE 複合文書）で、SheetJS が BIFF のブックとして読むもの（Workbook / Book のストリームがある・暗号化でない）か
export function isPlainXlsWorkbook(data: Buffer): boolean {
  try {
    const cfb = CFB.read(data, { type: 'buffer' });
    if (CFB.find(cfb, 'EncryptedPackage') || CFB.find(cfb, '/encryption')) return false;
    return Boolean(CFB.find(cfb, '/Workbook') ?? CFB.find(cfb, '/Book'));
  } catch {
    return false;
  }
}

// SheetJS は解析できない部品に出会うと、添付の中の文字列を含むメッセージを console に直接書く（ログ秘匿を通らない）。
// 解析の間だけ console の出力を捨てる（同期処理のため、他の処理の出力を巻き込まない）
export function withConsoleSilenced<T>(fn: () => T): T {
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug, trace: console.trace };
  const drop = () => undefined;
  Object.assign(console, { log: drop, info: drop, warn: drop, error: drop, debug: drop, trace: drop });
  try {
    return fn();
  } finally {
    Object.assign(console, saved);
  }
}

// Excel（.xlsx/.xls）の全シートをCSVテキストにする（同じプロセスで解析する。社外のファイルは spreadsheetIsolated.ts の
// ワーカー経由で呼ぶ）
export function spreadsheetBufferToText(data: Buffer): string {
  if (data.length > SPREADSHEET_MAX_BYTES) throw new SafeLogError('表計算ファイルが大きすぎるため解析しません（10MB超）');
  const kind = spreadsheetKind(data);
  if (!kind) throw new SafeLogError('Excel形式（xlsx/xls）ではないため解析しません');
  if (kind === 'xlsx' && !zipInflatesWithin(data, SPREADSHEET_MAX_INFLATED_BYTES)) {
    throw new SafeLogError('表計算ファイルの展開後の大きさが上限を超えるか壊れているため解析しません');
  }
  if (kind === 'xlsx' && !isPlainOoxmlWorkbook(data)) {
    throw new SafeLogError('通常のxlsx（XML形式のブック）ではないため解析しません（xlsb・ods等）');
  }
  if (kind === 'xls' && !isPlainXlsWorkbook(data)) {
    throw new SafeLogError('通常のxls（Workbookのストリームを持つブック）ではないため解析しません');
  }
  return withConsoleSilenced(() => workbookToText(data));
}

function workbookToText(data: Buffer): string {
  const workbook = readXlsx(data, {
    type: 'buffer',
    dense: true,
    sheetRows: SPREADSHEET_MAX_ROWS,
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    cellNF: false,
    bookVBA: false,
    bookFiles: false,
  });
  const parts: string[] = [];
  let total = 0;
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const head = `【シート: ${name}】\n`;
    const budget = SPREADSHEET_MAX_TEXT_CHARS - total - head.length;
    const part = `${head}${sheetToCsvBounded(sheet, Math.max(0, budget) + 1)}`;
    if (total + part.length > SPREADSHEET_MAX_TEXT_CHARS) {
      parts.push(`${part.slice(0, Math.max(0, SPREADSHEET_MAX_TEXT_CHARS - total))}\n…（長いため以降を省略）`);
      break;
    }
    parts.push(part);
    total += part.length;
  }
  return parts.join('\n\n');
}

function csvField(cell: CellObject | undefined): string {
  if (!cell || cell.v === undefined || cell.v === null) return '';
  let text: string;
  try {
    text = xlsxUtils.format_cell(cell);
  } catch {
    text = String(cell.v);
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// シートの CSV（行・列の上限まで。空の行と行末の空欄は出さない）。文字数が maxChars を超えたらそこで打ち切る
// （sheet_to_csv はシートの宣言した範囲の全幅で文字列を作るため使わない）
function sheetToCsvBounded(sheet: WorkSheet, maxChars: number): string {
  const ref = sheet['!ref'];
  if (!ref) return '';
  const range = xlsxUtils.decode_range(ref);
  const lastRow = Math.min(range.e.r, range.s.r + SPREADSHEET_MAX_ROWS - 1);
  const lastCol = Math.min(range.e.c, range.s.c + SPREADSHEET_MAX_COLS - 1);
  const dense = (sheet as { '!data'?: Array<Array<CellObject | undefined> | undefined> })['!data'];
  const lines: string[] = [];
  let length = 0;
  for (let r = range.s.r; r <= lastRow && length <= maxChars; r++) {
    const row = dense ? dense[r] : undefined;
    if (dense && !row) continue;
    const fields: string[] = [];
    let used = 0;
    for (let c = range.s.c; c <= lastCol; c++) {
      const cell = dense ? row?.[c] : (sheet[xlsxUtils.encode_cell({ r, c })] as CellObject | undefined);
      const field = csvField(cell);
      fields.push(field);
      if (field !== '') used = fields.length;
    }
    if (used === 0) continue;
    const line = fields.slice(0, used).join(',');
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join('\n');
}
