import '../env.js';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'fs';
import { extname, join } from 'path';
import { generateJsonFromPdf } from '../llm/index.js';
import { COMPANY_PROFILE } from '../data/companyProfile.js';
import {
  DB_IDS,
  fetchClients,
  fetchMembers,
  fetchAssignments,
  saveContract,
  attachPdfToPage,
  contractKindLabel,
} from './notionDb.js';
import type {
  Assignment,
  Client,
  ContractMatchStatus,
  ExtractedContract,
  Member,
  RateTerms,
} from '../types/engagements.js';

// 契約書PDFのフォルダ・ドロップ取込（npm run engagements:contracts）
//
// 契約書はアサインDBに手入力している契約条件の「原本」。PDFから条件を抽出して
// 要員/案件元/アサインに紐付け、アサインDBの現在値との差異を突合レポートする。
// 誤登録防止のデザイン: 既定はプレビューのみ。--apply を付けた時だけ Notion へ書き込む。
//
// 使い方:
//   npm run engagements:contracts              # プレビュー（書き込みなし）
//   npm run engagements:contracts -- --apply   # 契約書DBへ登録+PDF添付

const CONTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'contractKind', 'title', 'partyName', 'personName', 'projectName',
    'periodStart', 'periodEnd', 'autoRenewal', 'monthlyRate', 'lowerHours', 'upperHours',
    'overtimeRate', 'deductionRate', 'hourlyRate', 'paymentTermsNote', 'notes',
  ],
  properties: {
    contractKind: {
      type: 'string',
      enum: ['basic', 'individual', 'dispatch_individual', 'other'],
      description: '契約種別。基本契約=basic、個別契約(注文書/発注書含む)=individual、労働者派遣個別契約=dispatch_individual、判別不能=other',
    },
    title: { type: ['string', 'null'], description: '契約書の表題（例: 業務委託個別契約書）' },
    partyName: { type: ['string', 'null'], description: '相手方の名称（自社以外の当事者）' },
    personName: { type: ['string', 'null'], description: '対象要員名（個別契約に従事者の記載があれば）' },
    projectName: { type: ['string', 'null'], description: '案件・業務内容の名称' },
    periodStart: { type: ['string', 'null'], description: '契約期間の開始日。YYYY-MM-DD形式' },
    periodEnd: { type: ['string', 'null'], description: '契約期間の終了日。YYYY-MM-DD形式' },
    autoRenewal: { type: 'boolean', description: '自動更新条項の有無' },
    monthlyRate: { type: ['number', 'null'], description: '月額単価（税抜・円）' },
    lowerHours: { type: ['number', 'null'], description: '精算幅下限（h）' },
    upperHours: { type: ['number', 'null'], description: '精算幅上限（h）' },
    overtimeRate: { type: ['number', 'null'], description: '超過単価（円/h）' },
    deductionRate: { type: ['number', 'null'], description: '控除単価（円/h）' },
    hourlyRate: { type: ['number', 'null'], description: '時給単価（税抜・円）' },
    paymentTermsNote: { type: ['string', 'null'], description: '支払条件の記載（例: 月末締め翌月末払い）' },
    notes: { type: ['string', 'null'], description: 'その他特記事項（再委託禁止・秘密保持等の要点）' },
  },
} as const;

function buildSystemPrompt(): string {
  return `あなたはSES企業の契約管理担当です。PDFは業務委託基本契約書・個別契約書（注文書/発注書含む）・労働者派遣個別契約書のいずれかです。
記載されている値だけを抽出し、推測で埋めないでください。当事者のうち自社「${COMPANY_PROFILE.companyName}」以外を相手方（partyName）としてください。
金額は数値（円・税抜）、日付はYYYY-MM-DD形式で出力してください。精算幅（例: 140時間〜180時間）があれば lowerHours/upperHours に、超過・控除単価があれば overtimeRate/deductionRate に入れてください。`;
}

// --- 突合（純関数）---

export interface ContractComparison {
  status: ContractMatchStatus;
  diffs: string[];
}

function yen(n: number | undefined | null): string {
  return n !== null && n !== undefined ? `${n.toLocaleString()}円` : '未設定';
}

function dateStr(d: Date | undefined): string {
  return d ? d.toISOString().slice(0, 10) : '未設定';
}

// 契約書の抽出値とアサインDBの現在値を突合する。
// side: 相手方が委託先なら payment（支払側）、案件元なら billing（請求側）と比較する。
// 契約書に記載が無い項目（null）は比較しない（記載欠落は差異ではない）。
export function compareContractToAssignment(
  extracted: ExtractedContract,
  assignment: Assignment | undefined,
  side: 'payment' | 'billing',
): ContractComparison {
  if (!assignment) return { status: '照合不可', diffs: [] };

  const terms: RateTerms | undefined = side === 'payment' ? assignment.payment : assignment.billing;
  const diffs: string[] = [];

  const numericChecks: Array<[string, number | null, number | undefined]> = [
    ['単価', extracted.monthlyRate, terms?.monthlyRate],
    ['精算幅下限', extracted.lowerHours, terms?.lowerHours],
    ['精算幅上限', extracted.upperHours, terms?.upperHours],
    ['超過単価', extracted.overtimeRate, terms?.overtimeRate],
    ['控除単価', extracted.deductionRate, terms?.deductionRate],
    ['時給単価', extracted.hourlyRate, terms?.hourlyRate],
  ];
  for (const [label, contractValue, dbValue] of numericChecks) {
    if (contractValue === null) continue;
    if (dbValue === undefined || dbValue !== contractValue) {
      const unit = label.includes('幅') ? 'h' : '円';
      const contractStr = label.includes('幅') ? `${contractValue}${unit}` : yen(contractValue);
      const dbStr = dbValue === undefined ? '未設定' : label.includes('幅') ? `${dbValue}${unit}` : yen(dbValue);
      diffs.push(`${label}: 契約書 ${contractStr} ⇔ アサインDB ${dbStr}`);
    }
  }

  for (const [label, contractValue, dbValue] of [
    ['期間開始', extracted.periodStart, assignment.period.start],
    ['期間終了', extracted.periodEnd, assignment.period.end],
  ] as Array<[string, string | null, Date | undefined]>) {
    if (!contractValue) continue;
    const dbDate = dateStr(dbValue);
    if (dbDate !== contractValue) {
      diffs.push(`${label}: 契約書 ${contractValue} ⇔ アサインDB ${dbDate}`);
    }
  }

  return { status: diffs.length === 0 ? '一致' : '差異あり', diffs };
}

// --- 紐付け解決 ---

function normalize(name: string): string {
  return name.toLowerCase().replace(/[\s　]/g, '');
}

function findByName<T extends { name: string }>(candidates: T[], target: string | null): T | undefined {
  const t = target ? normalize(target) : '';
  if (!t) return undefined;
  return candidates.find((c) => {
    const n = normalize(c.name);
    return n !== '' && (t.includes(n) || n.includes(t));
  });
}

function overlaps(period: { start?: Date; end?: Date }, extracted: ExtractedContract): boolean {
  const contractStart = extracted.periodStart ? new Date(extracted.periodStart) : new Date(-8640000000000000);
  const contractEnd = extracted.periodEnd ? new Date(extracted.periodEnd) : new Date(8640000000000000);
  const periodStart = period.start ?? new Date(-8640000000000000);
  const periodEnd = period.end ?? new Date(8640000000000000);
  return periodStart <= contractEnd && periodEnd >= contractStart;
}

// --- 本文Markdown ---

function buildBodyMarkdown(extracted: ExtractedContract, comparison: ContractComparison, linkNote: string): string {
  const lines: string[] = [];
  lines.push('## 抽出結果');
  lines.push(`- 契約種別: ${contractKindLabel(extracted.contractKind)}`);
  lines.push(`- 表題: ${extracted.title ?? '不明'}`);
  lines.push(`- 相手方: ${extracted.partyName ?? '不明'}`);
  lines.push(`- 対象要員: ${extracted.personName ?? '-'}`);
  lines.push(`- 案件・業務内容: ${extracted.projectName ?? '-'}`);
  lines.push(`- 期間: ${extracted.periodStart ?? '不明'} 〜 ${extracted.periodEnd ?? '不明'}`);
  lines.push(`- 自動更新: ${extracted.autoRenewal ? 'あり' : 'なし'}`);
  lines.push(`- 月額単価: ${yen(extracted.monthlyRate)}`);
  if (extracted.lowerHours !== null || extracted.upperHours !== null) {
    lines.push(`- 精算幅: ${extracted.lowerHours ?? '-'}h 〜 ${extracted.upperHours ?? '-'}h`);
  }
  if (extracted.overtimeRate !== null) lines.push(`- 超過単価: ${yen(extracted.overtimeRate)}/h`);
  if (extracted.deductionRate !== null) lines.push(`- 控除単価: ${yen(extracted.deductionRate)}/h`);
  if (extracted.hourlyRate !== null) lines.push(`- 時給単価: ${yen(extracted.hourlyRate)}/h`);
  lines.push(`- 支払条件: ${extracted.paymentTermsNote ?? '-'}`);
  lines.push(`- 特記事項: ${extracted.notes ?? '-'}`);
  lines.push('');
  lines.push('## 紐付け');
  lines.push(linkNote);
  lines.push('');
  lines.push('## アサインDBとの突合');
  lines.push(`- ステータス: ${comparison.status}`);
  for (const diff of comparison.diffs) lines.push(`- ${diff}`);
  return lines.join('\n');
}

// --- 取込本体 ---

interface ContractSummary {
  fileName: string;
  status: ContractMatchStatus;
  note: string;
}

async function processPdf(
  fileName: string,
  filePath: string,
  apply: boolean,
  members: Member[],
  clients: Client[],
  assignments: Assignment[],
): Promise<ContractSummary | undefined> {
  console.log(`\n--- ${fileName} ---`);

  let extracted: ExtractedContract;
  try {
    const pdf = readFileSync(filePath);
    extracted = await generateJsonFromPdf<ExtractedContract>(
      buildSystemPrompt(),
      `契約書PDF「${fileName}」から指定のJSON Schemaに従って契約条件を抽出してください。`,
      pdf,
      CONTRACT_SCHEMA,
    );
  } catch (err) {
    console.error(`  抽出に失敗したためこのファイルはスキップします: ${String(err)}`);
    return undefined;
  }

  // 紐付け: 要員（相手方=委託先 or 記載の従事者）→ 見つからなければ案件元
  const member = findByName(members, extracted.personName) ?? findByName(members, extracted.partyName);
  const client = member ? undefined : findByName(clients, extracted.partyName);
  const side: 'payment' | 'billing' = member ? 'payment' : 'billing';

  // アサイン: 要員が特定でき、契約期間と重なる契約中アサインが1件に絞れた場合のみ
  let assignment: Assignment | undefined;
  if (member) {
    const candidates = assignments.filter(
      (a) => a.memberId === member.id && a.status === '契約中' && overlaps(a.period, extracted),
    );
    if (candidates.length === 1) assignment = candidates[0];
    else if (candidates.length > 1) {
      console.warn(`  ⚠ 要員「${member.name}」の契約中アサインが${candidates.length}件あり一意に決定できません`);
    }
  }

  // 基本契約は単価を持たないことが多い — アサイン突合は個別契約系のみ意味を持つ
  const comparison =
    extracted.contractKind === 'basic'
      ? ({ status: assignment ? '一致' : '照合不可', diffs: [] } as ContractComparison)
      : compareContractToAssignment(extracted, assignment, side);

  const linkParts = [
    `- 要員: ${member?.name ?? '未特定'}`,
    `- 案件元: ${client?.name ?? (member ? '-（相手方は委託先）' : '未特定')}`,
    `- アサイン: ${assignment?.name ?? '未特定'}`,
  ];

  console.log(`  種別: ${contractKindLabel(extracted.contractKind)} / 相手方: ${extracted.partyName ?? '不明'}`);
  console.log(`  期間: ${extracted.periodStart ?? '不明'} 〜 ${extracted.periodEnd ?? '不明'}${extracted.autoRenewal ? '（自動更新あり）' : ''}`);
  for (const part of linkParts) console.log(`  ${part.slice(2)}`);
  console.log(`  突合: ${comparison.status}`);
  for (const diff of comparison.diffs) console.log(`    ⚠ ${diff}`);

  const title = `${extracted.partyName ?? fileName} ${contractKindLabel(extracted.contractKind)}`;
  const matchNote = comparison.diffs.join('\n') || (assignment ? '契約書記載の条件はアサインDBと一致' : 'アサイン未特定のため照合できず');

  if (apply) {
    const pageId = await saveContract({
      title,
      contractKind: extracted.contractKind,
      partyName: extracted.partyName ?? '',
      memberId: member?.id,
      clientId: client?.id,
      assignmentId: assignment?.id,
      periodStart: extracted.periodStart ?? undefined,
      periodEnd: extracted.periodEnd ?? undefined,
      autoRenewal: extracted.autoRenewal,
      matchStatus: comparison.status,
      matchNote,
      filename: fileName,
      bodyMarkdown: buildBodyMarkdown(extracted, comparison, linkParts.join('\n')),
    });
    await attachPdfToPage(pageId, readFileSync(filePath), fileName, '契約書PDF');
    console.log(`  契約書DBへ登録しました: ${title}`);
  }

  return { fileName, status: comparison.status, note: matchNote };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const inboxDir = process.env.CONTRACTS_IMPORT_DIR ?? './contracts-import';

  if (!existsSync(inboxDir)) {
    mkdirSync(inboxDir, { recursive: true });
    console.log(`受け皿フォルダを作成しました: ${inboxDir}`);
    console.log('契約書PDF（基本契約・個別契約・派遣個別契約）をこのフォルダに置き、再度実行してください。');
    return;
  }

  const pdfFiles = readdirSync(inboxDir, { withFileTypes: true })
    .filter((f) => f.isFile() && extname(f.name).toLowerCase() === '.pdf')
    .map((f) => f.name);
  if (pdfFiles.length === 0) {
    console.log(`取り込み対象のPDFがありません（${inboxDir} に .pdf を置いてください）。`);
    return;
  }

  if (apply && !DB_IDS.contract) {
    console.warn('NOTION_CONTRACT_DB_ID が未設定です。npm run engagements:setup で契約書DBを作成してから --apply を実行してください。');
    console.warn('プレビュー（--apply なし）は実行できます。');
    return;
  }

  console.log(`契約書の${apply ? '取込' : 'プレビュー'}を開始します（対象: ${pdfFiles.length}件）`);
  if (!apply) console.log('※ --apply を付けずに実行するとプレビューのみです。Notionへの書き込みは行われません。');

  const [members, clients, assignments] = await Promise.all([fetchMembers(), fetchClients(), fetchAssignments()]);

  const summaries: ContractSummary[] = [];
  const processedDir = join(inboxDir, '_imported');
  for (const fileName of pdfFiles) {
    const filePath = join(inboxDir, fileName);
    try {
      const summary = await processPdf(fileName, filePath, apply, members, clients, assignments);
      if (summary) {
        summaries.push(summary);
        if (apply) {
          if (!existsSync(processedDir)) mkdirSync(processedDir, { recursive: true });
          renameSync(filePath, join(processedDir, fileName));
        }
      }
    } catch (err) {
      console.error(`  ${fileName} の処理中にエラー: ${String(err)}`);
    }
  }

  const matched = summaries.filter((s) => s.status === '一致').length;
  const diff = summaries.filter((s) => s.status === '差異あり').length;
  const unresolved = summaries.filter((s) => s.status === '照合不可').length;
  console.log('\n=== 契約書取込サマリ ===');
  console.log(`取込${summaries.length}件（一致${matched}/差異あり${diff}/照合不可${unresolved}）`);
  const notable = summaries.filter((s) => s.status !== '一致');
  if (notable.length > 0) {
    console.log('\n--- 要確認一覧 ---');
    for (const s of notable) console.log(`[${s.status}] ${s.fileName}: ${s.note.split('\n')[0]}`);
  }
  if (!apply) {
    console.log('\n--apply を付けると契約書DBへ登録します（例: npm run engagements:contracts -- --apply）。');
  }
}

main().catch((err) => {
  console.error(`契約書取込でエラーが発生しました: ${String(err)}`);
  process.exitCode = 1;
});
