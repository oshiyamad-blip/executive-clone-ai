// SESマッチング機能: 全設定の一元読み出し。
// 全モジュールはこのファイル経由で設定を参照し、process.env を直接読まない。
// isDemo() が唯一の本番/demo分岐点（各段モジュールは冒頭でこれを見て分岐する）。
//
// 値の解釈: 空文字・空白だけの値は「未設定」として既定値を使う（GitHub Actions の未定義変数や
// .env.example の `X=` がそのまま入っても 0 や空のモデル名にならないため）。
// 数値は全角・桁区切りカンマを許し、解釈できない/範囲外なら既定値に戻して1回だけ警告する。

import { splitNotifyRecipients } from './settingsFormat.js';

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

// 数値の設定。min/max の範囲外や数値でない値は既定値に戻す（値そのものはログに出さない）。
// 価格の方針（粗利下限・交渉幅）は秘匿モードでは既定値・範囲も出さない（公開ログから使っている方針が分かるため）
function envNum(name: string, def: number, range: NumberRange = {}): number {
  const { value, valid } = parseNumberSetting(env(name), def, range);
  if (!valid) {
    if (LEGACY_PRICING_ENV.includes(name) && logRedact()) {
      warnEnvOnce(name, 'を解釈できません（価格の方針のため、値・既定値はログに出しません）');
      return value;
    }
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

// 設定の生の値（前後の空白を除く・未設定は ''）。事前確認（npm run ses:preflight）が渡し漏れと書式を
// 検査するためだけに使う（値そのものは表示しない）。通常の処理は用途別のゲッターを使うこと
export function settingValue(name: string): string {
  return env(name);
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

// Gemini を Vertex AI 経由で使うか（false なら Google AI Studio の API キー）
export function geminiUsesVertex(): boolean {
  return env('GOOGLE_GENAI_USE_VERTEXAI') === 'true';
}

// Google AI Studio（Gemini API キー）で本番のメール・スキルシートを送ってよいことの明示（課金を有効にしたプロジェクトで、
// データの利用条件を確認済み）。無料枠は送った内容が品質改善・人による確認に使われ得るため、'paid' のときだけ本番で使う
export function geminiApiAcknowledged(): boolean {
  return env('SES_ALLOW_GEMINI_API').toLowerCase() === 'paid';
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

// ===== 価格の方針（粗利下限・交渉幅） =====
// 社外に知られたくない方針。GitHub Actions では1つの Secret（SES_PRICING_POLICY_JSON）で渡す。
// 「10」「5」のような短い数値を個別の Secret にすると、Actions はその文字列をログ全体で伏せ字（***）にするため、
// 公開ログの伏せ字の位置（既知の文言の中の数字）から値が分かってしまう。JSON に推測できない乱数（n）を含めて1つにする。
// 手元の実行（.env.local）では従来の個別の設定（MIN_GROSS_MARGIN_* / NEGOTIATION_MAX_*）も使える（JSON が優先）
export const PRICING_POLICY_ENV = 'SES_PRICING_POLICY_JSON';
export const PRICING_POLICY_NONCE_MIN_CHARS = 16;
export const LEGACY_PRICING_ENV: readonly string[] = [
  'MIN_GROSS_MARGIN_JPY',
  'MIN_GROSS_MARGIN_MAN',
  'NEGOTIATION_MAX_PROJECT_RAISE_MAN',
  'NEGOTIATION_MAX_ENGINEER_CUT_MAN',
];

export interface PricingPolicy {
  minGrossMarginJpy?: number;
  raiseMaxMan?: number;
  cutMaxMan?: number;
}

export interface PricingPolicyParse {
  set: boolean;
  policy: PricingPolicy;
  problems: string[]; // 固定の文言（値を含まない）
  nonceOk: boolean;
}

const PRICING_KEYS = ['minGrossMarginMan', 'minGrossMarginJpy', 'projectRaiseMaxMan', 'engineerCutMaxMan', 'n'];

// SES_PRICING_POLICY_JSON の解釈（純関数）。例: {"minGrossMarginMan":12,"projectRaiseMaxMan":3,"engineerCutMaxMan":4,"n":"<乱数>"}
export function parsePricingPolicy(raw: string): PricingPolicyParse {
  const t = raw.trim();
  const out: PricingPolicyParse = { set: Boolean(t), policy: {}, problems: [], nonceOk: false };
  if (!t) return out;
  if (/[\r\n]/.test(t)) out.problems.push(`${PRICING_POLICY_ENV} は1行で登録してください（改行を含む Secret は行ごとに伏せ字になるため）`);
  let obj: unknown;
  try {
    obj = JSON.parse(t);
  } catch {
    out.problems.push(`${PRICING_POLICY_ENV} を JSON として読めません`);
    return out;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    out.problems.push(`${PRICING_POLICY_ENV} は {"minGrossMarginMan": …} の形の JSON にしてください`);
    return out;
  }
  const rec = obj as Record<string, unknown>;
  const unknownKeys = Object.keys(rec).filter((k) => !PRICING_KEYS.includes(k)).length;
  if (unknownKeys > 0) out.problems.push(`${PRICING_POLICY_ENV} に知らない項目が${unknownKeys}件あります（${PRICING_KEYS.join(' / ')}）`);
  const num = (key: string): number | undefined => {
    const v = rec[key];
    if (v === undefined || v === null || v === '') return undefined;
    const parsed = parseNumberSetting(typeof v === 'number' ? String(v) : typeof v === 'string' ? v : 'x', NaN, { min: 0 });
    if (!parsed.valid || !Number.isFinite(parsed.value)) {
      out.problems.push(`${PRICING_POLICY_ENV} の ${key} を0以上の数値として解釈できません`);
      return undefined;
    }
    return parsed.value;
  };
  const man = num('minGrossMarginMan');
  const jpy = num('minGrossMarginJpy');
  if (man !== undefined) out.policy.minGrossMarginJpy = Math.round(man * 10000);
  else if (jpy !== undefined) {
    if (jpy > 0 && jpy < 1000) out.problems.push(`${PRICING_POLICY_ENV} の minGrossMarginJpy は円単位です（万円なら minGrossMarginMan）`);
    else out.policy.minGrossMarginJpy = jpy;
  }
  const raise = num('projectRaiseMaxMan');
  if (raise !== undefined) out.policy.raiseMaxMan = raise;
  const cut = num('engineerCutMaxMan');
  if (cut !== undefined) out.policy.cutMaxMan = cut;
  out.nonceOk = typeof rec.n === 'string' && rec.n.trim().length >= PRICING_POLICY_NONCE_MIN_CHARS;
  return out;
}

let pricingCache: { raw: string; parsed: PricingPolicyParse } | null = null;

// 現在の価格の方針（SES_PRICING_POLICY_JSON）の解釈結果。読めない場合は1回だけ固定の文言で警告し、個別の設定・既定値を使う
export function pricingPolicyStatus(): PricingPolicyParse {
  const raw = env(PRICING_POLICY_ENV);
  if (pricingCache?.raw !== raw) {
    pricingCache = { raw, parsed: parsePricingPolicy(raw) };
    if (pricingCache.parsed.problems.length > 0) {
      warnEnvOnce(PRICING_POLICY_ENV, `を解釈できない項目があります（${pricingCache.parsed.problems.length}件。値はログに出しません）`);
    }
  }
  return pricingCache.parsed;
}

// 個別の設定（MIN_GROSS_MARGIN_* / NEGOTIATION_MAX_*）のうち値のあるもの（名前だけ。値は返さない）
export function legacyPricingSettingsPresent(): string[] {
  return LEGACY_PRICING_ENV.filter((n) => Boolean(env(n)));
}

// 粗利下限（円/月）。SES_PRICING_POLICY_JSON → MIN_GROSS_MARGIN_MAN（万円）→ MIN_GROSS_MARGIN_JPY（円）→ 既定値の順
export function minGrossMarginJpy(): number {
  const fromPolicy = pricingPolicyStatus().policy.minGrossMarginJpy;
  if (fromPolicy !== undefined) return fromPolicy;
  if (env('MIN_GROSS_MARGIN_MAN')) return Math.round(envNum('MIN_GROSS_MARGIN_MAN', 10, { min: 0 }) * 10000);
  const jpy = envNum('MIN_GROSS_MARGIN_JPY', 100000, { min: 0 });
  if (jpy > 0 && jpy < 1000) {
    warnEnvOnce(
      'MIN_GROSS_MARGIN_JPY',
      logRedact() ? 'の値を確認してください（価格の方針のため、値はログに出しません）' : 'は円単位です（万円で指定する場合は MIN_GROSS_MARGIN_MAN を使ってください）',
    );
  }
  return jpy;
}

// 価格の方針の設定に解釈できない値があるか（本番では既定値・誤った単位のまま動かさず止める）
export function pricingSettingsInvalid(): boolean {
  if (pricingPolicyStatus().problems.length > 0) return true;
  const bad = (name: string) => Boolean(env(name)) && !parseNumberSetting(env(name), 0, { min: 0 }).valid;
  if (LEGACY_PRICING_ENV.some(bad)) return true;
  const jpy = parseNumberSetting(env('MIN_GROSS_MARGIN_JPY'), 0, { min: 0 }).value;
  return !env('MIN_GROSS_MARGIN_MAN') && jpy > 0 && jpy < 1000;
}

// 粗利下限が明示されているか（本番では既定値＝公開されている値のまま動かさない）
export function minGrossMarginConfigured(): boolean {
  return pricingPolicyStatus().policy.minGrossMarginJpy !== undefined || Boolean(env('MIN_GROSS_MARGIN_MAN') || env('MIN_GROSS_MARGIN_JPY'));
}

// 交渉幅が明示されているか（案件単金を上げる・要員単金を下げる上限の両方）
export function negotiationLimitsConfigured(): boolean {
  const p = pricingPolicyStatus().policy;
  return (p.raiseMaxMan !== undefined || Boolean(env('NEGOTIATION_MAX_PROJECT_RAISE_MAN'))) &&
    (p.cutMaxMan !== undefined || Boolean(env('NEGOTIATION_MAX_ENGINEER_CUT_MAN')));
}

// 1アイテムあたりLLM最終判定に回す候補ペア上限（LLMコスト上限の保証）
export function maxCandidatesPerItem(): number {
  return envNum('MAX_CANDIDATES_PER_ITEM', 5, { min: 1, int: true });
}

// 1回の突合で1名の要員を候補に入れる案件数の上限（単金の安い1名が多数の案件の上位を独占しないように。
// 枠からあふれた案件には次点の要員を繰り上げる）
export function maxProjectsPerEngineer(): number {
  return envNum('MAX_PROJECTS_PER_ENGINEER', 3, { min: 1, int: true });
}

// 受信からこの日数を超えた案件・要員は、募集・稼働の状況が変わっている恐れが高いため強マッチにせず「要再確認」を付ける
export function staleDays(): number {
  return envNum('SES_STALE_DAYS', 45, { min: 1 });
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

// AI最終判定のスコアがこれ未満の成立候補・交渉提案は「参考提案」に下げる（自動の紹介下書きを作らない）。0で無効
export function matchMinLlmScore(): number {
  return envNum('MATCH_MIN_LLM_SCORE', 60, { min: 0, max: 100 });
}

// AI最終判定のスコアがこれ未満の組は「不適合」とし、サマリには件数だけを載せる（マッチタブには判定「不適合」で残す）。
// 即NG条件（商流・年齢等）に反すると判定された組は、スコアに関わらず不適合。0でスコアによる不適合を無効
export function matchRejectLlmScore(): number {
  return envNum('MATCH_REJECT_LLM_SCORE', 40, { min: 0, max: 100 });
}

// 1回の実行でAI最終判定と紹介文面の生成に使ってよいLLMコストの目安（円）。超えたら残りの組はAI判定をせず
// ルールの結果のまま「未判定」で保存し、次回の実行で判定する（その組の案件・要員は突合済にしない）。0で上限なし
export function judgeBudgetJpy(): number {
  return envNum('SES_JUDGE_BUDGET_JPY', 300, { min: 0 });
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
  return pricingPolicyStatus().policy.raiseMaxMan ?? envNum('NEGOTIATION_MAX_PROJECT_RAISE_MAN', 5, { min: 0 });
}

// 交渉で「要員単金を下げてもらう」上限（万円/月）
export function maxNegotiationCutMan(): number {
  return pricingPolicyStatus().policy.cutMaxMan ?? envNum('NEGOTIATION_MAX_ENGINEER_CUT_MAN', 5, { min: 0 });
}

// 通常バッチの突合で、今回の新着と組み合わせる「前回以前に保存した募集中案件・提案可要員」の遡り日数
// （収集の実行回をまたいで届いた案件と要員を見逃さないため。判定済みのペアはマッチIDで除外する）
// 再送スキップ: 同じ送信元ドメインから何日前までに届いたメールと比べるか（0で無効）
export function resendWindowDays(): number {
  return envNum('SES_RESEND_WINDOW_DAYS', 14, { min: 0, max: 60 });
}

// 再送スキップ: 本文の近さ（推定Jaccard 0〜1）がこれ以上なら同じ内容の再送として抽出しない（1で完全一致のみ）。本文の数字・添付・項目の見出し数が同じことも条件
export function resendSimilarity(): number {
  return envNum('SES_RESEND_SIMILARITY', 0.9, { min: 0.8, max: 1 });
}

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
// 窓から外れて取りこぼされないように既定7日（窓の中のメールは本文を取得する前に処理済みかを確かめるため、
// 広げても取得量は増えない）。旧名 XSERVER_COLLECT_DAYS も受け付ける
export const COLLECT_DAYS_MAX = 60;

export function collectDays(): number {
  const name = env('SES_COLLECT_DAYS') ? 'SES_COLLECT_DAYS' : 'XSERVER_COLLECT_DAYS';
  return envNum(name, 7, { min: 1, max: COLLECT_DAYS_MAX });
}

// メール量の測定（npm run ses:mail-stats）で遡る日数
export function statsDays(): number {
  return envNum('SES_STATS_DAYS', 30, { min: 1, max: 365, int: true });
}

// 1回の実行で抽出する未処理メールの上限（次回の実行までに収集期間を外れるものを優先し、残りは新しい順。
// 超過分は次回以降に回す）。初回実行やバックログ時にLLMコストと実行時間が膨らまないようにする
export function maxMailsPerRun(): number {
  return envNum('SES_MAX_MAILS_PER_RUN', 150, { min: 1, int: true });
}

// 指示の検知に足す言い回し（正規表現。改行区切り。GitHub の Secret に置く）。公開リポジトリの一覧だけでは、
// 送り主が自分の文面が検知されるかを手元で確かめきれないようにする。解釈できない行は無視する
let extraPatternCache: { raw: string; patterns: RegExp[] } | null = null;

export function injectionExtraPatterns(): RegExp[] {
  const raw = env('SES_INJECTION_EXTRA_PATTERNS');
  if (extraPatternCache && extraPatternCache.raw === raw) return extraPatternCache.patterns;
  const patterns: RegExp[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const src = line.trim();
    if (!src || src.length > 500) continue;
    try {
      patterns.push(new RegExp(src, 'i'));
    } catch {
      /* 解釈できない行は使わない */
    }
  }
  extraPatternCache = { raw, patterns };
  return patterns;
}

// 1回の実行で本文・添付を取得するメールの合計の大きさ（MB。RFC822の原文）。1通ごとの上限（45MB）の内でも、
// 上限近くのメールを大量に送られると本文・添付をすべてメモリに抱えて収集中に落ちるため、合計にも上限を設ける
// （超えた分は次回以降に回す）
export function maxMailMbPerRun(): number {
  return envNum('SES_MAX_MAIL_MB_PER_RUN', 400, { min: 50, max: 4000, int: true });
}

// 1回の実行で新しい処理（メールの抽出・候補の判定）を始めてよい時間（分。バッチ開始から）。
// 過ぎたら新しい処理を始めず、済んだ分を保存してサマリを送る（残りは次回の実行で続きから処理する）。
// GitHub Actions のジョブの制限時間（timeout-minutes）より十分短くする
export function runDeadlineMinutes(): number {
  return envNum('SES_RUN_DEADLINE_MINUTES', 20, { min: 1, max: 600 });
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

// サマリ通知の宛先（設定の生の値。送るときは notify の宛先の絞り込みを通す）
export function sesNotifyTo(): string {
  return env('SES_NOTIFY_TO');
}

// サマリ・診断レポート（社員の氏名・必要案件単価、要員の情報を含む）を社外のドメインにも送るか。
// 既定は送らない（個人のGmail・打ち間違えたドメイン等に毎回の結果が届き続けないように）
export function notifyAllowExternal(): boolean {
  return envBool('SES_NOTIFY_ALLOW_EXTERNAL', false);
}

// サマリ・診断レポートを実際に送る宛先（社外のドメインは SES_NOTIFY_ALLOW_EXTERNAL=true のときだけ）と、送らない社外の宛先の数
export function notifyRecipients(): { to: string; externalSkipped: number } {
  const { recipients, external } = splitNotifyRecipients(sesNotifyTo(), internalMailDomains(), notifyAllowExternal());
  return { to: recipients.join(', '), externalSkipped: notifyAllowExternal() ? 0 : external };
}

// 社内とみなすメールのドメイン（自社ドメインと、使っているメール運用の共有メールボックスのドメイン）
export function internalMailDomains(): string[] {
  const mailbox = mailProvider() === 'gmail' ? sesTargetGmail() : xserverSharedUser();
  const at = mailbox.lastIndexOf('@');
  return [...new Set([...ownDomains(), at >= 0 ? mailbox.slice(at + 1).toLowerCase() : ''].filter(Boolean))];
}

// 個人データの保存期間（日）。受信からこれを超えた案件・要員・マッチ等の行は、氏名・年齢・居住地・単金・連絡先・文面を消す。
// 突合・再確認に使う期間（SES_MATCH_LOOKBACK_DAYS・SES_STALE_DAYS 等）より短くはしない
export function retentionDays(): number {
  const configured = envNum('SES_RETENTION_DAYS', 180, { min: 30, max: 3650, int: true });
  return Math.max(configured, matchLookbackDays() + 7, staleDays() + 7, properProjectLookbackDays() + 7, COLLECT_DAYS_MAX + 7);
}

// スプレッドシートの「担当者メール」で下書きの送信元に指定できるドメイン（カンマ区切り・小文字化）。
// 未設定なら SES_OWN_DOMAINS と共有メールボックスのドメインだけを許可する（どれも無ければ作成しない）
export function allowedSenderDomains(): string[] {
  return env('SES_ALLOWED_SENDER_DOMAINS')
    .split(',')
    .map((d) => d.trim().replace(/^@/, '').toLowerCase())
    .filter(Boolean);
}

// 下書きの送信元に指定できるアドレスの一覧（カンマ区切り・小文字化）。MAIL_PROVIDER=gmail では必須
// （DWDでそのユーザーのGmailに下書きを作るため、ドメインが合うだけの社内の誰にでもなりすませてしまわないように）
export function allowedSenders(): string[] {
  return env('SES_ALLOWED_SENDERS')
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
}

// スプレッドシートの「下書きデータ」列と、案件・要員タブの「返信メタ」・営業元メール（下書きの宛先の元）に付ける署名の鍵
// （HMAC-SHA256。行のタブ・IDも含めて署名する）。設定すると、人が書き換えた・別の行から写した値からは下書きを作らない。空なら署名しない
export function draftSigningKey(): string {
  return env('SES_DRAFT_SIGNING_KEY');
}

// 署名鍵の最短の長さ。これより短い（未設定を含む）ときは、担当者メールの下書き依頼を受けない
// （署名が無いと、シートの編集者が宛先・本文を書き換えた行からも下書きを作ってしまうため）
export const DRAFT_SIGNING_KEY_MIN_CHARS = 32;

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

// 設定された抽出用モデル（全メール最多コール。既定Haiku）
export function configuredExtractModel(): string {
  return envStr('ANTHROPIC_MODEL_EXTRACT', 'claude-haiku-4-5');
}

// 設定された抽出用モデルが退役・提供終了で使えないと分かった後は、このプロセスの残りを判定用モデルで代替する
// （extractModelFallback.ts が切り替える。費用は増えるが抽出を止めない）
let extractFallbackActive = false;

export function activateExtractModelFallback(): void {
  extractFallbackActive = true;
}

export function extractModelFallbackActive(): boolean {
  return extractFallbackActive;
}

export function resetExtractModelFallback(): void {
  extractFallbackActive = false;
}

// 抽出に使うモデル（代替中なら判定用モデル）
export function extractModel(): string {
  return extractFallbackActive ? matchModel() : configuredExtractModel();
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

// DB_PROVIDER=sheets 以外（スプレッドシートの実行中の印を使えない）で本番のバッチを動かすことの明示。
// 定時実行（Actions）と共有の受信箱を使う構成で手元の実行が重なると、同じメールの抽出・同じ下書きを二重に行うため既定は false
export function sesAllowUnleased(): boolean {
  return envBool('SES_ALLOW_UNLEASED', false);
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

// ===== Google の資格情報（SES） =====
// SES のメインのサービスアカウント鍵（スプレッドシート・リンク先のシートの読み取り・プロパーの既定）の環境変数の接頭辞（優先順）。
// SES 専用の SES_GOOGLE_SA_* を優先し、無ければ GOOGLE_SA_*（経営者クローンの収集と同じ名前。そちらの鍵はDWDを持つため共用しない）
export function sesServiceAccountEnvPrefixes(): readonly string[] {
  return ['SES_GOOGLE_SA_', 'GOOGLE_SA_'];
}

// 経営者クローンの収集が使う鍵の接頭辞（DWDでGmail・ドライブ等を読む。SESの専用の鍵と同じものでないかの比較に使う）
export function executiveServiceAccountEnvPrefix(): string {
  return 'GOOGLE_SA_';
}

// SHEETS_DB_IMPERSONATE（DWD）で案件スプレッドシートを読み書きするときだけ使う専用の鍵の接頭辞。
// メインの鍵（社外から届いたリンクを読む）にはDWDを持たせない
export function sheetsDbServiceAccountEnvPrefix(): string {
  return 'SHEETS_DB_SA_';
}

// MAIL_PROVIDER=gmail の DWD（gmail.readonly / compose / send）に使う専用の鍵の接頭辞。
// Gmail の委任はテナントの全員のメールボックスに及ぶため、スプレッドシート・リンクの読み取りに使うメインの鍵とは分ける
export function gmailServiceAccountEnvPrefix(): string {
  return 'SES_GMAIL_SA_';
}

// メインの資格情報を鍵ファイルではなく ADC（Application Default Credentials。GitHub Actions では Workload Identity 連携）で得るか。
// SES_GOOGLE_AUTH=adc のときだけ（手元の ADC が個人のアカウントのことがあるため、自動では切り替えない）
export function sesGoogleUsesAdc(): boolean {
  return env('SES_GOOGLE_AUTH').toLowerCase() === 'adc';
}

// ADC のときのサービスアカウントのメール（シートの保護の編集者・共有先の案内に使う。鍵が無いため設定で渡す）
export function sesGoogleAdcAccountEmail(): string {
  return env('SES_GOOGLE_SA_EMAIL');
}

// 社内のファイルとみなす所有者のドメイン（メールのリンク先のシートを読まない判定）。
// 自社ドメイン・SES_INTERNAL_FILE_DOMAINS（別テナントのグループ会社等）・プロパーのなりすまし先のドメイン
export function internalFileDomains(): string[] {
  const extra = env('SES_INTERNAL_FILE_DOMAINS')
    .split(',')
    .map((d) => d.trim().replace(/^@/, '').toLowerCase())
    .filter(Boolean);
  const proper = properImpersonate();
  const properDomain = proper.includes('@') ? proper.slice(proper.lastIndexOf('@') + 1).toLowerCase() : '';
  return [...new Set([...ownDomains(), ...extra, properDomain].filter(Boolean))];
}

// GitHub Actions の実行のブランチ（refs/heads/main 等）。Environment の Deployment branches が効かない構成の検出に使う
export function githubRef(): string {
  return env('GITHUB_REF');
}

// Environment「production」にだけ登録する目印の Secret（リポジトリの Secrets への退避・Environment が効かない構成の検出）
export function environmentSentinel(): string {
  return env('SES_ENVIRONMENT_SENTINEL');
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
// 未設定ならメインのサービスアカウント（SES_GOOGLE_SA_* / GOOGLE_SA_*）で接続する
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

// スキルシートのフォルダ内の「ファイルへのショートカット」の参照先も読むか（既定 false）。有効にすると、フォルダに
// ファイルを追加できる人は、プロパーの認証で読める任意のファイルを読み取らせられる（フォルダへのショートカットは常にたどらない）
export function properFollowShortcuts(): boolean {
  return envBool('PROPER_FOLLOW_SHORTCUTS', false);
}

// 管理表「プロパー管理」がメインのテナントにあり、メインのサービスアカウントで書くか（既定 false）。
// 別テナントのフォルダをなりすましで読む場合に、そのテナントへ spreadsheets（全スプレッドシートの読み書き）の委任を与えずに済む
export function properMasterInMainTenant(): boolean {
  return envBool('PROPER_MASTER_IN_MAIN_TENANT', false);
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

// マッチ確認UIの待受ホスト。複数人でLAN共有する場合は 0.0.0.0 等を設定（要 SES_WEB_ACCESS_TOKEN）。
// 既定は安全側でローカルのみ。
export function sesWebHost(): string {
  return env('SES_WEB_HOST') || env('WEB_HOST') || '127.0.0.1';
}

// 確認UIのアクセストークン（確認UI専用。chat UI の WEB_ACCESS_TOKEN とは別の値にする）。空なら認証なし＝ローカル専用運用
export function sesWebAccessToken(): string {
  return env('SES_WEB_ACCESS_TOKEN');
}

// chat UI（npm run web）のアクセストークン。確認UIでは使わず、同じ値の使い回しを検出するためだけに読む
export function chatWebAccessToken(): string {
  return env('WEB_ACCESS_TOKEN');
}

// 確認UIを HTTPS で待ち受けるときの証明書・秘密鍵（PEMファイルのパス）。両方あるときだけ HTTPS。
// ループバック以外（LAN共有）で待ち受けるには HTTPS か、次の SES_WEB_BEHIND_TLS=true が必要
export function sesWebTlsCertPath(): string {
  return env('SES_WEB_TLS_CERT');
}

export function sesWebTlsKeyPath(): string {
  return env('SES_WEB_TLS_KEY');
}

// HTTPS のリバースプロキシ・VPN の内側でだけ公開していることの明示（true なら平文HTTPのままループバック以外で待ち受ける）
export function sesWebBehindTls(): boolean {
  return envBool('SES_WEB_BEHIND_TLS', false);
}

// trueでBatch API（50%割引）を使用。Phase3で参照（現状は未使用の予約設定）
export function useBatchApi(): boolean {
  return envBool('USE_BATCH_API', false);
}

// demo成果物の書き出し先（本番 data/ と隔離）
export function demoDataDir(): string {
  return envStr('SES_DEMO_DATA_DIR', 'data/ses-demo');
}
