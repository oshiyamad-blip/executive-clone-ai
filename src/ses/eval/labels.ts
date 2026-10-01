// 判定ラベルの蓄積（AI判定と営業の評価を1か所にためる）。個人データ（案件の中身・経歴）を含むため、
// 置き場は SES_LABELS_DIR（既定 data/ses-labels。data/* は .gitignore 済み）。リポジトリには入れない。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as zlib from 'node:zlib';
import { ownPairsForJudge } from '../ownMatch.js';
import type { RawProperJudgment } from '../proper/judge.js';
import type { Project, ProperEngineer } from '../../types/index.js';

export interface LabelPair {
  key: string; // `${engineerId}|${projectId}`
  engineerId: string;
  engineerLabel: string;
  projectId: string;
  runId: string;
  judgedAt: string;
  engineerHash: string;
  project: Project;
  judgment: RawProperJudgment;
  priority: string; // 候補にならなかった組は ''
}
export interface LabelEngineer { hash: string; engineerId: string; engineer: ProperEngineer; }
export interface LabelSales {
  key: string;
  seenAt: string;
  tab: '全体' | 'クローズ済み';
  status: string;
  skipReason: string;
  check: string;
  checkMemo: string;
  priority: string;
}
export interface LabelStore { pairs: LabelPair[]; engineers: LabelEngineer[]; sales: LabelSales[]; skipped: number; }

export function labelsDir(): string {
  return process.env.SES_LABELS_DIR || 'data/ses-labels';
}

export const engineerHashOf = (e: ProperEngineer): string => createHash('sha256').update(JSON.stringify(e)).digest('hex').slice(0, 16);

export function salesKeyOf(id: string): string | null {
  const m = /^ownmatch_(.+)_(proj_[0-9a-f]+)$/.exec(id);
  return m ? `${m[1]}|${m[2]}` : null;
}

const FILES = { pairs: 'pairs.jsonl', engineers: 'engineers.jsonl', sales: 'sales.jsonl' } as const;

function readLines<T>(file: string): { rows: T[]; skipped: number } {
  const rows: T[] = [];
  let skipped = 0;
  if (!existsSync(file)) return { rows, skipped };
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (v === null || typeof v !== 'object') throw new Error('object ではありません');
      rows.push(v as T);
    } catch {
      skipped += 1;
    }
  }
  return { rows, skipped };
}

export function readLabelStore(dir: string): LabelStore {
  const p = readLines<LabelPair>(join(dir, FILES.pairs));
  const e = readLines<LabelEngineer>(join(dir, FILES.engineers));
  const s = readLines<LabelSales>(join(dir, FILES.sales));
  return { pairs: p.rows, engineers: e.rows, sales: s.rows, skipped: p.skipped + e.skipped + s.skipped };
}

// key ごとに seenAt が最新の行（同時刻は後に書かれた行）
export function latestSales(sales: LabelSales[]): Map<string, LabelSales> {
  const latest = new Map<string, LabelSales>();
  for (const s of sales) {
    const cur = latest.get(s.key);
    if (!cur || s.seenAt >= cur.seenAt) latest.set(s.key, s);
  }
  return latest;
}

const SALES_FIELDS = ['status', 'skipReason', 'check', 'checkMemo', 'priority', 'tab'] as const;
const sameSales = (a: LabelSales, b: LabelSales) => SALES_FIELDS.every((f) => a[f] === b[f]);

// 同じ組・同じ要員は書かない。営業の評価は、最新の行から変わったときだけ足す
export function appendLabels(
  dir: string,
  add: { pairs?: LabelPair[]; engineers?: LabelEngineer[]; sales?: LabelSales[] },
): { pairs: number; engineers: number; sales: number; addedPairs: LabelPair[] } {
  mkdirSync(dir, { recursive: true });
  const store = readLabelStore(dir);
  const pairKeys = new Set(store.pairs.map((p) => p.key));
  const hashes = new Set(store.engineers.map((e) => e.hash));
  const latest = latestSales(store.sales);
  const out = { pairs: [] as LabelPair[], engineers: [] as LabelEngineer[], sales: [] as LabelSales[] };
  for (const p of add.pairs ?? []) {
    if (pairKeys.has(p.key)) continue;
    pairKeys.add(p.key);
    out.pairs.push(p);
  }
  for (const e of add.engineers ?? []) {
    if (hashes.has(e.hash)) continue;
    hashes.add(e.hash);
    out.engineers.push(e);
  }
  // 同じ回で全体とクローズ済みの両方にある行は seenAt が同じ。あとに渡した方（クローズ済み）を採る
  const lastOfKey = new Map<string, LabelSales>();
  for (const s of add.sales ?? []) lastOfKey.set(s.key, s);
  for (const s of lastOfKey.values()) {
    const cur = latest.get(s.key);
    if (cur && sameSales(cur, s)) continue;
    latest.set(s.key, s);
    out.sales.push(s);
  }
  const write = (name: string, rows: unknown[]) => {
    if (rows.length > 0) appendFileSync(join(dir, name), rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
  };
  write(FILES.pairs, out.pairs);
  write(FILES.engineers, out.engineers);
  write(FILES.sales, out.sales);
  return { pairs: out.pairs.length, engineers: out.engineers.length, sales: out.sales.length, addedPairs: out.pairs };
}

// ===== Drive への控え =====
// 作り直せないもの（組のキー・元メール・判定の結論）だけを1行にする。案件の中身は元メールから抽出し直せる

export interface BackupRow {
  key: string;
  sourceMailId: string;
  runId: string;
  judgedAt: string;
  verdict: string;
  priority: string;
  req: string;
  rateReason: string;
}

// 控えの1行（タブ区切り）。列: v1, key, sourceMailId, runId, judgedAt, verdict, priority, req, rateReason, crc
export const BACKUP_HEADER = 'v1\tkey\tsourceMailId\trunId\tjudgedAt\tverdict\tpriority\treq\trateReason\tcrc';
const BACKUP_COLUMNS = 10;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

// node:zlib の crc32 は Node 20.15+ / 22 から。無ければ自前の表
function crc32Hex(text: string): string {
  const native = (zlib as unknown as { crc32?: (data: string) => number }).crc32;
  let v: number;
  if (typeof native === 'function') {
    v = native(text);
  } else {
    let c = 0xffffffff;
    for (const b of Buffer.from(text, 'utf8')) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
    v = (c ^ 0xffffffff) >>> 0;
  }
  return (v >>> 0).toString(16).padStart(8, '0');
}

const flat = (v: string): string => v.replace(/[\t\r\n]+/g, ' ');

function reqCodeOf(judgment: RawProperJudgment): string {
  const reqs = judgment.requirements ?? [];
  if (reqs.length === 0) return '-';
  return reqs
    .map((r) => {
      const c = r.status === 'met' ? 'M' : r.status === 'close' ? 'C' : 'U';
      return (r.kind ?? '必須') === '尚可' ? c.toLowerCase() : c;
    })
    .join('');
}

export function backupLineOf(p: LabelPair): string {
  const m = /^[ABCD]/.exec(p.priority ?? '');
  const body = [
    'v1', p.key, p.project.sourceMailId, p.runId, p.judgedAt, p.judgment.verdict, m ? m[0] : '-', reqCodeOf(p.judgment), p.judgment.rateReason || '-',
  ].map((v) => flat(String(v ?? ''))).join('\t');
  return `${body}\t${crc32Hex(body)}`;
}

// 見出し行・空行は飛ばす。列数・crc が合わない行は捨てて bad に数える。同じ key は最初の行を採る
export function parseBackup(text: string): { rows: BackupRow[]; bad: number } {
  const rows: BackupRow[] = [];
  const seen = new Set<string>();
  let bad = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line === BACKUP_HEADER) continue;
    const cols = line.split('\t');
    if (cols.length !== BACKUP_COLUMNS || cols[0] !== 'v1') {
      bad += 1;
      continue;
    }
    const body = cols.slice(0, -1).join('\t');
    if (crc32Hex(body) !== cols[BACKUP_COLUMNS - 1]) {
      bad += 1;
      continue;
    }
    const [, key, sourceMailId, runId, judgedAt, verdict, priority, req, rateReason] = cols as [string, string, string, string, string, string, string, string, string];
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ key, sourceMailId, runId, judgedAt, verdict, priority, req, rateReason });
  }
  return { rows, bad };
}

// 書いたものと読み戻したものを key ごとに突き合わせる。値が違う・戻らなかった key は missing（最大20）
export function compareBackup(
  written: BackupRow[],
  readBack: BackupRow[],
  readBackBad = 0,
): { written: number; readBack: number; missing: string[]; bad: number; ok: boolean } {
  const back = new Map(readBack.map((r) => [r.key, r]));
  const same = (a: BackupRow, b: BackupRow) => (Object.keys(a) as Array<keyof BackupRow>).every((f) => a[f] === b[f]);
  const missingAll = written.filter((w) => {
    const r = back.get(w.key);
    return !r || !same(w, r);
  }).map((w) => w.key);
  return {
    written: written.length,
    readBack: readBack.length,
    missing: missingAll.slice(0, 20),
    bad: readBackBad,
    ok: missingAll.length === 0 && readBackBad === 0,
  };
}

export const BACKUP_SPLIT_BYTES = 15000;

// 見出し行＋行を、split があれば指定バイトごとのファイルに分けて書く。0件は書かない。書いたファイル名と合計を返す
export function writeBackupFiles(outDir: string, pairs: LabelPair[], split: boolean): { files: string[]; lines: number; bytes: number } {
  const lines = pairs.map(backupLineOf);
  if (lines.length === 0) return { files: [], lines: 0, bytes: 0 };
  mkdirSync(outDir, { recursive: true });
  const groups: string[][] = [];
  if (!split) groups.push(lines);
  else {
    let cur: string[] = [];
    let size = Buffer.byteLength(BACKUP_HEADER) + 1;
    for (const l of lines) {
      const n = Buffer.byteLength(l) + 1;
      if (cur.length > 0 && size + n > BACKUP_SPLIT_BYTES) {
        groups.push(cur);
        cur = [];
        size = Buffer.byteLength(BACKUP_HEADER) + 1;
      }
      cur.push(l);
      size += n;
    }
    if (cur.length > 0) groups.push(cur);
  }
  const files: string[] = [];
  let bytes = 0;
  groups.forEach((g, i) => {
    const name = split ? `labels_backup_${String(i + 1).padStart(2, '0')}.tsv` : 'labels_backup.tsv';
    const content = `${BACKUP_HEADER}\n${g.join('\n')}\n`;
    writeFileSync(join(outDir, name), content);
    bytes += Buffer.byteLength(content);
    files.push(name);
  });
  return { files, lines: lines.length, bytes };
}

// ===== 足切りの再現率 =====

export const GOOD_STATUSES = ['提案済', '面談調整', '面談済', '成約'];
export const PROPOSED_OR_LATER = GOOD_STATUSES;
export const PRIORITY_NONE = '（候補外）';
export const isGoodCheck = (check: string) => /^[◎○]/.test(check.trim());

export interface RecallTally { total: number; kept: number; missed: string[]; }
export interface PrefilterRecall { ai: RecallTally; sales: RecallTally; negative: RecallTally; noEngineer: number; }

// JSON で保存した案件の日付を戻す
export function reviveProject(p: Project): Project {
  return { ...p, receivedAt: new Date(p.receivedAt) };
}

// 今の足切り（ownPairsForJudge）を通る組か
export function passesPrefilter(pair: LabelPair, engineer: ProperEngineer): boolean {
  const pairs = ownPairsForJudge([engineer], [reviveProject(pair.project)], Number.MAX_SAFE_INTEGER, new Date(pair.judgedAt));
  return pairs.some((p) => p.match.ownEngineerId === engineer.id && p.match.projectId === pair.projectId);
}

export function prefilterRecall(
  pairs: LabelPair[],
  engineersByHash: Map<string, ProperEngineer>,
  salesByKey: Map<string, LabelSales> = new Map(),
): PrefilterRecall {
  const r: PrefilterRecall = {
    ai: { total: 0, kept: 0, missed: [] },
    sales: { total: 0, kept: 0, missed: [] },
    negative: { total: 0, kept: 0, missed: [] },
    noEngineer: 0,
  };
  const tally = (t: RecallTally, key: string, kept: boolean) => {
    t.total += 1;
    if (kept) t.kept += 1;
    else t.missed.push(key);
  };
  for (const p of pairs) {
    const engineer = engineersByHash.get(p.engineerHash);
    if (!engineer) {
      r.noEngineer += 1;
      continue;
    }
    const s = salesByKey.get(p.key);
    const aiPositive = p.judgment.verdict === 'recommend' || p.judgment.verdict === 'conditional';
    const salesPositive = Boolean(s) && (isGoodCheck(s?.check ?? '') || GOOD_STATUSES.includes(s?.status ?? ''));
    const negative = p.judgment.verdict === 'reject';
    if (!aiPositive && !salesPositive && !negative) continue;
    const kept = passesPrefilter(p, engineer);
    if (aiPositive) tally(r.ai, p.key, kept);
    if (salesPositive) tally(r.sales, p.key, kept);
    if (negative) tally(r.negative, p.key, kept);
  }
  return r;
}
