import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { RawLog } from '../types/index.js';

// 収集バッチと抽出バッチはそれぞれ別プロセスとして実行されるため、
// 生ログを両者の間でローカルJSONに永続化する。
// （バックエンドは持たず、Notionへ格納する前の一時的な受け皿として使う）

const DATA_DIR = join(process.cwd(), 'data');
const RAW_LOG_FILE = join(DATA_DIR, 'raw-logs.json');
const PROCESSED_FILE = join(DATA_DIR, 'processed-ids.json');

interface StoredRawLog extends Omit<RawLog, 'timestamp'> {
  timestamp: string; // JSONではISO文字列で保持する
}

function ensureDataDir(): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    console.warn(`データディレクトリの作成に失敗: ${String(err)}`);
  }
}

// 収集した生ログを追記保存する（既存IDは重複追加しない）
export function saveRawLogs(logs: RawLog[]): void {
  ensureDataDir();
  const existing = loadRawLogs();
  const existingIds = new Set(existing.map((l) => l.id));
  const merged = [...existing, ...logs.filter((l) => !existingIds.has(l.id))];

  try {
    const serialized: StoredRawLog[] = merged.map((l) => ({
      ...l,
      timestamp: l.timestamp.toISOString(),
    }));
    writeFileSync(RAW_LOG_FILE, JSON.stringify(serialized, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`生ログの保存に失敗: ${String(err)}`);
  }
}

// 保存済みの生ログを読み込む
export function loadRawLogs(): RawLog[] {
  try {
    if (!existsSync(RAW_LOG_FILE)) return [];
    const serialized: StoredRawLog[] = JSON.parse(readFileSync(RAW_LOG_FILE, 'utf-8'));
    return serialized.map((l) => ({ ...l, timestamp: new Date(l.timestamp) }));
  } catch (err) {
    console.warn(`生ログの読み込みに失敗: ${String(err)}`);
    return [];
  }
}

// 未処理（まだシグナル抽出していない）の生ログを取得する
export function loadUnprocessedLogs(): RawLog[] {
  const processed = loadProcessedIds();
  return loadRawLogs().filter((l) => !processed.has(l.id));
}

// シグナル抽出済みとしてマークする
export function markProcessed(ids: string[]): void {
  ensureDataDir();
  const processed = loadProcessedIds();
  ids.forEach((id) => processed.add(id));
  try {
    writeFileSync(PROCESSED_FILE, JSON.stringify([...processed], null, 2), 'utf-8');
  } catch (err) {
    console.warn(`処理済みIDの保存に失敗: ${String(err)}`);
  }
}

function loadProcessedIds(): Set<string> {
  try {
    if (!existsSync(PROCESSED_FILE)) return new Set();
    const ids: string[] = JSON.parse(readFileSync(PROCESSED_FILE, 'utf-8'));
    return new Set(ids);
  } catch (err) {
    console.warn(`処理済みIDの読み込みに失敗: ${String(err)}`);
    return new Set();
  }
}
