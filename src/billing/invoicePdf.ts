import PDFDocument from 'pdfkit';
import { existsSync } from 'fs';
import { join } from 'path';
import type { IssuedInvoiceDraft } from '../types/engagements.js';
import type { Client } from '../types/engagements.js';
import { COMPANY_PROFILE } from '../data/companyProfile.js';

// 案件元向けの適格請求書（インボイス制度対応）PDFを pdfkit + 同梱の Noto Sans JP で生成する。
// フォントが同梱されていない環境では日本語警告のうえ null を返す（呼び出し側で縮退）。

const FONT_PATH = join(process.cwd(), 'fonts', 'NotoSansJP-Regular.ttf');

function formatYen(amount: number): string {
  return `${Math.round(amount).toLocaleString('ja-JP')}円`;
}

function formatDateJp(date: Date): string {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

export async function renderInvoicePdf(draft: IssuedInvoiceDraft, client: Client): Promise<Buffer | null> {
  if (!existsSync(FONT_PATH)) {
    console.warn(
      `請求書PDF: 日本語フォント（${FONT_PATH}）が見つかりません。PDF生成をスキップします。fonts/NotoSansJP-Regular.ttf を配置してください。`,
    );
    return null;
  }

  return new Promise<Buffer | null>((resolve) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (err: unknown) => {
        console.warn(`請求書PDF生成中にエラー: ${String(err)}`);
        resolve(null);
      });

      doc.registerFont('NotoSansJP', FONT_PATH);
      doc.font('NotoSansJP');

      drawInvoice(doc, draft, client);

      doc.end();
    } catch (err) {
      console.warn(`請求書PDF生成中にエラー: ${String(err)}`);
      resolve(null);
    }
  });
}

function drawInvoice(doc: PDFKit.PDFDocument, draft: IssuedInvoiceDraft, client: Client): void {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const bottom = doc.page.height - doc.page.margins.bottom;
  const contentWidth = right - left;
  const today = new Date();

  // タイトル
  doc.fontSize(22).text('請求書', left, 50, { width: contentWidth, align: 'center' });

  // 宛名（左）
  doc.fontSize(14).text(`${client.name} 御中`, left, 100, { width: contentWidth * 0.6 });

  // 請求書番号・発行日（右上）
  doc.fontSize(10);
  doc.text(`請求書番号: ${draft.invoiceNumber}`, left, 100, { width: contentWidth, align: 'right' });
  doc.text(`発行日: ${formatDateJp(today)}`, left, 116, { width: contentWidth, align: 'right' });
  doc.text(`対象月: ${draft.targetMonth}`, left, 132, { width: contentWidth, align: 'right' });

  // ご請求金額（税込）を中央に大きく
  const amountBoxY = 165;
  doc.fontSize(11).text('ご請求金額（税込）', left, amountBoxY, { width: contentWidth, align: 'center' });
  doc.fontSize(26).text(formatYen(draft.total), left, amountBoxY + 16, { width: contentWidth, align: 'center' });
  doc
    .moveTo(left + contentWidth / 2 - 110, amountBoxY + 52)
    .lineTo(left + contentWidth / 2 + 110, amountBoxY + 52)
    .lineWidth(1.5)
    .stroke();

  // 明細表
  const descW = contentWidth * 0.55;
  const hoursW = contentWidth * 0.18;
  const amountW = contentWidth - descW - hoursW;
  const hoursX = left + descW;
  const amountX = hoursX + hoursW;

  let y = amountBoxY + 80;

  const drawTableHeader = (headerY: number): number => {
    doc.fontSize(10);
    doc.text('品目', left, headerY, { width: descW });
    doc.text('稼働時間', hoursX, headerY, { width: hoursW, align: 'right' });
    doc.text('金額（税抜）', amountX, headerY, { width: amountW, align: 'right' });
    const lineY = headerY + 16;
    doc.moveTo(left, lineY).lineTo(right, lineY).lineWidth(0.75).stroke();
    return lineY + 6;
  };

  const ensureSpace = (needed: number, currentY: number): number => {
    if (currentY + needed <= bottom - 140) return currentY;
    doc.addPage();
    doc.font('NotoSansJP');
    return drawTableHeader(50);
  };

  y = drawTableHeader(y);

  doc.fontSize(9);
  for (const line of draft.lines) {
    const descHeight = doc.heightOfString(line.description, { width: descW });
    const rowHeight = Math.max(descHeight, 12) + 10;
    y = ensureSpace(rowHeight, y);

    doc.text(line.description, left, y, { width: descW });
    doc.text(line.hours !== undefined ? `${line.hours}h` : '-', hoursX, y, { width: hoursW, align: 'right' });
    doc.text(formatYen(line.amount), amountX, y, { width: amountW, align: 'right' });
    y += rowHeight;
    doc.moveTo(left, y - 4).lineTo(right, y - 4).lineWidth(0.25).stroke();
  }

  y += 12;
  y = ensureSpace(100, y);

  // 小計・消費税・合計
  const summaryLabelW = contentWidth - 150;
  doc.fontSize(10);
  doc.text('小計（税抜）', left, y, { width: summaryLabelW, align: 'right' });
  doc.text(formatYen(draft.subtotal), left + summaryLabelW, y, { width: 150, align: 'right' });
  y += 18;
  doc.text('消費税（10%対象）', left, y, { width: summaryLabelW, align: 'right' });
  doc.text(formatYen(draft.tax), left + summaryLabelW, y, { width: 150, align: 'right' });
  y += 18;
  doc.fontSize(12);
  doc.text('合計（税込）', left, y, { width: summaryLabelW, align: 'right' });
  doc.text(formatYen(draft.total), left + summaryLabelW, y, { width: 150, align: 'right' });
  y += 28;

  doc.fontSize(10);
  doc.text(`支払期日: ${formatDateJp(draft.paymentDueDate)}`, left, y, { width: contentWidth });
  y += 18;
  doc.text(`振込先: ${COMPANY_PROFILE.bankAccount}`, left, y, { width: contentWidth });
  y += 18;
  doc.fontSize(9);
  doc.text('※恐れ入りますが振込手数料は貴社にてご負担願います。', left, y, { width: contentWidth });

  // 自社情報（左下）
  const footerY = bottom - 70;
  doc.fontSize(9);
  doc.text(COMPANY_PROFILE.companyName, left, footerY, { width: contentWidth * 0.7 });
  doc.text(COMPANY_PROFILE.address, left, footerY + 14, { width: contentWidth * 0.7 });
  doc.text(`登録番号: ${COMPANY_PROFILE.invoiceRegistrationNumber}`, left, footerY + 28, {
    width: contentWidth * 0.7,
  });
}
