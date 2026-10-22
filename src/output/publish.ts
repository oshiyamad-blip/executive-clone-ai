import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createChildPage } from '../database/index.js';

// Markdownレポートの出力（ブリーフィング・週次ダイジェストで共通）。
// 1) ローカルの出力ディレクトリへ .md を保存（常に）
// 2) notionParentId があれば Notion 子ページとしても出力（ベストエフォート）
export async function publishMarkdownReport(opts: {
  dir: string; // 出力ディレクトリ名（briefings / digests）
  filename: string; // 例: 2026-07-19_slug.md
  title: string; // Notionページのタイトル
  body: string; // Markdown全文（見出し込み）
  notionParentId?: string;
  notionUnsetNote?: string; // 親ページ未設定時に表示する案内（不要なら省略）
}): Promise<string> {
  const dir = join(process.cwd(), opts.dir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, opts.filename);
  writeFileSync(file, opts.body, 'utf-8');
  console.log(`✅ 保存: ${file}`);

  if (opts.notionParentId) {
    try {
      const id = await createChildPage(opts.notionParentId, opts.title, opts.body);
      console.log(`✅ Notionページ作成: ${id}`);
    } catch (err) {
      console.error(`Notionページ作成に失敗: ${String(err)}`);
    }
  } else if (opts.notionUnsetNote) {
    console.log(opts.notionUnsetNote);
  }

  return file;
}
