import '../env.js';
import {
  DB_IDS,
  fetchMembers,
  fetchAssignments,
  fetchProjects,
  fetchClients,
  fetchWorkRecords,
  fetchIssuedInvoices,
  fetchContracts,
} from '../engagements/notionDb.js';
import type { ContractRecord, IssuedInvoiceRecord } from '../engagements/notionDb.js';
import { createChildPage } from '../database/index.js';
import type { Member, Assignment, Client, WorkRecord, IssuedInvoiceStatus } from '../types/engagements.js';

// 月次運用ダッシュボード（読み取り専用、npm run billing:status）
// 「誰から届いた・届いてない」「どの案件元に発行した・してない」の全体把握と、
// 次に何をすべきかのガイドを日本語で表示する。

function previousMonth(base: Date): string {
  const d = new Date(base.getFullYear(), base.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function parseMonthArg(args: string[]): string {
  const idx = args.findIndex((a) => a === '--month');
  const explicit = idx >= 0 ? args[idx + 1] : undefined;
  if (explicit && /^\d{4}-\d{2}$/.test(explicit)) return explicit;
  return previousMonth(new Date());
}

// アサインの契約期間が対象月に重なるか（開始/終了未設定は無期限とみなす）
function overlapsMonth(period: { start?: Date; end?: Date }, month: string): boolean {
  const [y, m] = month.split('-').map(Number);
  const monthStart = new Date(y, m - 1, 1);
  const monthEnd = new Date(y, m, 0, 23, 59, 59);
  if (period.start && period.start > monthEnd) return false;
  if (period.end && period.end < monthStart) return false;
  return true;
}

function docTypeLabel(kind: Member['kind']): string {
  return kind === 'employee' ? '勤表' : '請求書';
}

function kindLabel(kind: Member['kind']): string {
  return kind === 'employee' ? '正社員' : '委託先';
}

interface ReceivedLine {
  text: string;
  missing: boolean;
  needsReview: boolean; // 差異あり・要確認
}

function buildReceivedLines(
  month: string,
  assignments: Assignment[],
  memberById: Map<string, Member>,
  workRecords: WorkRecord[],
): ReceivedLine[] {
  const recordsByAssignment = new Map<string, WorkRecord[]>();
  for (const record of workRecords) {
    if (!record.assignmentId) continue;
    const list = recordsByAssignment.get(record.assignmentId) ?? [];
    list.push(record);
    recordsByAssignment.set(record.assignmentId, list);
  }

  const lines: ReceivedLine[] = [];
  const targetAssignments = assignments.filter(
    (a) => a.status === '契約中' && overlapsMonth(a.period, month),
  );

  for (const assignment of targetAssignments) {
    const member = assignment.memberId ? memberById.get(assignment.memberId) : undefined;
    const memberName = member?.name ?? assignment.name;
    const kind = member?.kind ?? 'contractor_corp';
    const label = docTypeLabel(kind);
    const records = recordsByAssignment.get(assignment.id) ?? [];

    if (records.length === 0) {
      const email = member?.email ? ` — 連絡先: ${member.email}` : ' — 連絡先: 未登録';
      lines.push({
        text: `✗ ${memberName}さん（${kindLabel(kind)}）: ${label} 未着${email}`,
        missing: true,
        needsReview: false,
      });
      continue;
    }

    for (const record of records) {
      const isOk = record.status === '検収OK';
      const prefix = isOk ? '✓' : '⚠';
      lines.push({
        text: `${prefix} ${month} ${memberName}さん（${label}）: ${record.status}`,
        missing: false,
        needsReview: !isOk,
      });
    }
  }

  return lines;
}

function buildIssuedLines(
  clients: Client[],
  issuedInvoices: IssuedInvoiceRecord[],
): { lines: string[]; counts: Record<IssuedInvoiceStatus | '未発行', number> } {
  const invoiceByClientId = new Map<string, IssuedInvoiceRecord>();
  for (const inv of issuedInvoices) {
    if (inv.clientId) invoiceByClientId.set(inv.clientId, inv);
  }

  const counts: Record<IssuedInvoiceStatus | '未発行', number> = {
    未発行: 0,
    承認待ち: 0,
    承認済み: 0,
    下書き作成済: 0,
    送付済: 0,
    入金確認済: 0,
  };

  const lines: string[] = [];
  const activeClients = clients.filter((c) => c.status === '取引中');
  for (const client of activeClients) {
    const inv = invoiceByClientId.get(client.id);
    if (!inv) {
      lines.push(`✗ ${client.name}: 未発行`);
      counts.未発行++;
    } else {
      lines.push(`✓ ${client.name}: ${inv.status}`);
      counts[inv.status]++;
    }
  }

  return { lines, counts };
}

// 契約終了が近い（60日以内・期限切れ含む）契約書を抽出する
function buildRenewalAlerts(contracts: ContractRecord[], now: Date): string[] {
  const limit = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
  const alerts: string[] = [];
  for (const contract of contracts) {
    if (!contract.periodEnd) continue;
    if (contract.periodEnd > limit) continue;
    const endStr = contract.periodEnd.toISOString().slice(0, 10);
    const expired = contract.periodEnd < now;
    const renewal = contract.autoRenewal ? '（自動更新あり）' : '';
    alerts.push(
      `${expired ? '✗ 期限切れ' : '⚠ 終了間近'} ${contract.title}: ${endStr} まで${renewal}`,
    );
  }
  return alerts;
}

function buildNextActions(
  month: string,
  receivedMissing: number,
  receivedNeedsReview: number,
  unresolvedRecords: number,
  issuedCounts: Record<IssuedInvoiceStatus | '未発行', number>,
  renewalAlerts: string[],
): string[] {
  const actions: string[] = [];

  if (receivedMissing > 0) {
    actions.push(`未着が${receivedMissing}件あります。委託先・正社員に請求書/勤表の提出を催促してください。`);
  }
  if (receivedNeedsReview > 0) {
    actions.push(
      `差異あり・要確認が${receivedNeedsReview}件あります。Notionの稼働実績DBで内容を確認してください。`,
    );
  }
  if (unresolvedRecords > 0) {
    actions.push(
      `アサインに紐付かない受領書類が${unresolvedRecords}件あります。稼働実績DBでアサインを手動設定してください。`,
    );
  }
  if (issuedCounts.未発行 > 0) {
    actions.push(
      `未発行の案件元が${issuedCounts.未発行}社あります。検収OKが揃っていれば npm run billing:issue -- --month ${month} で請求書を作成してください。`,
    );
  }
  if (issuedCounts.承認待ち > 0) {
    actions.push(
      `承認待ちが${issuedCounts.承認待ち}件あります。Notionで請求書PDFを確認し、ステータスを「承認済み」に変更してください → その後 npm run billing:drafts。`,
    );
  }
  if (issuedCounts.承認済み > 0) {
    actions.push(`承認済みが${issuedCounts.承認済み}件あります。npm run billing:drafts で下書きを作成してください。`);
  }
  if (issuedCounts.下書き作成済 > 0) {
    actions.push(
      `下書き作成済みが${issuedCounts.下書き作成済}件あります。Gmailの下書きを確認して送信し、Notionのステータスを「送付済」に更新してください。`,
    );
  }
  if (issuedCounts.送付済 > 0) {
    actions.push(`送付済みが${issuedCounts.送付済}件あります。入金を確認したらステータスを「入金確認済み」に更新してください。`);
  }
  if (renewalAlerts.length > 0) {
    actions.push(`更新対応: 契約終了が近い契約書が${renewalAlerts.length}件あります。更新手続き（再契約・条件見直し）を確認してください。`);
  }

  if (actions.length === 0) {
    actions.push('対象月の受領・発行はすべて完了しています。');
  }

  return actions;
}

async function main(): Promise<void> {
  const month = parseMonthArg(process.argv.slice(2));

  if (
    !process.env.NOTION_MEMBER_DB_ID ||
    !process.env.NOTION_ASSIGNMENT_DB_ID ||
    !process.env.NOTION_WORK_RECORD_DB_ID
  ) {
    console.warn(
      '案件・請求管理のDB(NOTION_MEMBER_DB_ID/NOTION_ASSIGNMENT_DB_ID/NOTION_WORK_RECORD_DB_ID等)が未設定です。npm run engagements:setup を実行してください。縮退動作のため空の結果を表示します。',
    );
  }

  console.log(`=== 月次運用ダッシュボード（対象月: ${month}） ===`);

  const [members, assignments, , clients, workRecords, issuedInvoices, contracts] = await Promise.all([
    fetchMembers(),
    fetchAssignments(),
    fetchProjects(),
    fetchClients(),
    fetchWorkRecords(month),
    fetchIssuedInvoices({ targetMonth: month }),
    DB_IDS.contract ? fetchContracts() : Promise.resolve([]),
  ]);

  const memberById = new Map(members.map((m) => [m.id, m]));

  console.log('\n--- 受領状況（委託先の請求書・正社員の勤表） ---');
  const receivedLines = buildReceivedLines(month, assignments, memberById, workRecords);
  if (receivedLines.length === 0) {
    console.log('対象月に重なる契約中アサインがありません。');
  } else {
    for (const line of receivedLines) console.log(line.text);
  }
  const receivedMissing = receivedLines.filter((l) => l.missing).length;
  const receivedNeedsReview = receivedLines.filter((l) => l.needsReview).length;
  const unresolvedRecords = workRecords.filter((r) => !r.assignmentId).length;
  if (unresolvedRecords > 0) {
    console.log(`⚠ アサイン未解決の受領書類: ${unresolvedRecords}件（稼働実績DBを確認してください）`);
  }

  console.log('\n--- 発行状況（案件元への請求書） ---');
  const { lines: issuedLines, counts: issuedCounts } = buildIssuedLines(clients, issuedInvoices);
  if (issuedLines.length === 0) {
    console.log('取引中の案件元がありません。');
  } else {
    for (const line of issuedLines) console.log(line);
  }

  const renewalAlerts = buildRenewalAlerts(contracts, new Date());
  if (DB_IDS.contract && renewalAlerts.length > 0) {
    console.log('\n--- 契約更新アラート（終了60日以内） ---');
    for (const alert of renewalAlerts) console.log(alert);
  }

  console.log('\n--- 次のアクション ---');
  const actions = buildNextActions(
    month,
    receivedMissing,
    receivedNeedsReview,
    unresolvedRecords,
    issuedCounts,
    renewalAlerts,
  );
  for (const action of actions) console.log(`・${action}`);

  // 複数人運用: ダッシュボードをNotionページにも出力（親ページ設定時のみ）
  const parentPageId = process.env.NOTION_ENGAGEMENTS_PARENT_PAGE_ID;
  if (parentPageId) {
    const markdown = [
      '## 受領状況（委託先の請求書・正社員の勤表）',
      ...(receivedLines.length ? receivedLines.map((l) => `- ${l.text}`) : ['- 対象月に重なる契約中アサインがありません']),
      ...(unresolvedRecords > 0 ? [`- ⚠ アサイン未解決の受領書類: ${unresolvedRecords}件`] : []),
      '',
      '## 発行状況（案件元への請求書）',
      ...(issuedLines.length ? issuedLines.map((l) => `- ${l}`) : ['- 取引中の案件元がありません']),
      ...(renewalAlerts.length ? ['', '## 契約更新アラート（終了60日以内）', ...renewalAlerts.map((a) => `- ${a}`)] : []),
      '',
      '## 次のアクション',
      ...actions.map((a) => `- ${a}`),
    ].join('\n');
    try {
      const today = new Date().toISOString().slice(0, 10);
      await createChildPage(parentPageId, `月次ダッシュボード ${month}（${today}時点）`, markdown);
      console.log('\nNotionにダッシュボードページを作成しました');
    } catch (err) {
      console.warn(`Notionへのダッシュボード出力に失敗（コンソール表示は有効）: ${String(err)}`);
    }
  }
}

main().catch((err) => {
  console.error(`ダッシュボード表示中にエラーが発生しました: ${String(err)}`);
  process.exitCode = 1;
});
