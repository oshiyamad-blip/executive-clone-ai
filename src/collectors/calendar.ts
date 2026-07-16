import type { RawLog } from '../types/index.js';

// Google Calendar API で予定履歴を収集する
// 参加者・場所・説明文をRawLogとして格納する
export async function collectFromCalendar(): Promise<RawLog[]> {
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!refreshToken) {
    console.warn('カレンダー: Google OAuth2 の設定が未完了');
    return [];
  }

  // TODO: googleapis で実装
  // const calendar = google.calendar({ version: 'v3', auth });
  // 過去24時間に終了した予定を取得（attendees・description・location含む）

  console.log('カレンダー: 収集処理は未実装です');
  return [];
}
