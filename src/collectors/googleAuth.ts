import { google } from 'googleapis';

// Google Workspace 認証（サービスアカウント + ドメイン全体委任）
//
// 対象経営者を impersonate（subject 指定）して各 API を最小権限の readonly で呼ぶ。
// セットアップ:
//   1. GCP でサービスアカウント作成 → JSON 鍵発行
//   2. Workspace 管理コンソール『APIの制御 > ドメイン全体の委任』で
//      サービスアカウントのクライアントIDと以下スコープをカンマ区切りで登録
//   3. .env.local に SA の client_email / private_key と対象ユーザーのメールを設定
//
// ⚠️ 個人 @gmail.com では不可（Workspace の Super Admin 承認が前提）。
// ⚠️ 登録していないスコープを要求すると 403。
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/meetings.space.readonly',
];

// 認証クライアントを返す。設定不足なら null（呼び出し側で縮退動作）。
// 型は googleapis 同梱の JWT に合わせるため google.auth.JWT を使う。
//
// extraScopes: 追加スコープが必要なフロー（請求書発行の gmail.compose 等）だけが指定する。
// 既定 SCOPES に足すと DWD 未登録の間は全収集が 403 になるため、呼び出し側で分離する。
// subjectOverride: 共有メールボックス（billing@ 等）を impersonate したいフローが指定する。
// 省略時は GOOGLE_TARGET_EMAIL（経営者本人）。
export function getGoogleAuth(
  extraScopes: string[] = [],
  subjectOverride?: string,
): InstanceType<typeof google.auth.JWT> | null {
  const clientEmail = process.env.GOOGLE_SA_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_SA_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const subject = subjectOverride || process.env.GOOGLE_TARGET_EMAIL;

  if (!clientEmail || !privateKey || !subject) {
    return null;
  }

  return new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: [...SCOPES, ...extraScopes],
    subject,
  });
}

// billing系（検収受信・請求書下書き・通知送信）用の認証。
// BILLING_TARGET_EMAIL（共有メールボックス）の解決をここに集約する。
// 未設定なら GOOGLE_TARGET_EMAIL（経営者本人）— ただし「設定したが空」の場合は
// 気づかず本人アカウントで動く事故になるため警告を出す。
export function getBillingGoogleAuth(
  extraScopes: string[] = [],
): InstanceType<typeof google.auth.JWT> | null {
  const billingEmail = process.env.BILLING_TARGET_EMAIL;
  if (billingEmail !== undefined && billingEmail.trim() === '') {
    console.warn(
      'BILLING_TARGET_EMAIL が空です — GOOGLE_TARGET_EMAIL（経営者本人）のメールボックスを使用します。共有メールボックス運用の場合は値を設定してください。',
    );
  }
  return getGoogleAuth(extraScopes, billingEmail?.trim() || undefined);
}

// 収集の時間窓（デフォルト: 過去24時間）
export function collectionWindow(): { since: Date; until: Date } {
  const until = new Date();
  const since = new Date(until.getTime() - 24 * 60 * 60 * 1000);
  return { since, until };
}
