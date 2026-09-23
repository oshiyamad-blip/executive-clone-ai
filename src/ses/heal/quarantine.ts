// 失敗メールの累積カウントと隔離（dead-letter）。
// 抽出に失敗したメールは通常「処理済みにせず次回再処理」だが、それだけだと壊れたメールを
// 永遠に再試行し続ける。SES_HEAL_MAX_ATTEMPTS 回（バッチ横断）失敗したら隔離し、
// 修正パッチ案生成（repair）と人の確認に回す。本文は保存しない（PII最小化。件名とエラーのみ）。
// 保存先: DB_PROVIDER=sheets の本番はスプレッドシート「_状態」タブ（スケジュール実行でも失敗回数が
// 引き継がれる）、それ以外はローカルJSON。
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { healDataDir, healMaxAttempts, durableStateInSheets, COLLECT_DAYS_MAX } from '../config.js';
import { safeErr } from '../redact.js';
import { maskPii } from '../pii.js';
import { addressOf, domainOfAddress } from '../mail/ownMail.js';
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

// 1件の記録として読めるか。mailId の無いものは捨て、それ以外の欠けた・型の違う項目は既定値で補う（以前の版の記録も読めるように）
function toEntry(v: unknown): QuarantineEntry | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const e = v as Record<string, unknown>;
  if (typeof e.mailId !== 'string' || !e.mailId) return null;
  const str = (x: unknown) => (typeof x === 'string' ? x : '');
  return {
    mailId: e.mailId,
    subject: reducedSubject(str(e.subject)), // 以前の版で伏せ字だけにして保存した件名も、読み出しの時点で縮める
    from: str(e.from),
    attempts: typeof e.attempts === 'number' && Number.isFinite(e.attempts) ? e.attempts : 0,
    lastError: str(e.lastError),
    firstFailedAt: str(e.firstFailedAt),
    lastFailedAt: str(e.lastFailedAt),
    quarantinedAt: typeof e.quarantinedAt === 'string' && e.quarantinedAt ? e.quarantinedAt : null,
  };
}

// 保存された値（「_状態」タブのセルは人も編集できる）を隔離リストとして解釈する（純関数）。
// 配列でない値・記録として読めない要素は捨てる（壊れた値のまま list.filter 等で例外になり、抽出の段ごと止まらないため）
export function quarantineEntriesFrom(value: unknown): { entries: QuarantineEntry[]; malformed: boolean } {
  if (value === null || value === undefined) return { entries: [], malformed: false };
  if (!Array.isArray(value)) return { entries: [], malformed: true };
  const entries = value.map(toEntry).filter((e): e is QuarantineEntry => e !== null);
  return { entries, malformed: entries.length !== value.length };
}

let warnedMalformed = false;

function validated(value: unknown): QuarantineEntry[] {
  const { entries, malformed } = quarantineEntriesFrom(value);
  if (malformed && !warnedMalformed) {
    warnedMalformed = true;
    console.warn('SES修復: 隔離リストに形の合わない値があるため、その部分を無視します（次の保存で書き直します）');
  }
  return entries;
}

// 読み込みに失敗した場合は null（空扱いで上書き保存すると履歴を消してしまうため区別する）
async function load(): Promise<QuarantineEntry[] | null> {
  if (inSheets()) {
    try {
      return validated(await readStateJson<unknown>(STATE_KEY));
    } catch (err) {
      console.warn(`SES修復: 隔離リストの読み込みに失敗: ${safeErr(err)}`);
      return null;
    }
  }
  try {
    if (!existsSync(filePath())) return [];
    return validated(JSON.parse(readFileSync(filePath(), 'utf-8')));
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
// 隔離した記録も、処理済みメールの記録と同じ期間（収集できる最大の日数＋7日）を過ぎたら捨てる
// （メールの件名の手がかりを「_状態」タブに何年も残さない。報告は隔離した回のサマリで済んでいる）
export const QUARANTINE_TTL_MS = (COLLECT_DAYS_MAX + 7) * 24 * 60 * 60 * 1000;

function ageMs(iso: string | null, now: number): number {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? now - t : Infinity;
}

// 期限を過ぎた記録を捨てる（純関数）
export function dropStaleEntries(list: QuarantineEntry[], now = Date.now()): QuarantineEntry[] {
  return list.filter((e) =>
    e.quarantinedAt !== null ? ageMs(e.quarantinedAt, now) < QUARANTINE_TTL_MS : ageMs(e.lastFailedAt, now) < PENDING_TTL_MS,
  );
}

// 隔離リストに残す件名。先頭の【案件】等の分類の見出しと長さだけにする（伏せ字処理は氏名・電話・アドレスしか隠さず、
// 件名に多いイニシャル・年齢・国籍・最寄駅・単金が残るため、件名そのものは保存しない）
export function reducedSubject(subject: string): string {
  if (/^[^…]*…（\d+文字）$/.test(subject)) return subject; // 縮めた後の値
  const tags = (subject.normalize('NFKC').match(/^(?:\s*(?:Re|RE|Fw|FW|Fwd):\s*)*((?:\s*[【\[][^】\]]{1,12}[】\]])*)/)?.[1] ?? '').trim();
  return `${tags.slice(0, 40)}…（${subject.length}文字）`;
}

// エラー文の伏せ字（氏名・電話・アドレスに加え、年齢・イニシャル）。修復レポートでLLMへ送る前にも通す
export function maskFailureText(text: string): string {
  return maskPii(text)
    .replace(/\d{1,3}\s*(?:歳|才)/g, '<年齢>')
    .replace(/(?<![A-Za-z])[A-Z]\s?\.\s?[A-Z](?:\s?\.)?(?![A-Za-z])/g, '<イニシャル>');
}

async function save(input: QuarantineEntry[]): Promise<void> {
  const list = dropStaleEntries(input);
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

// 送信者はドメインだけを残す（表示名の氏名やローカル部を隔離リスト・修復レポートに持ち込まない）
export function senderDomainOnly(from: string): string {
  const domain = domainOfAddress(addressOf(from.normalize('NFKC')));
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? `@${domain}` : '';
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
      subject: reducedSubject(mail.subject),
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
  // 伏せ字処理は入力の長さに対して重いため、先に切り詰めてから伏せる
  entry.lastError = maskFailureText(String(err).slice(0, 1000)).slice(0, 300);
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
  return dropStaleEntries((await load()) ?? [])
    .filter((e) => e.quarantinedAt !== null)
    .sort((a, b) => (b.quarantinedAt ?? '').localeCompare(a.quarantinedAt ?? ''));
}

export async function quarantineCount(): Promise<number> {
  return (await listQuarantined()).length;
}
