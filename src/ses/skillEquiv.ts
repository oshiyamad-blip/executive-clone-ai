// スキル同義・類似辞書（人のフィードバックで育てる）。
// 静的な skillDict.ts（表記ゆれの正規化）・skillGraph.ts（含意・否定）とは別に、「PHP≈Laravel」のような
// 実質同義／相互に満たすスキルの対応を蓄積する。マッチング時のスキル一致判定で参照する。
// 共有の正: 複数人運用のため prod=DB（Notion/Sheets）、demo=ローカルJSON。prodでDBに保存できなかった分は
// ローカルJSONに退避し、同じ環境での読み込み時にマージする。
// 照合は skillDict の正規化後の表記で行う（'vue' と入力しても案件側の 'Vue.js' に効くように）。
// 否定リスト（Java≠JavaScript 等）の組と、含意の親子の組（React≈Next.js 等。子→親は含意で満たし、
// 親だけで子の必須を満たす扱いにはしない）は登録されていても効かせない
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { isDemo, reviewDataDir } from './config.js';
import { normalizeSkill, tokenizeSkill } from './skillDict.js';
import {
  conditionalImplier,
  descendantKeysOf,
  impliesSkill,
  impliesSkillStrongly,
  isConditionalImplication,
  isNotEquivalent,
} from './skillGraph.js';
import { fetchSkillEquivalences, saveSkillEquivalence } from '../database/index.js';
import { safeErr } from './redact.js';
import type { SkillEquivalence } from '../types/index.js';

// 正規化・小文字化したスキル → 相互に満たすスキル集合（同じく正規化・小文字化）
const cache = new Map<string, Set<string>>();
let loaded = false;

const keyCache = new Map<string, string>();
const KEY_CACHE_MAX = 20_000;

// 同義辞書の照合キー（skillDict で正規化してから小文字化）。一次選抜で組ごと・必須スキルごとに引くため控えておく
export function equivalenceKey(s: string): string {
  const cached = keyCache.get(s);
  if (cached !== undefined) return cached;
  const key = normalizeSkill(s).toLowerCase();
  if (keyCache.size >= KEY_CACHE_MAX) keyCache.clear();
  keyCache.set(s, key);
  return key;
}

// 同義の組として使えない理由。invalid=空・同じ語・1つの技術名でない（'Java(Spring)' のように複数に分かれる）
export type EquivalenceRejection = 'invalid' | 'not_equivalent' | 'implied';

export function equivalenceRejection(a: string, b: string): EquivalenceRejection | null {
  if (tokenizeSkill(a).length !== 1 || tokenizeSkill(b).length !== 1) return 'invalid';
  const na = normalizeSkill(a);
  const nb = normalizeSkill(b);
  if (na.toLowerCase() === nb.toLowerCase()) return 'invalid';
  if (isNotEquivalent(na, nb)) return 'not_equivalent';
  if (impliesSkill(na, nb) || impliesSkill(nb, na) || isConditionalImplication(na, nb)) return 'implied';
  return null;
}

function link(a: string, b: string): EquivalenceRejection | null {
  const rejection = equivalenceRejection(a, b);
  if (rejection) return rejection;
  const la = equivalenceKey(a);
  const lb = equivalenceKey(b);
  if (!cache.has(la)) cache.set(la, new Set());
  if (!cache.has(lb)) cache.set(lb, new Set());
  cache.get(la)!.add(lb);
  cache.get(lb)!.add(la);
  return null;
}

export interface EquivalenceLoadResult {
  linked: number;
  notEquivalent: number; // 否定リストと矛盾するため効かせなかった登録
  implied: number; // 含意の親子の組のため効かせなかった登録（子→親は含意で満たす）
  invalid: number;
}

function linkAll(entries: SkillEquivalence[]): EquivalenceLoadResult {
  cache.clear();
  const result: EquivalenceLoadResult = { linked: 0, notEquivalent: 0, implied: 0, invalid: 0 };
  for (const e of entries) {
    const rejection = link(e.a, e.b);
    if (rejection === null) result.linked += 1;
    else if (rejection === 'not_equivalent') result.notEquivalent += 1;
    else if (rejection === 'implied') result.implied += 1;
    else result.invalid += 1;
  }
  return result;
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
// 効かせなかった登録は件数だけを知らせる（スキル名は公開ログに出さない）
export async function loadSkillEquivalences(): Promise<void> {
  let entries: SkillEquivalence[] = [];
  if (!isDemo()) {
    try {
      entries = await fetchSkillEquivalences();
    } catch (err) {
      console.warn(`スキル同義辞書の取得に失敗: ${safeErr(err)}`);
    }
  }
  const r = linkAll([...entries, ...readLocal()]);
  if (r.notEquivalent + r.implied + r.invalid > 0) {
    console.warn(
      `スキル同義辞書: 登録${r.linked + r.notEquivalent + r.implied + r.invalid}件のうち、否定リストと矛盾する${r.notEquivalent}件・` +
        `含意の親子の組${r.implied}件・1つの技術名でない${r.invalid}件は効かせません（確認UI・スキル同義タブで見直してください）`,
    );
  }
  loaded = true;
}

// テスト用: 同義の登録を差し替える（I/Oなし）
export function setSkillEquivalencesForTest(entries: SkillEquivalence[]): EquivalenceLoadResult {
  const r = linkAll(entries);
  loaded = true;
  return r;
}

export type AddEquivalenceResult =
  | { ok: true; entry: SkillEquivalence; savedTo: 'db' | 'local' }
  | { ok: false; reason: EquivalenceRejection };

// 同義エントリを追加（確認UIから、人のフィードバックで育てる）。demo=ローカル追記、prod=DB保存。
// prodでDBに保存できなかった（未設定・障害）場合はローカルへ退避し savedTo='local' を返す（UIで縮退を知らせる。
// 退避分はこの環境のバッチにしか効かない）。否定リスト・含意の親子の組は登録しない
export async function addSkillEquivalence(a: string, b: string, addedBy: string): Promise<AddEquivalenceResult> {
  const rejection = equivalenceRejection(a, b);
  if (rejection) return { ok: false, reason: rejection };
  const entry: SkillEquivalence = {
    a: normalizeSkill(a),
    b: normalizeSkill(b),
    addedBy: addedBy || '(不明)',
    at: new Date().toISOString(),
  };
  link(entry.a, entry.b);
  if (isDemo()) {
    appendLocal(entry);
    return { ok: true, entry, savedTo: 'local' };
  }
  try {
    if (await saveSkillEquivalence(entry)) return { ok: true, entry, savedTo: 'db' };
  } catch (err) {
    console.warn(`スキル同義の保存に失敗: ${safeErr(err)}`);
  }
  appendLocal(entry);
  return { ok: true, entry, savedTo: 'local' };
}

// 必須スキル1つの満たし方。exact=同じ語、equiv=同義辞書、implied=下位の技術（子）の経験から含意
export type SkillCoverage = 'exact' | 'equiv' | 'implied';

export interface CoverageHit {
  kind: SkillCoverage;
  via: string; // 満たした要員側のスキル（小文字の正規形）
  strong?: boolean; // implied のうち確実な含意（Spring Boot ⇒ Spring 等。直接の記載と同等に数える）
}

// required を have 集合（小文字の正規形）がどう満たすか。満たさなければ null。
// 親スキルだけを持っていても子の必須は満たさない（React だけでは Next.js 必須を満たさない）
export function skillCoverage(required: string, haveSetLower: ReadonlySet<string>): CoverageHit | null {
  const key = equivalenceKey(required);
  if (!key) return null;
  if (haveSetLower.has(key)) return { kind: 'exact', via: key };
  for (const e of cache.get(key) ?? []) if (haveSetLower.has(e)) return { kind: 'equiv', via: e };
  let weak: CoverageHit | null = null;
  for (const d of descendantKeysOf(key)) {
    if (!haveSetLower.has(d)) continue;
    if (impliesSkillStrongly(d, key)) return { kind: 'implied', via: d, strong: true };
    weak ??= { kind: 'implied', via: d };
  }
  if (weak) return weak;
  const conditional = conditionalImplier(key, haveSetLower);
  return conditional ? { kind: 'implied', via: conditional } : null;
}

export function equivalencesLoaded(): boolean {
  return loaded;
}
