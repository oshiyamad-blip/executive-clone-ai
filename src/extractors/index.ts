import '../env.js';
import { extractSignals } from './extract.js';
import { loadUnprocessedLogs, markProcessed, pruneProcessedLogs } from '../store/rawLogStore.js';
import { saveSignal } from '../database/index.js';

// バッチ実行エントリーポイント（日次）
// ローカルストアの未処理ログを取得し、シグナルを抽出してNotionへ保存する
async function runExtractionBatch(): Promise<void> {
  console.log('=== シグナル抽出バッチ開始 ===');
  const logs = loadUnprocessedLogs();

  if (logs.length === 0) {
    console.log('未処理のログはありません。先に `npm run collect` を実行してください。');
    return;
  }

  const signals = await extractSignals(logs);

  let saved = 0;
  for (const signal of signals) {
    try {
      await saveSignal(signal);
      saved++;
    } catch (err) {
      console.error(`Notion保存失敗 (${signal.summary}): ${String(err)}`);
    }
  }

  // 抽出できたかに関わらず、処理したログは処理済みにする
  markProcessed(logs.map((l) => l.id));
  pruneProcessedLogs(); // 処理済みの生ログを整理してファイルサイズを抑える
  console.log(`=== 抽出バッチ完了: ${saved}件のシグナルをNotionに保存 ===`);
}

runExtractionBatch().catch((err) => {
  console.error(err);
  process.exitCode = 1; // 失敗をcron/スクリプトから検知できるようにする
});
