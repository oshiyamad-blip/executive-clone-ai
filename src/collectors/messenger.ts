import { join, basename } from 'path';
import { processInbox } from './fileDropInbox.js';
import type { RawLog } from '../types/index.js';

// メッセンジャー収集（LINE）
//
// LINE には個人の1:1トークを読む公開APIが無い（Messaging API はBot/公式アカウント用）。
// そのため LINE アプリの「トーク履歴を送信/エクスポート」で出力した .txt を
// MESSENGER_INBOX_DIR に置く「フォルダ・ドロップ方式」で取り込む。
//
// LINE エクスポート形式（例）:
//   2026/07/15(水)
//   12:34<TAB>山田<TAB>こんにちは
//   12:35<TAB>自分<TAB>返信です
// 日付ヘッダ行で日を区切り、日ごとに1つの RawLog にまとめる。
const INBOX_DIR = process.env.MESSENGER_INBOX_DIR ?? join(process.cwd(), 'messenger-inbox');
const SUPPORTED_EXT = new Set(['.txt']);

export async function collectFromMessenger(): Promise<RawLog[]> {
  return processInbox(INBOX_DIR, SUPPORTED_EXT, parseLineExport, 'メッセンジャー');
}

interface DayBucket {
  date: Date;
  dateKey: string; // ローカル日付の YYYY-MM-DD（toISOString のUTCずれを避ける）
  lines: string[];
  senders: Set<string>;
}

function parseLineExport(raw: string, file: string): RawLog[] {
  const dateHeader = /^(\d{4})[/.](\d{2})[/.](\d{2})/; // 2026/07/15 または 2026.07.15
  const messageLine = /^(\d{1,2}:\d{2})\t([^\t]+)\t(.*)$/;

  const buckets: DayBucket[] = [];
  let current: DayBucket | null = null;

  for (const line of raw.split(/\r?\n/)) {
    const dm = line.match(dateHeader);
    if (dm) {
      current = {
        date: new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3])),
        dateKey: `${dm[1]}-${dm[2]}-${dm[3]}`,
        lines: [],
        senders: new Set(),
      };
      buckets.push(current);
      continue;
    }
    if (!current) continue;

    const mm = line.match(messageLine);
    if (mm) {
      const [, time, sender, text] = mm;
      current.senders.add(sender);
      current.lines.push(`[${time}] ${sender}: ${text}`);
    } else if (line.trim() && current.lines.length > 0) {
      // タイムスタンプの無い継続行は直前のメッセージに連結する
      current.lines[current.lines.length - 1] += `\n${line}`;
    }
  }

  return buckets
    .filter((b) => b.lines.length > 0)
    .map((b) => ({
      id: `messenger_${basename(file)}_${b.dateKey}`,
      source: 'messenger' as const,
      timestamp: b.date,
      content: b.lines.join('\n'),
      participants: [...b.senders],
      metadata: { platform: 'LINE', originalFile: file },
    }));
}
