import '../env.js';
import Anthropic from '@anthropic-ai/sdk';
import { createInterface } from 'readline/promises';
import { fetchRecentSignals, fetchRecentStories, saveSignal } from '../database/index.js';
import { EXECUTIVE_PROFILE } from '../data/executiveProfile.js';
import type { ExecutiveProfile, Signal, Story } from '../types/index.js';

const client = new Anthropic();

// シグナル/ストーリーに参照タグ（S1, S2… / T1, T2…）を割り当てて逆引き表を作る。
// これにより回答の根拠（要件3.4 根拠の明示）を具体的な参照元に紐付けられる。
function buildSourceIndex(
  signals: Signal[],
  stories: Story[],
): Map<string, { label: string; notionPageId?: string }> {
  const index = new Map<string, { label: string; notionPageId?: string }>();
  signals.slice(0, 20).forEach((s, i) => {
    index.set(`S${i + 1}`, {
      label: `[${s.category}] ${s.summary}`,
      notionPageId: s.notionPageId,
    });
  });
  stories.slice(0, 5).forEach((s, i) => {
    index.set(`T${i + 1}`, { label: `${s.title}`, notionPageId: s.notionPageId });
  });
  return index;
}

function buildSystemPrompt(profile: ExecutiveProfile, signals: Signal[], stories: Story[]): string {
  const rules = profile.decisionRules
    .slice()
    .sort((a, b) => a.priority - b.priority)
    .map((r) => `${r.priority}. ${r.rule}`)
    .join('\n');

  const recentSignals = signals
    .slice(0, 20)
    .map((s, i) => `[S${i + 1}] [${s.category}] [重要度${s.importance}] ${s.summary}`)
    .join('\n');

  const recentStories = stories
    .slice(0, 5)
    .map((s, i) => `[T${i + 1}] ${s.title}\n  洞察: ${s.insight}`)
    .join('\n\n');

  const successPatterns = profile.successPatterns.map((p) => `・${p}`).join('\n');
  const failurePatterns = profile.failurePatterns.map((p) => `・${p}`).join('\n');

  return `あなたは${profile.name}（${profile.role}）の思考を模倣するAIアシスタントです。
以下のプロファイルと実際の言動データを基に、経営者本人として回答してください。

【経営理念・価値観】
${profile.values.join('\n')}

【意思決定ルール（優先順位順）】
${rules}

【過去の成功パターン】
${successPatterns || '（未登録）'}

【過去の失敗パターン】
${failurePatterns || '（未登録）'}

【最近の重要シグナル】
${recentSignals || '（データなし）'}

【蓄積ストーリー（因果関係の洞察）】
${recentStories || '（データなし）'}

---
回答の際は:
1. 上記の意思決定ルールと過去のパターンに基づいて判断してください
2. シグナルやストーリーを根拠にした場合は、該当箇所に参照タグ（例: [S1] [T2]）を必ず付けてください
3. 確信度が低い場合はその旨を正直に伝えてください
4. 一人称は「私」を使い、経営者らしい簡潔なトーンで話してください`;
}

// 回答文中の参照タグ [S1] [T2] を検出し、参照元の一覧を組み立てる
function resolveSources(
  answer: string,
  index: Map<string, { label: string; notionPageId?: string }>,
): string[] {
  const used = new Set<string>();
  for (const m of answer.matchAll(/\[(S\d+|T\d+)\]/g)) {
    used.add(m[1]);
  }
  return [...used]
    // S/T の別と数値でソート（辞書順だと S1, S10, S2 になるのを防ぐ）
    .sort((a, b) => {
      const pa = a[0];
      const pb = b[0];
      if (pa !== pb) return pa < pb ? -1 : 1;
      return Number(a.slice(1)) - Number(b.slice(1));
    })
    .map((tag) => {
      const src = index.get(tag);
      if (!src) return `${tag}: (該当なし)`;
      const link = src.notionPageId ? ` (Notion: ${src.notionPageId})` : '';
      return `${tag}: ${src.label}${link}`;
    });
}

// AIとの対話ログをシグナルとして循環させる（疑似ログ再入力）
async function feedbackChatLog(userInput: string, assistantResponse: string): Promise<void> {
  const signal: Signal = {
    id: `chat_${Date.now()}`,
    rawLogIds: [],
    timestamp: new Date(),
    category: 'decision',
    summary: `壁打ち対話: ${userInput.slice(0, 50)}...`,
    detail: `Q: ${userInput}\n\nA: ${assistantResponse}`,
    tags: ['壁打ち', 'AI対話'],
    importance: 3,
    relatedPeople: [],
  };

  try {
    await saveSignal(signal);
  } catch {
    // 対話ログのフィードバックはベストエフォートで処理する
  }
}

async function startChat(): Promise<void> {
  console.log('経営者クローンAI — 対話インターフェースを起動中...');

  const [signals, stories] = await Promise.all([
    fetchRecentSignals(50),
    fetchRecentStories(10),
  ]);

  const profile = EXECUTIVE_PROFILE;
  const systemPrompt = buildSystemPrompt(profile, signals, stories);
  const sourceIndex = buildSourceIndex(signals, stories);
  const history: Anthropic.MessageParam[] = [];

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log(`\n✅ 準備完了（シグナル: ${signals.length}件 / ストーリー: ${stories.length}件）`);
  console.log(`${profile.name}の分身と会話を開始します。終了するには "exit" と入力してください。\n`);

  while (true) {
    const userInput = await rl.question('あなた: ');
    if (userInput.trim().toLowerCase() === 'exit') break;
    if (!userInput.trim()) continue;

    history.push({ role: 'user', content: userInput });

    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: 'claude-opus-4-8',
        max_tokens: 8192,
        thinking: { type: 'adaptive' },
        system: systemPrompt,
        messages: history,
      });
    } catch (err) {
      // 一過性のAPIエラーでセッション全体を落とさない。直前のユーザー入力は巻き戻す。
      console.error(`\n[エラー] 応答の取得に失敗しました。もう一度お試しください: ${String(err)}\n`);
      history.pop();
      continue;
    }

    // adaptive thinking では content に thinking ブロックが含まれるため text を探す。
    // 同一モデルでの継続では content 全体をそのまま履歴に戻す（thinking ブロック維持）。
    const textBlock = response.content.find((b) => b.type === 'text');
    const assistantText = textBlock && textBlock.type === 'text' ? textBlock.text : '';
    history.push({ role: 'assistant', content: response.content });

    console.log(`\n${profile.name}: ${assistantText}\n`);

    // 根拠の明示: 回答が参照したシグナル/ストーリーを解決して提示する
    const sources = resolveSources(assistantText, sourceIndex);
    if (sources.length > 0) {
      console.log('  参照元:');
      sources.forEach((s) => console.log(`    - ${s}`));
      console.log('');
    }

    // 対話ログをシグナルDBにフィードバックして学習ソースとして循環させる
    await feedbackChatLog(userInput, assistantText);
  }

  rl.close();
  console.log('\n対話セッションを終了しました。');
}

startChat().catch(console.error);
