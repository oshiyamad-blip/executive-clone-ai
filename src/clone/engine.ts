import '../env.js';
import { generateText, type LlmMessage } from '../llm/index.js';
import { fetchRecentSignals, fetchRecentStories, saveSignal } from '../database/index.js';
import { EXECUTIVE_PROFILE } from '../data/executiveProfile.js';
import { getPersona } from '../demo/personas.js';
import type { ExecutiveProfile, Signal, Story } from '../types/index.js';

// DEMO_MODE=true のとき Notion 不要のサンプルデータで動く（デモ用）
const DEMO_MODE = process.env.DEMO_MODE === 'true';

// 経営者クローンの中核ロジック。CLI対話 / Web UI / ブリーフィング / ダイジェストで共用する。
// LLMは src/llm のプロバイダ抽象（Anthropic / Gemini）経由で呼ぶ。

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

// 対話モード。モードを追加するときは CLONE_MODES と loadCloneContext の prompts に
// エントリを足す（消費側は prompts レコード経由で参照するため、他に触る箇所はない）。
export type CloneMode = 'chat' | 'decision' | 'hiring';
export const CLONE_MODES: readonly CloneMode[] = ['chat', 'decision', 'hiring'];

export interface CloneContext extends CloneData {
  // モード別システムプロンプト（chat=壁打ち / decision=営業向け即断 / hiring=採用判断）
  prompts: Record<CloneMode, string>;
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
  if (DEMO_MODE) {
    const p = getPersona(process.env.DEMO_PERSONA ?? 'mikitani');
    return { profile: p.profile, signals: p.signals, stories: p.stories };
  }
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
    prompts: {
      chat: buildSystemPrompt(data.profile, data.signals, data.stories),
      decision: buildDecisionPrompt(data.profile, data.signals, data.stories),
      hiring: buildHiringPrompt(data.profile, data.signals, data.stories),
    },
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

// プロファイル＋データの共有コンテキストブロック（両モードで使う）
function renderContext(profile: ExecutiveProfile, signals: Signal[], stories: Story[]): string {
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
  const delegation = (profile.delegationRules ?? []).map((r) => `・${r}`).join('\n');

  return `【経営理念・価値観】
${profile.values.join('\n')}

【意思決定ルール（優先順位順）】
${rules}

【権限委譲ライン（営業が自分で決めてよい範囲）】
${delegation || '（未登録）'}

【過去の成功パターン】
${successPatterns || '（未登録）'}

【過去の失敗パターン】
${failurePatterns || '（未登録）'}

【最近の重要シグナル】
${recentSignals || '（データなし）'}

【蓄積ストーリー（因果関係の洞察）】
${recentStories || '（データなし）'}`;
}

// 経営者クローンのシステムプロンプト（要件3.4 経営理念プロンプト・通常の壁打ち）
export function buildSystemPrompt(profile: ExecutiveProfile, signals: Signal[], stories: Story[]): string {
  return `あなたは${profile.name}（${profile.role}）の思考を模倣するAIアシスタントです。
以下のプロファイルと実際の言動データを基に、経営者本人として回答してください。

${renderContext(profile, signals, stories)}

---
回答の際は:
1. 上記の意思決定ルールと過去のパターンに基づいて判断してください
2. シグナルやストーリーを根拠にした場合は、該当箇所に参照タグ（例: [S1] [T2]）を必ず付けてください
3. 確信度が低い場合はその旨を正直に伝えてください
4. 一人称は「私」を使い、経営者らしい簡潔なトーンで話してください`;
}

// 営業向け即断モードのシステムプロンプト。
// 現場の営業が商談中に「社長ならどう判断するか」を即引きするための簡潔フォーマット。
export function buildDecisionPrompt(profile: ExecutiveProfile, signals: Signal[], stories: Story[]): string {
  return `あなたは${profile.name}（${profile.role}）の判断を代行し、現場の営業に即断で助言するAIです。
営業は商談中で急いでいます。社長ならどう判断するかを、短く・明確に返してください。

${renderContext(profile, signals, stories)}

---
必ず次のフォーマットで、簡潔に回答してください:

【結論】OK / 条件付きOK / NG / 要相談（社長確認） のいずれか（1行）
【理由】意思決定ルール・過去事例に沿って2〜3行。根拠は [S1] [T1] で明示
【権限】「営業の裁量で進めてOK」か「社長に確認が必要」かを、上記の権限委譲ラインに照らして明記
（条件付きOKの場合のみ）【条件】満たすべき条件を箇条書き

判断の原則:
- 権限委譲ラインを超える・不確実・情報不足なら、無理に決めず「要相談（社長確認）」にする
- 迷ったら安全側（社長確認）に倒す。営業を勝手にリスクに晒さない
- 前置きや長い説明は不要。営業がその場で動ける実用的な即答を優先`;
}

// 採用判断モードのシステムプロンプト。
// 候補者情報（職歴・面接メモ・音声書き起こし等）を渡すと、社長の採用基準に照らして
// 合否の傾き・評価点・懸念点・深掘り質問・次アクションを返す。最終判断は人が行う前提。
export function buildHiringPrompt(profile: ExecutiveProfile, signals: Signal[], stories: Story[]): string {
  const criteria = (profile.hiringCriteria ?? []).map((c) => `・${c}`).join('\n');
  return `あなたは${profile.name}（${profile.role}）の採用観を代行し、採用判断を支援するAIです。
候補者の情報（職歴・面接メモ・音声書き起こしなど）を読み、社長ならどう見るかを整理してください。

${renderContext(profile, signals, stories)}

【採用で重視する基準】
${criteria || '（未登録）'}

---
必ず次のフォーマットで回答してください:

【合否の傾き】採用寄り / 条件付き / 見送り寄り / 情報不足 のいずれか（1行）＋確信度（高/中/低）
【評価できる点】採用基準に照らして良い点を2〜4個、箇条書き。根拠は [S1] [T1] で明示
【懸念点】基準に照らして気になる点・確認が必要な点を2〜4個、箇条書き
【深掘り質問】次の面接で必ず聞くべき質問を3〜5個（カルチャーフィット・実績の再現性を見極める質問）
【次アクション】リファレンスチェック・追加面接・見送り連絡など、次にとるべき具体的行動

判断の原則:
- これは採用判断の「支援」であり、最終決定は人が行う。断定しすぎない
- 情報が足りなければ「情報不足」とし、何を確認すべきかを明確にする
- 上記の採用基準が「（未登録）」の場合は、合否の傾きを判定せず「情報不足」とし、
  まず経営者の採用基準（hiringCriteria）の登録が必要である旨を伝える。基準を推測で補わない
- 経歴の華やかさより、採用基準（特にカルチャーフィット）に沿うかを重視する
- 学歴・性別・年齢・国籍など、公正な採用を損なう属性で判断しない。能力・行動・価値観で見る`;
}

// 回答文中の参照タグ [S1] [T2] を検出し、参照元一覧を組み立てる
export function resolveSources(answer: string, index: Map<string, SourceRef>): SourceRef[] {
  const used = new Set<string>();
  for (const m of answer.matchAll(/\[(S\d+|T\d+)\]/g)) used.add(m[1]);
  return [...used]
    .sort((a, b) => (a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : Number(a.slice(1)) - Number(b.slice(1))))
    .map((tag) => index.get(tag) ?? { tag, label: '(該当なし)' });
}

// 参照元一覧をCLI表示用に整形する（chat / decide / hire で共用）
export function formatSourceList(sources: SourceRef[], indent = ''): string {
  return sources
    .map((s) => `${indent}  - ${s.tag}: ${s.label}${s.url ? ` (${s.url})` : ''}`)
    .join('\n');
}

export interface AskResult {
  answer: string;
  sources: SourceRef[];
}

// 会話1ターン（history には user メッセージまで積んだ状態で渡す）
export async function askClone(
  systemPrompt: string,
  history: LlmMessage[],
  sourceIndex: Map<string, SourceRef>,
): Promise<AskResult> {
  const answer = await generateText(systemPrompt, history, { maxTokens: 16000 });
  return { answer, sources: resolveSources(answer, sourceIndex) };
}

// 単発の生成（ブリーフィング/ダイジェスト用）。Markdownテキストを返す。
export async function complete(system: string, user: string, maxTokens = 16000): Promise<string> {
  return generateText(system, [{ role: 'user', content: user }], { maxTokens });
}

// 対話ログをシグナルDBにフィードバックして学習ソースとして循環させる（疑似ログ再入力）
export async function feedbackChatLog(userInput: string, assistantResponse: string): Promise<void> {
  if (DEMO_MODE) return; // デモではDB書き込みしない
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
