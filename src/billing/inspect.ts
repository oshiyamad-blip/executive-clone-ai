import '../env.js';
import {
  DB_IDS,
  fetchMembers,
  fetchAssignments,
  fetchProjects,
  saveWorkRecord,
  findWorkRecordByMessageId,
  type WorkRecordInput,
} from '../engagements/notionDb.js';
import { fetchDocumentEmails, type ReceivedMail } from './gmailDocuments.js';
import { saveSignal } from '../database/index.js';
import { notifyByEmail } from '../notify/index.js';
import { extractFromPdf } from './extractDocument.js';
import { reconcile, acceptTimesheet } from './reconcile.js';
import type { Assignment, ExtractedDocument, InspectionStatus, Member, ReconciliationResult } from '../types/engagements.js';

// 検収バッチ（npm run billing:inspect）。毎月メールで届く「委託先の請求書」「正社員の勤表」を
// 自動検出し、請求書は金額・記載事項を突合、勤表は稼働時間を確定して稼働実績DBへ保存する。

interface RecordSummary {
  docType: ExtractedDocument['docType'];
  status: InspectionStatus | '未検収';
  title: string;
  note: string;
}

// 対象月（YYYY-MM）の月初・月末を返す
function monthRange(month: string): { start: Date; end: Date } {
  const [y, m] = month.split('-').map(Number);
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 0, 23, 59, 59, 999)) };
}

// アサイン期間が対象月と重なるか（期間未設定側は無期限として扱う）
function overlapsMonth(period: { start?: Date; end?: Date }, month: string): boolean {
  const { start, end } = monthRange(month);
  const periodStart = period.start ?? new Date(-8640000000000000);
  const periodEnd = period.end ?? new Date(8640000000000000);
  return periodStart <= end && periodEnd >= start;
}

// 受信月の前月（YYYY-MM）。抽出結果に対象月が無いときのフォールバック
function previousMonth(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// From で要員を特定できなかった場合、発行者名/氏名と要員名の部分一致で解決を試みる
function resolveMemberByName(issuerName: string | null, members: Member[]): Member | undefined {
  const name = issuerName?.trim();
  if (!name) return undefined;
  return members.find((m) => m.name && (name.includes(m.name) || m.name.includes(name)));
}

function buildBodyMarkdown(
  extracted: ExtractedDocument,
  result: ReconciliationResult | undefined,
  unresolvedNote: string,
): string {
  const lines: string[] = [];
  lines.push('## 抽出結果');
  lines.push(`- 書類種別: ${extracted.docType === 'invoice' ? '請求書' : '勤表'}`);
  lines.push(`- 発行者/氏名: ${extracted.issuerName ?? '不明'}`);
  lines.push(`- 対象月: ${extracted.targetMonth ?? '不明'}`);
  lines.push(`- 稼働時間: ${extracted.workedHours ?? '不明'}`);
  lines.push(`- 請求書番号: ${extracted.invoiceNumber ?? '-'}`);
  lines.push(`- 発行日（取引年月日）: ${extracted.issueDate ?? '-'}`);
  lines.push(`- 税抜金額: ${extracted.subtotal ?? '-'}`);
  lines.push(`- 消費税額: ${extracted.taxAmount ?? '-'}`);
  lines.push(`- 税込合計: ${extracted.totalAmount ?? '-'}`);
  lines.push(`- インボイス登録番号: ${extracted.invoiceRegistrationNumber ?? '-'}`);
  lines.push(`- 振込先: ${extracted.bankAccount ?? '-'}`);
  lines.push(`- 支払期日: ${extracted.paymentDueDate ?? '-'}`);
  lines.push(`- 税率区分ごとの記載: ${extracted.hasTaxRateBreakdown ? 'あり' : 'なし'}`);
  lines.push(`- 宛名: ${extracted.recipientName ?? '-'}`);
  lines.push('');
  lines.push('## 検収結果');
  if (result) {
    lines.push(`- ステータス: ${result.status}`);
    lines.push(`- 計算根拠: ${result.calculationNote}`);
    if (extracted.docType === 'invoice') {
      lines.push(`- 期待税抜額: ${result.expectedSubtotal.toLocaleString()}円`);
      lines.push(`- 期待消費税: ${result.expectedTax.toLocaleString()}円`);
      lines.push(`- 期待税込額: ${result.expectedTotal.toLocaleString()}円`);
      lines.push(`- 差額（請求額−期待額）: ${result.diff.toLocaleString()}円`);
    }
    if (result.checklist.length > 0) {
      lines.push('');
      lines.push('## チェックリスト');
      for (const item of result.checklist) {
        lines.push(`- ${item.ok ? '✓' : '✗'} ${item.label}: ${item.detail}`);
      }
    }
  } else {
    lines.push('- ステータス: 要確認');
    lines.push(`- 理由: ${unresolvedNote}`);
  }
  return lines.join('\n');
}

async function processMail(
  mail: ReceivedMail,
  members: Member[],
  assignments: Assignment[],
  dryRun: boolean,
): Promise<RecordSummary | undefined> {
  const existingId = await findWorkRecordByMessageId(mail.messageId);
  if (existingId) {
    console.log(`検収: 処理済みのためスキップ（messageId=${mail.messageId}）`);
    return undefined;
  }

  const extractions: ExtractedDocument[] = [];
  for (const pdf of mail.pdfs) {
    try {
      extractions.push(await extractFromPdf(pdf.data));
    } catch (err) {
      console.warn(`検収: PDF抽出に失敗（${pdf.filename}）: ${String(err)}`);
    }
  }
  if (extractions.length === 0) {
    console.warn(`検収: 抽出できたPDFがないためスキップ（messageId=${mail.messageId}）`);
    return undefined;
  }
  const extracted = extractions.find((e) => e.docType === 'invoice' && e.totalAmount !== null) ?? extractions[0];

  const member = mail.member ?? resolveMemberByName(extracted.issuerName, members);
  const targetMonth = extracted.targetMonth ?? previousMonth(mail.receivedAt);

  let assignment: Assignment | undefined;
  let result: ReconciliationResult | undefined;
  let status: InspectionStatus | '未検収' = '要確認';
  let unresolvedNote = '';

  if (!member) {
    unresolvedNote = `要員を特定できませんでした（From: ${mail.from} / 発行者名: ${extracted.issuerName ?? '不明'}）`;
  } else {
    const candidates = assignments.filter(
      (a) => a.memberId === member.id && a.status === '契約中' && overlapsMonth(a.period, targetMonth),
    );
    if (candidates.length === 1) {
      assignment = candidates[0];
      result = member.kind === 'employee' ? acceptTimesheet(assignment, extracted) : reconcile(assignment, extracted, member);
      status = result.status;
    } else if (candidates.length === 0) {
      unresolvedNote = `要員「${member.name}」の対象月(${targetMonth})に契約中のアサインが見つかりませんでした`;
    } else {
      unresolvedNote = `要員「${member.name}」の対象月(${targetMonth})に契約中のアサインが${candidates.length}件あり一意に決定できませんでした`;
    }
  }

  const checklist = result?.checklist ?? [];
  const invoiceNumberMatched = checklist.find((c) => c.label === 'インボイス登録番号の一致')?.ok ?? false;
  const bankAccountMatched = checklist.find((c) => c.label === '振込先の一致')?.ok ?? false;
  const diffNote = result?.calculationNote ?? unresolvedNote;
  const checklistNote = checklist.map((c) => `${c.ok ? '✓' : '✗'} ${c.label}: ${c.detail}`).join('\n');

  const title = `${targetMonth} ${member?.name ?? extracted.issuerName ?? mail.from}`;
  const bodyMarkdown = buildBodyMarkdown(extracted, result, unresolvedNote);

  const input: WorkRecordInput = {
    title,
    assignmentId: assignment?.id,
    docType: extracted.docType,
    targetMonth,
    workedHours: extracted.workedHours ?? undefined,
    billedSubtotal: extracted.subtotal ?? undefined,
    billedTax: extracted.taxAmount ?? undefined,
    billedTotal: extracted.totalAmount ?? undefined,
    acceptedTotal: extracted.docType === 'invoice' && result ? result.expectedTotal : undefined,
    status,
    diffNote,
    checklistNote,
    invoiceNumberMatched,
    bankAccountMatched,
    paymentDueDate: extracted.paymentDueDate ?? undefined,
    gmailMessageId: mail.messageId,
    bodyMarkdown,
  };

  if (dryRun) {
    console.log(`[dry-run] 保存予定: ${title} — ${status}\n  ${diffNote}`);
  } else {
    await saveWorkRecord(input);
    console.log(`検収: 保存しました: ${title} — ${status}`);
  }

  return { docType: extracted.docType, status, title, note: diffNote };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  console.log(dryRun ? '=== 検収バッチ開始（--dry-run: 保存は行いません） ===' : '=== 検収バッチ開始 ===');

  if (!DB_IDS.workRecord) {
    console.warn('NOTION_WORK_RECORD_DB_ID が未設定のため検収バッチを終了します');
    return;
  }

  const [members, assignments, projects] = await Promise.all([fetchMembers(), fetchAssignments(), fetchProjects()]);
  console.log(`検収: 要員${members.length}名・アサイン${assignments.length}件・案件${projects.length}件を読み込みました`);

  const mails = await fetchDocumentEmails(members);

  const records: RecordSummary[] = [];
  for (const mail of mails) {
    try {
      const record = await processMail(mail, members, assignments, dryRun);
      if (record) records.push(record);
    } catch (err) {
      console.error(`検収: メール処理中にエラー（messageId=${mail.messageId}）: ${String(err)}`);
    }
  }

  const invoiceCount = records.filter((r) => r.docType === 'invoice').length;
  const timesheetCount = records.filter((r) => r.docType === 'timesheet').length;
  const okCount = records.filter((r) => r.status === '検収OK').length;
  const diffCount = records.filter((r) => r.status === '差異あり').length;
  const unresolvedCount = records.filter((r) => r.status === '要確認').length;

  console.log('\n=== 検収サマリ ===');
  console.log(
    `検収完了: 請求書${invoiceCount}件・勤表${timesheetCount}件（検収OK${okCount}/差異あり${diffCount}/要確認${unresolvedCount}）`,
  );

  const notable = records.filter((r) => r.status === '差異あり' || r.status === '要確認');
  if (notable.length > 0) {
    console.log('\n--- 要対応一覧 ---');
    for (const r of notable) console.log(`[${r.status}] ${r.title}: ${r.note}`);
  }

  // 担当者への通知（NOTIFY_EMAILS 設定時のみ）
  if (!dryRun && records.length > 0) {
    const notifyBody = [
      `検収完了: 請求書${invoiceCount}件・勤表${timesheetCount}件（検収OK${okCount}/差異あり${diffCount}/要確認${unresolvedCount}）`,
      '',
      ...(notable.length > 0
        ? ['【要対応】', ...notable.map((r) => `[${r.status}] ${r.title}: ${r.note}`)]
        : ['要対応はありません。']),
      '',
      '詳細はNotionの稼働実績DBを確認してください。',
    ].join('\n');
    await notifyByEmail(`【検収】${invoiceCount + timesheetCount}件処理・要対応${notable.length}件`, notifyBody);
  }

  // クローンAIとのシナジー: 検収イベントをシグナルDBへ流す（任意設定）
  if (process.env.ENGAGEMENT_SIGNALS_ENABLED === 'true' && !dryRun && records.length > 0) {
    try {
      await saveSignal({
        id: `billing_inspect_${Date.now()}`,
        rawLogIds: [],
        timestamp: new Date(),
        category: 'decision',
        summary: `検収完了: 請求書${invoiceCount}件・勤表${timesheetCount}件（検収OK${okCount}/差異あり${diffCount}/要確認${unresolvedCount}）`,
        detail: notable.map((r) => `[${r.status}] ${r.title}: ${r.note}`).join('\n') || '全件検収OK',
        tags: ['案件管理', '検収'],
        importance: notable.length > 0 ? 6 : 4,
        relatedPeople: [],
      });
      console.log('シグナルDBへ検収イベントを記録しました');
    } catch (err) {
      console.warn(`シグナルDBへの記録に失敗（検収結果には影響なし）: ${String(err)}`);
    }
  }
}

main().catch((err) => {
  console.error(`検収バッチ中にエラー: ${String(err)}`);
  process.exitCode = 1;
});
