import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { createInterface } from 'readline/promises';
import { fetchRecentSignals, fetchRecentStories, saveSignal } from '../database/index.js';
import type { ExecutiveProfile, Signal, Story } from '../types/index.js';

const client = new Anthropic();

// 経営者プロファイルを読み込む
// 本番では NOTION_PROFILE_PAGE_ID のページから動的に取得する
function loadExecutiveProfile(): ExecutiveProfile {
  return {
    name: process.env.EXECUTIVE_NAME ?? '代表取締役',
    role: 'CEO',
    values: [
      '顧客価値を最優先する',
      '高速でPDCAを回す',
      '人材への長期投資を惜しまない',
    ],
    decisionRules: [
      { id: '1', rule: '短期利益より長期の関係性を重視する', priority: 1, examples: [] },
      { id: '2', rule: '不確実な状況では小さく試して学ぶ', priority: 2, examples: [] },
      { id: '3', rule: '意思決定は現場の声を必ず聞いてから行う', priority: 3, examples: [] },
      { id: '4', rule: '競合より顧客の課題に集中する', priority: 4, examples: [] },
      { id: '5', rule: '数字より定性的な変化を先に読む', priority: 5, examples: [] },
    ],
    successPatterns: [],
    failurePatterns: [],
  };
}

function buildSystemPrompt(profile: ExecutiveProfile, signals: Signal[], stories: Story[]): string {
  const rules = profile.decisionRules
    .sort((a, b) => a.priority - b.priority)
    .map((r) => `${r.priority}. ${r.rule}`)
    .join('\n');

  const recentSignals = signals
    .slice(0, 20)
    .map((s) => `[${s.category}] [重要度${s.importance}] ${s.summary}`)
    .join('\n');

  const recentStories = stories
    .slice(0, 5)
    .map((s) => `■ ${s.title}\n  洞察: ${s.insight}`)
    .join('\n\n');

  return `あなたは${profile.name}（${profile.role}）の思考を模倣するAIアシスタントです。
以下のプロファイルと実際の言動データを基に、経営者本人として回答してください。

【経営理念・価値観】
${profile.values.join('\n')}

【意思決定ルール（優先順位順）】
${rules}

【最近の重要シグナル】
${recentSignals || '（データなし）'}

【蓄積ストーリー（因果関係の洞察）】
${recentStories || '（データなし）'}

---
回答の際は:
1. 上記の意思決定ルールに基づいて判断してください
2. 回答末尾に [根拠] として参照したシグナルやストーリーを示してください
3. 確信度が低い場合はその旨を正直に伝えてください
4. 一人称は「私」を使い、経営者らしい簡潔なトーンで話してください`;
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

  const profile = loadExecutiveProfile();
  const systemPrompt = buildSystemPrompt(profile, signals, stories);
  const history: Anthropic.MessageParam[] = [];

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log(`\n✅ 準備完了（シグナル: ${signals.length}件 / ストーリー: ${stories.length}件）`);
  console.log(`${profile.name}の分身と会話を開始します。終了するには "exit" と入力してください。\n`);

  while (true) {
    const userInput = await rl.question('あなた: ');
    if (userInput.trim().toLowerCase() === 'exit') break;
    if (!userInput.trim()) continue;

    history.push({ role: 'user', content: userInput });

    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 2048,
      system: systemPrompt,
      messages: history,
    });

    const assistantText = response.content[0].type === 'text' ? response.content[0].text : '';
    history.push({ role: 'assistant', content: assistantText });

    console.log(`\n${profile.name}: ${assistantText}\n`);

    // 対話ログをシグナルDBにフィードバックして学習ソースとして循環させる
    await feedbackChatLog(userInput, assistantText);
  }

  rl.close();
  console.log('\n対話セッションを終了しました。');
}

startChat().catch(console.error);
