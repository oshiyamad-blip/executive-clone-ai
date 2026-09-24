// 定時バッチの実行時刻と、1回の実行の持ち時間。
// - 次の実行時刻（.github/workflows/ses-batch.yml の cron と同じ平日10:00〜19:00 JST の毎時）から、メールが次回の実行時に
//   収集の窓（SES_COLLECT_DAYS）を外れるか（＝今回が最後の機会か）を決める
// - 1回の実行で新しい処理を始めてよい期限（SES_RUN_DEADLINE_MINUTES）と、LLM呼び出し1回の待ち時間の上限を管理する
import { runDeadlineMinutes } from './config.js';

const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
const JST_OFFSET_MS = 9 * HOUR_MS; // 日本時間は夏時間がないため固定オフセットで足りる

// 定時バッチ（.github/workflows/ses-batch.yml）の平日の実行時刻（日本時間）
export const RUN_HOURS_JST = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];

// GitHub Actions の定時実行は混雑で遅れることがあるため、次回の実行時刻にこの分の遅れを見込む
export const RUN_DELAY_MARGIN_MS = 3 * HOUR_MS;

// その時刻以降で最初の定時バッチの実行時刻（UTCのミリ秒）
export function nextRunAt(ms: number): number {
  const shifted = ms + JST_OFFSET_MS;
  let day = Math.floor(shifted / DAY_MS);
  for (let i = 0; i < 8; i += 1, day += 1) {
    const wd = new Date(day * DAY_MS).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    for (const h of RUN_HOURS_JST) {
      const slot = day * DAY_MS + h * HOUR_MS;
      if (slot >= shifted) return slot - JST_OFFSET_MS;
    }
  }
  return Number.POSITIVE_INFINITY;
}

// 今回の実行の次の定時実行の時刻（今この瞬間に始まる回は今回とみなす）
export function followingRunAt(now: Date): number {
  return nextRunAt(now.getTime() + 60_000);
}

// 次回の実行時には収集の窓から外れているか（＝今回が処理できる最後の機会か）。次回の実行の遅れも見込む
export function isLastChance(receivedAt: Date, collectDays: number, now = new Date()): boolean {
  return receivedAt.getTime() + collectDays * DAY_MS <= followingRunAt(now) + RUN_DELAY_MARGIN_MS;
}

// 1回の実行で処理する順。最後の機会のメールを先に（その中は新しい順）、残りは新しい順
export function orderForRun<T extends { receivedAt: Date }>(items: T[], collectDays: number, now = new Date()): T[] {
  const newest = (a: T, b: T) => b.receivedAt.getTime() - a.receivedAt.getTime();
  const last = items.filter((x) => isLastChance(x.receivedAt, collectDays, now)).sort(newest);
  const rest = items.filter((x) => !isLastChance(x.receivedAt, collectDays, now)).sort(newest);
  return [...last, ...rest];
}

// 1回の上限まで選び、残りを次回以降に回す
export function pickForRun<T extends { receivedAt: Date }>(
  items: T[],
  limit: number,
  collectDays: number,
  now = new Date(),
): { picked: T[]; deferred: T[] } {
  const ordered = orderForRun(items, collectDays, now);
  return { picked: ordered.slice(0, limit), deferred: ordered.slice(limit) };
}

// LLM で抽出する分を選ぶ。新しい順を基本にし、次回には収集期間を外れる古いメールは枠の2割まで先に入れる
// （当日の案件ほど提案の価値が高い。古いメールだけで枠を使い切って、毎回新着に届かなくなるのを防ぐ）
export const LAST_CHANCE_SHARE = 0.2;

export function pickForExtraction<T extends { receivedAt: Date }>(
  items: T[],
  limit: number,
  collectDays: number,
  now = new Date(),
): { picked: T[]; deferred: T[] } {
  const newest = (a: T, b: T) => b.receivedAt.getTime() - a.receivedAt.getTime();
  const last = items.filter((x) => isLastChance(x.receivedAt, collectDays, now)).sort(newest);
  const rest = items.filter((x) => !isLastChance(x.receivedAt, collectDays, now)).sort(newest);
  const lastSlots = Math.min(last.length, Math.ceil(limit * LAST_CHANCE_SHARE));
  const picked = [...last.slice(0, lastSlots), ...rest].slice(0, limit);
  if (picked.length < limit) picked.push(...last.slice(lastSlots, lastSlots + (limit - picked.length)));
  const chosen = new Set(picked);
  return { picked, deferred: items.filter((x) => !chosen.has(x)) };
}

// ===== 1回の実行の持ち時間 =====

// 期限を過ぎてから始まった呼び出しでも、この時間を超えては待たない（ジョブの制限時間の内に終えるため）
const CALL_GRACE_MS = 8 * 60 * 1000;
const MIN_CALL_TIMEOUT_MS = 30_000;

let runStartedAt: number | null = null;

// バッチの開始時に呼ぶ（呼ばれていないプロセス＝確認UI・自己検証等では期限を設けない）
export function startRunClock(now = Date.now()): void {
  runStartedAt = now;
}

export function stopRunClock(): void {
  runStartedAt = null;
}

function softDeadline(): number {
  return runStartedAt === null ? Number.POSITIVE_INFINITY : runStartedAt + runDeadlineMinutes() * 60_000;
}

// 新しい処理（メールの抽出・候補の判定）を始めてよい期限を過ぎたか
export function pastRunDeadline(now = Date.now()): boolean {
  return now >= softDeadline();
}

// メールの抽出に使ってよいのは持ち時間のこの割合まで。未処理のメールが多い日に抽出だけで持ち時間を使い切り、
// 突合・プロパー・通知が毎回後回しになって、突合前の案件・要員が突合の対象期間を外れてしまわないように
const EXTRACT_SHARE = 0.55;

// 新しいメールの抽出を始めてよい期限を過ぎたか（残りの時間は突合以降に回す）
export function pastExtractDeadline(now = Date.now()): boolean {
  return runStartedAt !== null && now >= runStartedAt + runDeadlineMinutes() * 60_000 * EXTRACT_SHARE;
}

// LLM呼び出し1回の待ち時間の上限とSDKの自動再試行の回数。既定の値を、期限＋猶予までの残り時間に収まるよう頭打ちにする
// （待ち時間は試行ごとにかかるため、残り時間を試行の回数で割る。期限を過ぎてから始める呼び出しは再試行しない）
export function callLimits(defaultMs: number, defaultRetries = 1, now = Date.now()): { timeoutMs: number; maxRetries: number } {
  const hardLimit = softDeadline() + CALL_GRACE_MS;
  if (!Number.isFinite(hardLimit)) return { timeoutMs: defaultMs, maxRetries: defaultRetries };
  const maxRetries = now >= softDeadline() ? 0 : defaultRetries;
  const perAttempt = Math.floor((hardLimit - now) / (maxRetries + 1));
  return { timeoutMs: Math.max(MIN_CALL_TIMEOUT_MS, Math.min(defaultMs, perAttempt)), maxRetries };
}
