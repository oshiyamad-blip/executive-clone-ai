// スキル語の未知語集計（辞書 skillDict.ts を育てる材料）。件数はバッチの統計（BatchStats）に、
// 頻出の未知語は「_状態」タブ（Sheets運用の本番）またはローカルJSONに残す。
// 未知語そのもの（スキル名）は秘匿モードのログに出さない（件数だけ）。人名・社名らしい語は数えない
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { durableStateInSheets, isDemo, logRedact, reviewDataDir } from './config.js';
import { classifySkillTokens } from './skillDict.js';
import { recordStat, getStats } from './heal/events.js';
import { sheetsDbConfigured, readStateJson, writeStateJson } from '../database/sheets.js';
import { safeErr } from './redact.js';

const STATE_KEY = 'unknownSkillTokens';
// 残す未知語の数（1セルに収まり、辞書の見直しに十分な数）
export const UNKNOWN_SKILL_KEEP = 150;
const MAX_TOKEN_CHARS = 40;

export interface UnknownSkillRecord {
  t: string; // 未知語（正規化後の表記）
  n: number; // 累計の出現数
  first: string; // 初出日 YYYY-MM-DD
  last: string; // 直近の出現日
}

interface UnknownSkillState {
  v: 1;
  tokens: UnknownSkillRecord[];
}

// 今回のバッチで数えた未知語（小文字 → 表記と件数）
const pending = new Map<string, { t: string; n: number }>();

// 連絡先・URLらしい語や長すぎる語は保存しない（件数には数える）
function storable(token: string): boolean {
  return token.length <= MAX_TOKEN_CHARS && !/@|https?:|www\.|\d{6,}/i.test(token);
}

// 抽出した1件分のスキル語を数える。names は表示名・営業元の会社名・担当者名（その語は人名・社名として数えない）
export function tallySkillTokens(tokens: string[], names: string[]): void {
  const { counted, unknown } = classifySkillTokens(tokens, names);
  if (counted.length > 0) recordStat('skillTokens', counted.length);
  if (unknown.length > 0) recordStat('unknownSkillTokens', unknown.length);
  for (const t of unknown) {
    if (!storable(t)) continue;
    const key = t.toLowerCase();
    const cur = pending.get(key);
    pending.set(key, { t: cur?.t ?? t, n: (cur?.n ?? 0) + 1 });
  }
}

export function pendingUnknownSkillTokens(): Array<{ t: string; n: number }> {
  return [...pending.values()];
}

export function resetSkillTokenTally(): void {
  pending.clear();
}

// 保存済みの未知語に今回の分を足し、出現数の多い順（同数なら直近に出た順）に上位 cap 件だけ残す（純関数）
export function mergeUnknownSkillTokens(
  prev: UnknownSkillRecord[],
  batch: Array<{ t: string; n: number }>,
  today: string,
  cap = UNKNOWN_SKILL_KEEP,
): UnknownSkillRecord[] {
  const byKey = new Map<string, UnknownSkillRecord>();
  for (const r of prev) {
    if (typeof r?.t !== 'string' || !r.t || typeof r.n !== 'number') continue;
    byKey.set(r.t.toLowerCase(), { t: r.t, n: r.n, first: String(r.first ?? today), last: String(r.last ?? today) });
  }
  for (const b of batch) {
    const key = b.t.toLowerCase();
    const cur = byKey.get(key);
    byKey.set(key, cur ? { ...cur, n: cur.n + b.n, last: today } : { t: b.t, n: b.n, first: today, last: today });
  }
  return [...byKey.values()]
    .sort((a, b) => b.n - a.n || b.last.localeCompare(a.last) || a.t.localeCompare(b.t))
    .slice(0, cap);
}

function inSheets(): boolean {
  return durableStateInSheets() && sheetsDbConfigured();
}

function localPath(): string {
  return join(process.cwd(), reviewDataDir(), 'unknown-skills.json');
}

async function loadRecords(): Promise<UnknownSkillRecord[]> {
  if (inSheets()) {
    const state = await readStateJson<UnknownSkillState>(STATE_KEY);
    return Array.isArray(state?.tokens) ? state.tokens : [];
  }
  if (!existsSync(localPath())) return [];
  const parsed = JSON.parse(readFileSync(localPath(), 'utf-8')) as UnknownSkillState;
  return Array.isArray(parsed?.tokens) ? parsed.tokens : [];
}

async function saveRecords(tokens: UnknownSkillRecord[]): Promise<void> {
  const state: UnknownSkillState = { v: 1, tokens };
  if (inSheets()) {
    await writeStateJson(STATE_KEY, state);
    return;
  }
  const dir = join(process.cwd(), reviewDataDir());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(localPath(), JSON.stringify(state, null, 2), 'utf-8');
}

// バッチの最後に1回呼ぶ。今回の未知語を保存済みの分に足して書く（demo・未知語なしでは何もしない）。
// 失敗してもバッチは止めない（辞書の見直し材料が1回分欠けるだけ）
export async function persistUnknownSkillTokens(): Promise<void> {
  const stats = getStats();
  if (stats.skillTokens > 0) {
    const rate = Math.round((stats.unknownSkillTokens / stats.skillTokens) * 100);
    console.log(`SESスキル語: ${stats.skillTokens}語のうち辞書にない語${stats.unknownSkillTokens}語（${rate}%）`);
  }
  if (isDemo() || pending.size === 0) return;
  const batch = pendingUnknownSkillTokens();
  try {
    const merged = mergeUnknownSkillTokens(await loadRecords(), batch, new Date().toISOString().slice(0, 10));
    await saveRecords(merged);
    pending.clear();
    const where = inSheets() ? `スプレッドシート「_状態」タブの ${STATE_KEY}` : localPath();
    const top = logRedact() ? '' : `（上位: ${merged.slice(0, 5).map((r) => `${r.t}×${r.n}`).join('、')}）`;
    console.log(`SESスキル語: 辞書にない語の累計上位${merged.length}件を ${where} に記録しました${top}`);
  } catch (err) {
    console.warn(`SESスキル語: 辞書にない語の記録に失敗しました（今回の分は記録しません）: ${safeErr(err)}`);
  }
}
