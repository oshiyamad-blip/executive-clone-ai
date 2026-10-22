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

  const { signals, failedLogIds } = await extractSignals(logs);
  const failed = new Set(failedLogIds);

  let saved = 0;
  for (const signal of signals) {
    try {
      await saveSignal(signal);
      saved++;
    } catch (err) {
      console.error(`Notion保存失敗 (${signal.summary}): ${String(err)}`);
      // 保存できなかったシグナルの元ログも未処理のまま残す（次回リトライ）。
      // 同じログの別シグナルが保存済みの場合はリトライで重複し得るが、
      // 障害時にデータが恒久的に失われるより重複を選ぶ。
      signal.rawLogIds.forEach((id) => failed.add(id));
    }
  }

  // 抽出・保存に成功したログだけを処理済みにする。失敗分は次回バッチで再試行される。
  markProcessed(logs.map((l) => l.id).filter((id) => !failed.has(id)));
  pruneProcessedLogs(); // 処理済みの生ログを整理してファイルサイズを抑える
  if (failed.size > 0) {
    console.warn(`⚠️  ${failed.size}件のログは失敗のため未処理のまま残しました（次回再試行）`);
    process.exitCode = 1;
  }
  console.log(`=== 抽出バッチ完了: ${saved}件のシグナルをNotionに保存 ===`);
}

runExtractionBatch().catch((err) => {
  console.error(err);
  process.exitCode = 1; // 失敗をcron/スクリプトから検知できるようにする
});
