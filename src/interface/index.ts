import '../env.js';
import type Anthropic from '@anthropic-ai/sdk';
import { createInterface } from 'readline/promises';
import { loadCloneContext, askClone, feedbackChatLog } from '../clone/engine.js';

// CLI 対話インターフェース（要件3.4 意思決定シミュレーション対話）
async function startChat(): Promise<void> {
  console.log('経営者クローンAI — 対話インターフェースを起動中...');

  const ctx = await loadCloneContext();
  const history: Anthropic.MessageParam[] = [];
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log(`\n✅ 準備完了（シグナル: ${ctx.signals.length}件 / ストーリー: ${ctx.stories.length}件）`);
  console.log(`${ctx.profile.name}の分身と会話を開始します。終了するには "exit" と入力してください。\n`);

  while (true) {
    const userInput = await rl.question('あなた: ');
    if (userInput.trim().toLowerCase() === 'exit') break;
    if (!userInput.trim()) continue;

    history.push({ role: 'user', content: userInput });

    let result;
    try {
      result = await askClone(ctx.systemPrompt, history, ctx.sourceIndex);
    } catch (err) {
      // 一過性のAPIエラーでセッション全体を落とさない。直前のユーザー入力は巻き戻す。
      console.error(`\n[エラー] 応答の取得に失敗しました。もう一度お試しください: ${String(err)}\n`);
      history.pop();
      continue;
    }

    // 同一モデルでの継続では content 全体をそのまま履歴に戻す（thinking ブロック維持）
    history.push({ role: 'assistant', content: result.content });
    console.log(`\n${ctx.profile.name}: ${result.answer}\n`);

    // 根拠の明示: 参照したシグナル/ストーリーを提示
    if (result.sources.length > 0) {
      console.log('  参照元:');
      result.sources.forEach((s) => console.log(`    - ${s.tag}: ${s.label}${s.url ? ` (${s.url})` : ''}`));
      console.log('');
    }

    // 対話ログをシグナルDBへ循環
    await feedbackChatLog(userInput, result.answer);
  }

  rl.close();
  console.log('\n対話セッションを終了しました。');
}

startChat().catch(console.error);
