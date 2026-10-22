// 相場の判定（LLM を使わない集計）。直近90日に届いた案件の単価の分布を「主なスキル×地域」で作り、
// 新しい案件の単価が同じ条件の案件の中で上位何%かを出す。自社に届く時点の単価（上流の取り分を引いた後）の相場で、
// 市場全体の相場ではない。件数が少ないうちは条件を広げ（スキルだけ→全体）、それでも足りなければ「参考」とする
import { normalizeSkills, skillCategory } from './skillDict.js';
import type { Project } from '../types/index.js';

export const MARKET_LOOKBACK_DAYS = 90;
export const MARKET_MIN_SAMPLES = 8;
const HIGH_SHARE = 0.75;
const LOW_SHARE = 0.25;

const REGIONS: Array<[string, string[]]> = [
  ['首都圏', ['東京都', '神奈川県', '埼玉県', '千葉県']],
  ['関西', ['大阪府', '京都府', '兵庫県', '奈良県', '滋賀県']],
  ['東海', ['愛知県', '岐阜県', '三重県', '静岡県']],
  ['福岡', ['福岡県', '佐賀県']],
];

export function regionOf(p: Pick<Project, 'remote' | 'prefecture'>): string {
  if (p.remote === 'full') return 'フルリモート';
  if (!p.prefecture) return '地域不明';
  return REGIONS.find(([, prefs]) => prefs.includes(p.prefecture as string))?.[0] ?? p.prefecture;
}

// 主なスキル: 必須の先頭の技術（役割・工程・業種の語は除く）。無ければ尚可の先頭
export function primarySkillOf(p: Pick<Project, 'requiredSkills' | 'preferredSkills'>): string | null {
  for (const list of [p.requiredSkills, p.preferredSkills]) {
    const hit = normalizeSkills(list).find((s) => skillCategory(s) === 'skill');
    if (hit) return hit;
  }
  return null;
}

export function projectRate(p: Pick<Project, 'rateMin' | 'rateMax'>): number | null {
  const v = p.rateMax ?? p.rateMin;
  return v !== null && Number.isFinite(v) && v > 0 ? v : null;
}

export interface MarketLabel {
  level: 'high' | 'normal' | 'low' | 'insufficient';
  text: string; // 案件タブ「相場」列とサマリに出す文（例: 高め（上位18%・Java×首都圏 24件・中央値65万））
  topShare: number | null; // 上位何%か（0〜1。小さいほど高い）
}

function median(sorted: number[]): number {
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// 同じ条件の案件（target 自身は除く）の単価の中で target が上位何%か。条件は細かい順に試す
export function marketLabelOf(target: Project, pool: Project[]): MarketLabel | null {
  const rate = projectRate(target);
  if (rate === null) return null;
  const skill = primarySkillOf(target);
  const region = regionOf(target);
  const levels: Array<{ name: string; match: (p: Project) => boolean }> = [];
  if (skill) {
    levels.push({ name: `${skill}×${region}`, match: (p) => primarySkillOf(p) === skill && regionOf(p) === region });
    levels.push({ name: skill, match: (p) => primarySkillOf(p) === skill });
  }
  levels.push({ name: '全案件', match: () => true });
  for (const lv of levels) {
    const values = pool
      .filter((p) => p.id !== target.id && lv.match(p))
      .map(projectRate)
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b);
    if (values.length < MARKET_MIN_SAMPLES) continue;
    const below = values.filter((v) => v < rate).length;
    const equal = values.filter((v) => v === rate).length;
    const share = (below + equal / 2) / values.length; // 下から何割の位置か
    const top = 1 - share;
    const level = share >= HIGH_SHARE ? 'high' : share <= LOW_SHARE ? 'low' : 'normal';
    const head = level === 'high' ? '高め' : level === 'low' ? '低め' : '相場なみ';
    const topPct = Math.max(1, Math.round(top * 100));
    return {
      level,
      topShare: top,
      text: `${head}（上位${topPct}%・${lv.name}の直近${MARKET_LOOKBACK_DAYS}日 ${values.length}件・中央値${fmt(median(values))}万）`,
    };
  }
  return { level: 'insufficient', topShare: null, text: `参考（同じ条件の案件が${MARKET_MIN_SAMPLES}件未満）` };
}

// ===== サマリメールに載せる「相場より高い注目案件」（案件名はメールにだけ載せ、ログには件数だけ） =====

let highlights: Array<{ title: string; text: string; topShare: number }> = [];

export function resetMarketHighlights(): void {
  highlights = [];
}

export function recordMarketHighlights(items: Array<{ project: Project; label: MarketLabel }>): void {
  for (const { project, label } of items) {
    if (label.level === 'high' && label.topShare !== null) highlights.push({ title: project.title, text: label.text, topShare: label.topShare });
  }
}

export function marketSummaryLines(forEmail: boolean, max = 5): string[] {
  if (highlights.length === 0) return [];
  if (!forEmail) return [`相場より高い新着案件: ${highlights.length}件`];
  const top = [...highlights].sort((a, b) => a.topShare - b.topShare).slice(0, max);
  return [
    '',
    `【相場より高い新着案件】${highlights.length}件（上位${top.length}件。案件タブの「相場」列でも確認できます）`,
    ...top.map((h) => `・${h.title} — ${h.text}`),
  ];
}
