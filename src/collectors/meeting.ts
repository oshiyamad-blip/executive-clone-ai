import { google } from 'googleapis';
import { getGoogleAuth, collectionWindow } from './googleAuth.js';
import type { RawLog } from '../types/index.js';

// Google Meet 収集 — 会議の自動文字起こしを取得する（meetings.space.readonly）
//
// フロー: conferenceRecords.list → transcripts.list → transcripts.entries.list
//   entries は話者ラベル付きの発話テキスト。
//
// ⚠️ conferenceRecords は「impersonate したユーザーが主催/参加した会議」のみ。
// ⚠️ Meet の文字起こし構造化データ（entries）は会議終了から30日で削除される。
//    日次バッチで即時取得する前提。長期網羅が必要なら Vault を併用する。
// ⚠️ 録画・文字起こしは対応エディション＋会議側での有効化が必要。
export async function collectFromMeetings(): Promise<RawLog[]> {
  const auth = getGoogleAuth();
  if (!auth) {
    console.warn('会議: Google サービスアカウント設定が未完了');
    return [];
  }

  const meet = google.meet({ version: 'v2', auth });
  const { since } = collectionWindow();
  const logs: RawLog[] = [];

  try {
    const records = await meet.conferenceRecords.list({ pageSize: 50 });

    for (const record of records.data.conferenceRecords ?? []) {
      if (!record.name) continue;
      // 過去24時間の会議のみ対象
      const startMs = record.startTime ? new Date(record.startTime).getTime() : 0;
      if (startMs < since.getTime()) continue;

      const transcripts = await meet.conferenceRecords.transcripts.list({ parent: record.name });

      for (const transcript of transcripts.data.transcripts ?? []) {
        if (!transcript.name) continue;
        const text = await collectTranscriptText(meet, transcript.name);
        if (!text.content.trim()) continue;

        logs.push({
          id: `meeting_${transcript.name.replace(/\//g, '_')}`,
          source: 'meeting',
          timestamp: new Date(record.startTime ?? Date.now()),
          content: text.content,
          participants: [...text.speakers],
          metadata: { conferenceRecord: record.name, space: record.space ?? '' },
        });
      }
    }
  } catch (err) {
    console.error(`会議: 収集中にエラー: ${String(err)}`);
  }

  console.log(`会議: ${logs.length}件を収集`);
  return logs;
}

type MeetClient = ReturnType<typeof google.meet>;

// 1つの文字起こしの全 entries を発話テキストに組み立てる
async function collectTranscriptText(
  meet: MeetClient,
  transcriptName: string,
): Promise<{ content: string; speakers: Set<string> }> {
  const speakers = new Set<string>();
  const lines: string[] = [];
  let pageToken: string | undefined;

  do {
    const res = await meet.conferenceRecords.transcripts.entries.list({
      parent: transcriptName,
      pageSize: 1000,
      pageToken,
    });

    for (const entry of res.data.transcriptEntries ?? []) {
      const speaker = entry.participant ?? '不明';
      speakers.add(speaker);
      if (entry.text) lines.push(`${speaker}: ${entry.text}`);
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return { content: lines.join('\n'), speakers };
}
