import '../env.js';
import { collectFromSlack } from './slack.js';
import { collectFromEmail } from './email.js';
import { collectFromCalendar } from './calendar.js';
import { collectFromMeetings } from './meeting.js';
import { collectFromDocuments } from './document.js';
import { collectFromMessenger } from './messenger.js';
import { collectFromLifelog } from './lifelog.js';
import { deduplicateLogs } from '../dedup/index.js';
import { saveRawLogs, markProcessed } from '../store/rawLogStore.js';
import type { RawLog } from '../types/index.js';

// ラベルと収集関数を1つの表で管理する（別配列の位置合わせだと、追加時にずれて
// 失敗が別ソース名で報告される事故が起きるため）。
const COLLECTORS: ReadonlyArray<readonly [string, () => Promise<RawLog[]>]> = [
  ['Slack', collectFromSlack],
  ['メール', collectFromEmail],
  ['カレンダー', collectFromCalendar],
  ['会議', collectFromMeetings],
  ['文書', collectFromDocuments],
  ['メッセンジャー', collectFromMessenger],
  ['ライフログ', collectFromLifelog],
];

export async function collectAll(): Promise<RawLog[]> {
  console.log('=== データ収集開始 ===');

  const results = await Promise.allSettled(COLLECTORS.map(([, fn]) => fn()));
  const logs: RawLog[] = [];

  results.forEach((result, i) => {
    const label = COLLECTORS[i][0];
    if (result.status === 'fulfilled') {
      console.log(`✅ ${label}: ${result.value.length}件`);
      logs.push(...result.value);
    } else {
      console.error(`❌ ${label}: ${String(result.reason)}`);
    }
  });

  const deduped = deduplicateLogs(logs);
  saveRawLogs(deduped);

  // 名寄せで統合された側のログIDも「処理済み」に記録する。
  // 記録しないと、収集ウィンドウ内の再実行でマージ相手だけが単独再収集され、
  // 同じ内容が重複してシグナル化される。
  const mergedAway = deduped.flatMap((log) => {
    const from = log.metadata.mergedFrom;
    return Array.isArray(from) ? (from as string[]).filter((id) => id !== log.id) : [];
  });
  if (mergedAway.length > 0) markProcessed(mergedAway);

  console.log(`=== 収集完了: 合計${deduped.length}件（名寄せ後）をローカルストアに保存 ===`);
  return deduped;
}

// バッチ実行エントリーポイント
collectAll().catch((err) => {
  console.error(err);
  process.exitCode = 1; // 失敗をcron/スクリプトから検知できるようにする
});
