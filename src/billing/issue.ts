import '../env.js';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import {
  fetchClients,
  fetchMembers,
  fetchProjects,
  fetchAssignments,
  fetchWorkRecords,
  fetchIssuedInvoices,
  countIssuedInvoicesInMonth,
  saveIssuedInvoice,
  attachPdfToPage,
} from '../engagements/notionDb.js';
import { calcSettlement } from './reconcile.js';
import { saveSignal } from '../database/index.js';
import { notifyByEmail } from '../notify/index.js';
import { renderInvoicePdf } from './invoicePdf.js';
import { COMPANY_PROFILE } from '../data/companyProfile.js';
import type { Client, Member, Project, Assignment, WorkRecord, InvoiceLine, IssuedInvoiceDraft } from '../types/engagements.js';

// 発行①作成バッチ（npm run billing:issue）。
// 検収OKの稼働実績 × アサインの請求側条件 → 案件元ごとに明細集約 → 適格請求書PDF生成
// → 発行請求書DBへ「承認待ち」で登録。Gmail下書きはここでは作らない（billing:drafts が担当）。

const INVOICE_DIR = join(process.cwd(), 'data', 'invoices');

function previousMonth(base: Date): string {
  const d = new Date(base.getFullYear(), base.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function parseArgs(args: string[]): { month: string; dryRun: boolean } {
  const idx = args.findIndex((a) => a === '--month');
  const explicit = idx >= 0 ? args[idx + 1] : undefined;
  const month = explicit && /^\d{4}-\d{2}$/.test(explicit) ? explicit : previousMonth(new Date());
  return { month, dryRun: args.includes('--dry-run') };
}

function formatYen(amount: number): string {
  return `${Math.round(amount).toLocaleString('ja-JP')}円`;
}

function lastDayOfMonth(year: number, monthIndex: number): Date {
  // monthIndex は 0-indexed。翌月の0日目 = 当月末日
  return new Date(year, monthIndex + 1, 0);
}

// 支払期日 = 案件元の締め日（対象月の翌月に締める想定） + 支払サイト
function computePaymentDueDate(targetMonth: string, closingDay: string, paymentTerms: string): Date {
  const [y, m] = targetMonth.split('-').map(Number); // m: 1-12
  const closingYear = m === 12 ? y + 1 : y;
  const closingMonthIndex = m === 12 ? 0 : m; // 0-indexed（対象月の翌月）

  let closingDate: Date;
  if (closingDay === '15日') closingDate = new Date(closingYear, closingMonthIndex, 15);
  else if (closingDay === '20日') closingDate = new Date(closingYear, closingMonthIndex, 20);
  else closingDate = lastDayOfMonth(closingYear, closingMonthIndex);

  if (paymentTerms === '翌々月末') return lastDayOfMonth(closingDate.getFullYear(), closingDate.getMonth() + 2);
  if (paymentTerms === '30日') return new Date(closingDate.getTime() + 30 * 24 * 60 * 60 * 1000);
  if (paymentTerms === '60日') return new Date(closingDate.getTime() + 60 * 24 * 60 * 60 * 1000);
  return lastDayOfMonth(closingDate.getFullYear(), closingDate.getMonth() + 1); // 既定: 翌月末
}

function formatDateJp(date: Date): string {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

interface LineContext {
  line: InvoiceLine;
  cost: number;
}

// 稼働実績1件 → 請求明細1行（金額・粗利込み）を組み立てる
function buildLine(
  record: WorkRecord,
  assignment: Assignment,
  project: Project | undefined,
  member: Member | undefined,
): LineContext | undefined {
  const hours = record.workedHours;
  if (hours === undefined) {
    console.warn(`発行: 稼働時間が未確定のためスキップします（アサイン: ${assignment.name}）`);
    return undefined;
  }

  const settlement = calcSettlement(assignment.billing, hours, assignment.rounding);
  const projectName = project?.name ?? '(案件不明)';
  const memberName = member?.name ?? assignment.name;
  const description = `${projectName} / ${memberName}（${record.targetMonth}月分）`;

  let cost: number;
  if (member?.kind === 'employee') {
    const salary = member.monthlySalary ?? 0;
    const costFactor = member.costFactor ?? COMPANY_PROFILE.defaultEmployeeCostFactor;
    cost = salary * costFactor * (assignment.allocationPercent / 100);
  } else if (record.acceptedTotal !== undefined) {
    cost = Math.round(record.acceptedTotal / (1 + COMPANY_PROFILE.taxRate));
  } else if (assignment.payment) {
    cost = calcSettlement(assignment.payment, hours, assignment.rounding).amount;
  } else {
    cost = 0;
  }

  const grossProfit = settlement.amount - cost;

  return {
    line: {
      description,
      hours,
      amount: settlement.amount,
      note: settlement.note,
      grossProfit,
    },
    cost,
  };
}

function buildBodyMarkdown(draft: IssuedInvoiceDraft, contexts: LineContext[]): string {
  const lines: string[] = [];
  lines.push(`# 発行請求書 ${draft.invoiceNumber}`, '');
  lines.push('## 明細', '');
  for (const { line } of contexts) {
    lines.push(`- ${line.description}: ${line.hours ?? '-'}h / ${formatYen(line.amount)}（税抜）`);
    lines.push(`  計算根拠: ${line.note}`);
  }
  lines.push('', '## 集計', '');
  lines.push(`- 小計（税抜）: ${formatYen(draft.subtotal)}`);
  lines.push(`- 消費税（10%）: ${formatYen(draft.tax)}`);
  lines.push(`- 合計（税込）: ${formatYen(draft.total)}`);
  lines.push(`- 支払期日: ${formatDateJp(draft.paymentDueDate)}`);
  lines.push('', '## 粗利内訳', '');
  let totalGrossProfit = 0;
  for (const { line, cost } of contexts) {
    const gp = line.grossProfit ?? 0;
    totalGrossProfit += gp;
    lines.push(`- ${line.description}: 請求 ${formatYen(line.amount)} − コスト ${formatYen(cost)} = 粗利 ${formatYen(gp)}`);
  }
  lines.push(`- 合計粗利: ${formatYen(totalGrossProfit)}`);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const { month, dryRun } = parseArgs(process.argv.slice(2));
  console.log(`=== 請求書発行①作成バッチ（対象月: ${month}${dryRun ? '、--dry-run' : ''}） ===`);

  if (!process.env.NOTION_ISSUED_INVOICE_DB_ID) {
    console.warn('NOTION_ISSUED_INVOICE_DB_ID が未設定です。npm run engagements:setup を実行してください。処理を終了します。');
    return;
  }

  const [clients, members, projects, assignments, workRecords, existingInvoices] = await Promise.all([
    fetchClients(),
    fetchMembers(),
    fetchProjects(),
    fetchAssignments(),
    fetchWorkRecords(month),
    fetchIssuedInvoices({ targetMonth: month }),
  ]);

  const clientById = new Map(clients.map((c) => [c.id, c]));
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const memberById = new Map(members.map((m) => [m.id, m]));
  const assignmentById = new Map(assignments.map((a) => [a.id, a]));
  const existingByClientId = new Set(existingInvoices.map((inv) => inv.clientId).filter(Boolean));

  const okRecords = workRecords.filter((r) => r.status === '検収OK');
  const skippedRecords = workRecords.filter((r) => r.status === '差異あり' || r.status === '要確認');
  if (skippedRecords.length > 0) {
    console.log('\n--- 対象外（差異あり・要確認）のアサイン ---');
    for (const record of skippedRecords) {
      const assignment = record.assignmentId ? assignmentById.get(record.assignmentId) : undefined;
      console.warn(`⚠ ${assignment?.name ?? record.title}: ${record.status}（${record.diffNote || '詳細は稼働実績DB参照'}）`);
    }
  }

  // 案件元ごとに明細を集約
  const byClient = new Map<string, { client: Client; contexts: LineContext[] }>();
  for (const record of okRecords) {
    const assignment = record.assignmentId ? assignmentById.get(record.assignmentId) : undefined;
    if (!assignment) {
      console.warn(`発行: アサインが解決できないためスキップします（稼働実績: ${record.title}）`);
      continue;
    }
    const project = assignment.projectId ? projectById.get(assignment.projectId) : undefined;
    const client = project?.clientId ? clientById.get(project.clientId) : undefined;
    if (!client) {
      console.warn(`発行: 案件元が解決できないためスキップします（アサイン: ${assignment.name}）`);
      continue;
    }
    const member = assignment.memberId ? memberById.get(assignment.memberId) : undefined;
    const ctx = buildLine(record, assignment, project, member);
    if (!ctx) continue;

    const entry = byClient.get(client.id) ?? { client, contexts: [] };
    entry.contexts.push(ctx);
    byClient.set(client.id, entry);
  }

  if (byClient.size === 0) {
    console.log('\n発行対象の明細がありません。検収OKの稼働実績が無いか、案件元が解決できませんでした。');
    return;
  }

  await mkdir(INVOICE_DIR, { recursive: true }).catch((err: unknown) => {
    console.warn(`発行: 保存先ディレクトリの作成に失敗: ${String(err)}`);
  });

  let seq = (await countIssuedInvoicesInMonth(month)) + 1;
  const invoiceMonthKey = month.replace('-', '');

  interface ProfitRow {
    clientName: string;
    billing: number;
    cost: number;
    grossProfit: number;
  }
  const profitRows: ProfitRow[] = [];

  for (const { client, contexts } of byClient.values()) {
    if (existingByClientId.has(client.id)) {
      console.warn(`発行: ${client.name} は対象月（${month}）に既に発行済みのためスキップします（冪等）`);
      continue;
    }

    const subtotal = contexts.reduce((sum, c) => sum + c.line.amount, 0);
    const tax = Math.floor(subtotal * COMPANY_PROFILE.taxRate);
    const total = subtotal + tax;
    const invoiceNumber = `INV-${invoiceMonthKey}-${String(seq).padStart(2, '0')}`;
    seq += 1;

    const draft: IssuedInvoiceDraft = {
      invoiceNumber,
      clientId: client.id,
      clientName: client.name,
      targetMonth: month,
      lines: contexts.map((c) => c.line),
      subtotal,
      tax,
      total,
      paymentDueDate: computePaymentDueDate(month, client.closingDay, client.paymentTerms),
    };

    const pdf = await renderInvoicePdf(draft, client);
    const pdfPath = join(INVOICE_DIR, `${invoiceNumber}.pdf`);
    if (pdf) {
      try {
        await writeFile(pdfPath, pdf);
        console.log(`発行: PDF生成完了 → ${pdfPath}`);
      } catch (err) {
        console.warn(`発行: PDFのローカル保存に失敗: ${String(err)}`);
      }
    } else {
      console.warn(`発行: ${client.name} のPDF生成に失敗しました（フォント未配置の可能性）。Notion登録は続行します。`);
    }

    if (!dryRun) {
      try {
        const bodyMarkdown = buildBodyMarkdown(draft, contexts);
        const pageId = await saveIssuedInvoice(draft, pdfPath, bodyMarkdown);
        if (pdf) {
          const attached = await attachPdfToPage(pageId, pdf, `${invoiceNumber}.pdf`);
          if (!attached) {
            console.warn(`発行: ${client.name} のPDF添付に失敗（ローカルパス ${pdfPath} で継続）`);
          }
        }
        console.log(`発行: ${client.name} を「承認待ち」で登録しました（${invoiceNumber}）`);
      } catch (err) {
        console.error(`発行: ${client.name} のNotion登録に失敗: ${String(err)}`);
      }
    }

    const billing = subtotal;
    const cost = contexts.reduce((sum, c) => sum + c.cost, 0);
    const grossProfit = contexts.reduce((sum, c) => sum + (c.line.grossProfit ?? 0), 0);
    profitRows.push({ clientName: client.name, billing, cost, grossProfit });
  }

  console.log('\n--- 粗利レポート（税抜） ---');
  let totalBilling = 0;
  let totalCost = 0;
  let totalGrossProfit = 0;
  for (const row of profitRows) {
    const margin = row.billing > 0 ? (row.grossProfit / row.billing) * 100 : 0;
    console.log(
      `${row.clientName}: 請求 ${formatYen(row.billing)} / コスト ${formatYen(row.cost)} / 粗利 ${formatYen(row.grossProfit)}（粗利率 ${margin.toFixed(1)}%）`,
    );
    totalBilling += row.billing;
    totalCost += row.cost;
    totalGrossProfit += row.grossProfit;
  }
  const totalMargin = totalBilling > 0 ? (totalGrossProfit / totalBilling) * 100 : 0;
  console.log(
    `合計: 請求 ${formatYen(totalBilling)} / コスト ${formatYen(totalCost)} / 粗利 ${formatYen(totalGrossProfit)}（粗利率 ${totalMargin.toFixed(1)}%）`,
  );

  if (dryRun) {
    console.log(`\n--dry-run のため Notion登録は行っていません。PDFは ${INVOICE_DIR} で確認できます。`);
  } else {
    console.log(
      '\nNotionで請求書PDFを確認し、ステータスを「承認済み」に変更後、npm run billing:drafts を実行してください。',
    );
  }

  // 担当者への通知（NOTIFY_EMAILS 設定時のみ）: 承認依頼
  if (!dryRun && profitRows.length > 0) {
    await notifyByEmail(
      `【請求書承認依頼】${month}分 ${profitRows.length}社`,
      [
        `${month}分の請求書を${profitRows.length}社分作成し、Notionの発行請求書DBに「承認待ち」で登録しました。`,
        '',
        ...profitRows.map((r) => `- ${r.clientName}: 請求 ${formatYen(r.billing)}（税抜）`),
        '',
        'NotionでPDFを確認し、問題なければステータスを「承認済み」に変更してください。',
        'その後 npm run billing:drafts でGmail下書きが作成されます。',
      ].join('\n'),
    );
  }

  // クローンAIとのシナジー: 発行イベントをシグナルDBへ流す（任意設定）
  if (process.env.ENGAGEMENT_SIGNALS_ENABLED === 'true' && !dryRun && profitRows.length > 0) {
    try {
      await saveSignal({
        id: `billing_issue_${Date.now()}`,
        rawLogIds: [],
        timestamp: new Date(),
        category: 'decision',
        summary: `${month}分の請求書を${profitRows.length}社へ発行（請求合計 ${formatYen(totalBilling)}・粗利 ${formatYen(totalGrossProfit)}・粗利率 ${totalMargin.toFixed(1)}%）`,
        detail: profitRows
          .map((r) => `${r.clientName}: 請求 ${formatYen(r.billing)} / 粗利 ${formatYen(r.grossProfit)}`)
          .join('\n'),
        tags: ['案件管理', '請求'],
        importance: 5,
        relatedPeople: [],
      });
      console.log('シグナルDBへ発行イベントを記録しました');
    } catch (err) {
      console.warn(`シグナルDBへの記録に失敗（発行結果には影響なし）: ${String(err)}`);
    }
  }
}

main().catch((err) => {
  console.error(`請求書発行バッチ中にエラーが発生しました: ${String(err)}`);
  process.exitCode = 1;
});
