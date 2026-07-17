import '../env.js';
import { fetchAssignments, fetchClients, fetchMembers, fetchProjects, memberKindLabel } from '../engagements/notionDb.js';
import { createChildPage } from '../database/index.js';
import { generateJson } from '../llm/index.js';
import { EXECUTIVE_PROFILE } from '../data/executiveProfile.js';
import { deriveAvailability } from './availability.js';
import type { Assignment, Client, ContractorAvailability, MatchProposal, Member, Project } from '../types/engagements.js';

// 稼働スケジュール導出＋最適案件マッチング提案のエントリ（npm run match）
// 終了間近（60日以内）のアサインは「もうすぐ空く要員」「後任が必要になる枠」として
// 先回りで提案対象に含める（ベンチ発生と後任不在の予防）。

const MATCHING_MONTHS = 6;
const RENEWAL_WINDOW_DAYS = 60;

const MATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memberName: { type: 'string' },
          projectName: { type: 'string' },
          direction: { type: 'string', enum: ['member_to_project', 'project_to_member'] },
          score: { type: 'number' },
          rationale: { type: 'string' },
          concerns: { type: 'array', items: { type: 'string' } },
        },
        required: ['memberName', 'projectName', 'direction', 'score', 'rationale', 'concerns'],
      },
    },
  },
  required: ['matches'],
} as const;

function formatDate(date?: Date): string {
  if (!date) return '未設定';
  return date.toISOString().slice(0, 10);
}

function formatAvailableMember(availability: ContractorAvailability, member?: Member): string {
  const skills = member?.skills.join('、') || '不明';
  const rateLine =
    availability.kind === 'employee'
      ? `月額給与: ${member?.monthlySalary !== undefined ? `${member.monthlySalary}円` : '未設定'}`
      : `単価目安: ${member?.monthlyRateHint !== undefined ? `${member.monthlyRateHint}円` : '未設定'}`;
  const monthsLine = availability.months.map((m) => `${m.month}: ${m.freePercent}%`).join(' / ');
  return [
    `- ${availability.memberName}（${memberKindLabel(availability.kind)}）`,
    `  スキル: ${skills}`,
    `  ${rateLine}`,
    `  月別空き%: ${monthsLine}`,
    `  次回空き日: ${formatDate(availability.nextAvailableDate)}`,
    `  空きメモ: ${availability.availabilityNote || 'なし'}`,
  ].join('\n');
}

function formatProject(project: Project, clientNameById: Map<string, string>): string {
  const clientName = project.clientId ? (clientNameById.get(project.clientId) ?? '不明') : '不明';
  const rateMin = project.rateRange.min !== undefined ? `${project.rateRange.min}円` : '未設定';
  const rateMax = project.rateRange.max !== undefined ? `${project.rateRange.max}円` : '未設定';
  return [
    `- ${project.name}（案件元: ${clientName}）`,
    `  必要スキル: ${project.requiredSkills.join('、') || 'なし'}`,
    `  単価レンジ: ${rateMin} 〜 ${rateMax}`,
    `  期間: ${formatDate(project.period.start)} 〜 ${formatDate(project.period.end)}`,
    `  必要人数: ${project.headcount ?? '未設定'}`,
    `  メモ: ${project.note || 'なし'}`,
  ].join('\n');
}

async function main(): Promise<void> {
  const [members, projects, assignments, clients] = await Promise.all([
    fetchMembers(),
    fetchProjects(),
    fetchAssignments(),
    fetchClients(),
  ]);

  const today = new Date();
  const availabilities = deriveAvailability(members, assignments, today, MATCHING_MONTHS);

  const availableMembers = availabilities.filter(
    (a) =>
      a.months.some((m) => m.freePercent > 0) ||
      a.nextAvailableDate !== undefined ||
      a.availabilityNote.trim() !== '',
  );
  const openProjects = projects.filter((p) => p.status === '提案中' || p.status === '募集中');

  const clientNameById = new Map<string, string>(clients.map((c: Client) => [c.id, c.name]));
  const memberById = new Map<string, Member>(members.map((m) => [m.id, m]));
  const projectById = new Map<string, Project>(projects.map((p) => [p.id, p]));

  // 終了間近（60日以内）の契約中アサイン = もうすぐ空く要員+後任が必要になる枠
  const renewalLimit = new Date(today.getTime() + RENEWAL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const endingAssignments = assignments.filter(
    (a: Assignment) => a.status === '契約中' && a.period.end !== undefined && a.period.end <= renewalLimit,
  );

  if (endingAssignments.length > 0) {
    console.log(`\n=== 終了間近のアサイン（${RENEWAL_WINDOW_DAYS}日以内・${endingAssignments.length}件） ===`);
    for (const assignment of endingAssignments) {
      const member = assignment.memberId ? memberById.get(assignment.memberId) : undefined;
      const project = assignment.projectId ? projectById.get(assignment.projectId) : undefined;
      console.log(
        `- ${assignment.name}: ${formatDate(assignment.period.end)} 終了予定（要員: ${member?.name ?? '未設定'} / 案件: ${project?.name ?? '未設定'}）`,
      );
    }
  }

  if (availableMembers.length === 0 || (openProjects.length === 0 && endingAssignments.length === 0)) {
    console.log(
      `マッチング対象がありません（空き要員: ${availableMembers.length}件 / 募集中・提案中案件: ${openProjects.length}件 / 終了間近アサイン: ${endingAssignments.length}件）。処理を終了します。`,
    );
    return;
  }

  const system = `あなたはSES・人材アサインの営業責任者です。空き要員と募集中案件の最適な組み合わせを提案してください。

観点:
(1) スキル一致
(2) 単価整合（要員の単価目安・給与と案件の単価レンジ）
(3) 期間整合
(4) 正社員（kind: employee）は空いていても給与が発生するため、正社員の空きを埋める提案を最優先する
(5) 懸念点（単価ギャップ・スキル不足）は concerns に正直に書く

経営者の価値観:
${EXECUTIVE_PROFILE.values.map((v) => `- ${v}`).join('\n')}`;

  const endingSection = endingAssignments.length
    ? `

# 終了間近のアサイン（${RENEWAL_WINDOW_DAYS}日以内に契約終了予定 — 先回り対応が必要）
${endingAssignments
        .map((a) => {
          const member = a.memberId ? memberById.get(a.memberId) : undefined;
          const project = a.projectId ? projectById.get(a.projectId) : undefined;
          return `- ${a.name}: ${formatDate(a.period.end)} 終了予定（要員: ${member?.name ?? '未設定'} / 案件: ${project?.name ?? '未設定'}）`;
        })
        .join('\n')}

終了間近のアサインについては、(a) 空く要員の次案件、(b) 空く枠の後任要員、の両方を優先的に提案してください。`
    : '';

  const user = `# 空き要員一覧
${availableMembers.map((a) => formatAvailableMember(a, memberById.get(a.memberId))).join('\n')}

# 募集中・提案中案件一覧
${openProjects.length ? openProjects.map((p) => formatProject(p, clientNameById)).join('\n') : '（現在なし）'}${endingSection}

上記の空き要員と案件について、要員→案件（member_to_project）・案件→要員（project_to_member）の両方向でマッチング提案をしてください。空き%はすでに計算済みの値なので、そのまま利用してください（再計算不要）。`;

  const result = await generateJson<{ matches: MatchProposal[] }>(system, user, MATCH_SCHEMA, { maxTokens: 16000 });
  const matches = [...result.matches].sort((a, b) => b.score - a.score);

  console.log(`\n=== 案件マッチング提案（${matches.length}件） ===\n`);
  for (const match of matches) {
    const directionLabel = match.direction === 'member_to_project' ? '要員→案件' : '案件→要員';
    const line = [
      `【${directionLabel}】${match.memberName} → ${match.projectName}（score: ${match.score}）`,
      `  理由: ${match.rationale}`,
      `  懸念点: ${match.concerns.length ? match.concerns.join('、') : 'なし'}`,
    ].join('\n');
    console.log(line + '\n');
  }

  const parentPageId = process.env.NOTION_ENGAGEMENTS_PARENT_PAGE_ID ?? '';
  if (!parentPageId) {
    console.warn('NOTION_ENGAGEMENTS_PARENT_PAGE_ID が未設定のため、Notionへのレポート出力はスキップします。');
    return;
  }

  const dateLabel = today.toISOString().slice(0, 10);
  const markdown = [
    `# 案件マッチング提案 ${dateLabel}`,
    '',
    `対象: 空き要員 ${availableMembers.length}件 / 募集中・提案中案件 ${openProjects.length}件`,
    '',
    ...matches.map((match) => {
      const directionLabel = match.direction === 'member_to_project' ? '要員→案件' : '案件→要員';
      return [
        `## [${directionLabel}] ${match.memberName} → ${match.projectName}（score: ${match.score}）`,
        `- 理由: ${match.rationale}`,
        `- 懸念点: ${match.concerns.length ? match.concerns.join('、') : 'なし'}`,
      ].join('\n');
    }),
  ].join('\n');

  try {
    await createChildPage(parentPageId, `案件マッチング提案 ${dateLabel}`, markdown);
    console.log('Notionにマッチング提案ページを作成しました。');
  } catch (err) {
    console.warn(`Notionへのレポート作成に失敗しました: ${String(err)}`);
  }
}

main().catch((err) => {
  console.error('マッチング処理でエラーが発生しました:', err);
  process.exitCode = 1;
});
