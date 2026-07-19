import { WebClient } from '@slack/web-api';
import { collectionWindow } from './googleAuth.js';
import type { RawLog } from '../types/index.js';

// Slack 収集 — 対象経営者の投稿を search.messages で全チャンネル・DM横断で取得する。
//
// 方式: ユーザートークン(xoxp) + `search.messages` の `from:<@USERID>` クエリ。
//   - パブリック/プライベートチャンネル・DM(im)・グループDM(mpim) を横断できる
//   - スレッド返信も matches に含まれる
//   - ページングは cursor ではなく page 番号（最大約10,000件 = 100件×100ページ）
//
// ⚠️ トークン所有者本人が参加している会話のみ取得可能。経営者のプライベートDMまで
//    取るには、経営者本人のOAuth認可で発行された xoxp トークンが必要。
// ⚠️ 会話列挙+history方式は 2025-05 のレート制限改定で非現実的になったため不採用。
export async function collectFromSlack(): Promise<RawLog[]> {
  const token = process.env.SLACK_USER_TOKEN;
  const targetUserId = process.env.SLACK_TARGET_USER_ID;

  if (!token || !targetUserId) {
    console.warn('Slack: SLACK_USER_TOKEN または SLACK_TARGET_USER_ID が未設定');
    return [];
  }

  const client = new WebClient(token);
  // 収集ウィンドウは他コレクタと共通の collectionWindow() を使う（ここだけ独自定義に
  // すると、ウィンドウ変更時にSlackだけ取得範囲がずれる）
  const sinceMs = collectionWindow().since.getTime();
  // Slack の `after:` は指定日を含まない(exclusive)。取りこぼしを防ぐため1日前を指定し、
  // 実際のウィンドウ(過去24時間)は取得後に ts で厳密に絞る。
  const afterDate = new Date(sinceMs - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const query = `from:<@${targetUserId}> after:${afterDate}`;

  const logs: RawLog[] = [];
  let page = 1;
  let totalPages = 1;

  try {
    do {
      const res = await client.search.messages({
        query,
        count: 100,
        page,
        sort: 'timestamp',
        sort_dir: 'asc',
      });

      const matches = res.messages?.matches ?? [];
      for (const m of matches) {
        if (!m.ts || !m.text) continue;
        const tsMs = Number(m.ts) * 1000;
        if (tsMs < sinceMs) continue; // ウィンドウ外（after: の粗さで混入した分）を除外
        logs.push({
          id: `slack_${m.ts}`,
          source: 'slack',
          timestamp: new Date(tsMs),
          content: m.text,
          participants: m.username ? [m.username] : [],
          metadata: {
            channel: m.channel?.name ?? m.channel?.id ?? '',
            permalink: m.permalink ?? '',
          },
        });
      }

      totalPages = res.messages?.paging?.pages ?? 1;
      page++;
    } while (page <= totalPages && page <= 100);
  } catch (err) {
    // 429 は @slack/web-api が Retry-After 準拠で自動リトライする。ここは致命的失敗のみ。
    console.error(`Slack: 収集中にエラー: ${String(err)}`);
  }

  console.log(`Slack: ${logs.length}件を収集`);
  return logs;
}
