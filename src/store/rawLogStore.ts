import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { RawLog } from '../types/index.js';

// 収集バッチと抽出バッチはそれぞれ別プロセスとして実行されるため、
// 生ログを両者の間でローカルJSONに永続化する。
// （バックエンドは持たず、Notionへ格納する前の一時的な受け皿として使う）

const DATA_DIR = join(process.cwd(), 'data');
const RAW_LOG_FILE = join(DATA_DIR, 'raw-logs.json');
const PROCESSED_FILE = join(DATA_DIR, 'processed-ids.json');

// 処理済みIDの保持期間。この期間「再遭遇しなかった」IDは失効する。
// 再遭遇（LINE全履歴の再エクスポート等で同じIDが再収集されること）のたびに
// lastSeen を更新するので、定期的に再出現するIDは失効しない。
// これが無いと processed-ids.json が無期限に成長し続ける。
const PROCESSED_TTL_DAYS = 180;

interface StoredRawLog extends Omit<RawLog, 'timestamp'> {
  timestamp: string; // JSONではISO文字列で保持する
}

// 処理済みID → 最終確認日時(ISO) のマップ
type ProcessedMap = Record<string, string>;

function ensureDataDir(): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    console.warn(`データディレクトリの作成に失敗: ${String(err)}`);
  }
}

// 生ログ一覧をファイルへ書き出す（保存・整理で共通）
function writeRawLogs(logs: RawLog[], failMessage: string): void {
  try {
    const serialized: StoredRawLog[] = logs.map((l) => ({
      ...l,
      timestamp: l.timestamp.toISOString(),
    }));
    writeFileSync(RAW_LOG_FILE, JSON.stringify(serialized, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`${failMessage}: ${String(err)}`);
  }
}

// 収集した生ログを追記保存する。
// 既存IDに加え「処理済みID」も除外する（同じファイルを再スキャンしても再蓄積しない）。
// 処理済みIDに再遭遇した場合は lastSeen を更新して失効を防ぐ。
export function saveRawLogs(logs: RawLog[]): void {
  ensureDataDir();
  const existing = loadRawLogs();
  const existingIds = new Set(existing.map((l) => l.id));
  const processed = loadProcessedMap();

  const nowIso = new Date().toISOString();
  let touchedProcessed = false;
  const fresh = logs.filter((l) => {
    if (processed[l.id]) {
      processed[l.id] = nowIso; // 再遭遇 → 延命
      touchedProcessed = true;
      return false;
    }
    return !existingIds.has(l.id);
  });

  writeRawLogs([...existing, ...fresh], '生ログの保存に失敗');
  if (touchedProcessed) saveProcessedMap(processed);
}

// 処理済みの生ログを raw-logs.json から取り除いてファイルサイズを抑える。
// （処理済みIDは processed-ids.json に残るため重複排除は維持される）
export function pruneProcessedLogs(): void {
  const processed = loadProcessedIds();
  if (processed.size === 0) return;
  const kept = loadRawLogs().filter((l) => !processed.has(l.id));
  writeRawLogs(kept, '生ログの整理に失敗');
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

// シグナル抽出済みとしてマークする（あわせてTTL超過分を失効させる）
export function markProcessed(ids: string[]): void {
  ensureDataDir();
  const processed = loadProcessedMap();
  const nowIso = new Date().toISOString();
  ids.forEach((id) => (processed[id] = nowIso));

  const cutoff = Date.now() - PROCESSED_TTL_DAYS * 24 * 60 * 60 * 1000;
  for (const [id, lastSeen] of Object.entries(processed)) {
    if (new Date(lastSeen).getTime() < cutoff) delete processed[id];
  }
  saveProcessedMap(processed);
}

function loadProcessedIds(): Set<string> {
  return new Set(Object.keys(loadProcessedMap()));
}

function loadProcessedMap(): ProcessedMap {
  try {
    if (!existsSync(PROCESSED_FILE)) return {};
    const parsed: unknown = JSON.parse(readFileSync(PROCESSED_FILE, 'utf-8'));
    if (Array.isArray(parsed)) {
      // 旧形式（ID文字列の配列）からの移行: 全IDをいま確認したものとして扱う
      const nowIso = new Date().toISOString();
      return Object.fromEntries((parsed as string[]).map((id) => [id, nowIso]));
    }
    return parsed as ProcessedMap;
  } catch (err) {
    console.warn(`処理済みIDの読み込みに失敗: ${String(err)}`);
    return {};
  }
}

function saveProcessedMap(map: ProcessedMap): void {
  try {
    writeFileSync(PROCESSED_FILE, JSON.stringify(map, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`処理済みIDの保存に失敗: ${String(err)}`);
  }
}
