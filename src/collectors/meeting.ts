import type { RawLog } from '../types/index.js';

// Google Meet の録音・文字起こしを収集する
// Google Drive API で Meet の録画フォルダをスキャンして文字起こし（.vtt）を取得する
export async function collectFromMeetings(): Promise<RawLog[]> {
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!refreshToken) {
    console.warn('会議: Google OAuth2 の設定が未完了');
    return [];
  }

  // TODO: googleapis で実装
  // Drive API で "Meet Recordings" フォルダをスキャン
  // .vtt ファイルを解析して参加者・タイムスタンプ付きでRawLogに変換
  // 音声のみの場合は Whisper API で文字起こし

  console.log('会議: 収集処理は未実装です');
  return [];
}
