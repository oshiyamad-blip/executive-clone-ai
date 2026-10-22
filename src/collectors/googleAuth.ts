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
// スコープは呼び出し側で選ぶ:
// - BASE_SCOPES: 既存コレクター用（readonly のみ）。
// - SES_GMAIL_*_SCOPES: SESマッチングのGmail運用（MAIL_PROVIDER=gmail）用。呼び出しごとに必要な1スコープだけを
//   要求する（収集=gmail.readonly / 下書き作成=gmail.compose / サマリ送信=gmail.send）。DWDに登録するのもこの3つだけでよい。
//   登録していないスコープを1つでも要求するとトークン取得自体が失敗するため、余分なスコープを混ぜない
//   SES では Gmail の委任は専用の鍵（SES_GMAIL_SA_KEY_JSON）で行い、この収集用の鍵（GOOGLE_SA_*）とは共用しない（src/ses/googleCreds.ts）
const BASE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/meetings.space.readonly',
];

export const SES_GMAIL_COLLECT_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
export const SES_GMAIL_DRAFT_SCOPES = ['https://www.googleapis.com/auth/gmail.compose'];
export const SES_GMAIL_SEND_SCOPES = ['https://www.googleapis.com/auth/gmail.send'];

export type GoogleJwt = InstanceType<typeof google.auth.JWT>;

export interface ServiceAccountCredentials {
  clientEmail: string;
  privateKey: string;
}

// JSON鍵（GCPでダウンロードした .json の中身そのもの）を解釈する。不正なら null。
// 鍵の中身はログに出さない（公開ログへの漏洩防止）
export function parseServiceAccountJson(json: string): ServiceAccountCredentials | null {
  try {
    const o = JSON.parse(json) as { client_email?: unknown; private_key?: unknown };
    if (typeof o.client_email !== 'string' || typeof o.private_key !== 'string') return null;
    if (!o.client_email || !o.private_key) return null;
    return { clientEmail: o.client_email, privateKey: o.private_key.replace(/\\n/g, '\n') };
  } catch {
    return null;
  }
}

const warnedBadKeyJson = new Set<string>();

// サービスアカウントの資格情報。<prefix>KEY_JSON（JSON鍵を丸ごと1変数に。GitHub Secrets向け）を優先し、
// 無ければ <prefix>CLIENT_EMAIL / <prefix>PRIVATE_KEY を使う。どちらも無ければ null。
// prefix の既定は GOOGLE_SA_。別テナント用の鍵（例: PROPER_GOOGLE_SA_）も同じ規則で読む
export function loadServiceAccountCredentials(prefix = 'GOOGLE_SA_'): ServiceAccountCredentials | null {
  const json = process.env[`${prefix}KEY_JSON`]?.trim();
  if (json) {
    const parsed = parseServiceAccountJson(json);
    if (parsed) return parsed;
    if (!warnedBadKeyJson.has(prefix)) {
      warnedBadKeyJson.add(prefix);
      console.warn(`Google認証: ${prefix}KEY_JSON を解釈できません（client_email / private_key を含むJSON鍵全体を設定してください）`);
    }
  }
  const clientEmail = process.env[`${prefix}CLIENT_EMAIL`]?.trim();
  const privateKey = process.env[`${prefix}PRIVATE_KEY`]?.trim().replace(/\\n/g, '\n');
  if (clientEmail && privateKey) return { clientEmail, privateKey };
  return null;
}

// サービスアカウント認証。subject 指定時のみDWDでそのユーザーになりすます（要: 管理コンソールでの委任登録）。
// subject 無しはSA自身として認証する（対象のファイルをSAのメールアドレスに共有しておけば読み書きできる。DWD不要）
export function getServiceAccountAuth(
  scopes: string[],
  subject?: string,
  creds?: ServiceAccountCredentials,
): GoogleJwt | null {
  const c = creds ?? loadServiceAccountCredentials();
  if (!c) return null;
  return new google.auth.JWT({ email: c.clientEmail, key: c.privateKey, scopes, subject: subject || undefined });
}

// 認証クライアントを返す。設定不足なら null（呼び出し側で縮退動作）。
// 型は googleapis 同梱の JWT に合わせるため google.auth.JWT を使う。
export function getGoogleAuth(scopes: string[] = BASE_SCOPES): GoogleJwt | null {
  return getGoogleAuthAs(process.env.GOOGLE_TARGET_EMAIL?.trim(), scopes);
}

// 指定ユーザーを impersonate した認証クライアントを返す（SES: 担当営業本人のGmailに
// 全員に返信の下書きを作るため、その営業の会社アドレスで委任する）。subject 未指定/設定不足は null。
export function getGoogleAuthAs(subject: string | undefined, scopes: string[] = BASE_SCOPES): GoogleJwt | null {
  if (!subject) return null;
  return getServiceAccountAuth(scopes, subject);
}

// 収集の時間窓（デフォルト: 過去24時間）
export function collectionWindow(): { since: Date; until: Date } {
  const until = new Date();
  const since = new Date(until.getTime() - 24 * 60 * 60 * 1000);
  return { since, until };
}
