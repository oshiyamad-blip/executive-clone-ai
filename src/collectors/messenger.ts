import { join, basename } from 'path';
import { processInbox } from './fileDropInbox.js';
import type { RawLog } from '../types/index.js';

// メッセンジャー収集（LINE） — 本システムの主要チャネル
//
// LINE には個人の1:1トークを読む公開APIが無い（Messaging API はBot/公式アカウント用）。
// そのため LINE アプリの「トーク履歴を送信/転送」で出力した .txt を
// MESSENGER_INBOX_DIR に置く「フォルダ・ドロップ方式」で取り込む。
//
// LINE エクスポート形式（例）:
//   [LINE] 山田さんとのトーク履歴
//   保存日時：2026/07/15 20:00
//
//   2026/07/15(水)
//   12:34<TAB>山田<TAB>こんにちは
//   12:35<TAB>自分<TAB>複数行の
//   メッセージも連結される
// 日付ヘッダ行で日を区切り、日ごとに1つの RawLog にまとめる。
// export しているのは doctor（環境診断）が実際の取り込み先と同じパスを検査するため
export const INBOX_DIR = process.env.MESSENGER_INBOX_DIR ?? join(process.cwd(), 'messenger-inbox');
const SUPPORTED_EXT = new Set(['.txt']);

// LINE のシステム/メディア系プレースホルダ（それ単体では経営シグナルにならないノイズ）
const NOISE_ONLY = new Set([
  '[スタンプ]',
  '[写真]',
  '[動画]',
  '[ファイル]',
  '[アルバム]',
  '[ボイスメッセージ]',
  '[位置情報]',
  '[連絡先]',
  'メッセージの送信を取り消しました',
]);

export async function collectFromMessenger(): Promise<RawLog[]> {
  // 既定は非破壊（ファイルを移動しない）。同期フォルダ運用＋全履歴再エクスポートでも、
  // 下流ストアが「トーク×日付」単位で重複排除するため各データは一度だけ処理される。
  // ローカルの使い捨てフォルダで退避したい場合は MESSENGER_ARCHIVE=true。
  const archive = process.env.MESSENGER_ARCHIVE === 'true';
  return processInbox(INBOX_DIR, SUPPORTED_EXT, parseLineExport, 'メッセンジャー', { archive });
}

interface DayBucket {
  date: Date;
  dateKey: string; // ローカル日付の YYYY-MM-DD（toISOString のUTCずれを避ける）
  lines: string[];
  senders: Set<string>;
}

function parseLineExport(raw: string, file: string): RawLog[] {
  // 月日は1〜2桁を許容（2026/07/15, 2026.7.5, 2026/07/15(水) 等）
  const dateHeader = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})(?:[^\d]|$)/;
  const messageLine = /^(\d{1,2}:\d{2})\t([^\t]+)\t(.*)$/;
  // 会話相手（最初のヘッダ行から推定）
  const titleMatch = raw.match(/^\[LINE\]\s*(.+?)(?:との)?トーク/m);
  const conversation = titleMatch?.[1]?.trim() ?? '';

  const buckets: DayBucket[] = [];
  let current: DayBucket | null = null;

  for (const line of raw.split(/\r?\n/)) {
    const dm = line.match(dateHeader);
    if (dm) {
      const y = dm[1];
      const mo = dm[2].padStart(2, '0');
      const d = dm[3].padStart(2, '0');
      current = {
        date: new Date(Number(y), Number(mo) - 1, Number(d)),
        dateKey: `${y}-${mo}-${d}`,
        lines: [],
        senders: new Set(),
      };
      buckets.push(current);
      continue;
    }
    if (!current) continue; // 先頭のヘッダ（[LINE].../保存日時：...）は日付ヘッダ前なので自然にスキップ

    const mm = line.match(messageLine);
    if (mm) {
      const [, time, sender, text] = mm;
      if (NOISE_ONLY.has(text.trim())) continue; // スタンプ/写真のみの行は除外
      current.senders.add(sender);
      current.lines.push(`[${time}] ${sender}: ${text}`);
    } else if (line.trim() && current.lines.length > 0) {
      // タイムスタンプの無い継続行は直前のメッセージに連結する（複数行メッセージ）
      current.lines[current.lines.length - 1] += `\n${line}`;
    }
  }

  // 当日分のバケットは取り込まない（書きかけの日だから）。
  // 「トーク×日付」IDは内容を反映しないため、昼にエクスポートした時点で当日を
  // 処理済みにすると、夜の再エクスポートに含まれる同日後半のメッセージが
  // 二度と取り込まれなくなる。当日分は翌日以降のバッチで完全な状態で取り込む。
  const now = new Date();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  return buckets
    .filter((b) => b.lines.length > 0 && b.dateKey !== todayKey)
    .map((b) => ({
      id: `messenger_${basename(file)}_${b.dateKey}`,
      source: 'messenger' as const,
      timestamp: b.date,
      content: conversation ? `（${conversation}とのLINE）\n${b.lines.join('\n')}` : b.lines.join('\n'),
      participants: [...b.senders],
      metadata: { platform: 'LINE', conversation, originalFile: file },
    }));
}
