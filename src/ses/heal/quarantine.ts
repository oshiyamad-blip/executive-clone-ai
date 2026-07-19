// 失敗メールの累積カウントと隔離（dead-letter）。
// 抽出に失敗したメールは通常「処理済みにせず次回再処理」だが、それだけだと壊れたメールを
// 永遠に再試行し続ける。SES_HEAL_MAX_ATTEMPTS 回（バッチ横断）失敗したら隔離し、
// 修正パッチ案生成（repair）と人の確認に回す。本文は保存しない（PII最小化。件名とエラーのみ）。
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { healDataDir, healMaxAttempts } from '../config.js';
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

function filePath(): string {
  return join(process.cwd(), healDataDir(), 'quarantine.json');
}

function load(): QuarantineEntry[] {
  try {
    if (!existsSync(filePath())) return [];
    return JSON.parse(readFileSync(filePath(), 'utf-8')) as QuarantineEntry[];
  } catch {
    return [];
  }
}

function save(list: QuarantineEntry[]): void {
  try {
    const dir = join(process.cwd(), healDataDir());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filePath(), JSON.stringify(list, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`SES修復: 隔離リストの保存に失敗: ${String(err)}`);
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
export function recordFailure(
  mail: SesRawMail,
  err: unknown,
  opts: { countTowardQuarantine: boolean } = { countTowardQuarantine: true },
): { attempts: number; quarantined: boolean } {
  const list = load();
  const now = new Date().toISOString();
  let entry = list.find((e) => e.mailId === mail.id);
  if (!entry) {
    entry = {
      mailId: mail.id,
      subject: maskPii(mail.subject).slice(0, 200),
      from: maskPii(mail.from).slice(0, 120),
      attempts: 0,
      lastError: '',
      firstFailedAt: now,
      lastFailedAt: now,
      quarantinedAt: null,
    };
    list.push(entry);
  }
  if (opts.countTowardQuarantine) entry.attempts += 1;
  entry.lastError = maskPii(String(err)).slice(0, 500);
  entry.lastFailedAt = now;
  const quarantined = entry.attempts >= healMaxAttempts();
  if (quarantined && !entry.quarantinedAt) entry.quarantinedAt = now;
  save(list);
  return { attempts: entry.attempts, quarantined };
}

// 成功したら失敗履歴を消す（一時障害からの回復）
export function recordSuccess(mailId: string): void {
  const list = load();
  const next = list.filter((e) => e.mailId !== mailId);
  if (next.length !== list.length) save(next);
}

export function listQuarantined(): QuarantineEntry[] {
  return load().filter((e) => e.quarantinedAt !== null);
}

export function quarantineCount(): number {
  return listQuarantined().length;
}
