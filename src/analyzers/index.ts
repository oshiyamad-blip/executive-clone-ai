import '../env.js';
import { buildStories } from './story.js';
import { fetchRecentSignals, saveStory } from '../database/index.js';

// バッチ実行エントリーポイント（週次）
// 直近シグナルからストーリーを構築してNotionへ保存する
async function runAnalysisBatch(): Promise<void> {
  const signals = await fetchRecentSignals(200);
  const stories = await buildStories(signals);

  for (const story of stories) {
    const pageId = await saveStory(story);
    console.log(`✅ ストーリー保存: ${story.title}（Notion ID: ${pageId}）`);
  }
}

runAnalysisBatch().catch((err) => {
  console.error(err);
  process.exitCode = 1; // 失敗をcron/スクリプトから検知できるようにする
});
