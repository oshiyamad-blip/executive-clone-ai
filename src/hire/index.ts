import '../env.js';
import { readFileSync } from 'fs';
import { loadCloneContext, askClone } from '../clone/engine.js';
import type { LlmMessage } from '../llm/index.js';

// 採用判断（CLI・単発）
// 使い方:
//   npm run hire -- "候補者の職歴・面接メモ…"
//   npm run hire -- --file demo/mikitani-inputs/candidate.txt
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let candidate = '';

  const fileIdx = args.findIndex((a) => a === '--file' || a === '-f');
  if (fileIdx >= 0) {
    const path = args[fileIdx + 1];
    if (!path) {
      console.error('使い方: npm run hire -- --file <候補者情報ファイル>');
      process.exit(1);
    }
    try {
      candidate = readFileSync(path, 'utf-8').trim();
    } catch (err) {
      console.error(`ファイルを読めませんでした: ${path}\n${String(err)}`);
      process.exit(1);
    }
  } else {
    candidate = args.join(' ').trim();
  }

  if (!candidate) {
    console.error('使い方: npm run hire -- "候補者情報" もしくは npm run hire -- --file <path>');
    process.exit(1);
  }

  const ctx = await loadCloneContext();
  const history: LlmMessage[] = [
    { role: 'user', content: `次の候補者について採用判断を支援してください。\n\n---\n${candidate}\n---` },
  ];
  const result = await askClone(ctx.hiringPrompt, history, ctx.sourceIndex);

  console.log(`\n${result.answer}\n`);
  if (result.sources.length > 0) {
    console.log('参照元:');
    result.sources.forEach((s) => console.log(`  - ${s.tag}: ${s.label}${s.url ? ` (${s.url})` : ''}`));
    console.log('');
  }
}

main().catch(console.error);
