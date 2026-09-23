// SES用ストア。
// (1) 処理済みメールID管理（二重処理防止）。DB_PROVIDER=sheets の本番はスプレッドシートの
//     「処理済みメール」タブ（毎回クリーンな環境で動くスケジュール実行でも状態が残る）、それ以外はローカルJSON
// (2) demoの成果物書き出し/読み込み（data/ses-demo/ 配下。本番 data/ とは隔離）
// (3) 案件・要員の名寄せ（内容類似度による重複統合。src/dedup の手法を流用）
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { isDemo, demoDataDir, durableStateInSheets } from './config.js';
import { safeErr } from './redact.js';
import {
  sheetsDbConfigured,
  loadProcessedMailIdsSheets,
  markMailProcessedSheets,
  type ProcessedMailResult,
} from '../database/sheets.js';
import type { Project, Engineer } from '../types/index.js';

export type { ProcessedMailResult };

const PROCESSED_FILE = join(process.cwd(), 'data', 'ses-processed-ids.json');

function processedInSheets(): boolean {
  return durableStateInSheets() && sheetsDbConfigured();
}

function loadProcessedLocal(): Set<string> {
  try {
    if (!existsSync(PROCESSED_FILE)) return new Set();
    const ids: string[] = JSON.parse(readFileSync(PROCESSED_FILE, 'utf-8'));
    return new Set(ids);
  } catch (err) {
    console.warn(`SES: 処理済みメールIDの読み込みに失敗: ${safeErr(err)}`);
    return new Set();
  }
}

// スプレッドシートの読み込み失敗は例外のまま返す（空集合で続行すると収集窓の全メールを再抽出してしまうため、
// 呼び出し側で収集失敗として扱う）
export async function loadProcessedMailIds(): Promise<Set<string>> {
  if (processedInSheets()) return loadProcessedMailIdsSheets();
  return loadProcessedLocal();
}

// 処理済みとして記録する。保存できなかった場合は false（次回同じメールを再処理することになる）。
// demoでは記録しない（毎回fixture全件で決定的に完走させるため）
export async function markMailProcessed(ids: string[], result: ProcessedMailResult = '抽出済'): Promise<boolean> {
  if (isDemo() || ids.length === 0) return true;
  if (processedInSheets()) {
    try {
      await markMailProcessedSheets(ids, result);
      return true;
    } catch (err) {
      console.error(`SES: 処理済みメールID(${ids.length}件)のスプレッドシート保存に失敗: ${safeErr(err)}`);
      return false;
    }
  }
  try {
    const dir = join(process.cwd(), 'data');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const processed = loadProcessedLocal();
    ids.forEach((id) => processed.add(id));
    writeFileSync(PROCESSED_FILE, JSON.stringify([...processed], null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.warn(`SES: 処理済みメールIDの保存に失敗: ${safeErr(err)}`);
    return false;
  }
}

// demo成果物をローカルJSONに書き出す（data/ses-demo/<name>.json）
export function writeDemoArtifact(name: string, data: unknown): void {
  try {
    const dir = join(process.cwd(), demoDataDir());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`SES: demo成果物の書き出しに失敗 (${name}): ${safeErr(err)}`);
  }
}

// demo成果物を読み込む（--match-only用。存在しなければ null）
export function readDemoArtifact<T>(name: string): T | null {
  try {
    const filePath = join(process.cwd(), demoDataDir(), `${name}.json`);
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch (err) {
    console.warn(`SES: demo成果物の読み込みに失敗 (${name}): ${safeErr(err)}`);
    return null;
  }
}

// ===== 名寄せ（重複統合） =====
// 文字bigramのJaccard類似度で重複を検出する（src/dedup/index.ts の手法を流用。型がRawLogに
// 特化しているため、Project/Engineer向けに同じアルゴリズムを軽量に再実装する）。
const DEDUP_THRESHOLD = 0.8;

function charBigrams(s: string): Set<string> {
  const t = s.replace(/\s+/g, '');
  const grams = new Set<string>();
  if (t.length === 1) {
    grams.add(t);
    return grams;
  }
  for (let i = 0; i < t.length - 1; i++) grams.add(t.slice(i, i + 2));
  return grams;
}

function bigramSimilarity(a: string, b: string): number {
  const setA = charBigrams(a);
  const setB = charBigrams(b);
  const intersection = new Set([...setA].filter((g) => setB.has(g)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

// 同一人物・同一案件でありえない組（別の単金・別の人物属性・同じメール内の別項目）は、文面が似ていても統合しない
// （統合＝片方の破棄なので、迷ったら残す）
function dedupeBySimilarity<T>(
  items: T[],
  keyFn: (item: T) => string,
  compatible: (a: T, b: T) => boolean,
  label: string,
): T[] {
  const kept: T[] = [];
  const keptKeys: string[] = [];
  for (const item of items) {
    const key = keyFn(item);
    const isDuplicate = kept.some((k, i) => compatible(k, item) && bigramSimilarity(keptKeys[i], key) >= DEDUP_THRESHOLD);
    if (!isDuplicate) {
      kept.push(item);
      keptKeys.push(key);
    }
  }
  const removed = items.length - kept.length;
  if (removed > 0) {
    console.log(`SES名寄せ: ${label}${removed}件の重複を統合（${items.length} → ${kept.length}件）`);
  }
  return kept;
}

// 片方が不明なら矛盾なしとみなす
function sameIfKnown<V>(a: V | null | undefined, b: V | null | undefined, eq: (x: V, y: V) => boolean): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return true;
  return eq(a, b);
}

const sameRate = (x: number, y: number) => Math.abs(x - y) < 0.05;

// 表示名・駅名の比較用（全角半角・空白・区切りの記号・大文字小文字の違いを無視）
function identityText(s: string): string {
  return s.normalize('NFKC').replace(/[\s.．・_\-]/g, '').replace(/駅$/, '').toLowerCase();
}

function nonEmpty(s: string): string | null {
  const t = identityText(s);
  return t ? t : null;
}

function projectsCompatible(a: Project, b: Project): boolean {
  return (
    a.sourceMailId !== b.sourceMailId &&
    sameIfKnown(a.rateMax ?? a.rateMin, b.rateMax ?? b.rateMin, sameRate) &&
    sameIfKnown(a.prefecture, b.prefecture, (x, y) => x === y) &&
    sameIfKnown(nonEmpty(a.agentCompany), nonEmpty(b.agentCompany), (x, y) => x === y)
  );
}

function engineersCompatible(a: Engineer, b: Engineer): boolean {
  const nameA = nonEmpty(a.displayName);
  const nameB = nonEmpty(b.displayName);
  return (
    a.sourceMailId !== b.sourceMailId &&
    // 表示名（イニシャル）が無い要員は人物を特定できないため統合しない
    nameA !== null &&
    nameA === nameB &&
    sameIfKnown(a.age, b.age, (x, y) => Math.abs(x - y) <= 1) &&
    sameIfKnown(nonEmpty(a.nearestStation), nonEmpty(b.nearestStation), (x, y) => x === y) &&
    sameIfKnown(a.desiredRate, b.desiredRate, sameRate) &&
    sameIfKnown(a.prefecture, b.prefecture, (x, y) => x === y)
  );
}

const projectKey = (p: Project) => `${p.title}${p.requiredSkills.join('')}${p.agentCompany}`;
const engineerKey = (e: Engineer) => `${e.displayName}${e.skills.join('')}${e.agentCompany}`;

// 同一案件が同じ営業元から再送された場合などの重複統合（単金・勤務地・営業元が食い違うものは別案件として残す）
export function dedupeProjects(projects: Project[]): Project[] {
  return dedupeBySimilarity(projects, projectKey, projectsCompatible, '案件');
}

// 同一要員が再送・複数経路で届いた場合の重複統合（イニシャル・年齢・最寄駅・希望単金・居住県が食い違うものは別人として残す）
export function dedupeEngineers(engineers: Engineer[]): Engineer[] {
  return dedupeBySimilarity(engineers, engineerKey, engineersCompatible, '要員');
}

// 前回以前の実行で保存済みのもの（existing）と同じ案件・要員の再送を除く（同じルールで判定）。
// 再送を新しい行として保存すると、同じ相手との組を別のマッチIDで判定し直し、同じ紹介を二重に提案してしまうため。
// 既存の行は残るので、再送された案件・要員とこれから届く相手との組は既存の行で突合される
function withoutResends<T extends { id: string }>(
  existing: T[],
  fresh: T[],
  keyFn: (item: T) => string,
  compatible: (a: T, b: T) => boolean,
  label: string,
): T[] {
  if (existing.length === 0 || fresh.length === 0) return fresh;
  const known = existing.map((e) => ({ item: e, key: keyFn(e) }));
  const knownIds = new Set(existing.map((e) => e.id));
  const kept = fresh.filter((item) => {
    if (knownIds.has(item.id)) return true; // 同じメールの抽出し直し（同じ行を更新する）
    const key = keyFn(item);
    return !known.some((k) => compatible(k.item, item) && bigramSimilarity(k.key, key) >= DEDUP_THRESHOLD);
  });
  const removed = fresh.length - kept.length;
  if (removed > 0) console.log(`SES名寄せ: 保存済みの${label}と同じ再送${removed}件を除外（既存の行で突合します）`);
  return kept;
}

export function withoutResentProjects(existing: Project[], fresh: Project[]): Project[] {
  return withoutResends(existing, fresh, projectKey, projectsCompatible, '案件');
}

export function withoutResentEngineers(existing: Engineer[], fresh: Engineer[]): Engineer[] {
  return withoutResends(existing, fresh, engineerKey, engineersCompatible, '要員');
}
