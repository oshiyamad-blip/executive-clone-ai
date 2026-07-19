import '../env.js';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { fetchIssuedInvoices, fetchClients, updateIssuedInvoiceStatus } from '../engagements/notionDb.js';
import type { IssuedInvoiceRecord } from '../engagements/notionDb.js';
import { createInvoiceDraft } from './gmailDraft.js';
import { COMPANY_PROFILE, renderTemplate } from '../data/companyProfile.js';
import { notifyByEmail } from '../notify/index.js';
import type { Client } from '../types/engagements.js';

// 発行②下書き作成バッチ（npm run billing:drafts）。
// 発行請求書DBから「承認済み」かつGmail下書きID未設定のレコードを取得し、Gmail下書きを作成する。
// 人がNotion上でステータスを「承認済み」に変えたものだけが対象（承認自体はNotionで行う）。

async function loadPdf(record: IssuedInvoiceRecord): Promise<Buffer | undefined> {
  if (record.pdfPath && existsSync(record.pdfPath)) {
    try {
      return await readFile(record.pdfPath);
    } catch (err) {
      console.warn(`下書き作成: ローカルPDFの読込に失敗（${record.pdfPath}）: ${String(err)}`);
    }
  }
  if (record.pdfUrl) {
    try {
      const res = await fetch(record.pdfUrl);
      if (!res.ok) throw new Error(`status ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      console.warn(`下書き作成: PDFのダウンロードに失敗（${record.pdfUrl}）: ${String(err)}`);
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  console.log('=== 請求書発行②下書き作成バッチ ===');

  if (!process.env.NOTION_ISSUED_INVOICE_DB_ID) {
    console.warn(
      'NOTION_ISSUED_INVOICE_DB_ID が未設定です。npm run engagements:setup を実行してください。処理を終了します。',
    );
    return;
  }

  const [approved, clients] = await Promise.all([
    fetchIssuedInvoices({ status: '承認済み' }),
    fetchClients(),
  ]);
  const targets = approved.filter((inv) => !inv.gmailDraftId);

  if (targets.length === 0) {
    console.log('承認済みの請求書はありません。');
    return;
  }

  const clientById = new Map<string, Client>(clients.map((c) => [c.id, c]));

  let created = 0;
  for (const record of targets) {
    const client = record.clientId ? clientById.get(record.clientId) : undefined;
    if (!client || !client.billingEmail) {
      console.warn(`下書き作成: ${record.invoiceNumber} は案件元の請求送付先メールが未登録のためスキップします`);
      continue;
    }

    const pdf = await loadPdf(record);
    if (!pdf) {
      console.warn(`下書き作成: ${record.invoiceNumber} はPDFが取得できないためスキップします`);
      continue;
    }

    const vars = {
      company: client.name,
      month: record.targetMonth,
      contact: client.contactPerson || 'ご担当者',
      address: COMPANY_PROFILE.address,
    };
    const subject = renderTemplate(COMPANY_PROFILE.emailSubjectTemplate, vars);
    const body = renderTemplate(COMPANY_PROFILE.emailBodyTemplate, vars);
    const filename = `${record.invoiceNumber || 'invoice'}.pdf`;

    const draftId = await createInvoiceDraft(client.billingEmail, subject, body, pdf, filename);
    if (!draftId) {
      console.warn(`下書き作成: ${record.invoiceNumber} のGmail下書き作成に失敗しました`);
      continue;
    }

    // Notion更新の失敗で残りの請求書処理を止めない。ただし下書きIDが未記録のままだと
    // 再実行時に同じ下書きが重複作成されるため、手動対応を明確に警告する
    try {
      await updateIssuedInvoiceStatus(record.notionPageId, '下書き作成済', draftId);
      console.log(`下書き作成: ${client.name}（${record.invoiceNumber}） → Gmail下書きID ${draftId}`);
    } catch (err) {
      console.error(
        `⚠ 下書き作成: ${record.invoiceNumber} のNotionステータス更新に失敗しました。` +
          `Gmail下書き（ID: ${draftId}）は作成済みです — 再実行前にNotionで手動で「下書き作成済」に変更するか、` +
          `Gmailの重複下書きを削除してください: ${String(err)}`,
      );
    }
    created += 1;
  }

  console.log(`\nGmail下書きを${created}件作成しました。Gmailで内容を確認して送信してください。`);

  // 担当者への通知（NOTIFY_EMAILS 設定時のみ）
  if (created > 0) {
    await notifyByEmail(
      `【請求書下書き】${created}件作成 — 確認して送信してください`,
      `承認済みの請求書からGmail下書きを${created}件作成しました。\nGmail（${process.env.BILLING_TARGET_EMAIL || '経営者アカウント'}）の下書きを確認して送信し、Notionのステータスを「送付済」に更新してください。`,
    );
  }
}

main().catch((err) => {
  console.error(`下書き作成バッチ中にエラーが発生しました: ${String(err)}`);
  process.exitCode = 1;
});
