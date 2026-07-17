import {
  notion,
  throttle,
  resolveDataSourceId,
  toRichText,
  createPageWithBody,
  markdownToBlocks,
  readTitle,
  readRichText,
  readSelect,
  readMultiSelect,
  readNumber,
  readDate,
  readRelation,
  readCheckbox,
  readEmail,
  updatePageProperties,
} from '../database/index.js';
import type {
  Client,
  Member,
  MemberKind,
  Project,
  Assignment,
  ContractType,
  RateTerms,
  Rounding,
  WorkRecord,
  IssuedInvoiceDraft,
  IssuedInvoiceStatus,
  InspectionStatus,
} from '../types/engagements.js';

// 案件・請求管理の Notion DB 層。
// 日本語プロパティ名はこのファイルに集約する（カラム名を変えたらここだけ直せばよい）。
// Notion 側でカラムを追加するのは自由 — コードは知らないプロパティを無視する。

export const DB_IDS = {
  client: process.env.NOTION_CLIENT_DB_ID ?? '',
  member: process.env.NOTION_MEMBER_DB_ID ?? '',
  project: process.env.NOTION_PROJECT_DB_ID ?? '',
  assignment: process.env.NOTION_ASSIGNMENT_DB_ID ?? '',
  workRecord: process.env.NOTION_WORK_RECORD_DB_ID ?? '',
  issuedInvoice: process.env.NOTION_ISSUED_INVOICE_DB_ID ?? '',
};

// --- select 値 ⇔ コード内 enum の対応表 ---

const MEMBER_KIND_LABELS: Record<MemberKind, string> = {
  contractor_corp: '業務委託（法人）',
  contractor_individual: '業務委託（個人事業主）',
  employee: '正社員',
};

const CONTRACT_TYPE_LABELS: Record<ContractType, string> = {
  outsourcing: '業務委託',
  quasi_mandate: '準委任（SES）',
  dispatch: '派遣',
};

const BILLING_METHOD_LABELS = { monthly: '月額+精算幅', hourly: '時給×実稼働' } as const;

const ROUNDING_LABELS: Record<Rounding, string> = {
  floor: '切り捨て',
  round: '四捨五入',
  ceil: '切り上げ',
};

function labelToKey<K extends string>(labels: Record<K, string>, label: string | undefined, fallback: K): K {
  for (const [key, value] of Object.entries(labels) as Array<[K, string]>) {
    if (value === label) return key;
  }
  return fallback;
}

export function memberKindLabel(kind: MemberKind): string {
  return MEMBER_KIND_LABELS[kind];
}

export function contractTypeLabel(type: ContractType): string {
  return CONTRACT_TYPE_LABELS[type];
}

// --- 共通クエリ（ページネーション対応）---

interface NotionPage {
  id: string;
  properties?: Record<string, unknown>;
}

async function queryAll(
  databaseId: string,
  options: { filter?: unknown; sorts?: unknown } = {},
): Promise<NotionPage[]> {
  const dataSourceId = await resolveDataSourceId(databaseId);
  const pages: NotionPage[] = [];
  let cursor: string | undefined;
  do {
    const response = await throttle(() =>
      notion.dataSources.query({
        data_source_id: dataSourceId,
        filter: options.filter as never,
        sorts: options.sorts as never,
        start_cursor: cursor,
        page_size: 100,
      }),
    );
    pages.push(...(response.results as NotionPage[]));
    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return pages;
}

function warnIfMissing(dbId: string, envName: string): boolean {
  if (!dbId) {
    console.warn(`${envName} が未設定 — 空のまま継続します`);
    return true;
  }
  return false;
}

// --- マスタ取得 ---

export async function fetchClients(): Promise<Client[]> {
  if (warnIfMissing(DB_IDS.client, 'NOTION_CLIENT_DB_ID')) return [];
  const pages = await queryAll(DB_IDS.client);
  return pages.map((page) => {
    const props = page.properties ?? {};
    return {
      id: page.id,
      name: readTitle(props['会社名']),
      contactPerson: readRichText(props['担当者']),
      billingEmail: readEmail(props['請求送付先メール']),
      closingDay: readSelect(props['締め日']) ?? '月末',
      paymentTerms: readSelect(props['支払サイト']) ?? '翌月末',
      status: readSelect(props['ステータス']) ?? '取引中',
      note: readRichText(props['メモ']),
    };
  });
}

export async function fetchMembers(): Promise<Member[]> {
  if (warnIfMissing(DB_IDS.member, 'NOTION_MEMBER_DB_ID')) return [];
  const pages = await queryAll(DB_IDS.member);
  return pages.map((page) => {
    const props = page.properties ?? {};
    const nextAvailable = readDate(props['次回空き日']);
    return {
      id: page.id,
      name: readTitle(props['名前']),
      kind: labelToKey(MEMBER_KIND_LABELS, readSelect(props['区分']), 'contractor_corp'),
      email: readEmail(props['メールアドレス']),
      skills: readMultiSelect(props['スキル']),
      nextAvailableDate: nextAvailable ? new Date(nextAvailable) : undefined,
      availabilityNote: readRichText(props['空き予定メモ']),
      status: readSelect(props['ステータス']) ?? '稼働中',
      invoiceRegistrationNumber: readRichText(props['インボイス登録番号']) || undefined,
      bankAccount: readRichText(props['振込先口座']) || undefined,
      monthlyRateHint: readNumber(props['単価目安']),
      monthlySalary: readNumber(props['月額給与']),
      costFactor: readNumber(props['コスト係数']),
    };
  });
}

export async function fetchProjects(): Promise<Project[]> {
  if (warnIfMissing(DB_IDS.project, 'NOTION_PROJECT_DB_ID')) return [];
  const pages = await queryAll(DB_IDS.project);
  return pages.map((page) => {
    const props = page.properties ?? {};
    const start = readDate(props['期間開始']);
    const end = readDate(props['期間終了']);
    return {
      id: page.id,
      name: readTitle(props['案件名']),
      clientId: readRelation(props['案件元'])[0],
      status: readSelect(props['ステータス']) ?? '提案中',
      period: {
        start: start ? new Date(start) : undefined,
        end: end ? new Date(end) : undefined,
      },
      requiredSkills: readMultiSelect(props['必要スキル']),
      rateRange: { min: readNumber(props['単価下限']), max: readNumber(props['単価上限']) },
      headcount: readNumber(props['必要人数']),
      note: readRichText(props['メモ']),
    };
  });
}

// アサインの請求/支払条件をプロパティ群から組み立てる
function readPaymentTerms(props: Record<string, unknown>): RateTerms | undefined {
  const monthlyRate = readNumber(props['支払単価']);
  if (monthlyRate === undefined) return undefined;
  return {
    rateType: 'monthly',
    monthlyRate,
    lowerHours: readNumber(props['支払精算下限h']),
    upperHours: readNumber(props['支払精算上限h']),
    overtimeRate: readNumber(props['支払超過単価']),
    deductionRate: readNumber(props['支払控除単価']),
  };
}

function readBillingTerms(props: Record<string, unknown>): RateTerms {
  const method = readSelect(props['請求方式']);
  if (method === BILLING_METHOD_LABELS.hourly) {
    return { rateType: 'hourly', hourlyRate: readNumber(props['請求時給単価']) };
  }
  return {
    rateType: 'monthly',
    monthlyRate: readNumber(props['請求単価']),
    lowerHours: readNumber(props['請求精算下限h']),
    upperHours: readNumber(props['請求精算上限h']),
    overtimeRate: readNumber(props['請求超過単価']),
    deductionRate: readNumber(props['請求控除単価']),
  };
}

export async function fetchAssignments(): Promise<Assignment[]> {
  if (warnIfMissing(DB_IDS.assignment, 'NOTION_ASSIGNMENT_DB_ID')) return [];
  const pages = await queryAll(DB_IDS.assignment);
  return pages.map((page) => {
    const props = page.properties ?? {};
    const start = readDate(props['期間開始']);
    const end = readDate(props['期間終了']);
    return {
      id: page.id,
      name: readTitle(props['アサイン名']),
      projectId: readRelation(props['案件'])[0],
      memberId: readRelation(props['要員'])[0],
      contractType: labelToKey(CONTRACT_TYPE_LABELS, readSelect(props['契約形態']), 'outsourcing'),
      period: {
        start: start ? new Date(start) : undefined,
        end: end ? new Date(end) : undefined,
      },
      allocationPercent: readNumber(props['稼働率']) ?? 100,
      payment: readPaymentTerms(props),
      billing: readBillingTerms(props),
      rounding: labelToKey(ROUNDING_LABELS, readSelect(props['端数処理']), 'floor'),
      status: readSelect(props['ステータス']) ?? '契約中',
    };
  });
}

// --- マスタ登録（移行取込・手動登録用）---

function billingMethodLabel(rateType: RateTerms['rateType']): string {
  return rateType === 'hourly' ? BILLING_METHOD_LABELS.hourly : BILLING_METHOD_LABELS.monthly;
}

export async function saveClient(client: Omit<Client, 'id'>): Promise<string> {
  const dataSourceId = await resolveDataSourceId(DB_IDS.client);
  const properties: Record<string, unknown> = {
    会社名: { title: toRichText(client.name) },
    担当者: { rich_text: toRichText(client.contactPerson) },
    メモ: { rich_text: toRichText(client.note) },
  };
  if (client.billingEmail) properties['請求送付先メール'] = { email: client.billingEmail };
  if (client.closingDay) properties['締め日'] = { select: { name: client.closingDay } };
  if (client.paymentTerms) properties['支払サイト'] = { select: { name: client.paymentTerms } };
  if (client.status) properties['ステータス'] = { select: { name: client.status } };

  return createPageWithBody(
    { parent: { type: 'data_source_id', data_source_id: dataSourceId }, properties } as never,
    [],
  );
}

export async function saveMember(member: Omit<Member, 'id'>): Promise<string> {
  const dataSourceId = await resolveDataSourceId(DB_IDS.member);
  const properties: Record<string, unknown> = {
    名前: { title: toRichText(member.name) },
    区分: { select: { name: memberKindLabel(member.kind) } },
    スキル: { multi_select: member.skills.map((s) => ({ name: s })) },
    空き予定メモ: { rich_text: toRichText(member.availabilityNote) },
  };
  if (member.email) properties['メールアドレス'] = { email: member.email };
  if (member.nextAvailableDate) {
    properties['次回空き日'] = { date: { start: member.nextAvailableDate.toISOString().slice(0, 10) } };
  }
  if (member.status) properties['ステータス'] = { select: { name: member.status } };
  if (member.invoiceRegistrationNumber) {
    properties['インボイス登録番号'] = { rich_text: toRichText(member.invoiceRegistrationNumber) };
  }
  if (member.bankAccount) properties['振込先口座'] = { rich_text: toRichText(member.bankAccount) };
  if (member.monthlyRateHint !== undefined) properties['単価目安'] = { number: member.monthlyRateHint };
  if (member.monthlySalary !== undefined) properties['月額給与'] = { number: member.monthlySalary };
  if (member.costFactor !== undefined) properties['コスト係数'] = { number: member.costFactor };

  return createPageWithBody(
    { parent: { type: 'data_source_id', data_source_id: dataSourceId }, properties } as never,
    [],
  );
}

export async function saveProject(project: Omit<Project, 'id'>): Promise<string> {
  const dataSourceId = await resolveDataSourceId(DB_IDS.project);
  const properties: Record<string, unknown> = {
    案件名: { title: toRichText(project.name) },
    必要スキル: { multi_select: project.requiredSkills.map((s) => ({ name: s })) },
    メモ: { rich_text: toRichText(project.note) },
  };
  if (project.clientId) properties['案件元'] = { relation: [{ id: project.clientId }] };
  if (project.status) properties['ステータス'] = { select: { name: project.status } };
  if (project.period.start) properties['期間開始'] = { date: { start: project.period.start.toISOString().slice(0, 10) } };
  if (project.period.end) properties['期間終了'] = { date: { start: project.period.end.toISOString().slice(0, 10) } };
  if (project.rateRange.min !== undefined) properties['単価下限'] = { number: project.rateRange.min };
  if (project.rateRange.max !== undefined) properties['単価上限'] = { number: project.rateRange.max };
  if (project.headcount !== undefined) properties['必要人数'] = { number: project.headcount };

  return createPageWithBody(
    { parent: { type: 'data_source_id', data_source_id: dataSourceId }, properties } as never,
    [],
  );
}

export async function saveAssignment(assignment: Omit<Assignment, 'id'>): Promise<string> {
  const dataSourceId = await resolveDataSourceId(DB_IDS.assignment);
  const properties: Record<string, unknown> = {
    アサイン名: { title: toRichText(assignment.name) },
    契約形態: { select: { name: contractTypeLabel(assignment.contractType) } },
    稼働率: { number: assignment.allocationPercent },
    端数処理: { select: { name: ROUNDING_LABELS[assignment.rounding] } },
    請求方式: { select: { name: billingMethodLabel(assignment.billing.rateType) } },
  };
  if (assignment.projectId) properties['案件'] = { relation: [{ id: assignment.projectId }] };
  if (assignment.memberId) properties['要員'] = { relation: [{ id: assignment.memberId }] };
  if (assignment.period.start) {
    properties['期間開始'] = { date: { start: assignment.period.start.toISOString().slice(0, 10) } };
  }
  if (assignment.period.end) {
    properties['期間終了'] = { date: { start: assignment.period.end.toISOString().slice(0, 10) } };
  }
  if (assignment.status) properties['ステータス'] = { select: { name: assignment.status } };

  const payment = assignment.payment;
  if (payment) {
    if (payment.monthlyRate !== undefined) properties['支払単価'] = { number: payment.monthlyRate };
    if (payment.lowerHours !== undefined) properties['支払精算下限h'] = { number: payment.lowerHours };
    if (payment.upperHours !== undefined) properties['支払精算上限h'] = { number: payment.upperHours };
    if (payment.overtimeRate !== undefined) properties['支払超過単価'] = { number: payment.overtimeRate };
    if (payment.deductionRate !== undefined) properties['支払控除単価'] = { number: payment.deductionRate };
  }

  const billing = assignment.billing;
  if (billing.rateType === 'hourly') {
    if (billing.hourlyRate !== undefined) properties['請求時給単価'] = { number: billing.hourlyRate };
  } else {
    if (billing.monthlyRate !== undefined) properties['請求単価'] = { number: billing.monthlyRate };
    if (billing.lowerHours !== undefined) properties['請求精算下限h'] = { number: billing.lowerHours };
    if (billing.upperHours !== undefined) properties['請求精算上限h'] = { number: billing.upperHours };
    if (billing.overtimeRate !== undefined) properties['請求超過単価'] = { number: billing.overtimeRate };
    if (billing.deductionRate !== undefined) properties['請求控除単価'] = { number: billing.deductionRate };
  }

  return createPageWithBody(
    { parent: { type: 'data_source_id', data_source_id: dataSourceId }, properties } as never,
    [],
  );
}

// --- 稼働実績（受領請求書・勤表）---

const DOC_TYPE_LABELS = { invoice: '請求書', timesheet: '勤表' } as const;

export async function findWorkRecordByMessageId(messageId: string): Promise<string | undefined> {
  if (!DB_IDS.workRecord) return undefined;
  const pages = await queryAll(DB_IDS.workRecord, {
    filter: { property: 'GmailメッセージID', rich_text: { equals: messageId } },
  });
  return pages[0]?.id;
}

export async function fetchWorkRecords(targetMonth?: string): Promise<WorkRecord[]> {
  if (warnIfMissing(DB_IDS.workRecord, 'NOTION_WORK_RECORD_DB_ID')) return [];
  const pages = await queryAll(DB_IDS.workRecord, {
    filter: targetMonth ? { property: '対象月', rich_text: { equals: targetMonth } } : undefined,
  });
  return pages.map((page) => {
    const props = page.properties ?? {};
    const due = readDate(props['支払期日']);
    return {
      id: page.id,
      title: readTitle(props['タイトル']),
      assignmentId: readRelation(props['アサイン'])[0],
      docType: readSelect(props['種別']) === DOC_TYPE_LABELS.timesheet ? 'timesheet' : 'invoice',
      targetMonth: readRichText(props['対象月']),
      workedHours: readNumber(props['稼働時間']),
      billedSubtotal: readNumber(props['請求金額（税抜）']),
      billedTax: readNumber(props['消費税']),
      billedTotal: readNumber(props['請求金額（税込）']),
      acceptedTotal: readNumber(props['検収金額（税込）']),
      status: (readSelect(props['検収ステータス']) ?? '未検収') as WorkRecord['status'],
      diffNote: readRichText(props['差異内容']),
      checklistNote: readRichText(props['記載チェック']),
      invoiceNumberMatched: readCheckbox(props['インボイス番号一致']),
      bankAccountMatched: readCheckbox(props['振込先一致']),
      paymentDueDate: due ? new Date(due) : undefined,
      gmailMessageId: readRichText(props['GmailメッセージID']),
      notionPageId: page.id,
    };
  });
}

export interface WorkRecordInput {
  title: string;
  assignmentId?: string;
  docType: 'invoice' | 'timesheet';
  targetMonth: string;
  workedHours?: number;
  billedSubtotal?: number;
  billedTax?: number;
  billedTotal?: number;
  acceptedTotal?: number;
  status: InspectionStatus | '未検収';
  diffNote: string;
  checklistNote: string;
  invoiceNumberMatched: boolean;
  bankAccountMatched: boolean;
  paymentDueDate?: string; // YYYY-MM-DD
  gmailMessageId: string;
  bodyMarkdown: string; // 抽出JSON+検収ログ（ページ本文）
}

export async function saveWorkRecord(input: WorkRecordInput): Promise<string> {
  const dataSourceId = await resolveDataSourceId(DB_IDS.workRecord);
  const properties: Record<string, unknown> = {
    タイトル: { title: toRichText(input.title) },
    種別: { select: { name: DOC_TYPE_LABELS[input.docType] } },
    対象月: { rich_text: toRichText(input.targetMonth) },
    検収ステータス: { select: { name: input.status } },
    差異内容: { rich_text: toRichText(input.diffNote) },
    記載チェック: { rich_text: toRichText(input.checklistNote) },
    インボイス番号一致: { checkbox: input.invoiceNumberMatched },
    振込先一致: { checkbox: input.bankAccountMatched },
    GmailメッセージID: { rich_text: toRichText(input.gmailMessageId) },
  };
  if (input.assignmentId) properties['アサイン'] = { relation: [{ id: input.assignmentId }] };
  if (input.workedHours !== undefined) properties['稼働時間'] = { number: input.workedHours };
  if (input.billedSubtotal !== undefined) properties['請求金額（税抜）'] = { number: input.billedSubtotal };
  if (input.billedTax !== undefined) properties['消費税'] = { number: input.billedTax };
  if (input.billedTotal !== undefined) properties['請求金額（税込）'] = { number: input.billedTotal };
  if (input.acceptedTotal !== undefined) properties['検収金額（税込）'] = { number: input.acceptedTotal };
  if (input.paymentDueDate) properties['支払期日'] = { date: { start: input.paymentDueDate } };

  return createPageWithBody(
    { parent: { type: 'data_source_id', data_source_id: dataSourceId }, properties } as never,
    markdownToBlocks(input.bodyMarkdown),
  );
}

// --- 発行請求書 ---

export interface IssuedInvoiceRecord {
  notionPageId: string;
  invoiceNumber: string;
  clientId?: string;
  targetMonth: string;
  total?: number;
  status: IssuedInvoiceStatus;
  gmailDraftId: string;
  pdfPath: string;
  pdfUrl: string; // Notion添付のURL（あれば）
}

export async function fetchIssuedInvoices(filter?: {
  targetMonth?: string;
  status?: IssuedInvoiceStatus;
}): Promise<IssuedInvoiceRecord[]> {
  if (warnIfMissing(DB_IDS.issuedInvoice, 'NOTION_ISSUED_INVOICE_DB_ID')) return [];
  const conditions: unknown[] = [];
  if (filter?.targetMonth) {
    conditions.push({ property: '対象月', rich_text: { equals: filter.targetMonth } });
  }
  if (filter?.status) {
    conditions.push({ property: 'ステータス', select: { equals: filter.status } });
  }
  const pages = await queryAll(DB_IDS.issuedInvoice, {
    filter: conditions.length ? { and: conditions } : undefined,
  });
  return pages.map((page) => {
    const props = page.properties ?? {};
    const files = (props['請求書PDF'] as {
      files?: Array<{ file?: { url?: string }; external?: { url?: string } }>;
    })?.files;
    return {
      notionPageId: page.id,
      invoiceNumber: readRichText(props['請求書番号']),
      clientId: readRelation(props['案件元'])[0],
      targetMonth: readRichText(props['対象月']),
      total: readNumber(props['合計（税込）']),
      status: (readSelect(props['ステータス']) ?? '承認待ち') as IssuedInvoiceStatus,
      gmailDraftId: readRichText(props['Gmail下書きID']),
      pdfPath: readRichText(props['PDFパス']),
      pdfUrl: files?.[0]?.file?.url ?? files?.[0]?.external?.url ?? '',
    };
  });
}

export async function countIssuedInvoicesInMonth(targetMonth: string): Promise<number> {
  const records = await fetchIssuedInvoices({ targetMonth });
  return records.length;
}

export async function saveIssuedInvoice(
  draft: IssuedInvoiceDraft,
  pdfPath: string,
  bodyMarkdown: string,
): Promise<string> {
  const dataSourceId = await resolveDataSourceId(DB_IDS.issuedInvoice);
  return createPageWithBody(
    {
      parent: { type: 'data_source_id', data_source_id: dataSourceId },
      properties: {
        タイトル: { title: toRichText(`${draft.targetMonth} ${draft.clientName}`) },
        請求書番号: { rich_text: toRichText(draft.invoiceNumber) },
        案件元: { relation: [{ id: draft.clientId }] },
        対象月: { rich_text: toRichText(draft.targetMonth) },
        '小計（税抜）': { number: draft.subtotal },
        消費税: { number: draft.tax },
        '合計（税込）': { number: draft.total },
        支払期日: { date: { start: draft.paymentDueDate.toISOString().slice(0, 10) } },
        ステータス: { select: { name: '承認待ち' } },
        PDFパス: { rich_text: toRichText(pdfPath) },
      },
    } as never,
    markdownToBlocks(bodyMarkdown),
  );
}

export async function updateIssuedInvoiceStatus(
  pageId: string,
  status: IssuedInvoiceStatus,
  gmailDraftId?: string,
): Promise<void> {
  const properties: Record<string, unknown> = { ステータス: { select: { name: status } } };
  if (gmailDraftId) properties['Gmail下書きID'] = { rich_text: toRichText(gmailDraftId) };
  await updatePageProperties(pageId, properties);
}

// --- 請求書PDFのNotion添付（File Upload API）---
// @notionhq/client v5 に fileUploads の型が無い場合に備え、REST を直接呼ぶ。
// 失敗しても発行フローは止めない（ローカルの PDFパス で参照できる）。
export async function attachPdfToPage(
  pageId: string,
  pdf: Buffer,
  filename: string,
): Promise<boolean> {
  const token = process.env.NOTION_TOKEN;
  if (!token) return false;
  const headers = { Authorization: `Bearer ${token}`, 'Notion-Version': '2025-09-03' };
  try {
    const created = await fetch('https://api.notion.com/v1/file_uploads', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'single_part', filename }),
    });
    if (!created.ok) throw new Error(`file_uploads create: ${created.status}`);
    const { id: uploadId } = (await created.json()) as { id: string };

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), filename);
    const sent = await fetch(`https://api.notion.com/v1/file_uploads/${uploadId}/send`, {
      method: 'POST',
      headers,
      body: form,
    });
    if (!sent.ok) throw new Error(`file_uploads send: ${sent.status}`);

    await updatePageProperties(pageId, {
      請求書PDF: { files: [{ type: 'file_upload', file_upload: { id: uploadId }, name: filename }] },
    });
    return true;
  } catch (err) {
    console.warn(`Notion: PDF添付に失敗（ローカルパスで継続）: ${String(err)}`);
    return false;
  }
}
