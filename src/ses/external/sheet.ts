// 外部マッチ（試行）: 営業リストの別タブ「外部マッチ」の列・優先度・行の組み立て（純関数）。「全体」タブには混ぜない
import { checkReasonLines, markRequirementsInMail, jstLabel, SALES_PRIORITIES } from '../proper/salesList.js';
import type { Engineer, ProperJudgment, Project } from '../../types/index.js';

export const EXT_TAB = '外部マッチ';
export const EXT_HEADER: string[] = [
  'No', '優先度', '要員', '要員の所属', '希望単価(万)', '案件名', '案件単価(万)', '差(万)', '勤務地', '開始',
  '判定理由', '確認すること', '対応状況', '見送り理由', '担当営業', 'メモ',
  '案件の営業元会社', '案件の担当者', '案件の営業元メール', '案件の件名', '案件の受信日時',
  '要員の担当者', '要員の営業元メール', '要員メールの件名', '要員メールの受信日時',
  '追加日時', '案件詳細（メール本文より）', '判定の理由', 'ID',
];
const COL = Object.fromEntries(EXT_HEADER.map((n, i) => [n, i])) as Record<string, number>;
export const EXT_STATUS_NEW = '未着手';

export const extHeaderRow = (): string[] => [...EXT_HEADER];

export function extColumnLetter(i: number): string {
  return i < 26 ? String.fromCharCode(65 + i) : `${String.fromCharCode(64 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`;
}
export const EXT_LAST_COLUMN = extColumnLetter(EXT_HEADER.length - 1);

// 優先度: 提案推奨で必須が全部「経験あり」→ A。条件付き、または提案推奨でも必須に近い経験・年数不足がある → B。見送り・経験の無い必須がある → 載せない
export function extPriorityOf(j: Pick<ProperJudgment, 'verdict' | 'checks'>): string | null {
  if (j.verdict === 'reject') return null;
  const required = (j.checks ?? []).filter((k) => k.kind === '必須');
  if (required.some((k) => k.status === 'unmet')) return null;
  const weak = required.some((k) => k.status === 'close' || typeof k.shortYears === 'number');
  return j.verdict === 'recommend' && !weak ? SALES_PRIORITIES.a : SALES_PRIORITIES.b;
}

export interface ExtRowInput {
  no: number;
  priority: string;
  engineer: Engineer;
  project: Project;
  judgment: ProperJudgment;
  addedAt: Date;
}

export function extRowOf(x: ExtRowInput): Array<string | number> {
  const { engineer: e, project: p, judgment: j } = x;
  const row: Array<string | number> = EXT_HEADER.map(() => '');
  const rate = p.rateMax ?? p.rateMin;
  const desired = e.desiredRate;
  const gaps = (j.checks ?? []).filter((k) => k.kind === '必須' && k.status === 'close').map((k) => `近い経験のみ: ${k.requirement}`);
  const confirm = [
    ...gaps,
    ...j.concerns,
    ...j.reviewNotes,
    e.businessFlow ? `要員の商流・所属: ${e.businessFlow}` : '',
    p.businessFlow ? `案件の商流: ${p.businessFlow}` : '',
  ].filter(Boolean);
  row[COL['No']] = x.no;
  row[COL['優先度']] = x.priority;
  row[COL['要員']] = e.displayName;
  row[COL['要員の所属']] = e.agentCompany;
  row[COL['希望単価(万)']] = desired ?? '';
  row[COL['案件名']] = p.title;
  row[COL['案件単価(万)']] = rate ?? '';
  row[COL['差(万)']] = rate !== null && rate !== undefined && desired !== null ? rate - desired : '';
  row[COL['勤務地']] = p.location;
  row[COL['開始']] = p.startPeriod;
  row[COL['判定理由']] = [`やること: ${j.work}`, j.levelFit ? `レベル: ${j.levelFit}` : ''].filter(Boolean).join('\n');
  row[COL['確認すること']] = confirm.join('\n');
  row[COL['対応状況']] = EXT_STATUS_NEW;
  row[COL['案件の営業元会社']] = p.agentCompany;
  row[COL['案件の担当者']] = p.agentContact;
  row[COL['案件の営業元メール']] = p.agentEmail;
  row[COL['案件の件名']] = p.replyTarget?.subject ?? '';
  row[COL['案件の受信日時']] = jstLabel(p.receivedAt);
  row[COL['要員の担当者']] = e.agentContact;
  row[COL['要員の営業元メール']] = e.agentEmail;
  row[COL['要員メールの件名']] = e.replyTarget?.subject ?? '';
  row[COL['要員メールの受信日時']] = jstLabel(e.receivedAt);
  row[COL['追加日時']] = jstLabel(x.addedAt);
  row[COL['案件詳細（メール本文より）']] = markRequirementsInMail((p.detail ?? '').replace(/&nbsp;/g, ' ').trim(), j.checks ?? []);
  row[COL['判定の理由']] = checkReasonLines(j.checks ?? []);
  row[COL['ID']] = `ext_${e.id}_${p.id}`;
  return row;
}

// タブの今の値（見出し行＋行）から、次に書く行番号と No（このタブの No は 1 から）
export function nextExtRow(values: string[][]): { row: number; no: number; ids: Set<string> } {
  const rows = values.length > 0 ? values : [EXT_HEADER];
  const body = rows.slice(1);
  let no = 0;
  const ids = new Set<string>();
  for (const r of body) {
    const n = Number(r[COL['No']]);
    if (Number.isFinite(n) && n > no) no = n;
    const id = String(r[COL['ID']] ?? '').trim();
    if (id) ids.add(id);
  }
  return { row: rows.length + 1, no: no + 1, ids };
}
