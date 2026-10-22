import { google } from 'googleapis';
import { getGoogleAuth, collectionWindow } from './googleAuth.js';
import type { RawLog } from '../types/index.js';

// 各種文書収集 — 対象経営者が作成/更新した Google ドキュメントを取得する（drive.readonly）
export async function collectFromDocuments(): Promise<RawLog[]> {
  const auth = getGoogleAuth();
  if (!auth) {
    console.warn('文書: Google サービスアカウント設定が未完了');
    return [];
  }

  const drive = google.drive({ version: 'v3', auth });
  const { since } = collectionWindow();
  const logs: RawLog[] = [];

  try {
    // 過去24時間に更新された Google ドキュメント（本人がオーナーのもの）
    const list = await drive.files.list({
      q: `mimeType='application/vnd.google-apps.document' and modifiedTime > '${since.toISOString()}' and 'me' in owners and trashed = false`,
      orderBy: 'modifiedTime desc',
      fields: 'files(id, name, modifiedTime, owners(emailAddress))',
      pageSize: 50,
    });

    for (const file of list.data.files ?? []) {
      if (!file.id) continue;
      // Google Docs はプレーンテキストにエクスポートして本文を取得する
      const exported = await drive.files.export({ fileId: file.id, mimeType: 'text/plain' });
      const body = typeof exported.data === 'string' ? exported.data : String(exported.data ?? '');
      if (!body.trim()) continue;

      logs.push({
        // 更新時刻をIDに含める。file.id だけだと一度取り込んだ文書のIDが処理済みに
        // 残り続け、その後の編集（生きた文書の改稿）が永久に取り込まれなくなる。
        id: `document_${file.id}_${file.modifiedTime ?? ''}`,
        source: 'document',
        timestamp: new Date(file.modifiedTime ?? Date.now()),
        content: `文書: ${file.name ?? '(無題)'}\n\n${body}`,
        participants: (file.owners ?? []).map((o) => o.emailAddress ?? '').filter(Boolean),
        metadata: { fileId: file.id, title: file.name ?? '' },
      });
    }
  } catch (err) {
    console.error(`文書: 収集中にエラー: ${String(err)}`);
  }

  console.log(`文書: ${logs.length}件を収集`);
  return logs;
}
