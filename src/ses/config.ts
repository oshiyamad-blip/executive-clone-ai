// SESマッチング機能: 全設定の一元読み出し。
// 全モジュールはこのファイル経由で設定を参照し、process.env を直接読まない。
// isDemo() が唯一の本番/demo分岐点（各段モジュールは冒頭でこれを見て分岐する）。
//
// 値の解釈: 空文字・空白だけの値は「未設定」として既定値を使う（GitHub Actions の未定義変数や
// .env.example の `X=` がそのまま入っても 0 や空のモデル名にならないため）。
// 数値は全角・桁区切りカンマを許し、解釈できない/範囲外なら既定値に戻して1回だけ警告する。

// 未設定・空文字は ''（前後の空白は除く）
function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

function envStr(name: string, def: string): string {
  return env(name) || def;
}

const warnedEnv = new Set<string>();

function warnEnvOnce(name: string, message: string): void {
  if (warnedEnv.has(name)) return;
  warnedEnv.add(name);
  console.warn(`設定: ${name} ${message}`);
}

export interface NumberRange {
  min?: number;
  max?: number;
  int?: boolean;
}

// 数値の設定値の解釈（純関数）。全角・桁区切り（, _ 空白）を許す。空・数値でない・範囲外は既定値（valid=false）
export function parseNumberSetting(raw: string, def: number, range: NumberRange = {}): { value: number; valid: boolean } {
  const t = raw.trim();
  if (!t) return { value: def, valid: true };
  const n = Number(t.normalize('NFKC').replace(/[,_\s]/g, ''));
  const ok =
    Number.isFinite(n) &&
    (range.min === undefined || n >= range.min) &&
    (range.max === undefined || n <= range.max) &&
    (!range.int || Number.isInteger(n));
  return ok ? { value: n, valid: true } : { value: def, valid: false };
}

// 数値の設定。min/max の範囲外や数値でない値は既定値に戻す（値そのものはログに出さない）
function envNum(name: string, def: number, range: NumberRange = {}): number {
  const { value, valid } = parseNumberSetting(env(name), def, range);
  if (!valid) {
    const bounds = [range.min !== undefined ? `${range.min}以上` : '', range.max !== undefined ? `${range.max}以下` : '']
      .filter(Boolean)
      .join('・');
    warnEnvOnce(name, `を数値${range.int ? '（整数）' : ''}${bounds ? `・${bounds}` : ''}として解釈できないため既定値 ${def} を使います`);
  }
  return value;
}

// 'true'/'false' の設定（それ以外・未設定は既定値）
function envBool(name: string, def: boolean): boolean {
  const v = env(name).toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return def;
}

// ===== 実行モード（demo / 本番） =====

// スケジュール実行（CI/GitHub Actions）など、demoに倒れては困る環境か。SES_REQUIRE_LIVE で明示上書き可
export function requireLive(): boolean {
  const v = env('SES_REQUIRE_LIVE').toLowerCase();
  if (v === 'true' || v === 'false') return v === 'true';
  return env('CI') === 'true' || env('GITHUB_ACTIONS') === 'true';
}

// DEMO_MODE=true が明示されているか
export function demoModeExplicit(): boolean {
  return env('DEMO_MODE') === 'true';
}

// LLMプロバイダ（anthropic | gemini）
export function llmProviderName(): string {
  return envStr('LLM_PROVIDER', 'anthropic').toLowerCase();
}

// 使用中のLLMプロバイダの鍵（Gemini は AI Studio の鍵 または Vertex AI のプロジェクト）が揃っているか
export function llmKeyConfigured(): boolean {
  if (llmProviderName() === 'gemini') {
    return env('GOOGLE_GENAI_USE_VERTEXAI') === 'true' ? Boolean(env('GOOGLE_CLOUD_PROJECT')) : Boolean(env('GEMINI_API_KEY'));
  }
  return Boolean(env('ANTHROPIC_API_KEY'));
}

function llmKeyName(): string {
  if (llmProviderName() !== 'gemini') return 'ANTHROPIC_API_KEY';
  return env('GOOGLE_GENAI_USE_VERTEXAI') === 'true' ? 'GOOGLE_CLOUD_PROJECT' : 'GEMINI_API_KEY';
}

// 確認UIのように、LLM鍵の有無ではなく DEMO_MODE の明示だけでモードを決めたいプロセス用の上書き
let demoOverride: boolean | null = null;
export function setDemoOverride(value: boolean | null): void {
  demoOverride = value;
}

export type RunMode = 'demo' | 'live' | 'error';

// 実行モードの決定（純関数）。DEMO_MODE=true 明示、またはローカル実行でLLMの鍵が無いときに demo。
// 「鍵の無い手元環境でも npm run ses:demo が外部呼び出しゼロで完走する」ことを保証する。
// ただし CI（requireLive）では鍵の欠落を demo に倒さない（fixtureで「成功」してしまうため）→ error
export function decideRunMode(o: { demoExplicit: boolean; keyConfigured: boolean; requireLive: boolean }): RunMode {
  if (o.demoExplicit) return 'demo';
  if (o.keyConfigured) return 'live';
  return o.requireLive ? 'error' : 'demo';
}

function currentRunMode(): RunMode {
  return decideRunMode({ demoExplicit: demoModeExplicit(), keyConfigured: llmKeyConfigured(), requireLive: requireLive() });
}

// error のときは demo にしない（本番経路に進み、各エントリポイントが liveConfigError() で終了コード1にして止める）
export function isDemo(): boolean {
  if (demoOverride !== null) return demoOverride;
  return currentRunMode() === 'demo';
}

// 本番として動けない設定なら理由（固定文言）を返す。問題なければ null
export function liveConfigError(): string | null {
  if (currentRunMode() !== 'error') return null;
  return `LLMの鍵（${llmKeyName()}）が未設定です。CI/スケジュール実行ではdemoに切り替えず停止します（Secretsの名前と受け渡しを確認してください。意図的にdemoで動かす場合は DEMO_MODE=true）`;
}

// 粗利下限（円/月）。要望の「10万円、変更可能に」に対応。
// 交渉幅の設定（*_MAN）に合わせて万円で書きたい場合は MIN_GROSS_MARGIN_MAN を使う（こちらを優先）
export function minGrossMarginJpy(): number {
  if (env('MIN_GROSS_MARGIN_MAN')) return Math.round(envNum('MIN_GROSS_MARGIN_MAN', 10, { min: 0 }) * 10000);
  const jpy = envNum('MIN_GROSS_MARGIN_JPY', 100000, { min: 0 });
  if (jpy > 0 && jpy < 1000) {
    warnEnvOnce('MIN_GROSS_MARGIN_JPY', 'は円単位です（万円で指定する場合は MIN_GROSS_MARGIN_MAN を使ってください）');
  }
  return jpy;
}

// 1アイテムあたりLLM最終判定に回す候補ペア上限（LLMコスト上限の保証）
export function maxCandidatesPerItem(): number {
  return envNum('MAX_CANDIDATES_PER_ITEM', 5, { min: 1, int: true });
}

// 必須スキル一致率の下限（0〜1）。これ未満は除外（＝許容範囲の下端）
export function skillMatchThreshold(): number {
  return envNum('SKILL_MATCH_THRESHOLD', 0.6, { min: 0, max: 1 });
}

// 「強マッチ」の下限（0〜1）。この値以上は成立候補、下限〜この値未満は「参考提案」バンド
export function skillMatchStrongThreshold(): number {
  return envNum('SKILL_MATCH_STRONG_THRESHOLD', 0.8, { min: 0, max: 1 });
}

// 時給→月額換算の稼働時間
export function hourlyToMonthlyHours(): number {
  return envNum('HOURLY_TO_MONTHLY_HOURS', 160, { min: 1 });
}

// 最終判定（LLM）のスコアがこれ未満の「成立候補」は「参考提案」に下げる（自動の紹介下書きを作らない）。0で無効
export function matchMinLlmScore(): number {
  return envNum('MATCH_MIN_LLM_SCORE', 50, { min: 0, max: 100 });
}

// 時期整合判定の猶予日数
export function matchTimingGraceDays(): number {
  return envNum('MATCH_TIMING_GRACE_DAYS', 30, { min: 0 });
}

// 交渉提案（粗利が下限に届かないペアを、両者の単金交渉で成立させる提案）を有効にするか
export function enableNegotiation(): boolean {
  return envBool('ENABLE_NEGOTIATION', true);
}

// 交渉で「案件単金を上げてもらう」上限（万円/月）
export function maxNegotiationRaiseMan(): number {
  return envNum('NEGOTIATION_MAX_PROJECT_RAISE_MAN', 5, { min: 0 });
}

// 交渉で「要員単金を下げてもらう」上限（万円/月）
export function maxNegotiationCutMan(): number {
  return envNum('NEGOTIATION_MAX_ENGINEER_CUT_MAN', 5, { min: 0 });
}

// 通常バッチの突合で、今回の新着と組み合わせる「前回以前に保存した募集中案件・提案可要員」の遡り日数
// （収集の実行回をまたいで届いた案件と要員を見逃さないため。判定済みのペアはマッチIDで除外する）
export function matchLookbackDays(): number {
  return envNum('SES_MATCH_LOOKBACK_DAYS', 14, { min: 0 });
}

// 上記で読み込む既存の案件・要員それぞれの上限件数（新しい順）
export function matchPoolLimit(): number {
  return envNum('SES_MATCH_POOL_LIMIT', 500, { min: 1, int: true });
}

// メール送受信のプロバイダ。xserver（既定・IMAP/SMTP）| gmail（Google Workspace・API）。
// マッチングやUIは共通。収集・下書き作成・サマリ送信の「口」だけがこれで切り替わる。
export function mailProvider(): string {
  return envStr('MAIL_PROVIDER', 'xserver').toLowerCase();
}

// Gmailプロバイダで収集・サマリ送信に使うSES専用メールボックス（DWDでこのユーザーとして読み書きする。
// グループアドレスではなく実ユーザーのアドレスを指定する）
export function sesTargetGmail(): string {
  return env('SES_TARGET_GMAIL');
}

// --- Xserver（IMAP/SMTP）設定。共有メーリス(sales@)の収集・下書きAPPEND・サマリ送信に使用 ---
export function xserverImapHost(): string {
  return env('XSERVER_IMAP_HOST');
}
export function xserverImapPort(): number {
  return envNum('XSERVER_IMAP_PORT', 993, { min: 1, max: 65535, int: true });
}
export function xserverSmtpHost(): string {
  return env('XSERVER_SMTP_HOST');
}
export function xserverSmtpPort(): number {
  return envNum('XSERVER_SMTP_PORT', 465, { min: 1, max: 65535, int: true });
}
// 共有メールボックス(sales@)のログイン情報（収集・下書きAPPEND・SMTP送信の認証に使用）
export function xserverSharedUser(): string {
  return env('XSERVER_SHARED_USER');
}
export function xserverSharedPass(): string {
  // パスワードは前後の空白も意味を持ち得るためトリムしない（空文字だけを未設定とみなす）
  return process.env.XSERVER_SHARED_PASS ?? '';
}
// 下書きフォルダ名（環境により 'Drafts' / 'INBOX.Drafts' / '下書き' 等）
export function xserverDraftsMailbox(): string {
  return envStr('XSERVER_DRAFTS_MAILBOX', 'Drafts');
}

// 収集の時間窓（日数。メールプロバイダ共通）。処理済みメールID（本番はスプレッドシート）で重複を除くため
// 広めに取る: 週末をまたぐ月曜の実行や、抽出に失敗したメールの次回以降の再試行（最大 SES_HEAL_MAX_ATTEMPTS 回）が
// 窓から外れて取りこぼされないように既定7日。旧名 XSERVER_COLLECT_DAYS も受け付ける
export function collectDays(): number {
  const name = env('SES_COLLECT_DAYS') ? 'SES_COLLECT_DAYS' : 'XSERVER_COLLECT_DAYS';
  return envNum(name, 7, { min: 1, max: 60 });
}

// 1回の実行で抽出する未処理メールの上限（新しい順。超過分は次回以降に回す）。
// 初回実行やバックログ時にLLMコストと実行時間が膨らまないようにする
export function maxMailsPerRun(): number {
  return envNum('SES_MAX_MAILS_PER_RUN', 150, { min: 1, int: true });
}

// 自社のメールドメイン（カンマ区切り・小文字化）。ここからのメールは収集しない（営業が共有メーリスをCcに入れた
// 自分たちの紹介メール等を、案件・要員として取り込み直さないため）
export function ownDomains(): string[] {
  return env('SES_OWN_DOMAINS')
    .split(',')
    .map((d) => d.trim().replace(/^@/, '').toLowerCase())
    .filter(Boolean);
}

// 自社ドメインからのメールも収集する（社内の営業が案件・要員を共有メーリスに流す運用の場合のみ true）
export function collectOwnDomain(): boolean {
  return envBool('SES_COLLECT_OWN_DOMAIN', false);
}

// サマリ通知の宛先
export function sesNotifyTo(): string {
  return env('SES_NOTIFY_TO');
}

// スプレッドシートの「担当者メール」で下書きの送信元に指定できるドメイン（カンマ区切り・小文字化）。
// 空なら制限しない。シートの編集者なら誰でも任意の送信元で下書きを作れてしまうため、本番では設定を推奨
export function allowedSenderDomains(): string[] {
  return env('SES_ALLOWED_SENDER_DOMAINS')
    .split(',')
    .map((d) => d.trim().replace(/^@/, '').toLowerCase())
    .filter(Boolean);
}

// ===== 自動検証・自己修復（heal）と修正パッチ案生成（repair）の設定 =====

// 自己修復（失敗時の再試行・モデル昇格・隔離）を有効にするか。既定ON（予算で拘束される）
export function healEnabled(): boolean {
  return envBool('SES_HEAL_ENABLED', true);
}

// 1バッチあたりの自動修復に使ってよいLLMコスト上限（円）。超えたら修復を打ち切り次回バッチへ繰越
export function healBudgetJpy(): number {
  return envNum('SES_HEAL_BUDGET_JPY', 50, { min: 0 });
}

// 同一メールの累計失敗回数がこの値に達したら隔離（無限再試行の打ち切り。バッチ横断で数える）
export function healMaxAttempts(): number {
  return envNum('SES_HEAL_MAX_ATTEMPTS', 3, { min: 1, int: true });
}

// 隔離リスト・診断ログの置き場
export function healDataDir(): string {
  return envStr('SES_HEAL_DATA_DIR', 'data/ses-heal');
}

// バッチ末尾での修正パッチ案の自動生成を有効にするか。既定OFF（ソースをAPIへ送るためopt-in。
// 手動の npm run ses:repair はこの設定に関わらず実行できる）
export function repairEnabled(): boolean {
  return envBool('SES_REPAIR_ENABLED', false);
}

// 修正パッチ案生成1回あたりのLLMコスト上限（円）
export function repairBudgetJpy(): number {
  return envNum('SES_REPAIR_BUDGET_JPY', 100, { min: 0 });
}

// 修正パッチ案生成に使うモデル（既定は最終判定と同じSonnet系。コーディング品質とコストの均衡）
export function repairModel(): string {
  return envStr('ANTHROPIC_MODEL_REPAIR', matchModel());
}

// 抽出用モデル（全メール最多コール。既定Haiku）
export function extractModel(): string {
  return envStr('ANTHROPIC_MODEL_EXTRACT', 'claude-haiku-4-5');
}

// 最終判定・メール生成用モデル（候補ペアのみ。既定Sonnet）
export function matchModel(): string {
  return envStr('ANTHROPIC_MODEL_MATCH', 'claude-sonnet-5');
}

// SESデータの保存先。notion（既定）| sheets（Googleスプレッドシート）。
// マッチング・UI・メール処理は共通で、保存・読出の「口」だけが切り替わる（MAIL_PROVIDERと同じ流儀）
export function dbProvider(): string {
  return envStr('DB_PROVIDER', 'notion').toLowerCase();
}

// DB_PROVIDER=sheets のときに使うスプレッドシートID（URLの /d/ と /edit の間の文字列）
export function sheetsDbSpreadsheetId(): string {
  return driveIdFrom(process.env.SHEETS_DB_SPREADSHEET_ID);
}

// SheetsDBを特定ユーザーになりすまして読み書きする場合のみ設定（要DWD）。
// 空ならサービスアカウント自身で認証する（スプレッドシートをSAのメールに共有するだけでよい）
export function sheetsDbImpersonate(): string {
  return env('SHEETS_DB_IMPERSONATE');
}

// 処理済みメールID・隔離リスト等のバッチ横断の状態をスプレッドシートに置くか。
// 毎回クリーンな環境で動くスケジュール実行（GitHub Actions等）ではローカル data/ が残らないため
export function durableStateInSheets(): boolean {
  return dbProvider() === 'sheets' && !isDemo();
}

// ===== プロパー（自社社員）スキルシート連携 =====
// スキルシートの置き場（Driveフォルダ）と、社員ごとの管理表「プロパー管理」のスプレッドシート。
// 既定はメインと同じGoogle Workspace・同じサービスアカウントで読み書きする（フォルダと管理表をSAのメールに共有）。
// 別テナントに置く場合だけ PROPER_GOOGLE_SA_* / PROPER_GOOGLE_IMPERSONATE で接続の資格情報を差し替える。
// フォルダと管理表の両方が設定されたときだけ有効（未設定なら案内を出してスキップ）

// IDの代わりにURLを貼られても動くよう、/folders/<id> や /d/<id> からIDを取り出す
function driveIdFrom(raw: string | undefined): string {
  const s = (raw ?? '').trim();
  const m = s.match(/\/(?:folders|d)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : s;
}

export function properFolderId(): string {
  return driveIdFrom(process.env.PROPER_SKILLSHEET_FOLDER_ID);
}

export function properMasterSpreadsheetId(): string {
  return driveIdFrom(process.env.PROPER_MASTER_SPREADSHEET_ID);
}

export function properEnabled(): boolean {
  return Boolean(properFolderId() && properMasterSpreadsheetId());
}

// プロパー専用サービスアカウント鍵の環境変数の接頭辞（PROPER_GOOGLE_SA_KEY_JSON 等。別テナント運用時のみ）。
// 未設定ならメインのサービスアカウント（GOOGLE_SA_*）で接続する
export function properServiceAccountEnvPrefix(): string {
  return 'PROPER_GOOGLE_SA_';
}

// フォルダ・管理表をサービスアカウントに共有できない（外部共有の禁止等）場合のみ設定する、
// なりすまし対象ユーザー（要: そのテナントでのDWD。drive.readonly と spreadsheets スコープ）
export function properImpersonate(): string {
  return env('PROPER_GOOGLE_IMPERSONATE');
}

// 1回の実行でLLM抽出するスキルシートの上限（初回の大量取り込みでもコストと実行時間を抑えるため。残りは次回以降）
export function properMaxExtractPerRun(): number {
  return envNum('PROPER_MAX_EXTRACT_PER_RUN', 20, { min: 0, int: true });
}

// プロパー候補の突合対象にする案件の受信日の遡り日数
export function properProjectLookbackDays(): number {
  return envNum('PROPER_PROJECT_LOOKBACK_DAYS', 14, { min: 1 });
}

// DWD（ドメイン全体委任）でなりすます既定ユーザー（経営者クローン側の既存コレクター用）。
// SESの処理はこのユーザーになりすまさない（Gmail運用は SES_TARGET_GMAIL、リンク先シートはSA自身で読む）
export function googleTargetEmail(): string {
  return env('GOOGLE_TARGET_EMAIL');
}

// ログ秘匿モード。公開リポジトリのActionsログは誰でも読めるため、CI上では既定で有効にし、
// 氏名・メールアドレス・件名・本文・API生エラー文をコンソールに出さない（明示的に false で解除可）
export function logRedact(): boolean {
  const v = env('SES_LOG_REDACT').toLowerCase();
  if (v === 'true' || v === 'false') return v === 'true';
  return env('CI') === 'true' || env('GITHUB_ACTIONS') === 'true';
}

export function notionProjectDbId(): string {
  return env('NOTION_PROJECT_DB_ID');
}

export function notionEngineerDbId(): string {
  return env('NOTION_ENGINEER_DB_ID');
}

export function notionMatchDbId(): string {
  return env('NOTION_MATCH_DB_ID');
}

// 自社社員DB（候補要員→案件探し機能）
export function notionOwnEngineerDbId(): string {
  return env('NOTION_OWN_ENGINEER_DB_ID');
}

// マッチ評価（フィードバック）ログDB。複数人の「妥当/ズレ」評価を共有の正として蓄積
export function notionFeedbackDbId(): string {
  return env('NOTION_FEEDBACK_DB_ID');
}

// スキル同義・類似辞書DB。人のフィードバックで育てる共有辞書
export function notionSkillEquivDbId(): string {
  return env('NOTION_SKILL_EQUIV_DB_ID');
}

// マッチ確認UIが読み書きするレビュー用ローカルJSONの置き場。
// バッチ/自社社員探しがここへ成果を書き出し、Web UIがこれを読んでステータス更新する。
// demoの成果は demo 用の置き場（demoDataDir 配下）に分け、本番のレビューデータにfixtureを混ぜない
export function reviewDataDir(): string {
  const explicit = env('SES_REVIEW_DATA_DIR');
  if (explicit) return explicit;
  return isDemo() ? `${demoDataDir()}/review` : 'data/ses-review';
}

// マッチ確認UIの待受ポート（既存の web(8787) と衝突しないよう既定8788）
export function sesWebPort(): number {
  return envNum('SES_WEB_PORT', 8788, { min: 1, max: 65535, int: true });
}

// マッチ確認UIの待受ホスト。複数人でLAN共有する場合は 0.0.0.0 等を設定（要 WEB_ACCESS_TOKEN）。
// 既定は安全側でローカルのみ。
export function sesWebHost(): string {
  return env('SES_WEB_HOST') || env('WEB_HOST') || '127.0.0.1';
}

// 確認UIのアクセストークン（共有）。空なら認証なし＝ローカル専用運用
export function webAccessToken(): string {
  return env('WEB_ACCESS_TOKEN');
}

// trueでBatch API（50%割引）を使用。Phase3で参照（現状は未使用の予約設定）
export function useBatchApi(): boolean {
  return envBool('USE_BATCH_API', false);
}

// demo成果物の書き出し先（本番 data/ と隔離）
export function demoDataDir(): string {
  return envStr('SES_DEMO_DATA_DIR', 'data/ses-demo');
}
