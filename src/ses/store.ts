// SES用ストア。
// (1) 処理済みメールID管理（二重処理防止）。DB_PROVIDER=sheets の本番はスプレッドシートの
//     「処理済みメール」タブ（毎回クリーンな環境で動くスケジュール実行でも状態が残る）、それ以外はローカルJSON
// (2) demoの成果物書き出し/読み込み（data/ses-demo/ 配下。本番 data/ とは隔離）
// (3) 案件・要員の名寄せ（内容類似度による重複統合。src/dedup の手法を流用）
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { isDemo, demoDataDir, durableStateInSheets } from './config.js';
import { safeErr } from './redact.js';
import { hasKnownInitials } from './pii.js';
import {
  sheetsDbConfigured,
  loadProcessedMailIdsSheets,
  markMailProcessedSheets,
  loadFingerprintRowsSheets,
  touchLastSeenSheets,
  type ProcessedMailResult,
  type ProcessedFingerprint,
} from '../database/sheets.js';
import { parseFingerprint, type FingerprintRecord } from './resend.js';
import type { Project, Engineer } from '../types/index.js';

export type { ProcessedMailResult, ProcessedFingerprint };

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
export async function markMailProcessed(
  ids: string[],
  result: ProcessedMailResult = '抽出済',
  fingerprints?: Map<string, ProcessedFingerprint>,
): Promise<boolean> {
  if (isDemo() || ids.length === 0) return true;
  if (processedInSheets()) {
    try {
      await markMailProcessedSheets(ids, result, fingerprints);
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
    if (fingerprints && (result === '抽出済' || result === '再送スキップ')) saveFingerprintsLocal(ids, fingerprints);
    return true;
  } catch (err) {
    console.warn(`SES: 処理済みメールIDの保存に失敗: ${safeErr(err)}`);
    return false;
  }
}

// demo成果物をローカルJSONに書き出す（data/ses-demo/<name>.json）
// ===== 再送スキップの指紋（sheets 運用は「処理済みメール」タブの列、それ以外はローカルJSON） =====

const FINGERPRINT_FILE = join(process.cwd(), 'data', 'ses-fingerprints.json');
const FINGERPRINT_LOCAL_MAX = 5000;

interface LocalFingerprintRow {
  mailId: string;
  rootMailId: string;
  at: string;
  fingerprint: string;
}

function loadFingerprintsLocal(): LocalFingerprintRow[] {
  try {
    if (!existsSync(FINGERPRINT_FILE)) return [];
    const rows = JSON.parse(readFileSync(FINGERPRINT_FILE, 'utf-8'));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function saveFingerprintsLocal(ids: string[], fingerprints: Map<string, ProcessedFingerprint>): void {
  const at = new Date().toISOString();
  const rows = loadFingerprintsLocal();
  for (const id of ids) {
    const fp = fingerprints.get(id);
    if (fp) rows.push({ mailId: id, rootMailId: fp.rootMailId, at, fingerprint: fp.fingerprint });
  }
  writeFileSync(FINGERPRINT_FILE, JSON.stringify(rows.slice(-FINGERPRINT_LOCAL_MAX)), 'utf-8');
}

// since 以降に抽出済み・再送スキップにしたメールの指紋。読めなければ空（再送スキップをせず、いつも通り抽出する）
export async function loadFingerprintRecords(since: Date): Promise<FingerprintRecord[]> {
  if (isDemo()) return [];
  let rows: Array<{ mailId: string; rootMailId: string; at: Date; fingerprint: string }>;
  try {
    rows = processedInSheets()
      ? await loadFingerprintRowsSheets(since)
      : loadFingerprintsLocal().map((r) => ({ ...r, at: new Date(r.at) })).filter((r) => r.at.getTime() >= since.getTime());
  } catch (err) {
    console.warn(`SES再送: 指紋を読めないため、今回は再送スキップをせずに抽出します: ${safeErr(err)}`);
    return [];
  }
  const out: FingerprintRecord[] = [];
  for (const r of rows) {
    const fp = parseFingerprint(r.fingerprint);
    if (fp) out.push({ mailId: r.mailId, rootMailId: r.rootMailId, at: r.at, fp });
  }
  return out;
}

// 再送スキップした元メールの案件・要員の最終受信日を更新する（sheets 運用のみ。失敗しても続行）
export async function touchLastSeen(seen: Map<string, Date>): Promise<void> {
  if (isDemo() || seen.size === 0 || !processedInSheets()) return;
  try {
    const n = await touchLastSeenSheets(seen);
    if (n > 0) console.log(`SES再送: 元の案件・要員${n}行の最終受信日を更新しました`);
  } catch (err) {
    console.warn(`SES再送: 最終受信日を更新できません（次回の突合の対象期間の判定が古い受信日のままになります）: ${safeErr(err)}`);
  }
}

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

// 単金以外の属性（別のメール・勤務地・営業元）が同じ案件でありえるか
function projectsCompatibleIgnoringRate(a: Project, b: Project): boolean {
  return (
    a.sourceMailId !== b.sourceMailId &&
    sameIfKnown(a.prefecture, b.prefecture, (x, y) => x === y) &&
    sameIfKnown(nonEmpty(a.agentCompany), nonEmpty(b.agentCompany), (x, y) => x === y)
  );
}

function projectsCompatible(a: Project, b: Project): boolean {
  return projectsCompatibleIgnoringRate(a, b) && sameIfKnown(a.rateMax ?? a.rateMin, b.rateMax ?? b.rateMin, sameRate);
}

// 希望単金以外の属性（別のメール・イニシャル・年齢・最寄駅・居住県）が同じ人物でありえるか
function engineersCompatibleIgnoringRate(a: Engineer, b: Engineer): boolean {
  const nameA = hasKnownInitials(a.displayName) ? a.displayName.trim() : null;
  const nameB = hasKnownInitials(b.displayName) ? b.displayName.trim() : null;
  // 表示名（イニシャル）が決められなかった要員（漢字の氏名だけのメール）は、同じ営業元のアドレス・ほぼ同じスキル・
  // 年齢か最寄駅の一致で同じ人物とみなす（氏名そのものは保存しないため、氏名以外の手がかりで再送を見分ける）
  const sameIdentity = nameA !== null || nameB !== null ? nameA === nameB : sameWithoutInitials(a, b);
  return (
    a.sourceMailId !== b.sourceMailId &&
    sameIdentity &&
    sameIfKnown(a.age, b.age, (x, y) => Math.abs(x - y) <= 1) &&
    sameIfKnown(nonEmpty(a.nearestStation), nonEmpty(b.nearestStation), (x, y) => x === y) &&
    sameIfKnown(a.prefecture, b.prefecture, (x, y) => x === y)
  );
}

// イニシャル不明の要員どうしの同一人物の手がかり（氏名以外）
const SKILL_OVERLAP_FOR_UNKNOWN_INITIALS = 0.8;

function sameWithoutInitials(a: Engineer, b: Engineer): boolean {
  const mailA = a.agentEmail.trim().toLowerCase();
  if (!mailA || mailA !== b.agentEmail.trim().toLowerCase()) return false;
  const sa = new Set(a.skills.map((x) => x.toLowerCase()));
  const sb = new Set(b.skills.map((x) => x.toLowerCase()));
  if (sa.size < 2 || sb.size < 2) return false;
  const common = [...sa].filter((x) => sb.has(x)).length;
  if (common / (sa.size + sb.size - common) < SKILL_OVERLAP_FOR_UNKNOWN_INITIALS) return false;
  const ageKnown = a.age !== null && b.age !== null;
  const stationKnown = nonEmpty(a.nearestStation) !== null && nonEmpty(b.nearestStation) !== null;
  return ageKnown || stationKnown; // 一致は呼び出し側（sameIfKnown）で確かめる
}

function engineersCompatible(a: Engineer, b: Engineer): boolean {
  return engineersCompatibleIgnoringRate(a, b) && sameIfKnown(a.desiredRate, b.desiredRate, sameRate);
}

const projectKey = (p: Project) => `${p.title}${p.requiredSkills.join('')}${p.agentCompany}`;
const engineerKey = (e: Engineer) => `${e.displayName}${e.skills.join('')}${e.agentCompany}`;

// 同じ案件（同じ行、または名寄せで同じとみなせる再送）か。単金・日付の違いは問わない（再提案抑制で使う）
export function sameProjectIgnoringRate(a: Project, b: Project): boolean {
  if (a.id === b.id) return true;
  return projectsCompatibleIgnoringRate(a, b) && bigramSimilarity(projectKey(a), projectKey(b)) >= DEDUP_THRESHOLD;
}

// 同じ要員（同じ行、または名寄せで同じとみなせる再送）か。希望単金・日付の違いは問わない（再提案抑制で使う）
// 表示名はイニシャルだけのため、同じ営業元の同じイニシャル・似たスキルの別人を取り違えないよう、再提案抑制では
// 同じ営業元のアドレスに加えて年齢か最寄駅の一致（どちらも記載があるもの）を求める（別人の組を黙って抑制しない）
export function sameEngineerIgnoringRate(a: Engineer, b: Engineer): boolean {
  if (a.id === b.id) return true;
  return (
    engineersCompatibleIgnoringRate(a, b) &&
    bigramSimilarity(engineerKey(a), engineerKey(b)) >= DEDUP_THRESHOLD &&
    sameAgentMail(a, b) &&
    ((a.age !== null && a.age === b.age) || (nonEmpty(a.nearestStation) !== null && nonEmpty(a.nearestStation) === nonEmpty(b.nearestStation)))
  );
}

function sameAgentMail(a: Engineer, b: Engineer): boolean {
  const mail = a.agentEmail.trim().toLowerCase();
  return mail !== '' && mail === b.agentEmail.trim().toLowerCase();
}

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

// ===== 同じメールを抽出し直したときのID =====

// 保存済みの行と「同じ項目」とみなす内容の類似度（名前＋スキル＋営業元の文字bigram）
const REEXTRACT_MATCH_THRESHOLD = 0.6;

// 同じメールを抽出し直したときのIDの対応付け。IDはメール内の出現順から作るため、LLMが項目の順番・件数を変えて返すと
// 別の項目の行を上書きし、その行の突合済・判定済みのペアを別の内容に引き継いでしまう。保存済みの同じメールの行と
// 内容の似ている順に対応付けてその行のIDを使い、対応しない項目は保存済みの行と重ならない新しいIDにする
// （内容が言い換えられただけで出現順が同じなら、従来どおり出現順のIDを使う）
export function reconcileReextractedIds<T extends Project | Engineer>(
  kind: 'project' | 'engineer',
  fresh: T[],
  saved: T[],
  newId: (mailId: string, index: number) => string,
): T[] {
  const keyOf = (item: T) => (kind === 'project' ? projectKey(item as Project) : engineerKey(item as Engineer));
  const out = [...fresh];
  for (const mailId of new Set(fresh.map((f) => f.sourceMailId))) {
    const existing = saved.filter((x) => x.sourceMailId === mailId);
    if (existing.length === 0) continue;
    const indexes = fresh.map((f, i) => (f.sourceMailId === mailId ? i : -1)).filter((i) => i >= 0);
    const assigned = new Map<number, string>(); // fresh の添字 → ID
    const used = new Set<string>();
    const pairs = indexes
      .flatMap((i) => existing.map((x) => ({ i, id: x.id, sim: bigramSimilarity(keyOf(fresh[i]), keyOf(x)) })))
      .filter((p) => p.sim >= REEXTRACT_MATCH_THRESHOLD)
      .sort((a, b) => b.sim - a.sim);
    for (const p of pairs) {
      if (assigned.has(p.i) || used.has(p.id)) continue;
      assigned.set(p.i, p.id);
      used.add(p.id);
    }
    const existingIds = new Set(existing.map((x) => x.id));
    for (const i of indexes) {
      if (assigned.has(i)) continue;
      const positional = fresh[i].id;
      if (existingIds.has(positional) && !used.has(positional)) {
        assigned.set(i, positional); // 似ている行が無く、同じ位置の行がまだ対応していない（言い換え）
        used.add(positional);
      }
    }
    let n = indexes.length + existing.length;
    for (const i of indexes) {
      if (assigned.has(i)) continue;
      let id = fresh[i].id;
      while (existingIds.has(id) || used.has(id)) id = newId(mailId, n++);
      assigned.set(i, id);
      used.add(id);
    }
    let changed = 0;
    for (const [i, id] of assigned) {
      // 保存済みの行に付いた指示混入疑い（AI判定・人の印）は、抽出し直しで印が立たなくても引き継ぐ
      if (existing.find((x) => x.id === id)?.injectionSuspected && !out[i].injectionSuspected) out[i] = { ...out[i], injectionSuspected: true };
      if (out[i].id === id) continue;
      out[i] = { ...out[i], id };
      changed += 1;
    }
    if (changed > 0) console.log(`SES保存: 抽出し直したメールの${kind === 'project' ? '案件' : '要員'}${changed}件のIDを保存済みの行に合わせました`);
  }
  return out;
}
