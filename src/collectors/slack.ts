import type { RawLog } from '../types/index.js';

// Slack Web API でターゲットユーザーの投稿を収集する
// 認証: SLACK_USER_TOKEN（conversations:history スコープ必要）
export async function collectFromSlack(): Promise<RawLog[]> {
  const token = process.env.SLACK_USER_TOKEN;
  const targetUserId = process.env.SLACK_TARGET_USER_ID;

  if (!token || !targetUserId) {
    console.warn('Slack: SLACK_USER_TOKEN または SLACK_TARGET_USER_ID が未設定');
    return [];
  }

  // TODO: @slack/web-api で実装
  // const client = new WebClient(token);
  // const channels = await client.conversations.list({ types: 'public_channel,private_channel,im' });
  // 各チャンネルの履歴を取得してユーザーの投稿のみフィルタリング

  console.log('Slack: 収集処理は未実装です');
  return [];
}
