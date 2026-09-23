// スキル同義・類似辞書（人のフィードバックで育てる）。
// 静的な skillDict.ts（表記ゆれの正規化）とは別に、「PHP≈Laravel」「React≈Next.js」のような
// 実質同義／相互に満たすスキルの対応を蓄積する。マッチング時のスキル一致判定で参照する。
// 共有の正: 複数人運用のため prod=DB（Notion/Sheets）、demo=ローカルJSON。prodでDBに保存できなかった分は
// ローカルJSONに退避し、同じ環境での読み込み時にマージする。
// 照合は skillDict の正規化後の表記で行う（'vue' と入力しても案件側の 'Vue.js' に効くように）
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { isDemo, reviewDataDir } from './config.js';
import { normalizeSkill } from './skillDict.js';
import { fetchSkillEquivalences, saveSkillEquivalence } from '../database/index.js';
import { safeErr } from './redact.js';
import type { SkillEquivalence } from '../types/index.js';

// 正規化・小文字化したスキル → 相互に満たすスキル集合（同じく正規化・小文字化）
const cache = new Map<string, Set<string>>();
let loaded = false;

// 同義辞書の照合キー（skillDict で正規化してから小文字化）
export function equivalenceKey(s: string): string {
  return normalizeSkill(s).toLowerCase();
}

function link(a: string, b: string): void {
  const la = equivalenceKey(a);
  const lb = equivalenceKey(b);
  if (!la || !lb || la === lb) return;
  if (!cache.has(la)) cache.set(la, new Set());
  if (!cache.has(lb)) cache.set(lb, new Set());
  cache.get(la)!.add(lb);
  cache.get(lb)!.add(la);
}

function localPath(): string {
  return join(process.cwd(), reviewDataDir(), 'skill-equivalences.json');
}

function readLocal(): SkillEquivalence[] {
  try {
    if (!existsSync(localPath())) return [];
    return JSON.parse(readFileSync(localPath(), 'utf-8')) as SkillEquivalence[];
  } catch {
    return [];
  }
}

function writeLocal(list: SkillEquivalence[]): void {
  try {
    const dir = join(process.cwd(), reviewDataDir());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(localPath(), JSON.stringify(list, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`スキル同義辞書の保存に失敗: ${safeErr(err)}`);
  }
}

function appendLocal(entry: SkillEquivalence): void {
  const list = readLocal();
  list.push(entry);
  writeLocal(list);
}

// マッチング前に一度呼ぶ。demo=ローカルJSON、prod=DB＋ローカルに退避した分を読み込みキャッシュ。
export async function loadSkillEquivalences(): Promise<void> {
  cache.clear();
  let entries: SkillEquivalence[] = [];
  if (!isDemo()) {
    try {
      entries = await fetchSkillEquivalences();
    } catch (err) {
      console.warn(`スキル同義辞書の取得に失敗: ${safeErr(err)}`);
    }
  }
  for (const e of [...entries, ...readLocal()]) link(e.a, e.b);
  loaded = true;
}

// 同義エントリを追加（確認UIから、人のフィードバックで育てる）。demo=ローカル追記、prod=DB保存。
// prodでDBに保存できなかった（未設定・障害）場合はローカルへ退避し savedTo='local' を返す（UIで縮退を知らせる。
// 退避分はこの環境のバッチにしか効かない）
export async function addSkillEquivalence(
  a: string,
  b: string,
  addedBy: string,
): Promise<{ entry: SkillEquivalence; savedTo: 'db' | 'local' } | null> {
  const entry: SkillEquivalence = {
    a: normalizeSkill(a),
    b: normalizeSkill(b),
    addedBy: addedBy || '(不明)',
    at: new Date().toISOString(),
  };
  if (!entry.a || !entry.b || equivalenceKey(entry.a) === equivalenceKey(entry.b)) return null;
  link(entry.a, entry.b);
  if (isDemo()) {
    appendLocal(entry);
    return { entry, savedTo: 'local' };
  }
  try {
    if (await saveSkillEquivalence(entry)) return { entry, savedTo: 'db' };
  } catch (err) {
    console.warn(`スキル同義の保存に失敗: ${safeErr(err)}`);
  }
  appendLocal(entry);
  return { entry, savedTo: 'local' };
}

// required スキルが have 集合（lowercased）で満たされるか。完全一致 or 同義辞書ヒットで true。
// 同義辞書は正規化後の表記で引く（required/have は抽出時に normalizeSkills 済み）
export function isSkillCovered(required: string, haveSetLower: Set<string>): boolean {
  const key = equivalenceKey(required);
  if (haveSetLower.has(key)) return true;
  const equivs = cache.get(key);
  if (!equivs) return false;
  for (const e of equivs) if (haveSetLower.has(e)) return true;
  return false;
}

export function equivalencesLoaded(): boolean {
  return loaded;
}
