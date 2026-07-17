import '../env.js';
import { readFileSync } from 'fs';
import { loadCloneContext, askClone, formatSourceList } from '../clone/engine.js';
import type { LlmMessage } from '../llm/index.js';

// 採用判断（CLI・単発）
// 使い方:
//   npm run hire -- "候補者の職歴・面接メモ…"
//   npm run hire -- --file demo/mikitani-inputs/candidate.txt
const USAGE = '使い方: npm run hire -- "候補者情報" もしくは npm run hire -- --file <path>';

// --file / -f は先頭でのみフラグとして解釈する。本文中に紛れたトークンでの誤爆や、
// インライン本文との併用による黙殺（本文が無視される）を防ぐため、曖昧な指定はエラーにする。
function parseCandidateInput(args: string[]): string {
  const fileFlagIdx = args.findIndex((a) => a === '--file' || a === '-f');
  if (fileFlagIdx > 0) {
    console.error(`--file / -f は先頭に指定してください（インライン本文との併用は不可）。\n${USAGE}`);
    process.exit(1);
  }
  if (fileFlagIdx === 0) {
    const path = args[1];
    if (!path) {
      console.error(USAGE);
      process.exit(1);
    }
    if (args.length > 2) {
      console.error(`--file とインライン本文は併用できません。どちらか一方を指定してください。\n${USAGE}`);
      process.exit(1);
    }
    try {
      return readFileSync(path, 'utf-8').trim();
    } catch (err) {
      console.error(`ファイルを読めませんでした: ${path}\n${String(err)}`);
      process.exit(1);
    }
  }
  return args.join(' ').trim();
}

async function main(): Promise<void> {
  const candidate = parseCandidateInput(process.argv.slice(2));
  if (!candidate) {
    console.error(USAGE);
    process.exit(1);
  }

  const ctx = await loadCloneContext();
  const history: LlmMessage[] = [
    { role: 'user', content: `次の候補者について採用判断を支援してください。\n\n---\n${candidate}\n---` },
  ];
  const result = await askClone(ctx.prompts.hiring, history, ctx.sourceIndex);

  console.log(`\n${result.answer}\n`);
  if (result.sources.length > 0) {
    console.log(`参照元:\n${formatSourceList(result.sources)}\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1; // 失敗をCI/スクリプトから検知できるようにする
});
