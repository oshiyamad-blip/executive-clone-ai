import '../env.js';
import { buildStories } from './story.js';
import { DIALOGUE_TAG } from '../clone/engine.js';
import { fetchRecentSignals, saveStory } from '../database/index.js';

// バッチ実行エントリーポイント（週次）
// 今週（過去7日）のシグナルからストーリーを構築してNotionへ保存する。
// 全期間を対象にすると、毎週同じ月のストーリーを再生成して重複ページが増殖し、
// クローンの生成コンテキスト（fetchRecentStories）を汚染するため、期間を絞る。
async function runAnalysisBatch(): Promise<void> {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const signals = (await fetchRecentSignals(100)).filter(
    (s) => s.timestamp.getTime() >= weekAgo && !s.tags.includes(DIALOGUE_TAG),
  );
  console.log(`ストーリー分析対象: 過去7日のシグナル${signals.length}件（対話ログ除く）`);

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
