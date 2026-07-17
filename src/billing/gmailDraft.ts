import { google } from 'googleapis';
import { getGoogleAuth } from '../collectors/googleAuth.js';

// 案件元への請求書メールを Gmail 下書きとして作成する。
// multipart/mixed の MIME を手組みし、gmail.users.drafts.create に raw(base64url) で渡す。
// 送信は行わない（人が Gmail 上で最終確認してから送信する運用）。

const BOUNDARY = `----=_Invoice_Boundary_${Math.random().toString(36).slice(2)}`;

// 件名の RFC2047 エンコード（日本語件名はそのまま送ると文字化けするため）
function encodeSubject(subject: string): string {
  return `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`;
}

// base64 は MIME 上 76 文字ごとに改行するのが慣例（必須ではないが互換性のため揃える）
function wrapBase64(base64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += 76) {
    lines.push(base64.slice(i, i + 76));
  }
  return lines.join('\r\n');
}

// 非ASCIIファイル名は RFC2231 拡張パラメータ（filename*=UTF-8''...）で渡す
function encodeFilenameRfc2231(filename: string): string {
  return `filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function createInvoiceDraft(
  to: string,
  subject: string,
  body: string,
  pdf: Buffer,
  filename: string,
): Promise<string | null> {
  const auth = getGoogleAuth(['https://www.googleapis.com/auth/gmail.compose']);
  if (!auth) {
    console.warn(
      'Gmail下書き作成: Google サービスアカウント設定が未完了のため、下書き作成をスキップします（GOOGLE_SA_CLIENT_EMAIL 等を確認してください）。',
    );
    return null;
  }

  try {
    const gmail = google.gmail({ version: 'v1', auth });

    const bodyBase64 = wrapBase64(Buffer.from(body, 'utf-8').toString('base64'));
    const pdfBase64 = wrapBase64(pdf.toString('base64'));

    const message = [
      `To: ${to}`,
      `Subject: ${encodeSubject(subject)}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${BOUNDARY}"`,
      '',
      `--${BOUNDARY}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      bodyBase64,
      '',
      `--${BOUNDARY}`,
      `Content-Type: application/pdf; name="${filename}"`,
      `Content-Disposition: attachment; ${encodeFilenameRfc2231(filename)}`,
      'Content-Transfer-Encoding: base64',
      '',
      pdfBase64,
      '',
      `--${BOUNDARY}--`,
      '',
    ].join('\r\n');

    const raw = Buffer.from(message, 'utf-8').toString('base64url');

    const draft = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: { message: { raw } },
    });

    const draftId = draft.data.id;
    if (!draftId) {
      console.warn('Gmail下書き作成: レスポンスに下書きIDが含まれていません');
      return null;
    }
    return draftId;
  } catch (err) {
    console.warn(
      `Gmail下書き作成中にエラー: ${String(err)}（DWDに gmail.compose スコープが未登録の可能性があります。Workspace管理コンソールで登録してください）`,
    );
    return null;
  }
}
