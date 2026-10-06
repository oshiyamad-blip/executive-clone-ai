// 試運転の抽出で、抽出担当が手で写した本文の先頭（bodyHead）を、サブエージェントの作業記録（transcript）に残った
// get_thread の取得結果から機械で差し替える。個人データを扱うので、出力ファイル以外に本文を書かない（標準出力は件数だけ）
import { existsSync, mkdirSync, readdirSync, readFileSync, copyFileSync, writeFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

export const BODY_HEAD_CHARS = 1500;
export const BODY_HEAD_ENGINEER_CHARS = 500;
const MAX_LINE_CHARS = 30_000_000;

interface ThreadMessage {
  internalDate?: unknown;
  plaintextBody?: unknown;
}
interface Thread {
  id: string;
  messages: ThreadMessage[];
}

export interface BodyFixResult {
  rows: number;
  replaced: number;
  notFound: number;
  skippedLinkOnly: number;
  skippedBySubject: number;
  transcripts: number;
}

function listJsonl(dir: string): string[] {
  const found: string[] = [];
  const walk = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) found.push(p);
    }
  };
  walk(dir);
  return found.sort();
}

function toolResultTexts(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as { type?: unknown; content?: unknown };
    if (p.type !== 'tool_result') continue;
    if (typeof p.content === 'string') texts.push(p.content);
    else if (Array.isArray(p.content)) {
      for (const el of p.content) {
        const e = el as { type?: unknown; text?: unknown };
        if (e && e.type === 'text' && typeof e.text === 'string') texts.push(e.text);
      }
    }
  }
  return texts;
}

function asThread(text: string): Thread | null {
  if (!text.includes('"messages"')) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const t = v as { id?: unknown; messages?: unknown };
  if (typeof t.id !== 'string' || !t.id || !Array.isArray(t.messages)) return null;
  return { id: t.id, messages: t.messages as ThreadMessage[] };
}

// get_message の結果（1通の JSON。messages を持たない）は、threadId のスレッドの1通として扱う
function asSingleMessage(text: string): Thread | null {
  if (!text.includes('"threadId"') || !text.includes('"plaintextBody"')) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const m = v as { threadId?: unknown; messages?: unknown; internalDate?: unknown; plaintextBody?: unknown };
  if (typeof m.threadId !== 'string' || !m.threadId || m.messages !== undefined) return null;
  return { id: m.threadId, messages: [{ internalDate: m.internalDate, plaintextBody: m.plaintextBody }] };
}

const newestDate = (th: Thread): number => th.messages.reduce((mx, m) => (m && typeof m === 'object' ? Math.max(mx, dateOf(m)) : mx), -Infinity);

// 候補どうしの比べ: 最新メッセージの internalDate が大きい方。同じなら messages が多い方
function isBetter(cand: Thread, prev: Thread): boolean {
  const c = newestDate(cand);
  const p = newestDate(prev);
  if (c !== p) return c > p;
  return cand.messages.length > prev.messages.length;
}

// スレッドID → スレッド。同じスレッドが何度も出たら（get_thread・get_message）最新メッセージの internalDate が一番大きいもの、同じなら messages が多いもの
export function collectThreads(transcriptDir: string): { threads: Map<string, Thread>; transcripts: number } {
  const threads = new Map<string, Thread>();
  const files = listJsonl(transcriptDir);
  for (const file of files) {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line || line.length > MAX_LINE_CHARS || !line.includes('tool_result')) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const o = obj as { type?: unknown; message?: { content?: unknown } };
      if (!o || o.type !== 'user') continue;
      for (const text of toolResultTexts(o.message?.content)) {
        const th = asThread(text) ?? asSingleMessage(text);
        if (!th) continue;
        const prev = threads.get(th.id);
        if (!prev || isBetter(th, prev)) threads.set(th.id, th);
      }
    }
  }
  return { threads, transcripts: files.length };
}

const dateOf = (m: ThreadMessage): number => {
  const n = Number(m.internalDate);
  return Number.isFinite(n) ? n : -Infinity;
};

// internalDate が一番大きいメッセージの plaintextBody（無ければ null）
export function latestBody(th: Thread): string | null {
  let best: ThreadMessage | null = null;
  for (const m of th.messages) {
    if (!m || typeof m !== 'object') continue;
    if (!best || dateOf(m) > dateOf(best)) best = m;
  }
  return best && typeof best.plaintextBody === 'string' ? best.plaintextBody : null;
}

export function fixRunDir(runDir: string, transcriptDir: string): BodyFixResult {
  const { threads, transcripts } = collectThreads(transcriptDir);
  const result: BodyFixResult = { rows: 0, replaced: 0, notFound: 0, skippedLinkOnly: 0, skippedBySubject: 0, transcripts };
  const outDir = join(runDir, 'out');
  if (!existsSync(outDir)) return result;
  const backupDir = join(runDir, 'out_backup');
  for (const name of readdirSync(outDir).filter((n) => n.endsWith('.jsonl')).sort()) {
    const file = join(outDir, name);
    if (!statSync(file).isFile()) continue;
    const original = readFileSync(file, 'utf8');
    let changed = false;
    const lines = original.split('\n').map((line) => {
      if (!line.trim()) return line;
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return line;
      }
      if (!row || typeof row !== 'object' || row.error !== undefined) return line;
      result.rows++;
      if (row.skippedBySubject === true) {
        result.skippedBySubject++;
        return line;
      }
      const id = typeof row.threadId === 'string' ? row.threadId : typeof row.messageId === 'string' ? row.messageId : '';
      const th = threads.get(id);
      if (!th) {
        result.notFound++;
        return line;
      }
      const body = (latestBody(th) ?? '').replace(/\r\n?/g, '\n');
      if (!body.trim() || (body.length < 200 && body.includes('http'))) {
        result.skippedLinkOnly++;
        return line;
      }
      row.bodyHead = body.slice(0, row.kind === 'engineer' ? BODY_HEAD_ENGINEER_CHARS : BODY_HEAD_CHARS);
      result.replaced++;
      changed = true;
      return JSON.stringify(row);
    });
    if (!changed) continue;
    mkdirSync(backupDir, { recursive: true });
    const backup = join(backupDir, name);
    if (!existsSync(backup)) copyFileSync(file, backup);
    writeFileSync(file, lines.join('\n'));
  }
  return result;
}

function main(): void {
  const [runDirArg, transcriptDirArg] = process.argv.slice(2);
  if (!runDirArg || !transcriptDirArg) {
    console.error('使い方: npm run ses:trial:bodyfix -- <RUN_DIR> <transcriptDir>');
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(fixRunDir(resolve(runDirArg), resolve(transcriptDirArg))));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`本文の差し替えに失敗しました: ${err instanceof Error ? err.constructor.name : 'Error'}`);
    process.exitCode = 1;
  }
}
