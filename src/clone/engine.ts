import '../env.js';
import Anthropic from '@anthropic-ai/sdk';
import { fetchRecentSignals, fetchRecentStories, saveSignal } from '../database/index.js';
import { EXECUTIVE_PROFILE } from '../data/executiveProfile.js';
import type { ExecutiveProfile, Signal, Story } from '../types/index.js';

// 経営者クローンの中核ロジック。CLI対話 / Web UI / ブリーフィング / ダイジェストで共用する。
const client = new Anthropic();

// 壁打ち対話ログ（疑似ログ再入力）を識別するタグ。
// DBには残すが、生成コンテキストからは除外して自己言及ノイズの占有を防ぐ。
export const DIALOGUE_TAG = 'AI対話';

export interface SourceRef {
  tag: string; // [S1] [T1] 等
  label: string;
  notionPageId?: string;
  url?: string;
}

export interface CloneData {
  profile: ExecutiveProfile;
  signals: Signal[];
  stories: Story[];
}

export interface CloneContext extends CloneData {
  systemPrompt: string;
  sourceIndex: Map<string, SourceRef>;
}

// Notion ページIDをクリック可能なURLに変換
function notionUrl(pageId?: string): string | undefined {
  return pageId ? `https://www.notion.so/${pageId.replace(/-/g, '')}` : undefined;
}

// DBから最新のシグナル・ストーリーを読み込む（生成コンテキスト用）。
// 壁打ち対話ログは除外し、本物のシグナルがプロンプトを占めるようにする。
// 除外分を見込んで多めに取得してからフィルタする。
export async function fetchCloneData(): Promise<CloneData> {
  const [signals, stories] = await Promise.all([fetchRecentSignals(80), fetchRecentStories(10)]);
  return {
    profile: EXECUTIVE_PROFILE,
    signals: signals.filter((s) => !s.tags.includes(DIALOGUE_TAG)),
    stories,
  };
}

export async function loadCloneContext(): Promise<CloneContext> {
  const data = await fetchCloneData();
  return {
    ...data,
    systemPrompt: buildSystemPrompt(data.profile, data.signals, data.stories),
    sourceIndex: buildSourceIndex(data.signals, data.stories),
  };
}

// シグナル/ストーリーに参照タグ（S1… / T1…）を割り当てて逆引き表を作る（根拠の明示）
export function buildSourceIndex(signals: Signal[], stories: Story[]): Map<string, SourceRef> {
  const index = new Map<string, SourceRef>();
  signals.slice(0, 20).forEach((s, i) => {
    const tag = `S${i + 1}`;
    index.set(tag, { tag, label: `[${s.category}] ${s.summary}`, notionPageId: s.notionPageId, url: notionUrl(s.notionPageId) });
  });
  stories.slice(0, 5).forEach((s, i) => {
    const tag = `T${i + 1}`;
    index.set(tag, { tag, label: s.title, notionPageId: s.notionPageId, url: notionUrl(s.notionPageId) });
  });
  return index;
}

// 経営者クローンのシステムプロンプト（要件3.4 経営理念プロンプト）
export function buildSystemPrompt(profile: ExecutiveProfile, signals: Signal[], stories: Story[]): string {
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

// 回答文中の参照タグ [S1] [T2] を検出し、参照元一覧を組み立てる
export function resolveSources(answer: string, index: Map<string, SourceRef>): SourceRef[] {
  const used = new Set<string>();
  for (const m of answer.matchAll(/\[(S\d+|T\d+)\]/g)) used.add(m[1]);
  return [...used]
    .sort((a, b) => (a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : Number(a.slice(1)) - Number(b.slice(1))))
    .map((tag) => index.get(tag) ?? { tag, label: '(該当なし)' });
}

export interface AskResult {
  answer: string;
  content: Anthropic.ContentBlock[];
  sources: SourceRef[];
}

// 会話1ターン（history には user メッセージまで積んだ状態で渡す）
export async function askClone(
  systemPrompt: string,
  history: Anthropic.MessageParam[],
  sourceIndex: Map<string, SourceRef>,
): Promise<AskResult> {
  const response = await client.messages.create({
    // adaptive thinking がトークン枠を消費するため、途中切れしにくい値にする
    model: 'claude-opus-4-8',
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: systemPrompt,
    messages: history,
  });
  const textBlock = response.content.find((b) => b.type === 'text');
  let answer = textBlock && textBlock.type === 'text' ? textBlock.text : '';
  // 空応答（max_tokens枯渇/refusal等）をそのまま履歴に戻すと文脈が壊れるため代替文にする
  if (!answer.trim()) {
    answer =
      response.stop_reason === 'max_tokens'
        ? '（回答が長くなりすぎて途中で止まりました。質問を分けてお試しください。）'
        : '（うまく回答を生成できませんでした。もう一度お試しください。）';
  }
  return { answer, content: response.content, sources: resolveSources(answer, sourceIndex) };
}

// 単発の生成（ブリーフィング/ダイジェスト用）。Markdownテキストを返す。
// adaptive thinking と本文が予算を食い合わないよう既定を大きめに（非ストリーミング安全上限）。
export async function complete(system: string, user: string, maxTokens = 16000): Promise<string> {
  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    system,
    messages: [{ role: 'user', content: user }],
  });
  const textBlock = response.content.find((b) => b.type === 'text');
  return textBlock && textBlock.type === 'text' ? textBlock.text : '';
}

// 対話ログをシグナルDBにフィードバックして学習ソースとして循環させる（疑似ログ再入力）
export async function feedbackChatLog(userInput: string, assistantResponse: string): Promise<void> {
  const signal: Signal = {
    id: `chat_${Date.now()}`,
    rawLogIds: [],
    timestamp: new Date(),
    category: 'decision',
    summary: `壁打ち対話: ${userInput.slice(0, 50)}...`,
    detail: `Q: ${userInput}\n\nA: ${assistantResponse}`,
    tags: ['壁打ち', DIALOGUE_TAG],
    importance: 3,
    relatedPeople: [],
  };
  try {
    await saveSignal(signal);
  } catch {
    // フィードバックはベストエフォート
  }
}
