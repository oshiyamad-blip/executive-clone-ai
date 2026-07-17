import { statSync } from 'fs';
import { join, extname, basename } from 'path';
import { processInbox } from './fileDropInbox.js';
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
const INBOX_DIR = process.env.LIFELOG_INBOX_DIR ?? join(process.cwd(), 'lifelog-inbox');
const SUPPORTED_EXT = new Set(['.txt', '.md', '.srt', '.vtt']);

export async function collectFromLifelog(): Promise<RawLog[]> {
  // 既定は archive=true（Plaudは録音ごとに一意ファイルが増えるため、処理済みを退避すると
  // 毎回の再スキャンが軽い）。Drive等の同期フォルダを使う場合は LIFELOG_ARCHIVE=false に
  // すると、クラウド上でファイルを動かさない（重複排除はストアのIDで担保）。
  const archive = process.env.LIFELOG_ARCHIVE !== 'false';
  return processInbox(INBOX_DIR, SUPPORTED_EXT, parseLifelogFile, 'ライフログ', { archive });
}

function parseLifelogFile(raw: string, file: string, filePath: string): RawLog | null {
  const ext = extname(file).toLowerCase();
  const content = ext === '.srt' || ext === '.vtt' ? parseSubtitle(raw) : parseTranscript(raw);
  if (!content.trim()) return null;

  return {
    id: `lifelog_${basename(file)}`,
    source: 'lifelog',
    timestamp: extractTimestamp(file, filePath),
    content,
    participants: extractSpeakers(raw),
    metadata: { device: 'Plaud NotePin S', originalFile: file },
  };
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
    for (const m of raw.matchAll(pattern)) {
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
    // statSync 自体が失敗する状況では ctime も取れないため、現在時刻でフォールバック
    return new Date();
  }
}
