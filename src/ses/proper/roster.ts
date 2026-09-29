// 要員リスト（営業用のスプレッドシート: 「要員」タブ＋「スキルシート_<名前>」タブ）から、突合に使う社員を読む。
// 「要員」タブは営業が日々更新する一覧で、1行に No.・状況・名前・稼働開始時期・サマリ（■名前／■所属／■最寄／■単価／■スキル／
// ■経験年数…の決まった書式）がある。状況が「営業中」の行だけを使い、サマリの■の欄はAIを使わずに読む。
// 技術ごと・工程ごとの経験年数と立場は、同じ名前のスキルシートのタブをスキルシートの抽出（Haiku）で読む。
// 抽出の結果はタブの内容のハッシュで「_状態」に控え、内容が変わったときだけ抽出し直す（毎時の実行で費用を増やさない）。
// 要員の希望単価は必要案件単価として使う（社員は希望単価どおりで提案できる。5万円下までは単価交渉。ownMatch.ts）。
// 氏名は持たない（リストの名前はイニシャル）。リストに書かれた内容はデータとして扱い、ログには件数だけを出す
import { createHash } from 'crypto';
import { google, type sheets_v4 } from 'googleapis';
import { GOOGLE_REQUEST_TIMEOUT_MS } from '../../database/sheetBook.js';
import { properEngineerIdOf, readStateJson, writeStateJson, sheetsDbConfigured } from '../../database/sheets.js';
import { properRosterSpreadsheetId, properRosterTab, isDemo } from '../config.js';
import { sesMainAuth } from '../googleCreds.js';
import { normalizeSkills } from '../skillDict.js';
import { normalizePrefecture } from '../prefecture.js';
import { safeErr } from '../redact.js';
import { extractSkillSheet, sanitizeInitials } from './extractSkillSheet.js';
import {
  parseYears,
  parsePhaseYears,
  parseSkillYears,
  parseRole,
  hasEngineerLevel,
  sanitizeEngineerLevel,
  type EngineerLevel,
} from '../level.js';
import type { ProperEngineer } from '../../types/index.js';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
export const ROSTER_ACTIVE_STATUS = '営業中';
const SKILL_SHEET_TAB_PREFIX = 'スキルシート_';
// スキルシートのタブを文字にしたときの上限（抽出の入力の大きさを抑える）
const SHEET_TEXT_MAX = 30_000;

export function rosterConfigured(): boolean {
  return Boolean(properRosterSpreadsheetId());
}

// ===== サマリの読み取り（純関数） =====

export interface RosterSummary {
  age: number | null;
  affiliation: 'proper' | 'partner';
  station: string;
  rateMan: number | null;
  skills: string[];
  experienceText: string;
  note: string;
}

// 「■名　前：Y.Y」のような行 → { 名前: 'Y.Y' }（見出しの字間の空白は詰める。続きの行は前の見出しに足す）
export function parseSummaryFields(summary: string): Map<string, string> {
  const fields = new Map<string, string>();
  let last = '';
  for (const line of summary.normalize('NFKC').split(/\r?\n/)) {
    const m = line.match(/^\s*■\s*([^:：]{1,12}?)\s*[:：]\s*(.*)$/);
    if (m) {
      last = m[1].replace(/\s+/g, '');
      fields.set(last, m[2].trim());
    } else if (last && line.trim()) {
      fields.set(last, `${fields.get(last)}\n${line.trim()}`);
    }
  }
  return fields;
}

export function parseRosterSummary(summary: string): RosterSummary {
  const f = parseSummaryFields(summary);
  const get = (k: string) => f.get(k) ?? '';
  const age = get('年齢').match(/\d{2}/);
  const rate = get('単価').match(/(\d+(?:\.\d+)?)\s*万/);
  return {
    age: age ? Number(age[0]) : null,
    // 「弊社社員」「弊社正社員」「弊社契約社員」は自社。それ以外（「協力会社」「BP」など）はパートナー
    affiliation: !get('所属') || /弊社|自社|当社/.test(get('所属')) ? 'proper' : 'partner',
    station: get('最寄'),
    rateMan: rate ? Number(rate[1]) : null,
    skills: get('スキル').split(/[、,，/／\n]/).map((s) => s.trim()).filter(Boolean),
    experienceText: get('経験年数'),
    note: get('備考'),
  };
}

// サマリの「■経験年数」から分かるレベル（「Java案件：2年7ヶ月」「テスト11ヶ月、運用保守2年1ヶ月」）
export function summaryLevel(s: RosterSummary): EngineerLevel {
  return { skillYears: parseSkillYears(s.experienceText), phaseYears: parsePhaseYears(s.experienceText), role: parseRole(s.note) };
}

// 「10月」「10月\nor\n11月」「即日」→ 稼働可能日（最も早いもの）。年は今日から見て次に来る月
export function rosterAvailableFrom(raw: string, now: Date): string | null {
  const s = raw.normalize('NFKC');
  const today = new Date(now.getTime() + 9 * 3600_000);
  const y = today.getUTCFullYear();
  const m0 = today.getUTCMonth() + 1;
  if (/即日|即時|随時/.test(s)) return today.toISOString().slice(0, 10);
  const months = [...s.matchAll(/(\d{1,2})\s*月/g)].map((m) => Number(m[1])).filter((m) => m >= 1 && m <= 12);
  if (months.length === 0) return null;
  const dates = months.map((m) => `${m < m0 - 2 ? y + 1 : y}-${String(m).padStart(2, '0')}-01`);
  return dates.sort()[0] ?? null;
}

// 2つのレベルを合わせる（スキルシートの値を優先し、無い軸はサマリの値で補う）
export function mergeLevels(primary: EngineerLevel | null, fallback: EngineerLevel): EngineerLevel {
  if (!primary) return fallback;
  return {
    skillYears: primary.skillYears.length > 0 ? primary.skillYears : fallback.skillYears,
    phaseYears: primary.phaseYears.length > 0 ? primary.phaseYears : fallback.phaseYears,
    role: primary.role ?? fallback.role,
  };
}

// ===== 読み込み =====

function api(): sheets_v4.Sheets | null {
  const auth = sesMainAuth(SCOPES);
  return auth ? google.sheets({ version: 'v4', auth, timeout: GOOGLE_REQUEST_TIMEOUT_MS }) : null;
}

const quoteTab = (t: string) => `'${t.replace(/'/g, "''")}'`;

async function tabValues(sheets: sheets_v4.Sheets, id: string, tab: string): Promise<string[][]> {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: quoteTab(tab) });
  return ((res.data.values ?? []) as unknown[][]).map((r) => r.map((c) => (c === null || c === undefined ? '' : String(c))));
}

// AI判定に渡す経歴の本文。サマリの年齢・性別・最寄（判定に使わない項目）は除く
export function rosterProfileText(summary: string, sheetText: string): string {
  const s = summary
    .split(/\r?\n/)
    .filter((l) => !/^\s*■\s*(年\s*齢|性\s*別|最\s*寄|名\s*前)\s*[:：]/.test(l.normalize('NFKC')))
    .join('\n')
    .trim();
  return [s && `【要員リストのサマリ】\n${s}`, sheetText.trim() && `【スキルシート】\n${sheetText.trim()}`].filter(Boolean).join('\n\n');
}

// スキルシートのタブの本文（セルをタブ区切り・行を改行で並べる。結合セルの繰り返しは1つにする）
async function sheetText(sheets: sheets_v4.Sheets, id: string, tab: string): Promise<string> {
  const rows = (await tabValues(sheets, id, tab)).map((r) => r.map((c) => c.trim()).filter((c, i, a) => c && c !== a[i - 1]).join('\t'));
  return rows.filter(Boolean).join('\n').slice(0, SHEET_TEXT_MAX);
}

// スキルシートのタブのレベル。内容のハッシュで控えを引き、無ければ抽出して控える（案件DBが無ければ抽出しない）
async function sheetLevel(text: string): Promise<EngineerLevel | null> {
  if (!text.trim()) return null;
  const key = `roster_level:${createHash('sha256').update(text).digest('hex').slice(0, 32)}`;
  const cached = await readStateJson<EngineerLevel>(key);
  if (cached) return sanitizeEngineerLevel({ skillYears: cached.skillYears, phaseYears: cached.phaseYears, roleLevel: cached.role });
  if (!sheetsDbConfigured()) return null;
  const profile = await extractSkillSheet({ kind: 'text', text });
  if (profile.injectionSuspected || !profile.level) return null;
  await writeStateJson(key, profile.level);
  return profile.level;
}

export async function loadRosterEngineers(now = new Date()): Promise<ProperEngineer[]> {
  if (isDemo() || !rosterConfigured()) return [];
  const sheets = api();
  if (!sheets) {
    console.warn('要員リスト: Google の認証情報が無いため読めません');
    return [];
  }
  const id = properRosterSpreadsheetId();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: id, fields: 'sheets.properties(sheetId,title)' });
  const gidOf = new Map((meta.data.sheets ?? []).map((s) => [s.properties?.title ?? '', s.properties?.sheetId ?? 0]));
  const rows = await tabValues(sheets, id, properRosterTab());
  const headerAt = rows.findIndex((r) => r.includes('状況') && r.includes('名前') && r.includes('サマリ'));
  if (headerAt < 0) {
    console.warn(`要員リスト: 「${properRosterTab()}」タブに「状況」「名前」「サマリ」の見出しの行が見つかりません`);
    return [];
  }
  const h = rows[headerAt];
  const col = (name: string) => h.indexOf(name);
  const out: ProperEngineer[] = [];
  let sheetFailures = 0;
  for (const r of rows.slice(headerAt + 1)) {
    const name = (r[col('名前')] ?? '').trim();
    if (!name || (r[col('状況')] ?? '').trim() !== ROSTER_ACTIVE_STATUS) continue;
    const s = parseRosterSummary(r[col('サマリ')] ?? '');
    const skills = normalizeSkills(s.skills);
    const tab = `${SKILL_SHEET_TAB_PREFIX}${name}`;
    let level = summaryLevel(s);
    let text = '';
    if (gidOf.has(tab)) {
      try {
        text = await sheetText(sheets, id, tab);
        level = mergeLevels(await sheetLevel(text), level);
      } catch (err) {
        sheetFailures += 1;
        console.warn(`要員リスト: スキルシートのタブを読めませんでした（サマリの内容だけで照合します）: ${safeErr(err)}`);
      }
    }
    const available = (r[col('稼働開始時期')] ?? '').trim();
    const head = s.experienceText.split(/[（(]/)[0] ?? '';
    const label = sanitizeInitials(name, '');
    out.push({
      id: properEngineerIdOf(`roster:${id}:${name}`),
      displayName: label || name,
      fullName: '',
      proposalLabel: label,
      fileId: '',
      skillSheetUrl: gidOf.has(tab) ? `https://docs.google.com/spreadsheets/d/${id}/edit#gid=${gidOf.get(tab)}` : '',
      skills: normalizeSkills([...skills, ...level.skillYears.map((y) => y.skill)]),
      experienceYears: parseYears(head),
      requiredProjectRate: s.rateMan,
      residence: s.station,
      prefecture: normalizePrefecture(s.station),
      availableDate: available,
      availableFrom: rosterAvailableFrom(available, now),
      remoteWish: 'unknown',
      status: 'available',
      affiliation: s.affiliation,
      ...(s.note ? { wish: s.note } : {}),
      ...(hasEngineerLevel(level) ? { level } : {}),
      profileText: rosterProfileText(r[col('サマリ')] ?? '', text),
    });
  }
  console.log(`要員リスト: 営業中${out.length}名を読みました${sheetFailures > 0 ? `（スキルシートのタブを読めなかった要員${sheetFailures}名）` : ''}`);
  return out;
}
