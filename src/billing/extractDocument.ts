import { generateJsonFromPdf } from '../llm/index.js';
import type { ExtractedDocument } from '../types/engagements.js';

// PDFを直接読解し、請求書/勤表を判定した上で記載項目を抽出する。
// テキスト抽出ライブラリを介さないため、レイアウト崩れに強い（Claude document block）。

const EXTRACTION_SYSTEM = `あなたは経理担当者です。
渡されるPDFは、業務委託先からの請求書、または自社社員の勤務表（勤表・作業報告書・タイムシート）のどちらかです。
まず docType（invoice/timesheet）を判定し、そのPDFに記載されている値だけを抽出してください。
記載がない項目は null にしてください。推測で値を埋めてはいけません。
対象月（targetMonth）は YYYY-MM 形式、日付（issueDate/paymentDueDate）は YYYY-MM-DD 形式で出力してください。
金額はすべて数値（円、カンマなし）で出力してください。
インボイス登録番号（invoiceRegistrationNumber）は「T」+数字13桁の形式で、記載通りに抽出してください。`;

const EXTRACTION_USER = '添付のPDFを読み取り、指定のJSON Schemaに従って書類の種別と記載項目を抽出してください。';

const EXTRACTED_DOCUMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'docType',
    'issuerName',
    'targetMonth',
    'workedHours',
    'invoiceNumber',
    'issueDate',
    'subtotal',
    'taxAmount',
    'totalAmount',
    'invoiceRegistrationNumber',
    'bankAccount',
    'paymentDueDate',
    'hasTaxRateBreakdown',
    'recipientName',
  ],
  properties: {
    docType: {
      type: 'string',
      enum: ['invoice', 'timesheet'],
      description: '請求書なら invoice、勤務表（勤表・作業報告書・タイムシート）なら timesheet',
    },
    issuerName: { type: ['string', 'null'], description: '発行者名（請求書）または氏名（勤表）' },
    targetMonth: { type: ['string', 'null'], description: '対象月。YYYY-MM形式' },
    workedHours: { type: ['number', 'null'], description: '稼働時間（h）' },
    invoiceNumber: { type: ['string', 'null'], description: '請求書番号（請求書のみ）' },
    issueDate: { type: ['string', 'null'], description: '発行日・取引年月日。YYYY-MM-DD形式（請求書のみ）' },
    subtotal: { type: ['number', 'null'], description: '税抜金額（円、請求書のみ）' },
    taxAmount: { type: ['number', 'null'], description: '消費税額（円、請求書のみ）' },
    totalAmount: { type: ['number', 'null'], description: '税込合計金額（円、請求書のみ）' },
    invoiceRegistrationNumber: {
      type: ['string', 'null'],
      description: '適格請求書発行事業者登録番号。T+数字13桁（請求書のみ）',
    },
    bankAccount: { type: ['string', 'null'], description: '振込先口座（請求書のみ）' },
    paymentDueDate: { type: ['string', 'null'], description: '支払期日。YYYY-MM-DD形式（請求書のみ）' },
    hasTaxRateBreakdown: {
      type: 'boolean',
      description: '税率区分ごとの対象額・消費税額が記載されているか（請求書のみ。勤表は false）',
    },
    recipientName: { type: ['string', 'null'], description: '宛名（請求書のみ）' },
  },
} as const;

export async function extractFromPdf(pdf: Buffer): Promise<ExtractedDocument> {
  const raw = await generateJsonFromPdf<ExtractedDocument>(
    EXTRACTION_SYSTEM,
    EXTRACTION_USER,
    pdf,
    EXTRACTED_DOCUMENT_SCHEMA,
  );

  // LLM抽出値の再検証。形式が違えば null に落とし、下流の誤判定を防ぐ。
  const invoiceRegistrationNumber =
    raw.invoiceRegistrationNumber && /^T\d{13}$/.test(raw.invoiceRegistrationNumber)
      ? raw.invoiceRegistrationNumber
      : null;
  const targetMonth = raw.targetMonth && /^\d{4}-\d{2}$/.test(raw.targetMonth) ? raw.targetMonth : null;

  return { ...raw, invoiceRegistrationNumber, targetMonth };
}
