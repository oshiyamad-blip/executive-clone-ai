import '../env.js';
import {
  fetchMembers,
  fetchAssignments,
  fetchProjects,
  fetchClients,
  fetchWorkRecords,
  fetchIssuedInvoices,
  DB_IDS,
} from '../engagements/notionDb.js';
import { createChildPage } from '../database/index.js';
import { COMPANY_PROFILE } from '../data/companyProfile.js';
import type { Assignment, Member, WorkRecord } from '../types/engagements.js';
import type { IssuedInvoiceRecord } from '../engagements/notionDb.js';

// 月次経営レポート（npm run billing:report）
// 発行請求書DB・稼働実績DBに溜まったデータから、売上・粗利・稼働率の推移と
// 収益性ランキングを集計する。集計はすべてコード側で行い、LLMは使わない。

function monthsBack(count: number): string[] {
  const list: string[] = [];
  const now = new Date();
  for (let i = count; i >= 1; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    list.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return list;
}

function parseMonthsArg(args: string[]): number {
  const idx = args.findIndex((a) => a === '--months');
  const value = idx >= 0 ? Number(args[idx + 1]) : NaN;
  return Number.isInteger(value) && value > 0 && value <= 24 ? value : 6;
}

function overlapsMonth(period: { start?: Date; end?: Date }, month: string): boolean {
  const [y, m] = month.split('-').map(Number);
  const monthStart = new Date(y, m - 1, 1);
  const monthEnd = new Date(y, m, 0, 23, 59, 59);
  if (period.start && period.start > monthEnd) return false;
  if (period.end && period.end < monthStart) return false;
  return true;
}

function yen(n: number): string {
  return `${Math.round(n).toLocaleString()}円`;
}

function percent(n: number): string {
  return `${n.toFixed(1)}%`;
}

// 正社員の月次コスト（給与×係数×稼働率）
function employeeCost(member: Member, assignment: Assignment): number {
  const salary = member.monthlySalary ?? 0;
  const factor = member.costFactor ?? COMPANY_PROFILE.defaultEmployeeCostFactor;
  return Math.floor(salary * factor * (assignment.allocationPercent / 100));
}

interface MonthlyFigures {
  month: string;
  revenue: number; // 売上（税抜）
  cost: number;
  grossProfit: number;
  utilization: number; // 稼働率（%）
  invoiceCount: number;
}

function buildMonthlyFigures(
  month: string,
  invoices: IssuedInvoiceRecord[],
  workRecords: WorkRecord[],
  assignments: Assignment[],
  memberById: Map<string, Member>,
): MonthlyFigures {
  const revenue = invoices.reduce(
    (sum, inv) => sum + (inv.subtotal ?? (inv.total !== undefined ? Math.floor(inv.total / 1.1) : 0)),
    0,
  );

  // コスト: 業務委託=検収金額（税抜換算）、正社員=給与×係数×稼働率
  let cost = 0;
  const countedEmployeeAssignments = new Set<string>();
  for (const record of workRecords) {
    if (record.docType === 'invoice') {
      const accepted = record.acceptedTotal !== undefined ? Math.floor(record.acceptedTotal / 1.1) : undefined;
      cost += accepted ?? record.billedSubtotal ?? 0;
    } else if (record.assignmentId) {
      countedEmployeeAssignments.add(record.assignmentId);
    }
  }
  for (const assignment of assignments) {
    if (!countedEmployeeAssignments.has(assignment.id)) continue;
    const member = assignment.memberId ? memberById.get(assignment.memberId) : undefined;
    if (member?.kind === 'employee') cost += employeeCost(member, assignment);
  }

  // 稼働率: 契約中×当月重複アサインの稼働率合計 ÷（取引終了以外の要員数×100）
  const activeMembers = [...memberById.values()].filter((m) => m.status !== '取引終了');
  const allocated = assignments
    .filter((a) => a.status === '契約中' && overlapsMonth(a.period, month))
    .reduce((sum, a) => sum + Math.min(a.allocationPercent, 100), 0);
  const utilization = activeMembers.length > 0 ? (allocated / (activeMembers.length * 100)) * 100 : 0;

  return {
    month,
    revenue,
    cost,
    grossProfit: revenue - cost,
    utilization: Math.min(utilization, 100),
    invoiceCount: invoices.length,
  };
}

async function main(): Promise<void> {
  const monthCount = parseMonthsArg(process.argv.slice(2));
  const months = monthsBack(monthCount);

  if (!DB_IDS.issuedInvoice || !DB_IDS.workRecord) {
    console.warn(
      'NOTION_ISSUED_INVOICE_DB_ID / NOTION_WORK_RECORD_DB_ID が未設定です。データが溜まってから実行してください。',
    );
    return;
  }

  console.log(`=== 月次経営レポート（直近${monthCount}ヶ月: ${months[0]} 〜 ${months[months.length - 1]}） ===`);

  const [members, assignments, projects, clients] = await Promise.all([
    fetchMembers(),
    fetchAssignments(),
    fetchProjects(),
    fetchClients(),
  ]);
  const memberById = new Map(members.map((m) => [m.id, m]));
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const clientById = new Map(clients.map((c) => [c.id, c]));

  const figures: MonthlyFigures[] = [];
  const allInvoices: IssuedInvoiceRecord[] = [];
  for (const month of months) {
    const [invoices, workRecords] = await Promise.all([
      fetchIssuedInvoices({ targetMonth: month }),
      fetchWorkRecords(month),
    ]);
    allInvoices.push(...invoices);
    figures.push(buildMonthlyFigures(month, invoices, workRecords, assignments, memberById));
  }

  const lines: string[] = [];
  lines.push('## 月次推移（税抜）');
  lines.push('');
  lines.push('| 月 | 売上 | コスト | 粗利 | 粗利率 | 稼働率 | 請求書数 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const f of figures) {
    const margin = f.revenue > 0 ? (f.grossProfit / f.revenue) * 100 : 0;
    lines.push(
      `| ${f.month} | ${yen(f.revenue)} | ${yen(f.cost)} | ${yen(f.grossProfit)} | ${percent(margin)} | ${percent(f.utilization)} | ${f.invoiceCount} |`,
    );
  }

  // 案件元別の売上ランキング（期間合計）
  const revenueByClient = new Map<string, number>();
  for (const inv of allInvoices) {
    if (!inv.clientId) continue;
    const subtotal = inv.subtotal ?? (inv.total !== undefined ? Math.floor(inv.total / 1.1) : 0);
    revenueByClient.set(inv.clientId, (revenueByClient.get(inv.clientId) ?? 0) + subtotal);
  }
  const clientRanking = [...revenueByClient.entries()]
    .map(([clientId, revenue]) => ({ name: clientById.get(clientId)?.name ?? clientId, revenue }))
    .sort((a, b) => b.revenue - a.revenue);

  lines.push('');
  lines.push('## 案件元別 売上（期間合計・税抜）');
  lines.push('');
  if (clientRanking.length === 0) {
    lines.push('発行請求書のデータがまだありません。');
  } else {
    for (const [i, row] of clientRanking.entries()) {
      lines.push(`${i + 1}. ${row.name}: ${yen(row.revenue)}`);
    }
  }

  // アサイン別の理論粗利（契約中のみ、月額ベース）
  interface AssignmentProfit {
    name: string;
    clientName: string;
    revenue: number;
    cost: number;
  }
  const assignmentProfits: AssignmentProfit[] = [];
  for (const assignment of assignments) {
    if (assignment.status !== '契約中') continue;
    if (assignment.billing.rateType !== 'monthly' || assignment.billing.monthlyRate === undefined) continue;
    const member = assignment.memberId ? memberById.get(assignment.memberId) : undefined;
    const cost =
      member?.kind === 'employee'
        ? employeeCost(member, assignment)
        : (assignment.payment?.monthlyRate ?? 0);
    if (cost === 0) continue;
    const project = assignment.projectId ? projectById.get(assignment.projectId) : undefined;
    const clientName = project?.clientId ? (clientById.get(project.clientId)?.name ?? '') : '';
    assignmentProfits.push({ name: assignment.name, clientName, revenue: assignment.billing.monthlyRate, cost });
  }
  assignmentProfits.sort((a, b) => (b.revenue - b.cost) - (a.revenue - a.cost));

  lines.push('');
  lines.push('## アサイン別 理論粗利（契約中・月額ベース）');
  lines.push('');
  if (assignmentProfits.length === 0) {
    lines.push('月額契約中のアサインがまだありません。');
  } else {
    for (const row of assignmentProfits) {
      const profit = row.revenue - row.cost;
      const margin = (profit / row.revenue) * 100;
      const client = row.clientName ? `（${row.clientName}）` : '';
      lines.push(`- ${row.name}${client}: 請求 ${yen(row.revenue)} − コスト ${yen(row.cost)} = 粗利 ${yen(profit)}（${percent(margin)}）`);
    }
    const lowMargin = assignmentProfits.filter((r) => ((r.revenue - r.cost) / r.revenue) * 100 < 15);
    if (lowMargin.length > 0) {
      lines.push('');
      lines.push(`⚠ 粗利率15%未満のアサインが${lowMargin.length}件あります。契約更新時の単価交渉を検討してください。`);
    }
  }

  const markdown = lines.join('\n');
  console.log(`\n${markdown}`);

  const parentPageId = process.env.NOTION_ENGAGEMENTS_PARENT_PAGE_ID;
  if (parentPageId) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      await createChildPage(parentPageId, `月次経営レポート ${today}`, markdown);
      console.log('\nNotionにレポートページを作成しました');
    } catch (err) {
      console.warn(`Notionへのレポート出力に失敗（コンソール出力は有効）: ${String(err)}`);
    }
  } else {
    console.log('\nNOTION_ENGAGEMENTS_PARENT_PAGE_ID を設定するとNotionにもレポートを出力します');
  }
}

main().catch((err) => {
  console.error(`経営レポート作成中にエラー: ${String(err)}`);
  process.exitCode = 1;
});
