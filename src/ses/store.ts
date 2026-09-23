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

function dedupeBySimilarity<T>(items: T[], keyFn: (item: T) => string, label: string): T[] {
  const kept: T[] = [];
  const keptKeys: string[] = [];
  for (const item of items) {
    const key = keyFn(item);
    const isDuplicate = keptKeys.some((k) => bigramSimilarity(k, key) >= DEDUP_THRESHOLD);
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

// 同一案件が複数の営業経路から届いた場合の重複統合
export function dedupeProjects(projects: Project[]): Project[] {
  return dedupeBySimilarity(
    projects,
    (p) => `${p.title}${p.requiredSkills.join('')}${p.agentCompany}`,
    '案件',
  );
}

// 同一要員が複数の営業経路から届いた場合の重複統合
export function dedupeEngineers(engineers: Engineer[]): Engineer[] {
  return dedupeBySimilarity(
    engineers,
    (e) => `${e.displayName}${e.skills.join('')}${e.agentCompany}`,
    '要員',
  );
}
