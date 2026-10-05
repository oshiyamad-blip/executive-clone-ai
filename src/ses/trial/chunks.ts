// 試運転の一覧（list/w*.tsv）を、抽出担当に渡すチャンク（chunks/cNN）に分ける。
// 件名だけで明らかな要員メールは抽出に回さず out/skip.jsonl に書く（抽出費用の削減）。個人データを扱うので標準出力は件数だけ
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineerBySubject } from '../mailKind.js';

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
  skippedBySubject: number;
  chunks: number;
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

export function chunkRunDir(runDir: string, chunkSize = 30): ChunksResult {
  const size = Number.isInteger(chunkSize) && chunkSize > 0 ? chunkSize : 30;
  const threads = readListDir(join(runDir, 'list'));
  const skipped = threads.filter((t) => engineerBySubject(t.subject));
  const rest = threads.filter((t) => !engineerBySubject(t.subject));
  const outDir = join(runDir, 'out');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'skip.jsonl'),
    skipped
      .map((t) => JSON.stringify({ threadId: t.threadId, messageId: t.messageId, subject: t.subject, from: t.from, receivedAt: new Date(t.internalDate).toISOString(), kind: 'engineer', bodyHead: '', skippedBySubject: true }))
      .join('\n') + (skipped.length > 0 ? '\n' : ''),
  );
  const chunkDir = join(runDir, 'chunks');
  mkdirSync(chunkDir, { recursive: true });
  for (const f of readdirSync(chunkDir).filter((n) => /^c\d+$/.test(n))) rmSync(join(chunkDir, f));
  let chunks = 0;
  for (let i = 0; i < rest.length; i += size) {
    const lines = rest.slice(i, i + size).map((t) => [t.threadId, new Date(t.internalDate).toISOString(), t.messageId, t.messageCount].join('\t'));
    writeFileSync(join(chunkDir, `c${String(chunks).padStart(2, '0')}`), `${lines.join('\n')}\n`);
    chunks += 1;
  }
  return { threads: threads.length, skippedBySubject: skipped.length, chunks };
}

function main(): void {
  const [runDirArg, sizeArg] = process.argv.slice(2);
  if (!runDirArg) {
    console.error('使い方: npm run ses:trial:chunks -- <RUN_DIR> [chunkSize=30]');
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(chunkRunDir(resolve(runDirArg), sizeArg ? Number(sizeArg) : 30)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`チャンク分けに失敗しました: ${err instanceof Error ? err.constructor.name : 'Error'}`);
    process.exitCode = 1;
  }
}
