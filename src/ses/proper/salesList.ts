// 営業に渡す「プロパー提案候補リスト」（営業専用の別スプレッドシート。PROPER_SALES_SPREADSHEET_ID）。
// 案件スプレッドシート（DB）は生データ・内部IDを含むため営業に共有せず、判断に要る列だけを見やすい形で書き出す。
// - 「全体」タブ: 優先度 → 要員 → 受信の新しい順。左に判断に要る列、右に詳細（本文・文面）。ID列は隠す
// - 要員ごとのタブ: 「全体」を FILTER で映す閲覧用（入力は「全体」で行う）。候補が0件の営業中の要員にも作り、要員の増減に合わせてバッチが足し引きする
// - 色: 優先度（A=緑/B=黄/C=灰）と対応状況（提案済=青/面談調整=紫/面談済=橙/成約=緑/見送り=灰）を条件付き書式で
// - 人が入力する列（対応状況・担当営業・メモ・精度チェック・精度メモ）は毎回の書き直しでも ID で引き継ぎ、今回の候補から外れた行も入力があれば残す
// - 要員一覧: いま営業している要員（稼働可）を、候補が0件の要員も含めて1行ずつ（稼働開始・希望単価・スキル・本人の希望・候補数）
// - 精度チェック: 営業が候補ごとに「合っていたか」を付け、「精度集計」タブが優先度・要員ごとの妥当率を数式で出す（AI判定の精度の測定）
import { google, type sheets_v4 } from 'googleapis';
import { GOOGLE_REQUEST_TIMEOUT_MS, withGoogleRetry, columnLetter, quoteTab } from '../../database/sheetBook.js';
import { properSalesSpreadsheetId } from '../config.js';
import { sesMainAuth } from '../googleCreds.js';
import type { Project, ProperCandidate, ProperEngineer } from '../../types/index.js';

export const SALES_ALL_TAB = '全体';
const STAFF_TAB_METADATA_KEY = 'ses_sales_staff_tab';
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

export const SALES_STATUSES = ['未着手', '提案済', '面談調整', '面談済', '成約', '見送り'] as const;
// 精度チェックの選択肢（先頭の記号で集計する）。◎○を「妥当」として妥当率に数える
export const ACCURACY_MARKS = ['◎ 妥当', '○ 概ね妥当', '△ 微妙', '× ズレ'] as const;
export const SALES_SUMMARY_TAB = '精度集計';
export const SALES_STAFF_LIST_TAB = '要員一覧';
const STAFF_LIST_TAB_METADATA_KEY = 'ses_sales_staff_list_tab';
const SUMMARY_TAB_METADATA_KEY = 'ses_sales_summary_tab';
export const SALES_PRIORITIES = { a: 'A 提案推奨', b: 'B 条件交渉', c: 'C 要確認' } as const;

// 列の定義（順番がそのまま表示順）。width はピクセル、wrap=false は折り返さずに切る（長文はセルを開いて読む）
interface SalesColumn {
  name: string;
  width: number;
  wrap?: boolean;
  human?: boolean; // 人が入力する列（書き直しでも引き継ぐ）
  hidden?: boolean;
}
export const SALES_COLUMNS: SalesColumn[] = [
  { name: 'No', width: 36 },
  { name: '優先度', width: 92 },
  { name: '要員', width: 56 },
  { name: '案件名', width: 240, wrap: true },
  { name: '案件単価(万)', width: 64 },
  { name: '希望単価(万)', width: 64 },
  { name: '差(万)', width: 52 },
  { name: '勤務地', width: 110, wrap: true },
  { name: 'リモート', width: 56 },
  { name: '開始', width: 80, wrap: true },
  { name: '判定理由', width: 260, wrap: true },
  { name: '合っている点', width: 260, wrap: true },
  { name: '足りない点', width: 160, wrap: true },
  { name: '交渉ポイント', width: 220, wrap: true },
  { name: '対応状況', width: 80, human: true },
  { name: '担当営業', width: 72, human: true },
  { name: 'メモ', width: 160, wrap: true, human: true },
  { name: '精度チェック', width: 96, human: true },
  { name: '精度メモ', width: 180, wrap: true, human: true },
  { name: '確認事項', width: 220, wrap: true },
  { name: '必須スキル', width: 160, wrap: true },
  { name: '営業元会社', width: 140, wrap: true },
  { name: '担当者', width: 72 },
  { name: '担当者メール', width: 160 },
  { name: 'メール件名', width: 280, wrap: false },
  { name: '受信日時', width: 108 },
  { name: '案件詳細（メール本文より）', width: 320, wrap: false },
  { name: '提案文面（案）', width: 320, wrap: false },
  { name: 'ID', width: 40, hidden: true },
];
const COL = Object.fromEntries(SALES_COLUMNS.map((c, i) => [c.name, i])) as Record<string, number>;
const HEADER = SALES_COLUMNS.map((c) => c.name);
const LAST_COL = columnLetter(SALES_COLUMNS.length - 1);
// 要員のタブは FILTER で映すだけのため、人が入力する列の見出しに入力先を添える
const staffHeaderOf = (h: string) => (SALES_COLUMNS.find((c) => c.name === h)?.human ? `${h}（入力は全体タブ）` : h);

type Row = Array<string | number>;

// 営業向けの表記（保存用の「不可」ではなく「常駐」）
const SALES_REMOTE_LABEL: Record<Project['remote'], string> = { full: 'フル', partial: '一部', none: '常駐', unknown: '' };

// 優先度: 要確認（単価・スキル不明や指示混入疑い、AIの根拠が経歴に無い等）→ C。
// AI判定のある候補は「推奨」かつ単価を満たせば A、ほかは B。AI判定の無い候補は、交渉や参考提案の注記が無く単価を満たす強マッチ → A
export function salesPriorityOf(c: ProperCandidate): string {
  if (c.needsReview) return SALES_PRIORITIES.c;
  if (c.judgment) return c.judgment.verdict === 'recommend' && c.meetsRate ? SALES_PRIORITIES.a : SALES_PRIORITIES.b;
  if (c.band === 'strong' && c.meetsRate && !/【(単価交渉|経験交渉|年数交渉|参考提案)】/.test(c.reason)) return SALES_PRIORITIES.a;
  return SALES_PRIORITIES.b;
}

// 根拠（ownMatch の reason）から交渉ポイント・確認事項を取り出す（どちらも1行1項目）
export function salesNotesOf(reason: string): { negotiation: string; confirm: string } {
  const negotiation: string[] = [];
  const confirm: string[] = [];
  for (const m of reason.matchAll(/【(単価交渉|経験交渉|年数交渉|参考提案)】([^【［。]*)/g)) {
    const body = m[2].replace(/。$/, '').trim();
    negotiation.push(m[1] === '参考提案' ? `参考提案${body ? `: ${body}` : ''}` : `${m[1].replace('交渉', '')}: ${body}`);
  }
  for (const m of reason.matchAll(/［(条件|確認)］([^【［。]*)/g)) confirm.push(m[2].trim());
  const review = /([^。）]*)のため要確認です/.exec(reason);
  if (review) confirm.unshift(`要確認: ${review[1].trim()}`);
  return { negotiation: negotiation.join('\n'), confirm: confirm.join('\n') };
}

function jstLabel(d: Date): string {
  if (!Number.isFinite(d.getTime())) return '';
  const j = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${j.getUTCFullYear()}/${p(j.getUTCMonth() + 1)}/${p(j.getUTCDate())} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}`;
}

// 候補1件を「全体」タブの1行にする（No と人の入力列は後で埋める）
export function salesRowOf(c: ProperCandidate, project: Project | undefined): Row {
  const row: Row = HEADER.map(() => '');
  const { negotiation, confirm } = salesNotesOf(c.reason);
  row[COL['優先度']] = salesPriorityOf(c);
  row[COL['要員']] = c.properLabel;
  row[COL['案件名']] = c.projectTitle;
  row[COL['案件単価(万)']] = c.projectRate ?? '';
  row[COL['希望単価(万)']] = c.requiredProjectRate ?? '';
  row[COL['差(万)']] = c.rateGapMan ?? '';
  // AI判定があれば「要件 ← 経歴の根拠」を1行ずつ、無ければ満たしたスキル名を並べる
  const sep = c.judgment ? '\n' : '、';
  row[COL['判定理由']] = c.judgment ? [`やること: ${c.judgment.work}`, c.judgment.levelFit ? `レベル: ${c.judgment.levelFit}` : ''].filter(Boolean).join('\n') : '';
  row[COL['合っている点']] = (c.matchedSkills ?? []).join(sep);
  row[COL['足りない点']] = (c.missingSkills ?? []).join(sep);
  row[COL['交渉ポイント']] = negotiation;
  row[COL['確認事項']] = confirm;
  row[COL['提案文面（案）']] = c.draftToProject?.body ?? '';
  row[COL['ID']] = c.id;
  if (project) {
    row[COL['勤務地']] = project.location;
    row[COL['リモート']] = SALES_REMOTE_LABEL[project.remote];
    row[COL['開始']] = project.startPeriod;
    row[COL['必須スキル']] = project.requiredSkills.join('、');
    row[COL['営業元会社']] = project.agentCompany;
    row[COL['担当者']] = project.agentContact;
    row[COL['担当者メール']] = project.agentEmail;
    row[COL['メール件名']] = project.replyTarget?.subject ?? '';
    row[COL['受信日時']] = jstLabel(project.receivedAt);
    row[COL['案件詳細（メール本文より）']] = project.detail ?? '';
  }
  return row;
}

const NUMERIC_COLS = new Set(['No', '案件単価(万)', '希望単価(万)', '差(万)']);
const HUMAN_COLS = SALES_COLUMNS.flatMap((c, i) => (c.human ? [i] : []));

function hasHumanInput(row: Row): boolean {
  return HUMAN_COLS.some((i) => {
    const v = String(row[i] ?? '').trim();
    return v !== '' && !(i === COL['対応状況'] && v === SALES_STATUSES[0]);
  });
}

const legacyKey = (engineer: string, title: string) => `${engineer}|${title}`.replace(/\s+/g, '');

// ID列の無い以前のリスト（バッチ導入前に手で作った営業リスト）の人の入力を、要員＋案件名で引ける形にする
function legacyInputs(legacy: string[][]): Map<string, string[]> {
  const header = legacy[0] ?? [];
  const at = (name: string) => header.indexOf(name);
  const out = new Map<string, string[]>();
  if (at('要員') < 0 || at('案件名') < 0) return out;
  for (const cells of legacy.slice(1)) {
    const key = legacyKey(cells[at('要員')] ?? '', cells[at('案件名')] ?? '');
    const human = HUMAN_COLS.map((i) => (at(HEADER[i]) >= 0 ? (cells[at(HEADER[i])] ?? '').trim() : ''));
    if (human.some((v) => v !== '') && !out.has(key)) out.set(key, human);
  }
  return out;
}

// 今回の行に、前回までのシートの人の入力を ID で引き継ぐ。今回の候補に無い行は、人の入力があるものだけ前回のまま残す。
// existing はシートの値（1行目は見出し。列は見出しの名前で探すため、人が列を並べ替えていても読める）。
// legacy は同じスプレッドシートにある以前のリスト（ID列なし）。IDで引けない行だけ、要員＋案件名が同じ行の入力を引き継ぐ
export function mergeSalesRows(fresh: Row[], existing: string[][], legacy: string[][] = []): Row[] {
  const fromLegacy = legacyInputs(legacy);
  const header = existing[0] ?? [];
  const at = (name: string) => header.indexOf(name);
  const idAt = at('ID');
  const previous = new Map<string, Row>();
  if (idAt >= 0) {
    for (const cells of existing.slice(1)) {
      const id = (cells[idAt] ?? '').trim();
      if (!id) continue;
      const row: Row = HEADER.map((name) => {
        const v = at(name) >= 0 ? (cells[at(name)] ?? '') : '';
        return NUMERIC_COLS.has(name) && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v;
      });
      previous.set(id, row);
    }
  }
  const out: Row[] = [];
  const seen = new Set<string>();
  for (const r of fresh) {
    const id = String(r[COL['ID']]);
    seen.add(id);
    const prev = previous.get(id);
    const merged = [...r];
    const old = prev ? null : fromLegacy.get(legacyKey(String(r[COL['要員']]), String(r[COL['案件名']])));
    HUMAN_COLS.forEach((i, k) => {
      merged[i] = prev ? prev[i] : (old?.[k] ?? '');
    });
    if (merged[COL['対応状況']] === '') merged[COL['対応状況']] = SALES_STATUSES[0];
    out.push(merged);
  }
  for (const [id, prev] of previous) if (!seen.has(id) && hasHumanInput(prev)) out.push(prev);
  return sortSalesRows(out);
}

// 優先度 → 要員 → 受信の新しい順。No を振り直す
export function sortSalesRows(rows: Row[]): Row[] {
  const s = (r: Row, name: string) => String(r[COL[name]] ?? '');
  const sorted = [...rows].sort(
    (a, b) =>
      s(a, '優先度').localeCompare(s(b, '優先度')) ||
      s(a, '要員').localeCompare(s(b, '要員')) ||
      s(b, '受信日時').localeCompare(s(a, '受信日時')) ||
      s(a, 'ID').localeCompare(s(b, 'ID')),
  );
  return sorted.map((r, i) => {
    const copy = [...r];
    copy[COL['No']] = i + 1;
    return copy;
  });
}

// 要員のタブ名（シート名に使えない文字を除く。「全体」と重ならないようにする）
export function staffTabName(label: string): string {
  const name = label.replace(/[[\]*?/\\:]/g, '').trim().slice(0, 90) || '（イニシャル不明）';
  return name === SALES_ALL_TAB ? `${name}_要員` : name;
}

export function staffFilterFormula(label: string): string {
  const tab = quoteTab(SALES_ALL_TAB);
  const c = columnLetter(COL['要員']);
  return `=IFERROR(FILTER(${tab}!A2:${LAST_COL},${tab}!${c}2:${c}="${label.replace(/"/g, '""')}"),"")`;
}

// 「精度集計」タブの値（数式）。優先度ごと・要員ごとに、精度チェックの件数と妥当率（◎○ ÷ チェック済み）を出す
export function summaryValues(staffLabels: string[]): string[][] {
  const tab = quoteTab(SALES_ALL_TAB);
  const col = (name: string) => `${tab}!${columnLetter(COL[name])}2:${columnLetter(COL[name])}`;
  const acc = col('精度チェック');
  const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const row = (label: string, cond: string, r: number): string[] => {
    const c = (mark: string) => `=COUNTIFS(${cond}${cond ? ',' : ''}${acc},${q(`${mark}*`)})`;
    const all = cond ? `=COUNTIFS(${cond})` : `=COUNTA(${col('ID')})`;
    return [label, all, c('?'), c('◎'), c('○'), c('△'), c('×'), `=IFERROR((D${r}+E${r})/C${r},"")`];
  };
  const pri = col('優先度');
  const staff = col('要員');
  const groups: Array<[string, string]> = [
    ['全体', ''],
    ...(['A', 'B', 'C'] as const).map((p): [string, string] => [`優先度 ${p}`, `${pri},${q(`${p}*`)}`]),
    ...staffLabels.map((l): [string, string] => [`要員 ${l}`, `${staff},${q(l)}`]),
  ];
  return [
    ['区分', '候補数', 'チェック済', '◎ 妥当', '○ 概ね妥当', '△ 微妙', '× ズレ', '妥当率（◎＋○）'],
    ...groups.map(([label, cond], i) => row(label, cond, i + 2)),
  ];
}

// 「要員一覧」タブの値。文字の列（stringsは RAW で書く）と、候補数などの数式の列（formulas は USER_ENTERED）に分ける
export const STAFF_LIST_HEADER = ['要員', '稼働開始', '希望単価(万)', '経験年数', '主なスキル', '本人の希望', '候補数', 'うちA', '提案済以降', '成約'];
export function staffListValues(engineers: Array<Pick<ProperEngineer, 'proposalLabel' | 'displayName' | 'availableDate' | 'requiredProjectRate' | 'experienceYears' | 'skills' | 'wish'>>): { strings: Array<Array<string | number>>; formulas: string[][] } {
  const tab = quoteTab(SALES_ALL_TAB);
  const col = (name: string) => `${tab}!${columnLetter(COL[name])}2:${columnLetter(COL[name])}`;
  const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const sorted = [...engineers].sort((a, b) => (a.proposalLabel || a.displayName).localeCompare(b.proposalLabel || b.displayName));
  const strings = sorted.map((e) => [
    e.proposalLabel || e.displayName,
    e.availableDate,
    e.requiredProjectRate ?? '',
    e.experienceYears ?? '',
    e.skills.slice(0, 15).join('、'),
    e.wish ?? '',
  ]);
  const formulas = sorted.map((e) => {
    const who = `${col('要員')},${q(e.proposalLabel || e.displayName)}`;
    return [
      `=COUNTIFS(${who})`,
      `=COUNTIFS(${who},${col('優先度')},"A*")`,
      `=COUNTIFS(${who},${col('対応状況')},"<>未着手",${col('対応状況')},"<>見送り",${col('対応状況')},"<>")`,
      `=COUNTIFS(${who},${col('対応状況')},"成約")`,
    ];
  });
  return { strings: [STAFF_LIST_HEADER.slice(0, 6), ...strings], formulas: [STAFF_LIST_HEADER.slice(6), ...formulas] };
}

// ===== 書式 =====

const rgb = (hex: string): sheets_v4.Schema$Color => ({
  red: parseInt(hex.slice(0, 2), 16) / 255,
  green: parseInt(hex.slice(2, 4), 16) / 255,
  blue: parseInt(hex.slice(4, 6), 16) / 255,
});

// 優先度・対応状況の色（背景, 文字）
export const PRIORITY_COLORS: Array<[string, string, string]> = [
  ['A', 'C6EFCE', '006100'],
  ['B', 'FFEB9C', '9C5700'],
  ['C', 'D9D9D9', '404040'],
];
export const ACCURACY_COLORS: Array<[string, string, string]> = [
  ['◎', 'C6EFCE', '006100'],
  ['○', 'E2EFDA', '375623'],
  ['△', 'FFEB9C', '9C5700'],
  ['×', 'F8CBAD', '9C0006'],
];
export const STATUS_COLORS: Array<[string, string, string]> = [
  ['提案済', 'DDEBF7', '1F4E78'],
  ['面談調整', 'E4DFEC', '5B2C6F'],
  ['面談済', 'FCE4D6', '843C0C'],
  ['成約', 'A9D08E', '0B3D0B'],
  ['見送り', 'EDEDED', '808080'],
];

function conditionalRules(sheetId: number): sheets_v4.Schema$Request[] {
  const range = (col: number): sheets_v4.Schema$GridRange => ({ sheetId, startRowIndex: 1, startColumnIndex: col, endColumnIndex: col + 1 });
  const rule = (col: number, type: string, value: string, bg: string, fg: string, bold: boolean): sheets_v4.Schema$Request => ({
    addConditionalFormatRule: {
      index: 0,
      rule: {
        ranges: [range(col)],
        booleanRule: {
          condition: { type, values: [{ userEnteredValue: value }] },
          format: { backgroundColor: rgb(bg), textFormat: { foregroundColor: rgb(fg), bold } },
        },
      },
    },
  });
  return [
    ...PRIORITY_COLORS.map(([p, bg, fg]) => rule(COL['優先度'], 'TEXT_STARTS_WITH', p, bg, fg, true)),
    ...STATUS_COLORS.map(([s, bg, fg]) => rule(COL['対応状況'], 'TEXT_EQ', s, bg, fg, s === '成約')),
    ...ACCURACY_COLORS.map(([m, bg, fg]) => rule(COL['精度チェック'], 'TEXT_STARTS_WITH', m, bg, fg, true)),
  ];
}

// タブ1枚分の見た目（見出し・固定・列幅・折り返し・色・隠し列）。既存の条件付き書式は消してから付け直す
export function formatRequests(sheetId: number, existingRuleCount: number, isAll: boolean): sheets_v4.Schema$Request[] {
  const reqs: sheets_v4.Schema$Request[] = [];
  for (let i = existingRuleCount - 1; i >= 0; i--) reqs.push({ deleteConditionalFormatRule: { sheetId, index: i } });
  reqs.push({
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: 1, frozenColumnCount: COL['要員'] + 1 } },
      fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount',
    },
  });
  reqs.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
      cell: {
        userEnteredFormat: {
          backgroundColor: rgb('1F4E78'),
          textFormat: { foregroundColor: rgb('FFFFFF'), bold: true },
          wrapStrategy: 'WRAP',
          verticalAlignment: 'MIDDLE',
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat,wrapStrategy,verticalAlignment)',
    },
  });
  SALES_COLUMNS.forEach((c, i) => {
    reqs.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: c.width, hiddenByUser: Boolean(c.hidden) },
        fields: 'pixelSize,hiddenByUser',
      },
    });
    reqs.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: i, endColumnIndex: i + 1 },
        cell: { userEnteredFormat: { wrapStrategy: c.wrap ? 'WRAP' : 'CLIP', verticalAlignment: 'TOP' } },
        fields: 'userEnteredFormat(wrapStrategy,verticalAlignment)',
      },
    });
  });
  reqs.push(...conditionalRules(sheetId));
  if (isAll) {
    reqs.push({
      setDataValidation: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: COL['対応状況'], endColumnIndex: COL['対応状況'] + 1 },
        rule: {
          condition: { type: 'ONE_OF_LIST', values: SALES_STATUSES.map((s) => ({ userEnteredValue: s })) },
          showCustomUi: true,
          strict: false,
        },
      },
    });
    reqs.push({
      setDataValidation: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: COL['精度チェック'], endColumnIndex: COL['精度チェック'] + 1 },
        rule: {
          condition: { type: 'ONE_OF_LIST', values: ACCURACY_MARKS.map((s) => ({ userEnteredValue: s })) },
          showCustomUi: true,
          strict: false,
        },
      },
    });
    reqs.push({ setBasicFilter: { filter: { range: { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: SALES_COLUMNS.length } } } });
  }
  return reqs;
}

// ===== 書き出し =====

export function salesListConfigured(): boolean {
  return Boolean(properSalesSpreadsheetId());
}

function sheetsApi(): sheets_v4.Sheets | null {
  const auth = sesMainAuth(SCOPES);
  return auth ? google.sheets({ version: 'v4', auth, timeout: GOOGLE_REQUEST_TIMEOUT_MS }) : null;
}

interface TabInfo {
  sheetId: number;
  title: string;
  rules: number;
  staff: boolean; // バッチが作った要員のタブ
}

async function readTabs(api: sheets_v4.Sheets, spreadsheetId: string): Promise<TabInfo[]> {
  const res = await withGoogleRetry(() =>
    api.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties(sheetId,title),conditionalFormats,developerMetadata(metadataKey))' }),
  );
  return (res.data.sheets ?? []).map((s) => ({
    sheetId: s.properties?.sheetId ?? 0,
    title: s.properties?.title ?? '',
    rules: s.conditionalFormats?.length ?? 0,
    staff: (s.developerMetadata ?? []).some((m) => m.metadataKey === STAFF_TAB_METADATA_KEY),
  }));
}

// 見出しに「要員」「案件名」「対応状況」がある最初のタブ（バッチが作った要員のタブを除く）。無ければ空
async function readLegacyList(api: sheets_v4.Sheets, spreadsheetId: string, tabs: TabInfo[]): Promise<string[][]> {
  for (const t of tabs.filter((x) => !x.staff)) {
    const res = await withGoogleRetry(() => api.spreadsheets.values.get({ spreadsheetId, range: `${quoteTab(t.title)}!A:AZ` }));
    const values = (res.data.values ?? []) as string[][];
    const header = values[0] ?? [];
    if (['要員', '案件名', '対応状況'].every((h) => header.includes(h))) return values;
  }
  return [];
}

// 候補を営業リストへ書き出す。書き出した行数（人の入力で残した行を含む）を返す。未設定なら null
// engineers: いま営業している要員（「要員一覧」タブに、候補が0件の要員も含めて載せる）
export async function writeSalesList(candidates: ProperCandidate[], projects: Project[], engineers: ProperEngineer[] = []): Promise<number | null> {
  const spreadsheetId = properSalesSpreadsheetId();
  if (!spreadsheetId) return null;
  const api = sheetsApi();
  if (!api) throw new Error('営業リスト: Google認証（メインのサービスアカウント）が未設定です');

  const projectById = new Map(projects.map((p) => [p.id, p]));
  const fresh = candidates.map((c) => salesRowOf(c, projectById.get(c.projectId)));

  let tabs = await readTabs(api, spreadsheetId);
  // 初回（「全体」タブがまだ無い）は、同じスプレッドシートにある以前の営業リストのタブから人の入力を引き継ぐ
  const legacy = tabs.some((t) => t.title === SALES_ALL_TAB) ? [] : await readLegacyList(api, spreadsheetId, tabs);
  const structural: sheets_v4.Schema$Request[] = [];
  if (!tabs.some((t) => t.title === SALES_ALL_TAB)) structural.push({ addSheet: { properties: { title: SALES_ALL_TAB, index: 0 } } });
  if (!tabs.some((t) => t.title === SALES_STAFF_LIST_TAB)) {
    const sheetId = Math.max(0, ...tabs.map((t) => t.sheetId)) + 2000;
    structural.push({ addSheet: { properties: { sheetId, title: SALES_STAFF_LIST_TAB, index: 1 } } });
    structural.push({
      createDeveloperMetadata: {
        developerMetadata: { metadataKey: STAFF_LIST_TAB_METADATA_KEY, metadataValue: '1', location: { sheetId }, visibility: 'DOCUMENT' },
      },
    });
  }
  if (!tabs.some((t) => t.title === SALES_SUMMARY_TAB)) {
    const sheetId = Math.max(0, ...tabs.map((t) => t.sheetId)) + 1000;
    structural.push({ addSheet: { properties: { sheetId, title: SALES_SUMMARY_TAB, index: 1 } } });
    structural.push({
      createDeveloperMetadata: {
        developerMetadata: { metadataKey: SUMMARY_TAB_METADATA_KEY, metadataValue: '1', location: { sheetId }, visibility: 'DOCUMENT' },
      },
    });
  }
  if (structural.length > 0) {
    await withGoogleRetry(() => api.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: structural } }));
    tabs = await readTabs(api, spreadsheetId);
  }

  const existing = await withGoogleRetry(() => api.spreadsheets.values.get({ spreadsheetId, range: `${quoteTab(SALES_ALL_TAB)}!A:${LAST_COL}` }));
  const rows = mergeSalesRows(fresh, (existing.data.values ?? []) as string[][], legacy);

  // 要員のタブ: 行のある要員の分を揃え、いなくなった要員のタブ（バッチが作ったものだけ）を消す
  // 候補が0件の要員（いま営業している要員）にもタブを作る
  const labels = [...new Set([...rows.map((r) => String(r[COL['要員']])), ...engineers.map((e) => e.proposalLabel || e.displayName)])]
    .filter(Boolean)
    .sort();
  const wanted = new Map(labels.map((l) => [staffTabName(l), l]));
  const tabChanges: sheets_v4.Schema$Request[] = [];
  for (const t of tabs) if (t.staff && !wanted.has(t.title)) tabChanges.push({ deleteSheet: { sheetId: t.sheetId } });
  let nextId = Math.max(0, ...tabs.map((t) => t.sheetId)) + 1;
  for (const title of wanted.keys()) {
    if (tabs.some((t) => t.title === title)) continue;
    const sheetId = nextId++;
    tabChanges.push({ addSheet: { properties: { sheetId, title } } });
    tabChanges.push({
      createDeveloperMetadata: {
        developerMetadata: { metadataKey: STAFF_TAB_METADATA_KEY, metadataValue: '1', location: { sheetId }, visibility: 'DOCUMENT' },
      },
    });
  }
  if (tabChanges.length > 0) {
    await withGoogleRetry(() => api.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: tabChanges } }));
    tabs = await readTabs(api, spreadsheetId);
  }

  // 値: 外部由来の文字列（件名・本文・社名）を数式にしないよう RAW で書く。要員タブの FILTER だけ USER_ENTERED
  const staffTabs = tabs.filter((t) => wanted.has(t.title));
  await withGoogleRetry(() =>
    api.spreadsheets.values.batchClear({
      spreadsheetId,
      requestBody: { ranges: [SALES_ALL_TAB, ...staffTabs.map((t) => t.title)].map((t) => `${quoteTab(t)}!A:${LAST_COL}`) },
    }),
  );
  await withGoogleRetry(() =>
    api.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: [
          { range: `${quoteTab(SALES_ALL_TAB)}!A1`, values: [HEADER, ...rows] },
          ...staffTabs.map((t) => ({
            range: `${quoteTab(t.title)}!A1`,
            values: [HEADER.map(staffHeaderOf)],
          })),
        ],
      },
    }),
  );
  await withGoogleRetry(() =>
    api.spreadsheets.values.batchClear({
      spreadsheetId,
      requestBody: { ranges: [`${quoteTab(SALES_SUMMARY_TAB)}!A:H`, `${quoteTab(SALES_STAFF_LIST_TAB)}!A:J`] },
    }),
  );
  // 要員一覧: 要員リスト由来の文字は RAW、候補数の数式は USER_ENTERED
  const staffList = staffListValues(engineers);
  await withGoogleRetry(() =>
    api.spreadsheets.values.update({
      spreadsheetId,
      range: `${quoteTab(SALES_STAFF_LIST_TAB)}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: staffList.strings },
    }),
  );
  // 要員タブの FILTER と「精度集計」の数式だけ USER_ENTERED（外部由来の文字列は含まない）
  await withGoogleRetry(() =>
    api.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: [
          ...staffTabs.map((t) => ({ range: `${quoteTab(t.title)}!A2`, values: [[staffFilterFormula(wanted.get(t.title) as string)]] })),
          { range: `${quoteTab(SALES_SUMMARY_TAB)}!A1`, values: summaryValues(labels) },
          { range: `${quoteTab(SALES_STAFF_LIST_TAB)}!G1`, values: staffList.formulas },
        ],
      },
    }),
  );

  const all = tabs.find((t) => t.title === SALES_ALL_TAB) as TabInfo;
  const format = [
    ...formatRequests(all.sheetId, all.rules, true),
    ...staffTabs.flatMap((t) => formatRequests(t.sheetId, t.rules, false)),
  ];
  await withGoogleRetry(() => api.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: format } }));
  return rows.length;
}
