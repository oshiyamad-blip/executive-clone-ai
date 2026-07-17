import '../env.js';
import type Anthropic from '@anthropic-ai/sdk';
import { loadCloneContext, askClone } from '../clone/engine.js';

// 営業向け即断（CLI・単発）
// 使い方: npm run decide -- "この案件、15%値引きまでOK？"
async function main(): Promise<void> {
  const situation = process.argv.slice(2).join(' ').trim();
  if (!situation) {
    console.error('使い方: npm run decide -- "商談の状況や相談内容"');
    process.exit(1);
  }

  const ctx = await loadCloneContext();
  const history: Anthropic.MessageParam[] = [{ role: 'user', content: situation }];
  const result = await askClone(ctx.decisionPrompt, history, ctx.sourceIndex);

  console.log(`\n${result.answer}\n`);
  if (result.sources.length > 0) {
    console.log('参照元:');
    result.sources.forEach((s) => console.log(`  - ${s.tag}: ${s.label}${s.url ? ` (${s.url})` : ''}`));
    console.log('');
  }
}

main().catch(console.error);
