import 'dotenv/config';
import { collectFromSlack } from './slack.js';
import { collectFromEmail } from './email.js';
import { collectFromCalendar } from './calendar.js';
import { collectFromMeetings } from './meeting.js';
import { collectFromLifelog } from './lifelog.js';
import { deduplicateLogs } from '../dedup/index.js';
import { saveRawLogs } from '../store/rawLogStore.js';
import type { RawLog } from '../types/index.js';

export async function collectAll(): Promise<RawLog[]> {
  console.log('=== データ収集開始 ===');

  const results = await Promise.allSettled([
    collectFromSlack(),
    collectFromEmail(),
    collectFromCalendar(),
    collectFromMeetings(),
    collectFromLifelog(),
  ]);

  const sources = ['Slack', 'メール', 'カレンダー', '会議', 'ライフログ'];
  const logs: RawLog[] = [];

  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      console.log(`✅ ${sources[i]}: ${result.value.length}件`);
      logs.push(...result.value);
    } else {
      console.error(`❌ ${sources[i]}: ${String(result.reason)}`);
    }
  });

  const deduped = deduplicateLogs(logs);
  saveRawLogs(deduped);
  console.log(`=== 収集完了: 合計${deduped.length}件（名寄せ後）をローカルストアに保存 ===`);
  return deduped;
}

// バッチ実行エントリーポイント
collectAll().catch(console.error);
