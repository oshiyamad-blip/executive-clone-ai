import { google } from 'googleapis';
import { getBillingGoogleAuth } from '../collectors/googleAuth.js';

// 担当者向けのメール通知（複数人運用）。
// NOTIFY_EMAILS（カンマ区切り）宛に、共有メールボックス（BILLING_TARGET_EMAIL、
// 未設定なら GOOGLE_TARGET_EMAIL）からサマリメールを自動送信する。
// gmail.compose スコープは送信も含むため、下書き作成と同じDWD登録で動く。
// 未設定なら何もしない（縮退動作）。

function encodeSubject(subject: string): string {
  return `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`;
}

export async function notifyByEmail(subject: string, body: string): Promise<boolean> {
  const recipients = (process.env.NOTIFY_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (recipients.length === 0) return false;

  const auth = getBillingGoogleAuth(['https://www.googleapis.com/auth/gmail.compose']);
  if (!auth) {
    console.warn('通知: Google サービスアカウント設定が未完了のためメール通知をスキップします');
    return false;
  }

  const mime = [
    `To: ${recipients.join(', ')}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body, 'utf-8').toString('base64'),
  ].join('\r\n');

  try {
    const gmail = google.gmail({ version: 'v1', auth });
    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: Buffer.from(mime).toString('base64url') },
    });
    console.log(`通知: ${recipients.length}名にメールを送信しました（${subject}）`);
    return true;
  } catch (err) {
    console.warn(`通知: メール送信に失敗（処理結果には影響なし）: ${String(err)}`);
    return false;
  }
}
