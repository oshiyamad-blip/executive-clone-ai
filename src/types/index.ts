// データソースの種類
export type DataSource =
  | 'slack'
  | 'email'
  | 'calendar'
  | 'meeting'
  | 'messenger'
  | 'lifelog'
  | 'document';

// 収集した生ログ
export interface RawLog {
  id: string;
  source: DataSource;
  timestamp: Date;
  content: string;
  participants: string[];
  metadata: Record<string, unknown>;
}

// シグナルのカテゴリ
export type SignalCategory =
  | 'hypothesis'  // 新しい仮説や気づき
  | 'key_person'  // 重要人物との接触
  | 'idea'        // 新規・既存事業のアイデア
  | 'decision'    // 経営方針・重要な意思決定
  | 'trend';      // 業界トレンド・競合知識

// シグナルデータベースのエントリ
export interface Signal {
  id: string;
  rawLogIds: string[];
  timestamp: Date;
  category: SignalCategory;
  summary: string;
  detail: string;
  tags: string[];
  importance: number; // 1〜10
  relatedPeople: string[];
  notionPageId?: string;
}

// ストーリー内の因果リンク
export interface CausalLink {
  fromSignalId: string;
  toSignalId: string;
  relationship: string;
}

// ストーリーデータベースのエントリ
export interface Story {
  id: string;
  title: string;
  signalIds: string[];
  period: { start: Date; end: Date };
  narrative: string;
  causalChain: CausalLink[];
  insight: string;
  createdAt: Date;
  updatedAt: Date;
  notionPageId?: string;
}

// 意思決定ルール（〜15個）
export interface DecisionRule {
  id: string;
  rule: string;
  priority: number;
  examples: string[];
}

// 経営者プロファイル
export interface ExecutiveProfile {
  name: string;
  role: string;
  values: string[];
  decisionRules: DecisionRule[];
  successPatterns: string[];
  failurePatterns: string[];
  // 権限委譲ライン（営業がその場で決めてよい範囲）。即断モードで参照する。
  // 例: 「値引きは10%まで営業裁量、超える場合は社長確認」
  delegationRules?: string[];
}

// 対話メッセージ
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  sources?: SourceReference[];
  timestamp: Date;
}

// 回答の根拠参照
export interface SourceReference {
  type: 'signal' | 'story';
  id: string;
  excerpt: string;
}

// バッチ処理の結果
export interface BatchResult<T> {
  succeeded: T[];
  failed: Array<{ item: T; error: Error }>;
  processedAt: Date;
}
