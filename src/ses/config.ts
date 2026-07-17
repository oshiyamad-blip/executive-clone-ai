// SESマッチング機能: 全設定の一元読み出し。
// 全モジュールはこのファイル経由で設定を参照し、process.env を直接読まない。
// isDemo() が唯一の本番/demo分岐点（各段モジュールは冒頭でこれを見て分岐する）。

// DEMO_MODE=true 明示、または ANTHROPIC_API_KEY 未設定なら demo。
// 「ANTHROPIC_API_KEYが無い環境でも npm run ses:demo が外部呼び出しゼロで完走する」ことを保証する。
export function isDemo(): boolean {
  return process.env.DEMO_MODE === 'true' || !process.env.ANTHROPIC_API_KEY;
}

// 粗利下限（円/月）。要望の「10万円、変更可能に」に対応
export function minGrossMarginJpy(): number {
  return Number(process.env.MIN_GROSS_MARGIN_JPY ?? '100000');
}

// 1アイテムあたりLLM最終判定に回す候補ペア上限（LLMコスト上限の保証）
export function maxCandidatesPerItem(): number {
  return Number(process.env.MAX_CANDIDATES_PER_ITEM ?? '5');
}

// 必須スキル一致率の下限（0〜1）。これ未満は除外（＝許容範囲の下端）
export function skillMatchThreshold(): number {
  return Number(process.env.SKILL_MATCH_THRESHOLD ?? '0.6');
}

// 「強マッチ」の下限（0〜1）。この値以上は成立候補、下限〜この値未満は「参考提案」バンド
export function skillMatchStrongThreshold(): number {
  return Number(process.env.SKILL_MATCH_STRONG_THRESHOLD ?? '0.8');
}

// 時給→月額換算の稼働時間
export function hourlyToMonthlyHours(): number {
  return Number(process.env.HOURLY_TO_MONTHLY_HOURS ?? '160');
}

// 時期整合判定の猶予日数
export function matchTimingGraceDays(): number {
  return Number(process.env.MATCH_TIMING_GRACE_DAYS ?? '30');
}

// 交渉提案（粗利が下限に届かないペアを、両者の単金交渉で成立させる提案）を有効にするか
export function enableNegotiation(): boolean {
  return (process.env.ENABLE_NEGOTIATION ?? 'true') !== 'false';
}

// 交渉で「案件単金を上げてもらう」上限（万円/月）
export function maxNegotiationRaiseMan(): number {
  return Number(process.env.NEGOTIATION_MAX_PROJECT_RAISE_MAN ?? '5');
}

// 交渉で「要員単金を下げてもらう」上限（万円/月）
export function maxNegotiationCutMan(): number {
  return Number(process.env.NEGOTIATION_MAX_ENGINEER_CUT_MAN ?? '5');
}

// 収集対象（Xserverからの転送先）Gmailアドレス
export function sesTargetGmail(): string {
  return process.env.SES_TARGET_GMAIL ?? '';
}

// サマリ通知の宛先
export function sesNotifyTo(): string {
  return process.env.SES_NOTIFY_TO ?? '';
}

// 抽出用モデル（全メール最多コール。既定Haiku）
export function extractModel(): string {
  return process.env.ANTHROPIC_MODEL_EXTRACT ?? 'claude-haiku-4-5';
}

// 最終判定・メール生成用モデル（候補ペアのみ。既定Sonnet）
export function matchModel(): string {
  return process.env.ANTHROPIC_MODEL_MATCH ?? 'claude-sonnet-5';
}

export function notionProjectDbId(): string {
  return process.env.NOTION_PROJECT_DB_ID ?? '';
}

export function notionEngineerDbId(): string {
  return process.env.NOTION_ENGINEER_DB_ID ?? '';
}

export function notionMatchDbId(): string {
  return process.env.NOTION_MATCH_DB_ID ?? '';
}

// 自社社員DB（候補要員→案件探し機能）
export function notionOwnEngineerDbId(): string {
  return process.env.NOTION_OWN_ENGINEER_DB_ID ?? '';
}

// マッチ評価（フィードバック）ログDB。複数人の「妥当/ズレ」評価を共有の正として蓄積
export function notionFeedbackDbId(): string {
  return process.env.NOTION_FEEDBACK_DB_ID ?? '';
}

// スキル同義・類似辞書DB。人のフィードバックで育てる共有辞書
export function notionSkillEquivDbId(): string {
  return process.env.NOTION_SKILL_EQUIV_DB_ID ?? '';
}

// マッチ確認UIが読み書きするレビュー用ローカルJSONの置き場（demo/本番共通）。
// バッチ/自社社員探しがここへ成果を書き出し、Web UIがこれを読んでステータス更新する。
export function reviewDataDir(): string {
  return process.env.SES_REVIEW_DATA_DIR ?? 'data/ses-review';
}

// マッチ確認UIの待受ポート（既存の web(8787) と衝突しないよう既定8788）
export function sesWebPort(): number {
  return Number(process.env.SES_WEB_PORT ?? '8788');
}

// マッチ確認UIの待受ホスト。複数人でLAN共有する場合は 0.0.0.0 等を設定（要 WEB_ACCESS_TOKEN）。
// 既定は安全側でローカルのみ。
export function sesWebHost(): string {
  return process.env.SES_WEB_HOST ?? process.env.WEB_HOST ?? '127.0.0.1';
}

// trueでBatch API（50%割引）を使用。Phase3で参照（現状は未使用の予約設定）
export function useBatchApi(): boolean {
  return process.env.USE_BATCH_API === 'true';
}

// demo成果物の書き出し先（本番 data/ と隔離）
export function demoDataDir(): string {
  return process.env.SES_DEMO_DATA_DIR ?? 'data/ses-demo';
}
