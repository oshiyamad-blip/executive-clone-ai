import { google } from 'googleapis';
import { getGoogleAuth, collectionWindow } from './googleAuth.js';
import type { RawLog } from '../types/index.js';

// Google Calendar 収集 — 対象経営者の予定履歴を取得する（calendar.readonly）
export async function collectFromCalendar(): Promise<RawLog[]> {
  const auth = getGoogleAuth();
  if (!auth) {
    console.warn('カレンダー: Google サービスアカウント設定が未完了');
    return [];
  }

  const calendar = google.calendar({ version: 'v3', auth });
  const { since, until } = collectionWindow();
  const logs: RawLog[] = [];

  try {
    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: since.toISOString(),
      timeMax: until.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
    });

    for (const event of res.data.items ?? []) {
      const start = event.start?.dateTime ?? event.start?.date;
      const attendees = (event.attendees ?? [])
        .map((a) => a.email ?? a.displayName ?? '')
        .filter(Boolean);

      logs.push({
        id: `calendar_${event.id}`,
        source: 'calendar',
        timestamp: new Date(start ?? Date.now()),
        content: [
          `予定: ${event.summary ?? '(無題)'}`,
          event.location ? `場所: ${event.location}` : '',
          event.description ? `詳細: ${event.description}` : '',
          attendees.length ? `参加者: ${attendees.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        participants: attendees,
        metadata: {
          location: event.location ?? '',
          organizer: event.organizer?.email ?? '',
          hangoutLink: event.hangoutLink ?? '',
        },
      });
    }
  } catch (err) {
    console.error(`カレンダー: 収集中にエラー: ${String(err)}`);
  }

  console.log(`カレンダー: ${logs.length}件を収集`);
  return logs;
}
