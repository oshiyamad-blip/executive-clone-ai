import { readdirSync, readFileSync, statSync, renameSync, mkdirSync, existsSync } from 'fs';
import { join, extname, basename } from 'path';
import type { RawLog } from '../types/index.js';

// ライフログ収集（録音デバイス: Plaud NotePin S）
//
// Plaud には公式ネイティブの Notion/Drive 連携が無く、手動UIにも一括/JSON
// エクスポートが無いため、本システムは「フォルダ・ドロップ方式」で取り込む。
// 以下いずれの経路でも、文字起こしファイルを LIFELOG_INBOX_DIR に置けば取り込める:
//   1. 公式 Zapier 連携「Transcript & Summary Ready」トリガー → Google Drive/
//      Dropbox 等へファイル出力 → ローカル同期フォルダを LIFELOG_INBOX_DIR に
//   2. 非公式 CLI（@plaud/cli）の `plaud sync <dir>` を日次 cron → その出力先を指定
//   3. Plaud アプリからの手動エクスポート（TXT/SRT/DOCX 等）をフォルダに置く
//
// 対応形式: .txt / .md / .srt / .vtt（文字起こしテキスト）
// 処理済みファイルは <inbox>/_processed へ退避して二重取り込みを防ぐ。

const INBOX_DIR = process.env.LIFELOG_INBOX_DIR ?? join(process.cwd(), 'lifelog-inbox');
const PROCESSED_DIR = join(INBOX_DIR, '_processed');
const SUPPORTED_EXT = new Set(['.txt', '.md', '.srt', '.vtt']);

export async function collectFromLifelog(): Promise<RawLog[]> {
  if (!existsSync(INBOX_DIR)) {
    console.warn(`ライフログ: 受け皿フォルダが存在しません (${INBOX_DIR})`);
    return [];
  }

  const files = readdirSync(INBOX_DIR).filter((f) => SUPPORTED_EXT.has(extname(f).toLowerCase()));
  if (files.length === 0) return [];

  const logs: RawLog[] = [];
  for (const file of files) {
    const filePath = join(INBOX_DIR, file);
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const ext = extname(file).toLowerCase();
      const content = ext === '.srt' || ext === '.vtt' ? parseSubtitle(raw) : parseTranscript(raw);

      if (content.trim()) {
        logs.push({
          id: `lifelog_${basename(file)}`,
          source: 'lifelog',
          timestamp: extractTimestamp(file, filePath),
          content,
          participants: extractSpeakers(raw),
          metadata: { device: 'Plaud NotePin S', originalFile: file },
        });
      }
      archiveFile(filePath, file);
    } catch (err) {
      console.error(`ライフログ: ${file} の処理に失敗: ${String(err)}`);
    }
  }

  return logs;
}

// SRT/VTT から発話テキストのみを抽出する（インデックス行・タイムコード行を除去）
function parseSubtitle(raw: string): string {
  return raw
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      if (!t) return false;
      if (t === 'WEBVTT') return false;
      if (/^\d+$/.test(t)) return false; // SRT のインデックス番号
      if (/-->/.test(t)) return false; // タイムコード行
      return true;
    })
    .join('\n')
    .trim();
}

// TXT/MD の文字起こし。話者ラベルやタイムスタンプは残す（文脈として有用）。
function parseTranscript(raw: string): string {
  // Markdown のフロントマターがあれば除去
  return raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}

// 「Speaker 1」「話者A」等のラベルを参加者として抽出する
function extractSpeakers(raw: string): string[] {
  const speakers = new Set<string>();
  const patterns = [/^(Speaker\s*\d+)/gim, /^(話者\s*[A-Z0-9]+)/gim, /^([^\n:：]{1,20})[:：]/gm];
  for (const pattern of patterns) {
    const matches = raw.matchAll(pattern);
    for (const m of matches) {
      const name = m[1]?.trim();
      if (name && name.length <= 20) speakers.add(name);
    }
    if (speakers.size > 0) break; // 最初にヒットしたパターンを採用
  }
  return [...speakers].slice(0, 10);
}

// ファイル名から日付を推定。取れなければファイルの更新日時を使う。
function extractTimestamp(fileName: string, filePath: string): Date {
  // 例: 2026-07-15, 20260715, 2026_07_15 などを拾う
  const iso = fileName.match(/(\d{4})[-_]?(\d{2})[-_]?(\d{2})/);
  if (iso) {
    const [, y, mo, d] = iso;
    const parsed = new Date(Number(y), Number(mo) - 1, Number(d));
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  try {
    return statSync(filePath).mtime;
  } catch {
    return statSync(filePath).ctime;
  }
}

// 取り込み済みファイルを _processed へ退避する
function archiveFile(filePath: string, fileName: string): void {
  try {
    if (!existsSync(PROCESSED_DIR)) mkdirSync(PROCESSED_DIR, { recursive: true });
    renameSync(filePath, join(PROCESSED_DIR, fileName));
  } catch (err) {
    console.warn(`ライフログ: ${fileName} の退避に失敗: ${String(err)}`);
  }
}
