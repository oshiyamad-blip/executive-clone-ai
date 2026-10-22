// SES が使う Google の資格情報の選び方（鍵を用途ごとに分け、社外から届いたリンクを読む鍵にDWDを持たせない）。
// - メイン（SES_GOOGLE_SA_* → GOOGLE_SA_*、または SES_GOOGLE_AUTH=adc）: 案件スプレッドシート・リンク先のシート・プロパーの既定。
//   サービスアカウント自身として使い、なりすまし（subject）はしない
// - SHEETS_DB_SA_*: SHEETS_DB_IMPERSONATE（DWD）で案件スプレッドシートを読み書きするときだけ
// - SES_GMAIL_SA_*: MAIL_PROVIDER=gmail の DWD（収集・下書き・サマリ送信）だけ
// 専用の鍵がメインの鍵（または経営者クローンの鍵）と同じなら使わない（DWDがメインの鍵に付いてしまうため）。
// 鍵・アドレスはログに出さない。
import { google } from 'googleapis';
import {
  getServiceAccountAuth,
  loadServiceAccountCredentials,
  type GoogleJwt,
  type ServiceAccountCredentials,
} from '../collectors/googleAuth.js';
import {
  sesServiceAccountEnvPrefixes,
  executiveServiceAccountEnvPrefix,
  sheetsDbServiceAccountEnvPrefix,
  gmailServiceAccountEnvPrefix,
  properServiceAccountEnvPrefix,
  sesGoogleUsesAdc,
  sesGoogleAdcAccountEmail,
  sheetsDbImpersonate,
  sesTargetGmail,
  mailProvider,
  allowedSenders,
  sesNotifyTo,
  properImpersonate,
  sesDwdProbeSubject,
} from './config.js';

export type SesGoogleAuth = GoogleJwt | InstanceType<typeof google.auth.GoogleAuth>;

// 同じサービスアカウント（同じ client_email か、同じ秘密鍵）か
export function sameServiceAccount(a: ServiceAccountCredentials | null | undefined, b: ServiceAccountCredentials | null | undefined): boolean {
  if (!a || !b) return false;
  return a.clientEmail.trim().toLowerCase() === b.clientEmail.trim().toLowerCase() || a.privateKey.trim() === b.privateKey.trim();
}

// メインの鍵（見つかった接頭辞つき）。ADC のときは null
export function sesMainCredentials(): { creds: ServiceAccountCredentials; prefix: string } | null {
  if (sesGoogleUsesAdc()) return null;
  for (const prefix of sesServiceAccountEnvPrefixes()) {
    const creds = loadServiceAccountCredentials(prefix);
    if (creds) return { creds, prefix };
  }
  return null;
}

export function sesMainConfigured(): boolean {
  return sesGoogleUsesAdc() || sesMainCredentials() !== null;
}

// メインのサービスアカウントのメール（シートの保護・共有先の案内。分からなければ ''）
export function sesMainAccountEmail(): string {
  if (sesGoogleUsesAdc()) return sesGoogleAdcAccountEmail();
  return sesMainCredentials()?.creds.clientEmail ?? '';
}

// メインの資格情報での認証（なりすましなし）。未設定なら null
export function sesMainAuth(scopes: string[]): SesGoogleAuth | null {
  if (sesGoogleUsesAdc()) return new google.auth.GoogleAuth({ scopes });
  const main = sesMainCredentials();
  return main ? getServiceAccountAuth(scopes, undefined, main.creds) : null;
}

// 専用の鍵（なりすましに使う）。メインの鍵・経営者クローンの鍵と同じなら sharesMain=true（使わない）
export function dedicatedCredentials(prefix: string): { creds: ServiceAccountCredentials | null; sharesMain: boolean } {
  const creds = loadServiceAccountCredentials(prefix);
  if (!creds) return { creds: null, sharesMain: false };
  const others = [sesMainCredentials()?.creds, loadServiceAccountCredentials(executiveServiceAccountEnvPrefix())];
  return { creds, sharesMain: others.some((o) => sameServiceAccount(creds, o)) };
}

// なりすましに使える専用の鍵（無い・メインと同じなら null）
function usableDedicated(prefix: string): ServiceAccountCredentials | null {
  const d = dedicatedCredentials(prefix);
  return d.creds && !d.sharesMain ? d.creds : null;
}

const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

// ===== 案件スプレッドシート（DB） =====

// SHEETS_DB_IMPERSONATE の設定の問題（なりすましに専用の鍵が無い・メインと同じ）。問題なければ null
export function sheetsDbAuthProblem(): string | null {
  if (!sheetsDbImpersonate()) return null;
  const d = dedicatedCredentials(sheetsDbServiceAccountEnvPrefix());
  if (!d.creds) {
    return 'SHEETS_DB_IMPERSONATE（DWD）は専用のサービスアカウント鍵 SHEETS_DB_SA_KEY_JSON と組み合わせたときだけ使います（メインの鍵ではなりすましません）';
  }
  if (d.sharesMain) {
    return 'SHEETS_DB_SA_KEY_JSON がメインのサービスアカウント鍵と同じです。DWDはメインとは別のサービスアカウント（spreadsheets だけを委任）にしてください';
  }
  return null;
}

export function sheetsDbAuth(scopes: string[]): SesGoogleAuth | null {
  const subject = sheetsDbImpersonate();
  if (!subject) return sesMainAuth(scopes);
  const problem = sheetsDbAuthProblem();
  if (problem) {
    warnOnce('sheetsDb', `SheetsDB: ${problem}`);
    return null;
  }
  return getServiceAccountAuth(scopes, subject, usableDedicated(sheetsDbServiceAccountEnvPrefix()) ?? undefined);
}

// シートの保護の編集者にするアカウント（なりすまし先か、サービスアカウント自身）
export function sheetsDbEditorAccount(): string {
  return sheetsDbImpersonate() || sesMainAccountEmail();
}

// ===== Gmail（MAIL_PROVIDER=gmail） =====

export function gmailAuthProblem(): string | null {
  const d = dedicatedCredentials(gmailServiceAccountEnvPrefix());
  if (!d.creds) return 'Gmail運用のDWDには専用のサービスアカウント鍵 SES_GMAIL_SA_KEY_JSON が必要です（メインの鍵ではなりすましません）';
  if (d.sharesMain) {
    return 'SES_GMAIL_SA_KEY_JSON がメインのサービスアカウント鍵と同じです。Gmailの委任（テナントの全員のメールボックスに及ぶ）は別のサービスアカウントにしてください';
  }
  return null;
}

export function gmailCredentialsReady(): boolean {
  return gmailAuthProblem() === null;
}

// Gmail の DWD（subject のメールボックスとして）。使えなければ null
export function gmailDelegatedAuth(subject: string | undefined, scopes: string[]): GoogleJwt | null {
  if (!subject) return null;
  const creds = usableDedicated(gmailServiceAccountEnvPrefix());
  if (!creds) {
    const problem = gmailAuthProblem();
    if (problem) warnOnce('gmail', `Gmail: ${problem}`);
    return null;
  }
  return getServiceAccountAuth(scopes, subject, creds);
}

// ===== 不要なDWDの検出 =====

export const SCOPE = {
  gmailReadonly: 'https://www.googleapis.com/auth/gmail.readonly',
  driveReadonly: 'https://www.googleapis.com/auth/drive.readonly',
  spreadsheets: 'https://www.googleapis.com/auth/spreadsheets',
} as const;

// 委任の有無を確かめるスコープ。Google は要求したスコープごとに登録の一覧と文字どおり照合するため、
// 使うスコープより広いもの（メール全体・ドライブ全体・カレンダー・管理者 API 等）も個別に確かめる
export const DELEGATION_PROBE_SCOPES: readonly string[] = [
  'https://mail.google.com/',
  SCOPE.gmailReadonly,
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/drive',
  SCOPE.driveReadonly,
  SCOPE.spreadsheets,
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/meetings.space.readonly',
  'https://www.googleapis.com/auth/admin.directory.user.readonly',
  'https://www.googleapis.com/auth/cloud-platform',
];

// 各鍵が DWD で使ってよいスコープ（これ以外に委任があれば止める）。メインの鍵は DWD を使わない
export const DELEGATION_ALLOWED: Readonly<Record<'main' | 'sheetsDb' | 'gmail' | 'proper', readonly string[]>> = {
  main: [],
  sheetsDb: [SCOPE.spreadsheets],
  gmail: [SCOPE.gmailReadonly, 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.send'],
  proper: [SCOPE.driveReadonly, SCOPE.spreadsheets],
};

export function unneededProbeScopes(kind: keyof typeof DELEGATION_ALLOWED): string[] {
  const allowed = new Set(DELEGATION_ALLOWED[kind]);
  return DELEGATION_PROBE_SCOPES.filter((s) => !allowed.has(s));
}

export type DelegationProbe = 'granted' | 'denied' | 'unknown';

// トークン要求の結果の分類（純関数）。null = トークンが発行された（委任が登録されている）。
// unauthorized_client = そのクライアントIDにそのスコープの委任が無い。それ以外（ユーザーが無い・通信の失敗等）は分からない
export function classifyDelegationProbe(err: unknown): DelegationProbe {
  if (err === null) return 'granted';
  const e = err as { message?: unknown; response?: { data?: { error?: unknown } } };
  const code = typeof e.response?.data?.error === 'string' ? e.response.data.error : '';
  const message = typeof e.message === 'string' ? e.message : '';
  if (code === 'unauthorized_client' || /unauthorized_client/.test(message)) return 'denied';
  return 'unknown';
}

type TokenFetcher = (creds: ServiceAccountCredentials, subject: string, scope: string) => Promise<void>;

const PROBE_TIMEOUT_MS = 15_000;

const defaultFetcher: TokenFetcher = async (creds, subject, scope) => {
  const jwt = getServiceAccountAuth([scope], subject, creds);
  if (!jwt) throw new Error('no credentials');
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      jwt.authorize(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), PROBE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

let fetcher: TokenFetcher = defaultFetcher;

// オフライン自己検証（npm run ses:flow:check）用の差し替え口（本番コードからは呼ばない）
export function __setTokenFetcherForTest(f: TokenFetcher | null): void {
  fetcher = f ?? defaultFetcher;
}

export async function probeDelegation(creds: ServiceAccountCredentials, subject: string, scope: string): Promise<DelegationProbe> {
  try {
    await fetcher(creds, subject, scope);
    return classifyDelegationProbe(null);
  } catch (err) {
    return classifyDelegationProbe(err);
  }
}

// なりすましの確認に使う社内のユーザー（委任の有無はユーザーが実在しないと確かめられない）。
// SES_DWD_PROBE_SUBJECT（社内の実在するユーザー。グループ・配信リストは不可）を優先する
export function delegationProbeSubject(): string {
  const notify = sesNotifyTo()
    .split(',')
    .map((a) => a.trim().toLowerCase());
  const candidates = [sesDwdProbeSubject(), sheetsDbImpersonate(), mailProvider() === 'gmail' ? sesTargetGmail() : '', ...allowedSenders(), ...notify];
  return candidates.find((a) => /^[^@\s]+@[^@\s]+$/.test(a)) ?? '';
}

function scopeLabel(scope: string): string {
  return scope.replace('https://www.googleapis.com/auth/', '');
}

// 各鍵に、使わないスコープのDWDが登録されていないか（トークンが発行されたら問題）。
// メインの鍵は社外から届いたリンクを読み、専用の鍵もバッチの実行環境にあるため、漏れたときにテナントの全員のメール・ドライブを
// 読めるような委任が付いていたら止める。確かめられないとき（確認に使うユーザーが無い・グループ・通信の失敗）も止める（fail closed）。
// 問題の説明（アドレスは含めない）の一覧を返す
export async function unneededDelegationProblems(): Promise<string[]> {
  const problems: string[] = [];
  const checks: Array<{ label: string; creds: ServiceAccountCredentials; subject: string; scopes: string[] }> = [];
  const main = sesMainCredentials();
  const subject = delegationProbeSubject();
  if (main) {
    const mainLabel = `メインのサービスアカウント鍵（${main.prefix}*）`;
    if (main.prefix === executiveServiceAccountEnvPrefix()) {
      problems.push(
        `${mainLabel}: SES のメインの鍵に経営者クローンの鍵の名前 GOOGLE_SA_* を使っています（そちらの鍵はドメイン全体の委任を持つため）。` +
          '委任の無い別のサービスアカウントの鍵を SES_GOOGLE_SA_KEY_JSON に登録し、GOOGLE_SA_* は SES に渡さないでください',
      );
    }
    if (subject) checks.push({ label: mainLabel, creds: main.creds, subject, scopes: unneededProbeScopes('main') });
    else {
      problems.push(
        `${mainLabel}のドメイン全体の委任を確かめるユーザーがいません。SES_DWD_PROBE_SUBJECT に社内の実在するユーザーのアドレス（グループ・配信リストは不可）を登録してください`,
      );
    }
  }
  const sheetsKey = usableDedicated(sheetsDbServiceAccountEnvPrefix());
  if (sheetsKey && sheetsDbImpersonate()) {
    checks.push({ label: 'SHEETS_DB_SA_KEY_JSON', creds: sheetsKey, subject: sheetsDbImpersonate(), scopes: unneededProbeScopes('sheetsDb') });
  }
  const gmailKey = usableDedicated(gmailServiceAccountEnvPrefix());
  if (gmailKey && mailProvider() === 'gmail' && sesTargetGmail()) {
    checks.push({ label: 'SES_GMAIL_SA_KEY_JSON', creds: gmailKey, subject: sesTargetGmail(), scopes: unneededProbeScopes('gmail') });
  }
  const properKey = usableDedicated(properServiceAccountEnvPrefix());
  if (properKey && properImpersonate()) {
    checks.push({ label: 'PROPER_GOOGLE_SA_KEY_JSON', creds: properKey, subject: properImpersonate(), scopes: unneededProbeScopes('proper') });
  }
  const unknown = new Set<string>();
  await Promise.all(
    checks.flatMap((c) =>
      c.scopes.map(async (scope) => {
        let result = await probeDelegation(c.creds, c.subject, scope);
        // 一時的な失敗は1回だけ確かめ直す
        if (result === 'unknown') result = await probeDelegation(c.creds, c.subject, scope);
        if (result === 'granted') {
          problems.push(
            `${c.label} に、使わないスコープ ${scopeLabel(scope)} のドメイン全体の委任が登録されています` +
              '（テナントの全員に及ぶため、管理コンソールの「ドメイン全体の委任を管理」からこのクライアントIDの登録を外してください）',
          );
        } else if (result === 'unknown') unknown.add(c.label);
      }),
    ),
  );
  for (const label of unknown) {
    problems.push(
      `${label} のドメイン全体の委任を確かめられませんでした（確認に使ったユーザーが実在しない・グループ・通信の失敗）。` +
        'SES_DWD_PROBE_SUBJECT に社内の実在するユーザーのアドレスを登録し、時間をおいて再実行してください',
    );
  }
  return problems.sort();
}
