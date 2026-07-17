// スキル同義・類似辞書（人のフィードバックで育てる）。
// 静的な skillDict.ts（表記ゆれの正規化）とは別に、「PHP≈Laravel」「React≈Next.js」のような
// 実質同義／相互に満たすスキルの対応を蓄積する。マッチング時のスキル一致判定で参照する。
// 共有の正: 複数人運用のため prod=Notion、demo=ローカルJSON。
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { isDemo, reviewDataDir } from './config.js';
import { fetchSkillEquivalences, saveSkillEquivalence } from '../database/index.js';
import type { SkillEquivalence } from '../types/index.js';

// lowercased スキル → 相互に満たす lowercased スキル集合
const cache = new Map<string, Set<string>>();
let loaded = false;

function link(a: string, b: string): void {
  const la = a.trim().toLowerCase();
  const lb = b.trim().toLowerCase();
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
    console.warn(`スキル同義辞書の保存に失敗: ${String(err)}`);
  }
}

// マッチング前に一度呼ぶ。demo=ローカルJSON、prod=Notionから読み込みキャッシュ。
export async function loadSkillEquivalences(): Promise<void> {
  cache.clear();
  let entries: SkillEquivalence[] = [];
  if (isDemo()) {
    entries = readLocal();
  } else {
    try {
      entries = await fetchSkillEquivalences();
    } catch (err) {
      console.warn(`スキル同義辞書の取得に失敗: ${String(err)}`);
    }
  }
  for (const e of entries) link(e.a, e.b);
  loaded = true;
}

// 同義エントリを追加（確認UIから、人のフィードバックで育てる）。demo=ローカル追記、prod=Notion保存。
export async function addSkillEquivalence(a: string, b: string, addedBy: string): Promise<SkillEquivalence | null> {
  const entry: SkillEquivalence = {
    a: a.trim(),
    b: b.trim(),
    addedBy: addedBy || '(不明)',
    at: new Date().toISOString(),
  };
  if (!entry.a || !entry.b || entry.a.toLowerCase() === entry.b.toLowerCase()) return null;
  link(entry.a, entry.b);
  if (isDemo()) {
    const list = readLocal();
    list.push(entry);
    writeLocal(list);
  } else {
    try {
      await saveSkillEquivalence(entry);
    } catch (err) {
      console.warn(`スキル同義の保存に失敗: ${String(err)}`);
    }
  }
  return entry;
}

// required スキルが have 集合（lowercased）で満たされるか。完全一致 or 同義辞書ヒットで true。
export function isSkillCovered(required: string, haveSetLower: Set<string>): boolean {
  const key = required.trim().toLowerCase();
  if (haveSetLower.has(key)) return true;
  const equivs = cache.get(key);
  if (!equivs) return false;
  for (const e of equivs) if (haveSetLower.has(e)) return true;
  return false;
}

export function equivalencesLoaded(): boolean {
  return loaded;
}
