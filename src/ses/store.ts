// SES用ローカルストア。
// (1) 処理済みメールID管理（src/store/rawLogStore.ts と同型・二重処理防止）
// (2) demoの成果物書き出し/読み込み（data/ses-demo/ 配下。本番 data/ とは隔離）
// (3) 案件・要員の名寄せ（内容類似度による重複統合。src/dedup の手法を流用）
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { isDemo, demoDataDir } from './config.js';
import type { Project, Engineer } from '../types/index.js';

const PROCESSED_FILE = join(process.cwd(), 'data', 'ses-processed-ids.json');

export function loadProcessedMailIds(): Set<string> {
  try {
    if (!existsSync(PROCESSED_FILE)) return new Set();
    const ids: string[] = JSON.parse(readFileSync(PROCESSED_FILE, 'utf-8'));
    return new Set(ids);
  } catch (err) {
    console.warn(`SES: 処理済みメールIDの読み込みに失敗: ${String(err)}`);
    return new Set();
  }
}

// demoでは処理済みIDを記録しない（毎回fixture全件で決定的に完走させるため）
export function markMailProcessed(ids: string[]): void {
  if (isDemo() || ids.length === 0) return;
  try {
    const dir = join(process.cwd(), 'data');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const processed = loadProcessedMailIds();
    ids.forEach((id) => processed.add(id));
    writeFileSync(PROCESSED_FILE, JSON.stringify([...processed], null, 2), 'utf-8');
  } catch (err) {
    console.warn(`SES: 処理済みメールIDの保存に失敗: ${String(err)}`);
  }
}

// demo成果物をローカルJSONに書き出す（data/ses-demo/<name>.json）
export function writeDemoArtifact(name: string, data: unknown): void {
  try {
    const dir = join(process.cwd(), demoDataDir());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`SES: demo成果物の書き出しに失敗 (${name}): ${String(err)}`);
  }
}

// demo成果物を読み込む（--match-only用。存在しなければ null）
export function readDemoArtifact<T>(name: string): T | null {
  try {
    const filePath = join(process.cwd(), demoDataDir(), `${name}.json`);
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch (err) {
    console.warn(`SES: demo成果物の読み込みに失敗 (${name}): ${String(err)}`);
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
