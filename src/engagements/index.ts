import '../env.js';
import { fetchClients, fetchMembers, fetchProjects, fetchAssignments } from './notionDb.js';
import type { Assignment, Member } from '../types/engagements.js';

// 案件管理マスタの一覧表示+整合性チェック（npm run engagements）
// Notion 上のデータ入力ミス（relation欠落・精算幅の逆転・逆ざや等）を検出する。

function checkAssignment(
  assignment: Assignment,
  member: Member | undefined,
  issues: string[],
): void {
  const label = `アサイン「${assignment.name || assignment.id}」`;

  if (!assignment.projectId) issues.push(`${label}: 案件が未設定`);
  if (!assignment.memberId) issues.push(`${label}: 要員が未設定`);

  for (const [side, terms] of [
    ['支払', assignment.payment],
    ['請求', assignment.billing],
  ] as const) {
    if (!terms) continue;
    if (
      terms.lowerHours !== undefined &&
      terms.upperHours !== undefined &&
      terms.lowerHours > terms.upperHours
    ) {
      issues.push(`${label}: ${side}精算幅の下限(${terms.lowerHours}h)が上限(${terms.upperHours}h)を超えている`);
    }
  }

  if (assignment.billing.rateType === 'monthly' && assignment.billing.monthlyRate === undefined) {
    issues.push(`${label}: 請求単価が未設定`);
  }
  if (assignment.billing.rateType === 'hourly' && assignment.billing.hourlyRate === undefined) {
    issues.push(`${label}: 請求方式が時給×実稼働なのに請求時給単価が未設定`);
  }

  if (member?.kind === 'employee') {
    if (assignment.payment) {
      issues.push(`${label}: 正社員のアサインに支払単価が入っている（コストは給与×係数で計算される）`);
    }
    if (member.monthlySalary === undefined) {
      issues.push(`${label}: 正社員「${member.name}」の月額給与が未設定 — 粗利が計算できない`);
    }
  } else if (member && !assignment.payment && assignment.status === '契約中') {
    issues.push(`${label}: 業務委託なのに支払単価が未設定`);
  }

  // 逆ざや検出（月額同士のときのみ単純比較できる）
  if (
    assignment.payment?.rateType === 'monthly' &&
    assignment.billing.rateType === 'monthly' &&
    assignment.payment.monthlyRate !== undefined &&
    assignment.billing.monthlyRate !== undefined &&
    assignment.billing.monthlyRate < assignment.payment.monthlyRate
  ) {
    issues.push(
      `${label}: 逆ざや — 請求単価(${assignment.billing.monthlyRate.toLocaleString()}円) < 支払単価(${assignment.payment.monthlyRate.toLocaleString()}円)`,
    );
  }
}

async function main(): Promise<void> {
  console.log('案件管理マスタを読み込み中...');
  const [clients, members, projects, assignments] = await Promise.all([
    fetchClients(),
    fetchMembers(),
    fetchProjects(),
    fetchAssignments(),
  ]);

  console.log('\n=== マスタ一覧 ===');
  console.log(`案件元: ${clients.length}社`);
  for (const c of clients) console.log(`  - ${c.name}（${c.status} / 締め:${c.closingDay} / サイト:${c.paymentTerms}）`);
  console.log(`要員: ${members.length}名`);
  for (const m of members) {
    const kind = m.kind === 'employee' ? '正社員' : '業務委託';
    console.log(`  - ${m.name}（${kind} / ${m.status} / スキル: ${m.skills.join(', ') || 'なし'}）`);
  }
  console.log(`案件: ${projects.length}件`);
  for (const p of projects) console.log(`  - ${p.name}（${p.status}）`);
  console.log(`アサイン: ${assignments.length}件`);
  for (const a of assignments) console.log(`  - ${a.name}（${a.status}）`);

  console.log('\n=== 整合性チェック ===');
  const issues: string[] = [];
  const memberById = new Map(members.map((m) => [m.id, m]));
  const clientById = new Map(clients.map((c) => [c.id, c]));

  for (const project of projects) {
    if (!project.clientId) issues.push(`案件「${project.name}」: 案件元が未設定`);
    else if (!clientById.has(project.clientId)) issues.push(`案件「${project.name}」: 案件元の参照先が見つからない`);
  }
  for (const assignment of assignments) {
    checkAssignment(assignment, assignment.memberId ? memberById.get(assignment.memberId) : undefined, issues);
  }
  for (const client of clients) {
    if (client.status === '取引中' && !client.billingEmail) {
      issues.push(`案件元「${client.name}」: 請求送付先メールが未設定 — 請求書下書きが作れない`);
    }
  }

  if (issues.length === 0) {
    console.log('問題は見つかりませんでした');
  } else {
    for (const issue of issues) console.log(`⚠ ${issue}`);
    console.log(`\n${issues.length}件の要修正項目があります`);
  }
}

main().catch((err) => {
  console.error(`マスタチェック中にエラー: ${String(err)}`);
  process.exitCode = 1;
});
