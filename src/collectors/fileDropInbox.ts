import { readdirSync, readFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { join, extname } from 'path';
import type { RawLog } from '../types/index.js';

// フォルダ・ドロップ方式の共通処理。
// 公式APIが無い/使いにくいソース（Plaud NotePin S ライフログ、LINEエクスポート等）は、
// エクスポートしたファイルを受け皿フォルダに置く運用で取り込む。
// 処理済みファイルは <inbox>/_processed へ退避して二重取り込みを防ぐ。

export function processInbox(
  inboxDir: string,
  supportedExt: Set<string>,
  parseFile: (raw: string, fileName: string, filePath: string) => RawLog[] | RawLog | null,
  label: string,
): RawLog[] {
  if (!existsSync(inboxDir)) {
    console.warn(`${label}: 受け皿フォルダが存在しません (${inboxDir})`);
    return [];
  }

  const processedDir = join(inboxDir, '_processed');
  const files = readdirSync(inboxDir).filter((f) => supportedExt.has(extname(f).toLowerCase()));
  if (files.length === 0) return [];

  const logs: RawLog[] = [];
  for (const file of files) {
    const filePath = join(inboxDir, file);
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = parseFile(raw, file, filePath);
      if (parsed) logs.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      archiveFile(filePath, file, processedDir, label);
    } catch (err) {
      console.error(`${label}: ${file} の処理に失敗: ${String(err)}`);
    }
  }

  console.log(`${label}: ${logs.length}件を収集`);
  return logs;
}

function archiveFile(filePath: string, fileName: string, processedDir: string, label: string): void {
  try {
    if (!existsSync(processedDir)) mkdirSync(processedDir, { recursive: true });
    renameSync(filePath, join(processedDir, fileName));
  } catch (err) {
    console.warn(`${label}: ${fileName} の退避に失敗: ${String(err)}`);
  }
}
