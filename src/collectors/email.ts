import { google } from 'googleapis';
import { getGoogleAuth } from './googleAuth.js';
import type { RawLog } from '../types/index.js';

// Gmail 収集 — 対象経営者の送受信メールを取得する（gmail.readonly）
export async function collectFromEmail(): Promise<RawLog[]> {
  const auth = getGoogleAuth();
  if (!auth) {
    console.warn('メール: Google サービスアカウント設定が未完了');
    return [];
  }

  const gmail = google.gmail({ version: 'v1', auth });
  const logs: RawLog[] = [];

  try {
    // 過去24時間の送受信メール（下書き・スパム・ゴミ箱は除外）
    const list = await gmail.users.messages.list({
      userId: 'me',
      q: 'newer_than:1d -in:drafts -in:spam -in:trash',
      maxResults: 100,
    });

    for (const ref of list.data.messages ?? []) {
      if (!ref.id) continue;
      const msg = await gmail.users.messages.get({ userId: 'me', id: ref.id, format: 'full' });
      const headers = msg.data.payload?.headers ?? [];
      const header = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';

      const subject = header('Subject');
      const from = header('From');
      const to = header('To');
      const body = extractBody(msg.data.payload);
      const dateMs = Number(msg.data.internalDate ?? Date.now());

      logs.push({
        id: `email_${ref.id}`,
        source: 'email',
        timestamp: new Date(dateMs),
        content: `件名: ${subject}\nFrom: ${from}\nTo: ${to}\n\n${body}`,
        participants: [from, to].filter(Boolean),
        metadata: { subject, threadId: msg.data.threadId ?? '' },
      });
    }
  } catch (err) {
    console.error(`メール: 収集中にエラー: ${String(err)}`);
  }

  console.log(`メール: ${logs.length}件を収集`);
  return logs;
}

// MIMEツリーから text/plain 本文を再帰的に抽出する（base64url デコード）
function extractBody(payload: unknown): string {
  const p = payload as {
    mimeType?: string;
    body?: { data?: string };
    parts?: unknown[];
  } | undefined;
  if (!p) return '';

  if (p.mimeType === 'text/plain' && p.body?.data) {
    return decodeBase64Url(p.body.data);
  }
  for (const part of p.parts ?? []) {
    const text = extractBody(part);
    if (text) return text;
  }
  // text/plain が無ければ最初の body を返す
  if (p.body?.data) return decodeBase64Url(p.body.data);
  return '';
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}
