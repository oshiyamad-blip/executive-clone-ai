import '../env.js';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fetchCloneData, buildSystemPrompt, complete } from '../clone/engine.js';
import { createChildPage } from '../database/index.js';

// ① 会議前ブリーフィング生成
// 議題を渡すと、経営者クローンの見解＋根拠＋想定反論を1枚の成果物として出力する。
// 使い方: npm run brief -- "来期の新規事業投資をどうするか"

const BRIEF_INSTRUCTION = `以下の議題について、経営会議の前に経営者（あなた）の視点で意思決定ブリーフィングを作成してください。
必ず次の見出し構成のMarkdownで出力してください:

## 論点の要約
（議題の本質を2〜3行で）

## 私の見解
（経営者としての判断・方向性。意思決定ルールに沿って述べる。根拠は [S1] [T1] のように明示）

## 根拠
（参照したシグナル/ストーリーを箇条書きで。各項目の先頭に [S1] 等のタグ）

## 想定されるリスク・反論
（見落としがちな点、反対意見、失敗パターンとの照合）

## 会議で確認すべき論点
（部下に投げるべき問い、その場で決めるべきこと）`;

async function main(): Promise<void> {
  const topic = process.argv.slice(2).join(' ').trim();
  if (!topic) {
    console.error('使い方: npm run brief -- "会議の議題やテーマ"');
    process.exit(1);
  }

  const { profile, signals, stories } = await fetchCloneData();
  const system = buildSystemPrompt(profile, signals, stories);
  const md = await complete(system, `${BRIEF_INSTRUCTION}\n\n---\n議題: ${topic}\n---`);

  const date = new Date().toISOString().slice(0, 10);
  const title = `会議前ブリーフィング: ${topic}`;
  const body = `# ${title}\n\n_生成日: ${date} / ${profile.name}の分身_\n\n${md}`;

  // ローカルにMarkdown保存（常に）
  const dir = join(process.cwd(), 'briefings');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const slug = topic.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
  const file = join(dir, `${date}_${slug}.md`);
  writeFileSync(file, body, 'utf-8');
  console.log(`✅ ブリーフィングを保存: ${file}`);

  // 任意: Notionにも子ページ作成
  const parent = process.env.NOTION_BRIEFING_PARENT_PAGE_ID;
  if (parent) {
    try {
      const id = await createChildPage(parent, title, body);
      console.log(`✅ Notionページ作成: ${id}`);
    } catch (err) {
      console.error(`Notionページ作成に失敗: ${String(err)}`);
    }
  } else {
    console.log('（NOTION_BRIEFING_PARENT_PAGE_ID 未設定のため Notion 出力はスキップ）');
  }

  console.log(`\n${body}\n`);
}

main().catch(console.error);
