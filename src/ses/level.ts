// 案件と要員の「レベル」の照合（LLMを使わない）。技術スキルの名前が合っていても、次の3つの軸は別の概念として比べる:
//   ① 技術ごとの経験年数（「Java 3年以上」）と IT経験の合計年数
//   ② 工程（要件定義→基本設計→詳細設計→製造→テスト→運用保守）: 案件が求める最も上流の工程を要員が経験しているか
//   ③ 立場（PG→SE→PL→PM）
// 軸の平均ではなく最も弱い軸で決める（どれか1つがはっきり足りない、または2つ以上の軸が少しずつ足りなければ除外。1つの軸だけ少し足りなければ「経験交渉」として残す）。
// 片方の値が分からない軸は判定しない（案件に書かれていない条件で落とさない。要員側が不明なら確認事項として根拠に載せる）
import { normalizeSkill, skillCategory } from './skillDict.js';

export const PHASES = ['要件定義', '基本設計', '詳細設計', '製造', 'テスト', '運用保守'] as const;
export type Phase = (typeof PHASES)[number];
export const ROLES = ['PG', 'SE', 'PL', 'PM'] as const;
export type RoleLevel = (typeof ROLES)[number];

export interface SkillYears {
  skill: string; // 正規化済みの技術名
  years: number;
}

export interface PhaseYears {
  phase: Phase;
  years: number;
}

// 案件が求めるレベル（抽出の結果。記載の無い項目は null・空配列）
export interface ProjectLevel {
  skillYears: SkillYears[]; // 必須の技術ごとの最低経験年数
  totalYears: number | null; // IT経験の合計の最低年数
  topPhase: Phase | null; // 担当する工程のうち最も上流
  role: RoleLevel | null; // 求める立場
  juniorOk: boolean; // 若手可・未経験可・経験浅め可
  selfDriven: boolean; // 一人称で進められることが必要
}

// 要員（社員）のレベル（スキルシート・要員リスト・管理表から）
export interface EngineerLevel {
  skillYears: SkillYears[];
  phaseYears: PhaseYears[];
  role: RoleLevel | null;
}

// 工程の経験として数える最短の期間（研修・数か月の手伝いだけで上流の経験ありとしない）
export const PHASE_MIN_YEARS = 0.5;

export const EMPTY_PROJECT_LEVEL: ProjectLevel = { skillYears: [], totalYears: null, topPhase: null, role: null, juniorOk: false, selfDriven: false };

export function isPhase(v: unknown): v is Phase {
  return typeof v === 'string' && (PHASES as readonly string[]).includes(v);
}

export function isRole(v: unknown): v is RoleLevel {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}

const phaseIdx = (p: Phase) => PHASES.indexOf(p);
const roleIdx = (r: RoleLevel) => ROLES.indexOf(r);

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function validYears(n: unknown, max = 50): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max ? round1(n) : null;
}

// ===== 文字列の読み取り（管理表・要員リストの人が書いた値） =====

// 「3年6ヶ月」「2年7か月」「11ヶ月」「約6年9ヵ月」「2.5年」「2.5」→ 年（小数第1位）。読めなければ null
export function parseYears(raw: string): number | null {
  // 「2026年10月」のような日付は年数ではない（4桁の年を消してから読む）
  const s = raw.normalize('NFKC').replace(/\d{4}\s*年\s*(?:\d{1,2}\s*月)?/g, ' ');
  const y = s.match(/(\d+(?:\.\d+)?)\s*年/);
  const m = s.match(/(\d+)\s*(?:ヶ|か|カ|ケ|ヵ|箇)\s*月/);
  if (y || m) return validYears((y ? Number(y[1]) : 0) + (m ? Number(m[1]) / 12 : 0));
  const bare = s.trim().match(/^(\d+(?:\.\d+)?)$/);
  return bare ? validYears(Number(bare[1])) : null;
}

const PHASE_WORDS: Array<[RegExp, Phase]> = [
  [/要件定義|要求定義|要件調査|上流/, '要件定義'],
  [/基本設計|外部設計|概要設計/, '基本設計'],
  [/詳細設計|内部設計/, '詳細設計'],
  [/製造|実装|コーディング|開発|プログラミング/, '製造'],
  [/テスト|試験|検証/, 'テスト'],
  [/運用|保守|監視/, '運用保守'],
];

export function phaseOf(token: string): Phase | null {
  const t = token.normalize('NFKC');
  const viaDict = normalizeSkill(t);
  if (skillCategory(viaDict) === 'phase' && isPhase(viaDict)) return viaDict;
  return PHASE_WORDS.find(([re]) => re.test(t))?.[1] ?? null;
}

// 「要件調査3ヶ月、テスト11ヶ月、運用保守2年1ヶ月」「詳細設計〜結合テスト 2年」→ 工程ごとの年数（同じ工程は合計）。
// 範囲の記載はその範囲のすべての工程に同じ年数を入れる
export function parsePhaseYears(raw: string): PhaseYears[] {
  const acc = new Map<Phase, number>();
  for (const part of raw.normalize('NFKC').split(/[、,，/／\n（(）)]|(?:\s{2,})/)) {
    const years = parseYears(part);
    if (years === null) continue;
    const label = part.replace(/[\d.]+\s*(?:年|ヶ月|か月|カ月|ヵ月|ケ月)/g, '').replace(/[:：()（）約]/g, ' ');
    const range = label.split(/[〜~]/);
    const a = phaseOf(range[0] ?? '');
    const b = range.length > 1 ? phaseOf(range[1] ?? '') : null;
    const phases = a && b ? PHASES.slice(Math.min(phaseIdx(a), phaseIdx(b)), Math.max(phaseIdx(a), phaseIdx(b)) + 1) : a ? [a] : [];
    for (const p of phases) acc.set(p, round1((acc.get(p) ?? 0) + years));
  }
  return PHASES.filter((p) => acc.has(p)).map((p) => ({ phase: p, years: acc.get(p) as number }));
}

// 「Java 2.5年, Oracle 2年」「Java案件：2年7ヶ月」「VB.NET：約6年9ヶ月」→ 技術ごとの年数（工程の語は除く）
export function parseSkillYears(raw: string): SkillYears[] {
  const out = new Map<string, number>();
  for (const part of raw.normalize('NFKC').split(/[、,，\n]|[（(]|[)）]/)) {
    const years = parseYears(part);
    if (years === null) continue;
    const name = part
      .replace(/[\d.]+\s*(?:年|ヶ月|か月|カ月|ヵ月|ケ月)/g, '')
      .replace(/(?:案件|経験|開発|約)/g, '')
      .replace(/[:：]/g, ' ')
      .trim();
    // 「SQL / PL/SQL：9年」のように並んだ技術は、それぞれに同じ年数を入れる
    for (const one of name.split(/\s+\/\s+|・/)) {
      const t = one.trim();
      if (!t || phaseOf(t)) continue;
      const skill = normalizeSkill(t);
      if (!skill || skillCategory(skill) === 'phase') continue;
      out.set(skill, Math.max(out.get(skill) ?? 0, years));
    }
  }
  return [...out].map(([skill, years]) => ({ skill, years }));
}

export function parseRole(raw: string): RoleLevel | null {
  const s = raw.normalize('NFKC').toUpperCase();
  for (const r of [...ROLES].reverse()) if (new RegExp(`(^|[^A-Z])${r}([^A-Z]|$)`).test(s)) return r;
  if (/リーダー/.test(s)) return 'PL';
  return null;
}

export function formatSkillYears(list: SkillYears[]): string {
  return list.map((s) => `${s.skill} ${s.years}年`).join(', ');
}

export function formatPhaseYears(list: PhaseYears[]): string {
  return list.map((p) => `${p.phase} ${p.years}年`).join(', ');
}

// ===== 案件のレベル（抽出結果・保存した JSON の検証） =====

// 保存した JSON（人が書き換えうる列）や抽出結果を、型どおりの値だけに絞る
export function sanitizeProjectLevel(raw: unknown): ProjectLevel {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_PROJECT_LEVEL };
  const r = raw as Record<string, unknown>;
  const skillYears: SkillYears[] = [];
  if (Array.isArray(r.skillYears)) {
    for (const x of r.skillYears.slice(0, 10)) {
      const o = x as Record<string, unknown>;
      const years = validYears(o?.years, 30);
      const skill = typeof o?.skill === 'string' ? normalizeSkill(o.skill.slice(0, 60)) : '';
      if (skill && years !== null && years > 0 && skillCategory(skill) !== 'phase') skillYears.push({ skill, years });
    }
  }
  const total = validYears(r.totalYears, 30);
  return {
    skillYears,
    totalYears: total !== null && total > 0 ? total : null,
    topPhase: isPhase(r.topPhase) ? r.topPhase : null,
    role: isRole(r.role) ? r.role : null,
    juniorOk: r.juniorOk === true,
    selfDriven: r.selfDriven === true,
  };
}

// スキルシートの抽出結果（AIの出力）や人の入力を、型どおりの値だけに絞る
export function sanitizeEngineerLevel(raw: { skillYears?: unknown; phaseYears?: unknown; roleLevel?: unknown }): EngineerLevel {
  const skillYears: SkillYears[] = [];
  for (const x of Array.isArray(raw.skillYears) ? raw.skillYears.slice(0, 30) : []) {
    const o = x as Record<string, unknown>;
    const years = validYears(o?.years);
    const skill = typeof o?.skill === 'string' ? normalizeSkill(o.skill.slice(0, 60)) : '';
    if (skill && years !== null && years > 0 && skillCategory(skill) !== 'phase') skillYears.push({ skill, years });
  }
  const phaseYears: PhaseYears[] = [];
  for (const x of Array.isArray(raw.phaseYears) ? raw.phaseYears : []) {
    const o = x as Record<string, unknown>;
    const years = validYears(o?.years);
    if (isPhase(o?.phase) && years !== null && years > 0 && !phaseYears.some((p) => p.phase === o.phase)) phaseYears.push({ phase: o.phase, years });
  }
  return { skillYears, phaseYears: PHASES.flatMap((p) => phaseYears.filter((y) => y.phase === p)), role: isRole(raw.roleLevel) ? raw.roleLevel : null };
}

export function hasEngineerLevel(l: EngineerLevel | undefined): boolean {
  return Boolean(l && (l.skillYears.length > 0 || l.phaseYears.length > 0 || l.role !== null));
}

export function hasLevelRequirement(l: ProjectLevel | undefined): boolean {
  return Boolean(l && (l.skillYears.length > 0 || l.totalYears !== null || l.topPhase !== null || l.role !== null || l.juniorOk || l.selfDriven));
}

export function projectLevelJson(l: ProjectLevel | undefined): string {
  return l && hasLevelRequirement(l) ? JSON.stringify(l) : '';
}

export function parseProjectLevelJson(raw: string): ProjectLevel | undefined {
  if (!raw.trim()) return undefined;
  try {
    return sanitizeProjectLevel(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

// ===== 照合 =====

export interface LevelVerdict {
  verdict: 'ok' | 'negotiate' | 'exclude';
  gaps: string[]; // 少し足りない軸（経験交渉の中身）
  unknowns: string[]; // 要員側が分からず判定できなかった軸（確認事項）
  bonus: string[]; // 若手可など
  gapScore: number; // 足りない度合い（0が最良。並び順に使う）
}

// 要員の最も上流の経験工程（PHASE_MIN_YEARS 以上の経験があるもの）
export function topPhaseOf(level: EngineerLevel | undefined): Phase | null {
  const done = (level?.phaseYears ?? []).filter((p) => p.years >= PHASE_MIN_YEARS);
  if (done.length === 0) return null;
  return PHASES[Math.min(...done.map((p) => phaseIdx(p.phase)))] ?? null;
}

// yearsTolerance: 経験年数がこの年数までの不足なら経験交渉（超えたら除外）。工程・立場は1段までの不足が交渉
export function evaluateLevel(
  project: ProjectLevel | undefined,
  engineer: EngineerLevel | undefined,
  engineerTotalYears: number | null,
  yearsTolerance = 1,
): LevelVerdict {
  const v: LevelVerdict = { verdict: 'ok', gaps: [], unknowns: [], bonus: [], gapScore: 0 };
  if (!project) return v;
  let exclude = false;
  // 少し足りない軸（技術年数・IT経験・工程・立場）。2つ以上の軸で足りなければ除外する
  const shortAxes = new Set<string>();
  const years = (label: string, need: number, have: number | null, axis = 'years') => {
    if (have === null) {
      v.unknowns.push(`${label}${need}年以上`);
      return;
    }
    const short = round1(need - have);
    if (short <= 0) return;
    if (short > yearsTolerance) exclude = true;
    else {
      v.gaps.push(`${label}${need}年以上に対し${have}年`);
      v.gapScore += short;
      shortAxes.add(axis);
    }
  };
  const skillMap = new Map((engineer?.skillYears ?? []).map((s) => [s.skill.toLowerCase(), s.years]));
  for (const req of project.skillYears) {
    // 技術ごとの年数が無い要員は合計年数を上限の目安にする（合計より長い技術経験は無いため、合計で足りなければ足りない）
    const have = skillMap.get(req.skill.toLowerCase()) ?? null;
    if (have !== null) years(req.skill, req.years, have);
    else if (engineerTotalYears !== null && engineerTotalYears < req.years) years(`${req.skill}（合計年数で判定）`, req.years, engineerTotalYears);
    else v.unknowns.push(`${req.skill}${req.years}年以上`);
  }
  if (project.totalYears !== null) years('IT経験', project.totalYears, engineerTotalYears);

  if (project.topPhase) {
    const top = topPhaseOf(engineer);
    if (!top) v.unknowns.push(`${project.topPhase}の経験`);
    else {
      const steps = phaseIdx(top) - phaseIdx(project.topPhase);
      if (steps >= 2) exclude = true;
      else if (steps === 1) {
        v.gaps.push(`工程は${project.topPhase}から（経験は${top}から）`);
        v.gapScore += 1;
        shortAxes.add('phase');
      }
    }
  }
  if (project.role) {
    const role = engineer?.role ?? null;
    if (!role) v.unknowns.push(`立場${project.role}`);
    else {
      const steps = roleIdx(project.role) - roleIdx(role);
      if (steps >= 2) exclude = true;
      else if (steps === 1) {
        v.gaps.push(`立場は${project.role}（経験は${role}）`);
        v.gapScore += 1;
        shortAxes.add('role');
      }
    }
  }
  if (project.juniorOk) v.bonus.push('若手可');
  if (project.selfDriven) v.unknowns.push('一人称で進められるか');
  if (shortAxes.size >= 2) exclude = true;
  v.verdict = exclude ? 'exclude' : v.gaps.length > 0 ? 'negotiate' : 'ok';
  return v;
}
