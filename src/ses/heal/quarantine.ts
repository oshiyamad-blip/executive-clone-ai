// 失敗メールの累積カウントと隔離（dead-letter）。
// 抽出に失敗したメールは通常「処理済みにせず次回再処理」だが、それだけだと壊れたメールを
// 永遠に再試行し続ける。SES_HEAL_MAX_ATTEMPTS 回（バッチ横断）失敗したら隔離し、
// 修正パッチ案生成（repair）と人の確認に回す。本文は保存しない（PII最小化。件名とエラーのみ）。
// 保存先: DB_PROVIDER=sheets の本番はスプレッドシート「_状態」タブ（スケジュール実行でも失敗回数が
// 引き継がれる）、それ以外はローカルJSON。
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { healDataDir, healMaxAttempts, durableStateInSheets } from '../config.js';
import { safeErr } from '../redact.js';
import { sheetsDbConfigured, readStateJson, writeStateJson, STATE_JSON_MAX_CHARS } from '../../database/sheets.js';
import type { SesRawMail } from '../../types/index.js';

export interface QuarantineEntry {
  mailId: string;
  subject: string;
  from: string;
  attempts: number;
  lastError: string;
  firstFailedAt: string;
  lastFailedAt: string;
  quarantinedAt: string | null; // null = まだ隔離前（再試行継続中）
}

const STATE_KEY = 'quarantine';
export const QUARANTINE_MAX_ENTRIES = 200;

function inSheets(): boolean {
  return durableStateInSheets() && sheetsDbConfigured();
}

export function quarantineLocation(): string {
  return inSheets() ? 'スプレッドシート「_状態」タブ' : `${healDataDir()}/quarantine.json`;
}

function filePath(): string {
  return join(process.cwd(), healDataDir(), 'quarantine.json');
}

// 読み込みに失敗した場合は null（空扱いで上書き保存すると履歴を消してしまうため区別する）
async function load(): Promise<QuarantineEntry[] | null> {
  if (inSheets()) {
    try {
      return (await readStateJson<QuarantineEntry[]>(STATE_KEY)) ?? [];
    } catch (err) {
      console.warn(`SES修復: 隔離リストの読み込みに失敗: ${safeErr(err)}`);
      return null;
    }
  }
  try {
    if (!existsSync(filePath())) return [];
    return JSON.parse(readFileSync(filePath(), 'utf-8')) as QuarantineEntry[];
  } catch {
    return [];
  }
}

// 1セルに収まるよう、新しい順に最大件数と文字数で切り詰める（古い履歴から捨てる。
// 隔離済みメールは「処理済みメール」タブにも結果=隔離で残るため、ここで落ちても再処理はされない）
export function capQuarantine(list: QuarantineEntry[], maxChars = STATE_JSON_MAX_CHARS): QuarantineEntry[] {
  const sorted = [...list]
    .sort((a, b) => b.lastFailedAt.localeCompare(a.lastFailedAt))
    .slice(0, QUARANTINE_MAX_ENTRIES);
  while (sorted.length > 0 && JSON.stringify(sorted).length > maxChars) sorted.pop();
  return sorted;
}

async function save(list: QuarantineEntry[]): Promise<void> {
  if (inSheets()) {
    try {
      await writeStateJson(STATE_KEY, capQuarantine(list));
    } catch (err) {
      console.warn(`SES修復: 隔離リストの保存に失敗: ${safeErr(err)}`);
    }
    return;
  }
  try {
    const dir = join(process.cwd(), healDataDir());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filePath(), JSON.stringify(list, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`SES修復: 隔離リストの保存に失敗: ${safeErr(err)}`);
  }
}

// メールアドレス・電話番号らしき並びをマスクする（診断ログ・repairプロンプトに載せる前に必ず通す）
export function maskPii(s: string): string {
  return s
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '<メールアドレス>')
    .replace(/0\d{1,4}-\d{1,4}-\d{3,4}/g, '<電話番号>');
}

// 失敗を記録する。countTowardQuarantine=false のときはカウンタを増やさない
// （バッチ内の過半数が失敗＝基盤障害の可能性が高い場合の誤隔離防止）。
// 履歴を読めなかった場合は記録も隔離もしない（次回バッチで再試行される）。
export async function recordFailure(
  mail: SesRawMail,
  err: unknown,
  opts: { countTowardQuarantine: boolean } = { countTowardQuarantine: true },
): Promise<{ attempts: number; quarantined: boolean }> {
  const list = await load();
  if (!list) return { attempts: 0, quarantined: false };
  const now = new Date().toISOString();
  let entry = list.find((e) => e.mailId === mail.id);
  if (!entry) {
    entry = {
      mailId: mail.id,
      subject: maskPii(mail.subject).slice(0, 120),
      from: maskPii(mail.from).slice(0, 80),
      attempts: 0,
      lastError: '',
      firstFailedAt: now,
      lastFailedAt: now,
      quarantinedAt: null,
    };
    list.push(entry);
  }
  if (opts.countTowardQuarantine) entry.attempts += 1;
  entry.lastError = maskPii(String(err)).slice(0, 300);
  entry.lastFailedAt = now;
  const quarantined = entry.attempts >= healMaxAttempts();
  if (quarantined && !entry.quarantinedAt) entry.quarantinedAt = now;
  await save(list);
  return { attempts: entry.attempts, quarantined };
}

// 成功したら失敗履歴を消す（一時障害からの回復）
export async function recordSuccess(mailId: string): Promise<void> {
  const list = await load();
  if (!list) return;
  const next = list.filter((e) => e.mailId !== mailId);
  if (next.length !== list.length) await save(next);
}

export async function listQuarantined(): Promise<QuarantineEntry[]> {
  return ((await load()) ?? []).filter((e) => e.quarantinedAt !== null);
}

export async function quarantineCount(): Promise<number> {
  return (await listQuarantined()).length;
}
