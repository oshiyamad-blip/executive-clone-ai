// 外部マッチ: 営業が一目で見送る組（国籍・稼働率・リモート・年齢）を、AI判定の前に決まりごとで外す。
// 迷うときは外さない（不明は通す）。判定の根拠は文面にあるものだけ
import { ageLimitOf } from '../match.js';
import { isFullRemoteLocation, wideRegionOf } from '../prefecture.js';
import type { Engineer, Project } from '../../types/index.js';

export type HardRule = 'nationality' | 'utilization' | 'remote' | 'hybrid' | 'age' | 'area';
export interface HardMismatch {
  rule: HardRule;
  reason: string;
}

const norm = (s: string): string => s.normalize('NFKC');

// --- 1. 国籍 ---
const FORBID_FOREIGN = [
  /外国籍(?:の方)?(?:は|も)?\s*[:：]?\s*(?:検討)?(?:不可|NG|×|✕|✖|お断り|対象外|受け入れ不可)/i,
  /日本国籍(?:の方)?(?:のみ|限定|必須|に限る)/,
  /日本人(?:のみ|限定)/,
];
const NOT_NATIONALITY_TAIL = /[在本転移戸入退書学除所復帰]$/;

export function projectForbidsForeign(text: string): boolean {
  const s = norm(text);
  return FORBID_FOREIGN.some((re) => re.test(s));
}

export function engineerIsForeign(text: string): boolean {
  const s = norm(text);
  if (/外国籍/.test(s.replace(/外国籍(?:の方)?(?:は|も)?\s*[:：]?\s*(?:検討)?(?:不可|NG|×|可|OK)/gi, ''))) return true;
  const field = s.match(/国籍\s*[:：]\s*([^\s、,。\n（()]+)/);
  if (field && !/^(?:日本|不明|非公開|未記載|なし|—|-)/.test(field[1])) return true;
  for (const m of s.matchAll(/([゠-ヿ一-鿿]{2,8})籍/g)) {
    const w = m[1];
    if (/^日本/.test(w) || NOT_NATIONALITY_TAIL.test(w)) continue;
    return true;
  }
  return false;
}

// --- 2. 稼働率 ---
const FULL_TIME = /稼働率?\s*[:：]?\s*100\s*%|週\s*5\s*日?|フル稼働|フルタイム|常時稼働|(?<![\d.〜~])1(?:\.0)?\s*人月(?!の案件|案件)|100\s*%/;

// 「週3日出社」は稼働の日数でなく出社の日数なので、稼働の判定から除く
const stripAttend = (s: string): string => s.replace(/週\s*[1-4]\s*[日回]?\s*(?:[〜~\-]\s*\d\s*[日回]?)?\s*(?:出社|出勤|リモート|在宅|常駐)/g, '');

export function engineerPartTime(e: { utilization?: string }, text: string): boolean {
  const lines = norm(text).split('\n').filter((l) => /稼働|副業|並行|人月/.test(l));
  const s = [norm(e.utilization ?? ''), ...lines].join('\n');
  if (!s.trim() || FULL_TIME.test(s)) return false;
  for (const m of s.matchAll(/(\d(?:\.\d+)?)\s*(?:[〜~\-]\s*(\d(?:\.\d+)?))?\s*人月/g)) {
    if (Math.max(Number(m[1]), Number(m[2] ?? 0)) < 0.9) return true;
  }
  for (const m of s.matchAll(/(\d{1,3})\s*%/g)) {
    if (Number(m[1]) < 90 && Number(m[1]) > 0) return true;
  }
  if (/週\s*[1-4]/.test(stripAttend(s))) return true;
  return /副業(?!不可|禁止)/.test(s);
}

export function projectAllowsPartTime(text: string): boolean {
  const s = norm(text);
  if (/週\s*[1-4]/.test(stripAttend(s))) return true;
  for (const m of s.matchAll(/稼働(?:率)?[^\n]{0,8}?(\d{1,3})\s*%/g)) if (Number(m[1]) < 100) return true;
  return /副業|兼業|並行|時短|短時間|稼働(?:率)?[^\n]{0,6}(?:相談|調整|柔軟)|[0-9.]+\s*人月未満/.test(s);
}

export function projectNeedsFullTime(text: string): boolean {
  return FULL_TIME.test(norm(text));
}

// --- 3. リモート ---
const ENGINEER_FULL_REMOTE = /フルリモート(?:希望)?\s*[（(][^）)\n]{0,12}初日|初日(?:の|のみ)?\s*出社(?:のみ)?\s*(?:可|OK)|フルリモート\s*(?:必須|のみ|限定)|完全リモート\s*(?:必須|のみ|限定)|リモート(?:のみ|限定|必須)|出社\s*不可|出社(?:は)?できません|初日のみ出社|出社(?:は)?初日のみ/;
const PROJECT_REMOTE_OK = /フルリモート(?!\s*(?:不可|NG|×|は不可|はNG|はできません|ではない|ではありません))|完全リモート(?!\s*(?:不可|NG|×))|基本(?:的に)?(?:は)?\s*(?:リモート|在宅)|リモート(?:中心|主体|ワーク中心)|在宅(?:中心|主体)|月\s*[1-3]\s*[回日]\s*(?:程度)?(?:の)?(?:出社|出勤)|出社\s*[:：]?\s*月\s*[1-3]|原則(?:リモート|在宅)/;
const PROJECT_ATTEND = [
  /常駐(?!\s*(?:なし|無し|不要|ではな))/,
  /出社\s*必須|必須\s*出社|フル出社|全日出社|毎日出社|オンサイト/,
  /週\s*[1-5]\s*[日回]\s*(?:程度|ほど)?\s*(?:の)?\s*(?:出社|出勤)/,
  /(?:出社|出勤)[^\n。]{0,6}週\s*[1-5]\s*[日回]/,
];

export function engineerNeedsFullRemote(text: string): boolean {
  return ENGINEER_FULL_REMOTE.test(norm(text));
}

export function projectNeedsAttendance(text: string, remote: Project['remote'] | undefined): boolean {
  const s = norm(text);
  if (PROJECT_REMOTE_OK.test(s)) return false;
  return PROJECT_ATTEND.some((re) => re.test(s)) || remote === 'none';
}

// 在宅のある働き方（ハイブリッド以上）を必須とする要員 × 在宅の無い案件。任意の言い方（出社も可・できれば）は外さない
const ENGINEER_HYBRID = /ハイブリッド(?:環境|勤務|ワーク)?\s*以上\s*(?:希望|必須)|リモート併用\s*(?:希望|必須)|一部リモート\s*(?:希望|必須)|週\s*[1-5]\s*[日回]\s*以上\s*(?:の)?\s*(?:リモート|在宅)\s*(?:勤務)?\s*(?:希望|必須)/;
const HYBRID_OPTIONAL = /出社(?:も|は)?\s*(?:可|OK)|できれば|可能であれば|可能なら|あれば|尚可|歓迎|相談|応相談/;
const PROJECT_NO_REMOTE = /フル出社|完全常駐|在宅(?:勤務)?\s*(?:なし|無し|不可)|(?<!フル|完全)リモート(?:勤務|ワーク)?\s*(?:なし|無し|不可|NG|×)|テレワーク\s*(?:なし|無し|不可)/;
const PROJECT_HAS_REMOTE = /ハイブリッド|リモート併用|一部リモート|週\s*[1-4]\s*[日回]\s*(?:程度)?\s*(?:は|の)?\s*(?:リモート|在宅)|リモート(?:可|OK)|在宅(?:可|OK)/;

export function engineerNeedsHybrid(text: string): boolean {
  return norm(text).split('\n').some((l) => ENGINEER_HYBRID.test(l) && !HYBRID_OPTIONAL.test(l));
}

export function projectHasNoRemote(text: string, remote: Project['remote'] | undefined): boolean {
  const s = norm(text);
  if (PROJECT_HAS_REMOTE.test(s) || PROJECT_REMOTE_OK.test(s)) return false;
  return PROJECT_NO_REMOTE.test(s) || remote === 'none';
}

// --- 4. 年齢 ---
export function ageOverLimit(age: number | null | undefined, text: string): number | null {
  if (age === null || age === undefined) return null;
  const limit = ageLimitOf(text);
  return limit !== null && age > limit ? limit : null;
}

type EngineerLike = Pick<Engineer, 'age' | 'utilization'> & Partial<Pick<Engineer, 'businessFlow' | 'skills' | 'residence' | 'availableDate' | 'prefecture'>>;
type ProjectLike = Pick<Project, 'title' | 'businessFlow' | 'remote'> & Partial<Pick<Project, 'detail' | 'location' | 'prefecture'>>;

// --- 5. 勤務地と住まい ---
// 案件の勤務地の都道府県と要員の住まいの都道府県が両方分かり、地方（首都圏・中部・近畿など）が違う組。フルリモートは外さない
const FULL_REMOTE_TEXT = /フルリモート(?!\s*(?:不可|NG|×|は不可|はNG|はできません|ではない|ではありません))|完全リモート(?!\s*(?:不可|NG|×))/;

export function areaMismatch(e: Pick<EngineerLike, 'prefecture'>, p: ProjectLike, pText: string): { project: string; engineer: string } | null {
  const pr = wideRegionOf(p.prefecture ?? null);
  const er = wideRegionOf(e.prefecture ?? null);
  if (!pr || !er || pr === er) return null;
  if (p.remote === 'full' || isFullRemoteLocation(p.location ?? '')) return null;
  const s = norm(pText);
  if (FULL_REMOTE_TEXT.test(s) && !PROJECT_ATTEND.some((re) => re.test(s)) && p.remote !== 'none') return null;
  return { project: p.prefecture as string, engineer: e.prefecture as string };
}

export function externalHardMismatches(e: EngineerLike, mailText: string, p: ProjectLike): HardMismatch[] {
  const eText = [e.businessFlow ?? '', e.utilization ?? '', (e.skills ?? []).join(' '), e.residence ?? '', e.availableDate ?? '', mailText].join('\n');
  const pText = [p.title ?? '', p.businessFlow ?? '', p.detail ?? ''].join('\n');
  const out: HardMismatch[] = [];
  if (projectForbidsForeign(pText) && engineerIsForeign(eText)) out.push({ rule: 'nationality', reason: '案件は外国籍不可・要員は外国籍' });
  if (engineerPartTime(e, eText) && !projectAllowsPartTime(pText)) out.push({ rule: 'utilization', reason: '要員は常時稼働でなく、案件は稼働の減を許していない' });
  if (engineerNeedsFullRemote(eText) && projectNeedsAttendance(pText, p.remote)) out.push({ rule: 'remote', reason: '要員はフルリモート必須・案件は出社が要る' });
  if (engineerNeedsHybrid(eText) && projectHasNoRemote(pText, p.remote)) out.push({ rule: 'hybrid', reason: '要員は在宅のある働き方が必須・案件は出社のみ' });
  const limit = ageOverLimit(e.age, pText);
  if (limit !== null) out.push({ rule: 'age', reason: `案件の年齢上限${limit}歳を超える（${e.age}歳）` });
  const area = areaMismatch(e, p, pText);
  if (area) out.push({ rule: 'area', reason: `案件の勤務地（${area.project}）と要員の住まい（${area.engineer}）が別の地方で、フルリモートでない` });
  return out;
}

export function externalHardMismatch(e: EngineerLike, mailText: string, p: ProjectLike): string[] {
  return externalHardMismatches(e, mailText, p).map((m) => m.reason);
}
