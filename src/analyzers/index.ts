import '../env.js';
import Anthropic from '@anthropic-ai/sdk';
import { fetchRecentSignals, saveStory } from '../database/index.js';
import type { Signal, Story, CausalLink } from '../types/index.js';

const client = new Anthropic();

const STORY_SYSTEM = `あなたは経営者の思考と行動パターンを分析する専門家です。
時系列シグナルデータを分析し、因果関係を持つストーリーを構築してください。

注目するポイント:
- ある人物との出会いがその後の事業進捗にどう影響したか
- アイデアの着想から意思決定に至るまでの流れ
- 外部環境の変化に対する反応パターン
- 成功・失敗体験が後の判断に与えた影響

以下のJSON形式のみで返してください:
{
  "title": "ストーリーの題名",
  "narrative": "因果関係を含む詳細な説明（500字以上）",
  "causalChain": [{"fromSignalId": "id", "toSignalId": "id", "relationship": "関係の説明"}],
  "insight": "このストーリーから導かれる経営上の知見"
}`;

// 構造化出力スキーマ（JSONパースの信頼性を担保）
const STORY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    narrative: { type: 'string' },
    causalChain: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fromSignalId: { type: 'string' },
          toSignalId: { type: 'string' },
          relationship: { type: 'string' },
        },
        required: ['fromSignalId', 'toSignalId', 'relationship'],
      },
    },
    insight: { type: 'string' },
  },
  required: ['title', 'narrative', 'causalChain', 'insight'],
} as const;

interface StoryCandidate {
  title: string;
  narrative: string;
  causalChain: CausalLink[];
  insight: string;
}

export async function buildStories(signals: Signal[]): Promise<Story[]> {
  if (signals.length < 3) {
    console.log('ストーリー構築: シグナルが少ないためスキップ（最低3件必要）');
    return [];
  }

  const groups = groupByMonth(signals);
  const stories: Story[] = [];

  for (const [period, group] of Object.entries(groups)) {
    const story = await buildStoryFromGroup(period, group);
    if (story) stories.push(story);
  }

  console.log(`ストーリー構築完了: ${stories.length}件`);
  return stories;
}

function groupByMonth(signals: Signal[]): Record<string, Signal[]> {
  return signals.reduce<Record<string, Signal[]>>((acc, signal) => {
    const key = signal.timestamp.toISOString().slice(0, 7);
    acc[key] = [...(acc[key] ?? []), signal];
    return acc;
  }, {});
}

async function buildStoryFromGroup(period: string, signals: Signal[]): Promise<Story | null> {
  const signalText = signals
    .map((s) => `[${s.id}] [${s.timestamp.toISOString()}] [${s.category}]\n概要: ${s.summary}\n詳細: ${s.detail}`)
    .join('\n\n');

  const message = await client.messages.create({
    // adaptive thinking + 構造化JSON出力の予算確保（非ストリーミング安全上限 ~16000）
    model: 'claude-opus-4-8',
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: STORY_SYSTEM,
    output_config: { format: { type: 'json_schema', schema: STORY_SCHEMA } },
    messages: [
      {
        role: 'user',
        content: `対象期間: ${period}\n\n---シグナルデータ---\n${signalText}\n---\n\nストーリーを構築してください。`,
      },
    ],
  });

  const textBlock = message.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') return null;

  try {
    const candidate: StoryCandidate = JSON.parse(textBlock.text);

    const parts = period.split('-').map(Number);
    const startYear = parts[0] ?? new Date().getFullYear();
    const startMonth = parts[1] ?? 1;

    return {
      id: `story_${period}_${Math.random().toString(36).slice(2, 7)}`,
      title: candidate.title,
      signalIds: signals.map((s) => s.id),
      period: {
        start: new Date(startYear, startMonth - 1, 1),
        end: new Date(startYear, startMonth, 0),
      },
      narrative: candidate.narrative,
      causalChain: candidate.causalChain,
      insight: candidate.insight,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  } catch {
    return null;
  }
}

// バッチ実行エントリーポイント（週次）
const signals = await fetchRecentSignals(200);
const stories = await buildStories(signals);

for (const story of stories) {
  const pageId = await saveStory(story);
  console.log(`✅ ストーリー保存: ${story.title}（Notion ID: ${pageId}）`);
}
