import type { RawLog } from '../types/index.js';

// Gmail API で送受信メールを収集する
// 認証: OAuth2（gmail.readonly スコープ）
export async function collectFromEmail(): Promise<RawLog[]> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !refreshToken) {
    console.warn('メール: Google OAuth2 の設定が未完了');
    return [];
  }

  // TODO: googleapis で実装
  // const auth = new google.auth.OAuth2(clientId, clientSecret);
  // auth.setCredentials({ refresh_token: refreshToken });
  // const gmail = google.gmail({ version: 'v1', auth });
  // 過去24時間の送受信メールを取得してRawLogに変換

  console.log('メール: 収集処理は未実装です');
  return [];
}
