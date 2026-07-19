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
//
// スコープは呼び出し側で選ぶ2段構え:
// - BASE_SCOPES: 既存コレクター用（readonly のみ）。SES用スコープを混ぜると、
//   DWD側に旧スコープしか登録していない既存環境で全コレクターの認証が壊れるため分離している。
// - SES_SCOPES: SESマッチング用（BASE + 下書き作成/サマリ送信/スプレッドシート読取）。
//   使う場合は DWD 側にも追加スコープの登録が必要。
const BASE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/meetings.space.readonly',
];

export const SES_SCOPES = [
  ...BASE_SCOPES,
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
];

// 認証クライアントを返す。設定不足なら null（呼び出し側で縮退動作）。
// 型は googleapis 同梱の JWT に合わせるため google.auth.JWT を使う。
export function getGoogleAuth(scopes: string[] = BASE_SCOPES): InstanceType<typeof google.auth.JWT> | null {
  return getGoogleAuthAs(process.env.GOOGLE_TARGET_EMAIL, scopes);
}

// 指定ユーザーを impersonate した認証クライアントを返す（SES: 担当営業本人のGmailに
// 全員に返信の下書きを作るため、その営業の会社アドレスで委任する）。subject 未指定/設定不足は null。
export function getGoogleAuthAs(
  subject: string | undefined,
  scopes: string[] = BASE_SCOPES,
): InstanceType<typeof google.auth.JWT> | null {
  const clientEmail = process.env.GOOGLE_SA_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_SA_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!clientEmail || !privateKey || !subject) {
    return null;
  }

  return new google.auth.JWT({ email: clientEmail, key: privateKey, scopes, subject });
}

// 収集の時間窓（デフォルト: 過去24時間）
export function collectionWindow(): { since: Date; until: Date } {
  const until = new Date();
  const since = new Date(until.getTime() - 24 * 60 * 60 * 1000);
  return { since, until };
}
