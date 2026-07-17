import '../env.js';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { complete, DIALOGUE_TAG } from '../clone/engine.js';
import { fetchRecentSignals, fetchRecentStories, createChildPage } from '../database/index.js';

// ③ 週次ダイジェスト生成
// 直近7日のシグナル・ストーリーを要約し、経営者向けの週次ダイジェストとして出力する。
// weekly バッチ（analyze の後）で自動実行される。

const DIGEST_SYSTEM = `あなたは経営者の右腕として、今週の重要な動きを簡潔にまとめる編集者です。
与えられた「今週のシグナル・ストーリー」を基に、経営者が3分で把握できる週次ダイジェストを
次の見出し構成のMarkdownで作成してください。該当が無い節は「特になし」と書いてください。

## 今週のハイライト
（最重要トピックを3点まで）

## 重要人物・外部接触
## 意思決定・方針
## 新しい気づき・仮説
## 業界トレンド・競合
## 来週の注目ポイント`;

async function main(): Promise<void> {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const signals = (await fetchRecentSignals(100)).filter(
    (s) => s.timestamp.getTime() >= weekAgo && !s.tags.includes(DIALOGUE_TAG),
  );
  // ストーリーは「期間（開始）」降順で取得されるため、createdAt（今週作成）でフィルタすると
  // 期間開始が古いものを取りこぼす。広めに取得してから作成日で絞る。
  const stories = (await fetchRecentStories(50)).filter((s) => s.createdAt.getTime() >= weekAgo);

  if (signals.length === 0 && stories.length === 0) {
    console.log('週次ダイジェスト: 今週の新規データがないためスキップします。');
    return;
  }

  const signalText = signals
    .map((s) => `[${s.category}][重要度${s.importance}] ${s.summary}`)
    .join('\n');
  const storyText = stories.map((s) => `■ ${s.title}: ${s.insight}`).join('\n');
  const context = `【今週のシグナル (${signals.length}件)】\n${signalText || '（なし）'}\n\n【今週のストーリー (${stories.length}件)】\n${storyText || '（なし）'}`;

  const md = await complete(DIGEST_SYSTEM, `以下は今週（過去7日）に蓄積されたデータです。\n\n${context}`);

  if (!md.trim()) {
    console.error('週次ダイジェストの生成に失敗しました（空応答）。中止します。');
    return;
  }

  const date = new Date().toISOString().slice(0, 10);
  const title = `週次ダイジェスト ${date}`;
  const body = `# ${title}\n\n_シグナル${signals.length}件 / ストーリー${stories.length}件_\n\n${md}`;

  // ローカル保存
  const dir = join(process.cwd(), 'digests');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, `${date}.md`);
  writeFileSync(file, body, 'utf-8');
  console.log(`✅ 週次ダイジェストを保存: ${file}`);

  // 任意: Notion 出力（ダイジェスト用 → ブリーフィング用親ページの順でフォールバック）
  const parent = process.env.NOTION_DIGEST_PARENT_PAGE_ID ?? process.env.NOTION_BRIEFING_PARENT_PAGE_ID;
  if (parent) {
    try {
      const id = await createChildPage(parent, title, body);
      console.log(`✅ Notionページ作成: ${id}`);
    } catch (err) {
      console.error(`Notionページ作成に失敗: ${String(err)}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1; // 失敗をcron/スクリプトから検知できるようにする
});
