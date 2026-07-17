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
  // 採用で重視する基準（カルチャーフィット・見極めポイント）。採用判断モードで参照する。
  // 例: 「能力よりカルチャーフィットを優先」「素直さと学習速度を見る」
  hiringCriteria?: string[];
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

// ===== SES案件・要員マッチング機能 =====
// 単金はすべて「万円/月」に正規化した number で保持する（不明値は null）。
// 詳細は docs/ses-matching-basic-design.md §3 を参照。

// リモート可否（フル/一部/不可/不明）
export type RemoteOption = 'full' | 'partial' | 'none' | 'unknown';
// 案件ステータス（募集中/終了）
export type ProjectStatus = 'open' | 'closed';
// 要員ステータス（提案可/決定済）
export type EngineerStatus = 'available' | 'assigned';
// マッチステータス（未確認/紹介済/成約/見送り）
export type MatchStatus = 'unconfirmed' | 'introduced' | 'closed_won' | 'dropped';

// SES案件（要件定義 §4.1 の抽出スキーマに一致）
export interface Project {
  id: string; // 'proj_<hash>' 決定的ID（名寄せキーにも使う）
  title: string;
  requiredSkills: string[]; // 正規化済み
  preferredSkills: string[]; // 正規化済み
  rateMin: number | null; // 万円/月。「スキル見合い」等は null
  rateMax: number | null; // 万円/月
  location: string; // 勤務地（都道府県+市区）原文
  prefecture: string | null; // 正規化した都道府県名（隣接判定用）
  remote: RemoteOption;
  startPeriod: string; // 開始時期（原文）
  startDate: string | null; // 正規化した開始日 ISO（不明は null）
  duration: string; // 期間（原文）
  businessFlow: string; // 商流制限・外国籍可否・面談回数などの原文メモ
  agentCompany: string;
  agentContact: string;
  agentEmail: string; // 紹介メールの宛先に使用
  sourceMailId: string; // 抽出元メールID
  receivedAt: Date;
  status: ProjectStatus;
  notionPageId?: string;
}

// SES要員（エンジニア）。氏名・年齢等はPII（CLAUDE.md §非機能要件）
export interface Engineer {
  id: string; // 'eng_<hash>' 決定的ID
  displayName: string; // イニシャル推奨
  age: number | null;
  skills: string[]; // 正規化済み
  experienceYears: number | null;
  desiredRate: number | null; // 万円/月。不明は null
  residence: string; // 居住地（原文）
  prefecture: string | null; // 正規化した都道府県名
  nearestStation: string;
  availableDate: string; // 稼働開始可能日（原文）
  availableFrom: string | null; // 正規化した稼働可能日 ISO（不明は null）
  utilization: string; // 稼働率（原文）
  remoteWish: RemoteOption;
  agentCompany: string;
  agentContact: string;
  agentEmail: string;
  sourceMailId: string;
  receivedAt: Date;
  status: EngineerStatus;
  notionPageId?: string;
}

// 一次選抜（LLM不使用）を通過した候補ペア
export interface MatchPair {
  project: Project;
  engineer: Engineer;
  grossMarginJpy: number; // 粗利額（円/月）
  skillMatchRate: number; // 必須スキル一致率 0〜1
  locationOk: boolean;
  timingOk: boolean;
  needsReview: boolean; // 単金・勤務地不明などの「要確認」枠
}

// 紹介メール下書き参照
export interface DraftRef {
  draftId: string; // Gmail下書きID（demoはローカルID）
  url: string; // 下書きURL（demoはローカルファイルパス）
  to: string;
  subject: string;
}

// 最終判定・保存対象のマッチ結果（要件定義 §6.4 マッチ結果DBに対応）
export interface MatchResult {
  id: string; // 'match_<projId>_<engId>' 決定的ID（再実行冪等）
  projectId: string;
  engineerId: string;
  title: string; // 「案件名 × 要員表示名」
  grossMarginJpy: number; // 円/月
  score: number; // 適合スコア 0〜100
  reason: string; // 判定根拠文
  needsReview: boolean;
  draftToProject?: DraftRef;
  draftToEngineer?: DraftRef;
  status: MatchStatus;
  detectedAt: Date;
  notionPageId?: string;
}

// 添付を同梱した収集メール（parse への入力）
export interface SesRawMail {
  id: string; // 'sesmail_<gmailId>'
  from: string;
  to: string;
  subject: string;
  body: string; // text/plain 本文
  receivedAt: Date;
  attachments: SesAttachment[];
  sheetLinks: string[]; // 本文中の Google スプレッドシートURL
}

export interface SesAttachment {
  filename: string;
  mimeType: string;
  data: string; // base64（PDFはそのままdocumentブロックへ）
  text?: string; // parseでテキスト化した結果（xlsx/Sheets）
}

// extract の出力（1メールから0件以上）。種別で判別可能なユニオン
export type ExtractedItem =
  | { kind: 'project'; project: Project }
  | { kind: 'engineer'; engineer: Engineer }
  | { kind: 'other' }; // 案件でも要員でもない（破棄）
