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

// 「次回の実行時には収集の窓を外れるか」は定時実行の時刻から決める（schedule.ts）
export { isLastChance } from '../schedule.js';

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

// 隔離前（再試行中）のまま一定期間更新のない記録は捨てる（成功・窓落ちで二度と更新されないものが溜まるため）
const PENDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function dropStalePending(list: QuarantineEntry[], now = Date.now()): QuarantineEntry[] {
  return list.filter((e) => e.quarantinedAt !== null || now - new Date(e.lastFailedAt).getTime() < PENDING_TTL_MS);
}

async function save(input: QuarantineEntry[]): Promise<void> {
  const list = dropStalePending(input);
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

// メールアドレス・電話番号らしき並びをマスクする（診断ログ・repairプロンプトに載せる前に必ず通す）。
// 全角（０９０−…）・括弧（03(1234)5678）・区切りなし（09012345678）・+81 表記も拾えるよう先に NFKC で正規化する
export function maskPii(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '<メールアドレス>')
    .replace(/(?<![\d])(?:\+81[\s-]?\(?0?\)?|0)\d{1,4}[\s-]*\(?[\s-]*\d{1,4}[\s-]*\)?[\s-]*\d{3,4}(?![\d])/g, '<電話番号>')
    .replace(/(?<![\d])0\d{9,10}(?![\d])/g, '<電話番号>');
}

// 送信者はドメインだけを残す（表示名の氏名やローカル部を隔離リスト・修復レポートに持ち込まない）
export function senderDomainOnly(from: string): string {
  const m = from.normalize('NFKC').match(/@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
  return m ? `@${m[1].toLowerCase()}` : '';
}

// 失敗を記録する。countTowardQuarantine=false のときはカウンタを増やさない
// （バッチ内の過半数が失敗＝基盤障害の可能性が高い場合・修復予算切れの誤隔離防止）。
// lastChance=true は「次回の実行ではもう収集の窓から外れる」メール。回数に達していなくても隔離して
// サマリに載せる（黙って窓から落ちて消えるのを防ぐ）。基盤障害中は呼び出し側が lastChance を渡さない
// （メールの問題ではないため隔離せず、処理済みにもしないで異常終了として知らせる）。
// 履歴を読めなかった場合は記録も隔離もしない（recorded=false。呼び出し側は、次回の実行で窓を外れるメールなら
// 取りこぼしとして異常終了で知らせる）。
export async function recordFailure(
  mail: SesRawMail,
  err: unknown,
  opts: { countTowardQuarantine: boolean; lastChance?: boolean } = { countTowardQuarantine: true },
): Promise<{ attempts: number; quarantined: boolean; recorded: boolean }> {
  const list = await load();
  if (!list) return { attempts: 0, quarantined: false, recorded: false };
  const now = new Date().toISOString();
  let entry = list.find((e) => e.mailId === mail.id);
  if (!entry) {
    entry = {
      mailId: mail.id,
      subject: maskPii(mail.subject).slice(0, 120),
      from: senderDomainOnly(mail.from),
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
  const quarantined = entry.attempts >= healMaxAttempts() || Boolean(opts.lastChance);
  if (quarantined && !entry.quarantinedAt) entry.quarantinedAt = now;
  await save(list);
  return { attempts: entry.attempts, quarantined, recorded: true };
}

// 成功したら失敗履歴を消す（一時障害からの回復）
export async function recordSuccess(mailId: string): Promise<void> {
  const list = await load();
  if (!list) return;
  const next = list.filter((e) => e.mailId !== mailId);
  if (next.length !== list.length) await save(next);
}

// 隔離済みの記録を新しい順に返す（修復レポートは直近の失敗を分析対象にするため）
export async function listQuarantined(): Promise<QuarantineEntry[]> {
  return ((await load()) ?? [])
    .filter((e) => e.quarantinedAt !== null)
    .sort((a, b) => (b.quarantinedAt ?? '').localeCompare(a.quarantinedAt ?? ''));
}

export async function quarantineCount(): Promise<number> {
  return (await listQuarantined()).length;
}
