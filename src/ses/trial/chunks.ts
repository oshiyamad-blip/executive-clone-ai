// 試運転の一覧（list/w*.tsv）を、抽出担当に渡すチャンク（chunks/cNN）に分ける。
// 件名だけで明らかな要員メールは抽出に回さず out/skip.jsonl に書く（抽出費用の削減）。個人データを扱うので標準出力は件数だけ
// 前の回で1案件と抽出済みの同じ送信者・同じ件名の再送は抽出に回さず、前の行を写して out/resent.jsonl に書く（resent）
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineerBySubject, subjectPriority } from '../mailKind.js';

export interface ListedThread {
  threadId: string;
  messageId: string;
  internalDate: number;
  from: string;
  subject: string;
  messageCount: string;
}

export interface ChunksResult {
  threads: number;
  capped: number; // 新しい順の上限（max）で外したスレッド数
  skippedBySubject: number;
  deferred: number;
  chunks: number;
  resent: number; // 前の回の抽出を使い回して抽出に回さなかった再送スレッド数
}

interface PrevRow {
  threadId: string;
  messageId: string;
  subject: string;
  from: string;
  receivedAt: string;
  error?: unknown;
  extraction?: { projects?: Array<{ title?: string }> };
  [k: string]: unknown;
}

// 汎用的な件名（一覧・まとめ・時点）は別の案件でも同じになりうるので、再送とみなすには案件名が件名に含まれることを求める
const GENERIC_SUBJECT = /新着|案件(?:の)?(?:ご)?(?:連絡|案内|紹介|情報|一覧)|案件まとめ|時点|配信/;

// 一覧は送信者のアドレスだけ、抽出の行は「名前 <アドレス>」なので、アドレスで比べる
const normFrom = (s: string): string => {
  const t = s.normalize('NFKC').trim().toLowerCase();
  return t.match(/[^\s<>"]+@[^\s<>"]+/)?.[0] ?? t;
};
const normSubject = (s: string): string => s.normalize('NFKC').replace(/\s+/g, ' ').trim();
const resendKey = (from: string, subject: string): string => `${normFrom(from)}\u0000${normSubject(subject)}`;

function bigrams(s: string): Set<string> {
  const t = s.normalize('NFKC').replace(/[\s【】\[\]（）()]/g, '');
  const out = new Set<string>();
  for (let i = 0; i + 1 < t.length; i += 1) out.add(t.slice(i, i + 2));
  return out;
}

function titleInSubject(title: string, subject: string): boolean {
  const tb = bigrams(title);
  if (tb.size === 0) return false;
  const sb = bigrams(subject);
  let hit = 0;
  for (const g of tb) if (sb.has(g)) hit += 1;
  return hit / tb.size >= 0.5;
}

// harness.ts の carryDirs と同じ規則（CARRY_DIRS 優先、無ければ run_ で始まる兄弟）。
// ただし自分の名前が run_ で始まらない作業ディレクトリ（検証用の一時ディレクトリなど）は、CARRY_DIRS が無ければ何も読まない
function previousRunDirs(runDir: string): string[] {
  const own = resolve(runDir);
  const given = (process.env.CARRY_DIRS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (given.length > 0) return given.map((x) => resolve(x)).filter((x) => x !== own);
  if (!basename(own).startsWith('run_')) return [];
  const parent = dirname(own);
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('run_'))
      .map((d) => join(parent, d.name))
      .filter((p) => resolve(p) !== own)
      .sort();
  } catch {
    return [];
  }
}

function loadResendCandidates(runDir: string, now: number): Map<string, PrevRow> {
  const days = Number(process.env.PROPER_PROJECT_LOOKBACK_DAYS);
  const since = now - (Number.isFinite(days) && days > 0 ? days : 14) * 86_400_000;
  const byKey = new Map<string, PrevRow>();
  for (const d of previousRunDirs(runDir)) {
    const outDir = join(d, 'out');
    let files: string[];
    try {
      files = readdirSync(outDir).filter((n) => n.endsWith('.jsonl')).sort();
    } catch {
      continue;
    }
    for (const f of files) {
      let text: string;
      try {
        text = readFileSync(join(outDir, f), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let r: PrevRow;
        try {
          r = JSON.parse(line) as PrevRow;
        } catch {
          continue;
        }
        if (!r || typeof r.threadId !== 'string' || typeof r.subject !== 'string' || typeof r.from !== 'string' || r.error) continue;
        if (r.extraction?.projects?.length !== 1) continue;
        const t = new Date(r.receivedAt).getTime();
        if (!Number.isFinite(t) || t < since || t > now) continue;
        const key = resendKey(r.from, r.subject);
        const cur = byKey.get(key);
        if (!cur || t > new Date(cur.receivedAt).getTime()) byKey.set(key, r);
      }
    }
  }
  return byKey;
}

// 新しい形: スレッドID, 最新メッセージID, internalDate, 送信者, 件名, メッセージ数。古い形は4列で、2列目がスレッドIDと同じ（最新メッセージIDは無い扱い）
export function parseListLine(line: string): ListedThread | null {
  const cols = line.replace(/\r$/, '').split('\t');
  if (cols.length < 3) return null;
  const internalDate = Number(cols[2]);
  if (!cols[0] || !Number.isFinite(internalDate)) return null;
  const hasNew = cols.length >= 6;
  return {
    threadId: cols[0],
    messageId: cols[1] && cols[1] !== cols[0] ? cols[1] : '',
    internalDate,
    from: cols[3] ?? '',
    // 件名にタブが入っていても、最後の列（メッセージ数）を除いた残りを件名にする
    subject: hasNew ? cols.slice(4, -1).join(' ') : '',
    messageCount: hasNew ? (cols[cols.length - 1] ?? '') : '',
  };
}

export function readListDir(listDir: string): ListedThread[] {
  const byThread = new Map<string, ListedThread>();
  if (!existsSync(listDir)) return [];
  for (const f of readdirSync(listDir).filter((n) => /^w.*\.tsv$/.test(n)).sort()) {
    for (const line of readFileSync(join(listDir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const t = parseListLine(line);
      if (!t) continue;
      const prev = byThread.get(t.threadId);
      if (!prev || t.internalDate > prev.internalDate) byThread.set(t.threadId, t);
    }
  }
  return [...byThread.values()].sort((a, b) => a.internalDate - b.internalDate || (a.threadId < b.threadId ? -1 : 1));
}

// max は一覧のスレッド全体（件名で要員と分かるものも含む）を新しい順に並べて上位 max 件だけを以降に回す（0 以下・不正は上限なし）。
// 外した分は deferred.jsonl に reason: olderThanResumeCap で残す（再開した回に、届いた量に回の重さが左右されないため）
export function chunkRunDir(runDir: string, chunkSize = 30, keep = 1, max = 0): ChunksResult {
  const size = Number.isInteger(chunkSize) && chunkSize > 0 ? chunkSize : 30;
  const listed = readListDir(join(runDir, 'list'));
  const cap = Number.isInteger(max) && max > 0 ? max : 0;
  const newestFirst = [...listed].sort((a, b) => b.internalDate - a.internalDate || (a.threadId < b.threadId ? -1 : 1));
  const cappedOut = cap > 0 ? newestFirst.slice(cap) : [];
  const cappedIds = new Set(cappedOut.map((t) => t.threadId));
  const threads = listed.filter((t) => !cappedIds.has(t.threadId));
  const skipped = threads.filter((t) => engineerBySubject(t.subject));
  const remaining = threads.filter((t) => !engineerBySubject(t.subject));
  const ratio = Number.isFinite(keep) ? Math.min(1, Math.max(0, keep)) : 1;
  // 点数の高い順（同点は受信が新しい順）に上位 ceil(残り × keep) 件だけ抽出する。外した分は deferred.jsonl に残す
  const ranked = remaining
    .map((t) => ({ t, priority: subjectPriority(t.subject) }))
    .sort((a, b) => b.priority - a.priority || b.t.internalDate - a.t.internalDate || (a.t.threadId < b.t.threadId ? -1 : 1));
  const take = Math.ceil(remaining.length * ratio);
  const kept = new Set(ranked.slice(0, take).map((r) => r.t.threadId));
  const deferred = ranked.slice(take);
  const candidates = remaining.filter((t) => kept.has(t.threadId));
  const prevByKey = loadResendCandidates(runDir, Date.now());
  const resentRows: string[] = [];
  const rest = candidates.filter((t) => {
    const prev = prevByKey.get(resendKey(t.from, t.subject));
    // 同じ件名の再送は同じスレッドに新しいメッセージとして入ることが多いので、スレッドIDが同じでも受信が新しければ再送とみなす
    if (!prev || t.internalDate <= new Date(prev.receivedAt).getTime()) return true;
    const title = prev.extraction?.projects?.[0]?.title ?? '';
    if (GENERIC_SUBJECT.test(t.subject.normalize('NFKC')) && !titleInSubject(title, t.subject)) return true;
    resentRows.push(
      JSON.stringify({ ...prev, threadId: t.threadId, messageId: t.threadId, receivedAt: new Date(t.internalDate).toISOString(), subject: t.subject, from: t.from, resentOf: prev.messageId }),
    );
    return false;
  });
  const outDir = join(runDir, 'out');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'skip.jsonl'),
    skipped
      .map((t) => JSON.stringify({ threadId: t.threadId, messageId: t.messageId, subject: t.subject, from: t.from, receivedAt: new Date(t.internalDate).toISOString(), kind: 'engineer', bodyHead: '', skippedBySubject: true }))
      .join('\n') + (skipped.length > 0 ? '\n' : ''),
  );
  writeFileSync(join(outDir, 'resent.jsonl'), resentRows.join('\n') + (resentRows.length > 0 ? '\n' : ''));
  const deferredLine = (t: ListedThread, priority: number, reason: string): string =>
    JSON.stringify({ threadId: t.threadId, messageId: t.messageId, subject: t.subject, from: t.from, receivedAt: new Date(t.internalDate).toISOString(), priority, reason });
  const deferredLines = [
    ...deferred.map((r) => deferredLine(r.t, r.priority, 'lowPriority')),
    ...cappedOut.map((t) => deferredLine(t, subjectPriority(t.subject), 'olderThanResumeCap')),
  ];
  writeFileSync(join(runDir, 'deferred.jsonl'), deferredLines.join('\n') + (deferredLines.length > 0 ? '\n' : ''));
  const chunkDir = join(runDir, 'chunks');
  mkdirSync(chunkDir, { recursive: true });
  for (const f of readdirSync(chunkDir).filter((n) => /^c\d+$/.test(n))) rmSync(join(chunkDir, f));
  let chunks = 0;
  for (let i = 0; i < rest.length; i += size) {
    const lines = rest.slice(i, i + size).map((t) => [t.threadId, new Date(t.internalDate).toISOString(), t.messageId, t.messageCount].join('\t'));
    writeFileSync(join(chunkDir, `c${String(chunks).padStart(2, '0')}`), `${lines.join('\n')}\n`);
    chunks += 1;
  }
  return { threads: listed.length, capped: cappedOut.length, skippedBySubject: skipped.length, deferred: deferred.length, chunks, resent: resentRows.length };
}

function main(): void {
  const [runDirArg, sizeArg, keepArg, maxArg] = process.argv.slice(2);
  if (!runDirArg) {
    console.error(
      '使い方: npm run ses:trial:chunks -- <RUN_DIR> [chunkSize=30] [keep=1] [max=0]（keep は 0〜1。環境変数 SES_TRIAL_KEEP でも可。max は新しい順に残すスレッド数で 0 は上限なし。環境変数 SES_TRIAL_MAX_THREADS でも可。引数が優先）',
    );
    process.exitCode = 1;
    return;
  }
  const keepRaw = keepArg ?? process.env.SES_TRIAL_KEEP;
  const keep = keepRaw !== undefined && keepRaw !== '' ? Number(keepRaw) : 1;
  const maxRaw = maxArg ?? process.env.SES_TRIAL_MAX_THREADS;
  const max = maxRaw !== undefined && maxRaw !== '' ? Number(maxRaw) : 0;
  console.log(JSON.stringify(chunkRunDir(resolve(runDirArg), sizeArg ? Number(sizeArg) : 30, keep, max)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`チャンク分けに失敗しました: ${err instanceof Error ? err.constructor.name : 'Error'}`);
    process.exitCode = 1;
  }
}
