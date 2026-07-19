import '../env.js';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'fs';
import { extname, join } from 'path';
import { generateJson } from '../llm/index.js';
import {
  fetchClients,
  fetchMembers,
  fetchProjects,
  fetchAssignments,
  saveClient,
  saveMember,
  saveProject,
  saveAssignment,
  memberKindLabel,
  contractTypeLabel,
} from './notionDb.js';
import type { Client, Member, MemberKind, Project, Assignment, ContractType, RateTerms, Rounding } from '../types/engagements.js';

// 既存マスタデータ（Excel/スプレッドシート等）のフォルダ・ドロップ取込（npm run engagements:import）
//
// 誤登録防止のデザイン: 既定はプレビューのみ。--apply を付けた時だけ Notion へ書き込む。
// 使い方:
//   npm run engagements:import              # プレビュー（書き込みなし）
//   npm run engagements:import -- --apply   # 実際に登録する

const SUPPORTED_EXT = new Set(['.csv', '.tsv', '.txt', '.md']);
const EXCEL_EXT = new Set(['.xlsx', '.xls']);

// --- LLM抽出結果の型（Notionドメイン型から id/relationId を除き、relationは名前文字列で受ける）---

interface ImportRateTerms {
  rateType: 'monthly' | 'hourly' | null;
  monthlyRate: number | null;
  lowerHours: number | null;
  upperHours: number | null;
  overtimeRate: number | null;
  deductionRate: number | null;
  hourlyRate: number | null;
}

interface ImportClient {
  name: string;
  contactPerson: string | null;
  billingEmail: string | null;
  closingDay: string | null;
  paymentTerms: string | null;
  status: string | null;
  note: string | null;
}

interface ImportMember {
  name: string;
  kind: MemberKind | null;
  email: string | null;
  skills: string[];
  status: string | null;
  invoiceRegistrationNumber: string | null;
  bankAccount: string | null;
  monthlyRateHint: number | null;
  monthlySalary: number | null;
  costFactor: number | null;
}

interface ImportProject {
  name: string;
  clientName: string | null;
  status: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  requiredSkills: string[];
  rateMin: number | null;
  rateMax: number | null;
  headcount: number | null;
  note: string | null;
}

interface ImportAssignment {
  name: string;
  projectName: string | null;
  memberName: string | null;
  contractType: ContractType | null;
  periodStart: string | null;
  periodEnd: string | null;
  allocationPercent: number | null;
  payment: ImportRateTerms | null;
  billing: ImportRateTerms | null;
  rounding: Rounding | null;
  status: string | null;
}

interface ImportPayload {
  clients: ImportClient[];
  members: ImportMember[];
  projects: ImportProject[];
  assignments: ImportAssignment[];
}

// --- JSON Schema（構造化出力）---

const RATE_TERMS_PROPERTIES = {
  rateType: { type: ['string', 'null'], enum: ['monthly', 'hourly', null], description: '精算方式。月額+精算幅=monthly、時給×実稼働=hourly' },
  monthlyRate: { type: ['number', 'null'], description: '月額単価（税抜・円）' },
  lowerHours: { type: ['number', 'null'], description: '精算幅下限（h）' },
  upperHours: { type: ['number', 'null'], description: '精算幅上限（h）' },
  overtimeRate: { type: ['number', 'null'], description: '超過単価（円/h）' },
  deductionRate: { type: ['number', 'null'], description: '控除単価（円/h）' },
  hourlyRate: { type: ['number', 'null'], description: '時給単価（税抜・円）' },
} as const;

const RATE_TERMS_SCHEMA = {
  type: ['object', 'null'],
  additionalProperties: false,
  properties: RATE_TERMS_PROPERTIES,
  required: Object.keys(RATE_TERMS_PROPERTIES),
} as const;

const IMPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['clients', 'members', 'projects', 'assignments'],
  properties: {
    clients: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'contactPerson', 'billingEmail', 'closingDay', 'paymentTerms', 'status', 'note'],
        properties: {
          name: { type: 'string', description: '会社名（必須）' },
          contactPerson: { type: ['string', 'null'], description: '担当者名' },
          billingEmail: { type: ['string', 'null'], description: '請求送付先メールアドレス' },
          closingDay: { type: ['string', 'null'], enum: ['月末', '15日', '20日', null], description: '締め日' },
          paymentTerms: {
            type: ['string', 'null'],
            enum: ['翌月末', '翌々月末', '30日', '60日', null],
            description: '支払サイト',
          },
          status: { type: ['string', 'null'], enum: ['取引中', '休眠', '終了', null], description: 'ステータス' },
          note: { type: ['string', 'null'], description: 'メモ' },
        },
      },
    },
    members: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'name', 'kind', 'email', 'skills', 'status',
          'invoiceRegistrationNumber', 'bankAccount', 'monthlyRateHint', 'monthlySalary', 'costFactor',
        ],
        properties: {
          name: { type: 'string', description: '氏名・会社名（必須）' },
          kind: {
            type: ['string', 'null'],
            enum: ['contractor_corp', 'contractor_individual', 'employee', null],
            description: '区分。業務委託(法人)=contractor_corp、業務委託(個人事業主)=contractor_individual、自社正社員=employee',
          },
          email: { type: ['string', 'null'], description: 'メールアドレス（請求書・勤表メールの照合キー）' },
          skills: { type: 'array', items: { type: 'string' }, description: 'スキル一覧（無ければ空配列）' },
          status: { type: ['string', 'null'], enum: ['稼働中', '待機', '取引終了', null], description: 'ステータス' },
          invoiceRegistrationNumber: {
            type: ['string', 'null'],
            description: 'インボイス登録番号（T+13桁）。業務委託のみ。免税事業者はnull',
          },
          bankAccount: { type: ['string', 'null'], description: '振込先口座。業務委託のみ' },
          monthlyRateHint: { type: ['number', 'null'], description: '単価目安（円）。業務委託のみ' },
          monthlySalary: { type: ['number', 'null'], description: '月額給与（円）。正社員のみ' },
          costFactor: { type: ['number', 'null'], description: 'コスト係数。正社員のみ（不明ならnull）' },
        },
      },
    },
    projects: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'name', 'clientName', 'status', 'periodStart', 'periodEnd',
          'requiredSkills', 'rateMin', 'rateMax', 'headcount', 'note',
        ],
        properties: {
          name: { type: 'string', description: '案件名（必須）' },
          clientName: { type: ['string', 'null'], description: '案件元の会社名（clients内のnameと一致させる）' },
          status: {
            type: ['string', 'null'],
            enum: ['提案中', '募集中', '進行中', '終了', '失注', null],
            description: 'ステータス',
          },
          periodStart: { type: ['string', 'null'], description: '開始日。YYYY-MM-DD形式' },
          periodEnd: { type: ['string', 'null'], description: '終了日。YYYY-MM-DD形式' },
          requiredSkills: { type: 'array', items: { type: 'string' }, description: '必要スキル一覧' },
          rateMin: { type: ['number', 'null'], description: '単価下限（月額・円）' },
          rateMax: { type: ['number', 'null'], description: '単価上限（月額・円）' },
          headcount: { type: ['number', 'null'], description: '必要人数' },
          note: { type: ['string', 'null'], description: 'メモ' },
        },
      },
    },
    assignments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'name', 'projectName', 'memberName', 'contractType', 'periodStart', 'periodEnd',
          'allocationPercent', 'payment', 'billing', 'rounding', 'status',
        ],
        properties: {
          name: {
            type: 'string',
            description: 'アサイン名（必須）。明記が無ければ「案件名 要員名」の形式で組み立ててよい',
          },
          projectName: { type: ['string', 'null'], description: '案件名（projects内のnameと一致させる）' },
          memberName: { type: ['string', 'null'], description: '要員名（members内のnameと一致させる）' },
          contractType: {
            type: ['string', 'null'],
            enum: ['outsourcing', 'quasi_mandate', 'dispatch', null],
            description: '契約形態。業務委託=outsourcing、準委任(SES)=quasi_mandate、派遣=dispatch',
          },
          periodStart: { type: ['string', 'null'], description: '契約開始日。YYYY-MM-DD形式' },
          periodEnd: { type: ['string', 'null'], description: '契約終了日。YYYY-MM-DD形式' },
          allocationPercent: { type: ['number', 'null'], description: '稼働率（%）。不明なら null（既定100として扱う）' },
          payment: {
            ...RATE_TERMS_SCHEMA,
            description: '委託先への支払条件（業務委託のみ）。正社員アサインはnull',
          },
          billing: {
            ...RATE_TERMS_SCHEMA,
            description: '案件元への請求条件',
          },
          rounding: {
            type: ['string', 'null'],
            enum: ['floor', 'round', 'ceil', null],
            description: '端数処理。切り捨て=floor、四捨五入=round、切り上げ=ceil。不明ならnull（既定floor）',
          },
          status: { type: ['string', 'null'], enum: ['契約中', '終了', '更新待ち', null], description: 'ステータス' },
        },
      },
    },
  },
} as const;

const IMPORT_SYSTEM = `あなたはSES企業のデータ移行担当です。テキスト/CSVから案件元（クライアント企業）・要員（業務委託先/正社員）・案件・アサイン（契約）を抽出してください。
判別できる情報だけを抽出し、推測で埋めないでください。金額は数値（円）、日付はYYYY-MM-DD形式で出力してください。

補足:
- 1つのファイルに複数の種類のデータ（案件元一覧と要員一覧など）が混在していても構いません。該当しない種類は空配列にしてください。
- clients/members/projects/assignments 間の関連付けは、名前の文字列（clientName/projectName/memberName）で表現してください。同一ファイル内の名前は完全一致させてください。
- 列挙値（区分・契約形態・締め日・支払サイト・ステータス・端数処理等）は指定のenumのいずれかに正規化してください。判断できなければ null のままにしてください（コード側の既定値で補います）。
- assignments の billing（請求条件）・payment（支払条件）は、金額・時間の記載が無い項目は null にしてください。rateType が読み取れない場合も null にしてください。
- アサインの name は明記が無ければ「案件名 要員名」の形式で組み立てて構いません（これは推測ではなく単なる命名です）。`;

function buildUserPrompt(fileName: string, content: string): string {
  return `以下は移行元データファイル「${fileName}」の内容です。指定のJSON Schemaに従って構造化してください。\n\n---\n${content}\n---`;
}

// --- ヘルパー ---

function parseDate(value: string | null): Date | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function toRateTerms(r: ImportRateTerms | null, fallbackRateType: RateTerms['rateType']): RateTerms {
  return {
    rateType: r?.rateType ?? fallbackRateType,
    monthlyRate: r?.monthlyRate ?? undefined,
    lowerHours: r?.lowerHours ?? undefined,
    upperHours: r?.upperHours ?? undefined,
    overtimeRate: r?.overtimeRate ?? undefined,
    deductionRate: r?.deductionRate ?? undefined,
    hourlyRate: r?.hourlyRate ?? undefined,
  };
}

function yen(n: number | null | undefined): string {
  return n !== null && n !== undefined ? `${n.toLocaleString()}円` : '未設定';
}

// --- 取込本体 ---

interface ImportCounters {
  clientsNew: number;
  clientsSkipped: number;
  membersNew: number;
  membersSkipped: number;
  projectsNew: number;
  projectsSkipped: number;
  assignmentsNew: number;
  assignmentsSkipped: number;
}

async function processFile(
  fileName: string,
  filePath: string,
  apply: boolean,
  clientIdByName: Map<string, string>,
  memberIdByName: Map<string, string>,
  projectIdByName: Map<string, string>,
  assignmentNames: Set<string>,
  counters: ImportCounters,
): Promise<boolean> {
  console.log(`\n--- ${fileName} ---`);
  let payload: ImportPayload;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    payload = await generateJson<ImportPayload>(IMPORT_SYSTEM, buildUserPrompt(fileName, raw), IMPORT_SCHEMA, {
      maxTokens: 16000,
    });
  } catch (err) {
    console.error(`  抽出に失敗したためこのファイルはスキップします: ${String(err)}`);
    return false;
  }

  // 案件元
  for (const c of payload.clients) {
    const name = c.name?.trim();
    if (!name) continue;
    if (clientIdByName.has(name)) {
      console.log(`  案件元: ${name} → 既存のためスキップ`);
      counters.clientsSkipped++;
      continue;
    }
    console.log(`  案件元: ${name}（締め:${c.closingDay ?? '未設定'} / サイト:${c.paymentTerms ?? '未設定'}）`);
    counters.clientsNew++;
    if (apply) {
      const client: Omit<Client, 'id'> = {
        name,
        contactPerson: c.contactPerson ?? '',
        billingEmail: c.billingEmail ?? '',
        closingDay: c.closingDay ?? '月末',
        paymentTerms: c.paymentTerms ?? '翌月末',
        status: c.status ?? '取引中',
        note: c.note ?? '',
      };
      try {
        const id = await saveClient(client);
        clientIdByName.set(name, id);
      } catch (err) {
        console.error(`  案件元「${name}」のNotion登録に失敗（残りの取込は継続）: ${String(err)}`);
        counters.clientsNew--;
      }
    } else {
      clientIdByName.set(name, `__preview__:${name}`);
    }
  }

  // 要員
  for (const m of payload.members) {
    const name = m.name?.trim();
    if (!name) continue;
    if (memberIdByName.has(name)) {
      console.log(`  要員: ${name} → 既存のためスキップ`);
      counters.membersSkipped++;
      continue;
    }
    const kind: MemberKind = m.kind ?? 'contractor_corp';
    console.log(`  要員: ${name}（${memberKindLabel(kind)}${m.email ? ` / ${m.email}` : ''}）`);
    counters.membersNew++;
    if (apply) {
      const member: Omit<Member, 'id'> = {
        name,
        kind,
        email: m.email ?? '',
        skills: m.skills ?? [],
        availabilityNote: '',
        status: m.status ?? '稼働中',
        invoiceRegistrationNumber: m.invoiceRegistrationNumber ?? undefined,
        bankAccount: m.bankAccount ?? undefined,
        monthlyRateHint: m.monthlyRateHint ?? undefined,
        monthlySalary: m.monthlySalary ?? undefined,
        costFactor: m.costFactor ?? undefined,
      };
      try {
        const id = await saveMember(member);
        memberIdByName.set(name, id);
      } catch (err) {
        console.error(`  要員「${name}」のNotion登録に失敗（残りの取込は継続）: ${String(err)}`);
        counters.membersNew--;
      }
    } else {
      memberIdByName.set(name, `__preview__:${name}`);
    }
  }

  // 案件
  for (const p of payload.projects) {
    const name = p.name?.trim();
    if (!name) continue;
    if (projectIdByName.has(name)) {
      console.log(`  案件: ${name} → 既存のためスキップ`);
      counters.projectsSkipped++;
      continue;
    }
    let clientId: string | undefined;
    if (p.clientName) {
      clientId = clientIdByName.get(p.clientName);
      if (!clientId) console.warn(`  ⚠ 案件「${name}」: 案件元「${p.clientName}」が見つからないため関連付けなしで登録します`);
    }
    console.log(`  案件: ${name}（案件元:${p.clientName ?? '未設定'} / ステータス:${p.status ?? '未設定'}）`);
    counters.projectsNew++;
    if (apply) {
      const project: Omit<Project, 'id'> = {
        name,
        clientId: clientId && !clientId.startsWith('__preview__:') ? clientId : undefined,
        status: p.status ?? '提案中',
        period: { start: parseDate(p.periodStart), end: parseDate(p.periodEnd) },
        requiredSkills: p.requiredSkills ?? [],
        rateRange: { min: p.rateMin ?? undefined, max: p.rateMax ?? undefined },
        headcount: p.headcount ?? undefined,
        note: p.note ?? '',
      };
      try {
        const id = await saveProject(project);
        projectIdByName.set(name, id);
      } catch (err) {
        console.error(`  案件「${name}」のNotion登録に失敗（残りの取込は継続）: ${String(err)}`);
        counters.projectsNew--;
      }
    } else {
      projectIdByName.set(name, `__preview__:${name}`);
    }
  }

  // アサイン
  for (const a of payload.assignments) {
    const name = a.name?.trim();
    if (!name) continue;
    if (assignmentNames.has(name)) {
      console.log(`  アサイン: ${name} → 既存のためスキップ`);
      counters.assignmentsSkipped++;
      continue;
    }
    let projectId: string | undefined;
    if (a.projectName) {
      projectId = projectIdByName.get(a.projectName);
      if (!projectId) console.warn(`  ⚠ アサイン「${name}」: 案件「${a.projectName}」が見つからないため関連付けなしで登録します`);
    }
    let memberId: string | undefined;
    if (a.memberName) {
      memberId = memberIdByName.get(a.memberName);
      if (!memberId) console.warn(`  ⚠ アサイン「${name}」: 要員「${a.memberName}」が見つからないため関連付けなしで登録します`);
    }
    const contractType: ContractType = a.contractType ?? 'outsourcing';
    console.log(
      `  アサイン: ${name}（${contractTypeLabel(contractType)} / 案件:${a.projectName ?? '未設定'} / 要員:${a.memberName ?? '未設定'} / 請求:${yen(a.billing?.monthlyRate ?? a.billing?.hourlyRate)}）`,
    );
    counters.assignmentsNew++;
    if (apply) {
      const assignment: Omit<Assignment, 'id'> = {
        name,
        projectId: projectId && !projectId.startsWith('__preview__:') ? projectId : undefined,
        memberId: memberId && !memberId.startsWith('__preview__:') ? memberId : undefined,
        contractType,
        period: { start: parseDate(a.periodStart), end: parseDate(a.periodEnd) },
        allocationPercent: a.allocationPercent ?? 100,
        payment: a.payment ? toRateTerms(a.payment, 'monthly') : undefined,
        billing: toRateTerms(a.billing, 'monthly'),
        rounding: a.rounding ?? 'floor',
        status: a.status ?? '契約中',
      };
      try {
        await saveAssignment(assignment);
      } catch (err) {
        console.error(`  アサイン「${name}」のNotion登録に失敗（残りの取込は継続）: ${String(err)}`);
        counters.assignmentsNew--;
      }
      assignmentNames.add(name);
    } else {
      assignmentNames.add(name);
    }
  }

  return true;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const inboxDir = process.env.ENGAGEMENTS_IMPORT_DIR ?? './engagements-import';

  if (!existsSync(inboxDir)) {
    mkdirSync(inboxDir, { recursive: true });
    console.log(`受け皿フォルダを作成しました: ${inboxDir}`);
    console.log('既存のExcel/スプレッドシートをCSVエクスポートしてこのフォルダに置き、再度実行してください（対応拡張子: .csv/.tsv/.txt/.md）。');
    return;
  }

  const allFiles = readdirSync(inboxDir, { withFileTypes: true })
    .filter((f) => f.isFile())
    .map((f) => f.name);

  const excelFiles = allFiles.filter((f) => EXCEL_EXT.has(extname(f).toLowerCase()));
  if (excelFiles.length) {
    console.log(`Excelファイルが見つかりました（${excelFiles.join(', ')}）。CSVエクスポートしてこのフォルダに置いてください。`);
  }

  const targetFiles = allFiles.filter((f) => SUPPORTED_EXT.has(extname(f).toLowerCase()));
  if (targetFiles.length === 0) {
    console.log(`取り込み対象のファイルがありません（${inboxDir} に .csv/.tsv/.txt/.md を置いてください）。`);
    return;
  }

  console.log(`案件・請求管理データの${apply ? '取込' : 'プレビュー'}を開始します（対象: ${targetFiles.length}件）`);
  if (!apply) {
    console.log('※ --apply を付けずに実行するとプレビューのみです。Notionへの書き込みは行われません。\n');
  }

  const [existingClients, existingMembers, existingProjects, existingAssignments] = await Promise.all([
    fetchClients(),
    fetchMembers(),
    fetchProjects(),
    fetchAssignments(),
  ]);

  const clientIdByName = new Map(existingClients.map((c) => [c.name, c.id]));
  const memberIdByName = new Map(existingMembers.map((m) => [m.name, m.id]));
  const projectIdByName = new Map(existingProjects.map((p) => [p.name, p.id]));
  const assignmentNames = new Set(existingAssignments.map((a) => a.name));

  const counters: ImportCounters = {
    clientsNew: 0,
    clientsSkipped: 0,
    membersNew: 0,
    membersSkipped: 0,
    projectsNew: 0,
    projectsSkipped: 0,
    assignmentsNew: 0,
    assignmentsSkipped: 0,
  };

  const processedDir = join(inboxDir, '_imported');
  for (const fileName of targetFiles) {
    const filePath = join(inboxDir, fileName);
    const ok = await processFile(
      fileName,
      filePath,
      apply,
      clientIdByName,
      memberIdByName,
      projectIdByName,
      assignmentNames,
      counters,
    );
    if (ok && apply) {
      try {
        if (!existsSync(processedDir)) mkdirSync(processedDir, { recursive: true });
        renameSync(filePath, join(processedDir, fileName));
      } catch (err) {
        console.warn(`  ${fileName} の退避に失敗（再実行で重複登録の可能性あり）: ${String(err)}`);
      }
    }
  }

  console.log('\n=== 取込サマリ ===');
  console.log(`案件元: 新規${counters.clientsNew}件 / スキップ${counters.clientsSkipped}件`);
  console.log(`要員: 新規${counters.membersNew}件 / スキップ${counters.membersSkipped}件`);
  console.log(`案件: 新規${counters.projectsNew}件 / スキップ${counters.projectsSkipped}件`);
  console.log(`アサイン: 新規${counters.assignmentsNew}件 / スキップ${counters.assignmentsSkipped}件`);

  if (apply) {
    console.log('\nNotionへの登録が完了しました。npm run engagements で整合性チェックを行ってください。');
  } else {
    console.log('\n--apply を付けると登録します（例: npm run engagements:import -- --apply）。');
  }
}

main().catch((err) => {
  console.error(`取込処理でエラーが発生しました: ${String(err)}`);
  process.exitCode = 1;
});
