import '../env.js';
import { readFileSync } from 'fs';
import { basename } from 'path';
import { extractSignals } from '../extractors/extract.js';
import { buildStories } from '../analyzers/story.js';
import type { RawLog } from '../types/index.js';

// 本番リハーサル（乾式・Notion書き込みなし）
// 本番と同じ LLM 経路（構造化抽出 → ストーリー構築）を、実ファイルで通して動作確認する。
// 導入日の朝に `npm run doctor` とセットで実行する想定。
//
// 使い方:
//   npm run rehearse                      # 同梱のサンプル議事録・音声メモで実行
//   npm run rehearse -- 議事録.txt メモ.txt  # 実ファイルで実行（内容はNotionに保存されない）
const DEFAULT_FILES = [
  'demo/mikitani-inputs/2026-07-15_meeting-minutes.txt',
  'demo/mikitani-inputs/2026-07-15_voice-memo.txt',
];

async function main(): Promise<void> {
  const files = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_FILES;

  console.log('経営者クローンAI — 本番リハーサル（Notionへの書き込みなし）\n');
  const logs: RawLog[] = files.map((path, i) => {
    const content = readFileSync(path, 'utf-8');
    console.log(`  📄 入力 ${i + 1}: ${basename(path)}（${content.length}文字）`);
    return {
      id: `rehearsal_${i + 1}`,
      source: 'lifelog',
      timestamp: new Date(),
      content,
      participants: [],
      metadata: { rehearsal: true, path },
    };
  });

  console.log('\n■ ステップ1: シグナル抽出（本番の npm run extract と同じ経路）');
  const signals = await extractSignals(logs);
  if (signals.length === 0) {
    console.error(
      '❌ シグナルが1件も抽出されませんでした。LLMの疎通（npm run doctor）と入力内容を確認してください。',
    );
    process.exitCode = 1;
    return;
  }
  for (const s of signals) {
    console.log(`  [${s.category}] [重要度${s.importance}] ${s.summary}`);
  }

  console.log('\n■ ステップ2: ストーリー構築（本番の npm run analyze と同じ経路）');
  const stories = await buildStories(signals);
  for (const st of stories) {
    console.log(`  📖 ${st.title}`);
    console.log(`     洞察: ${st.insight}`);
  }
  if (stories.length === 0 && signals.length < 3) {
    console.log('  （シグナル3件未満のためストーリーはスキップ — 入力ファイルを増やせば確認できます）');
  }

  console.log(
    `\n✅ リハーサル完了: シグナル${signals.length}件 / ストーリー${stories.length}件（Notionには何も保存していません）`,
  );
  console.log('   本番実行: 入力を lifelog-inbox/ 等に置いて npm run daily（週次は npm run weekly）');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
