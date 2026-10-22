// 収集の下限。通常は「今 − SES_COLLECT_DAYS」だが、バッチの見送りから再開した回は、止めていた間の古いメールを読まないよう
// それより新しい下限（sinceMs）を使う（collectDays() 自体は変えない。「最後の機会」の判定に影響させないため）。

// 検索の下限（ミリ秒）
export function collectSinceMs(nowMs: number, days: number, sinceMs?: number): number {
  const base = nowMs - days * 24 * 60 * 60 * 1000;
  return sinceMs !== undefined && Number.isFinite(sinceMs) ? Math.max(base, sinceMs) : base;
}

// 新しい順に並んだ ID（Gmail の一覧）から n 番目を選ぶ。n 件に満たなければ null
export function nthFromNewest<T>(idsNewestFirst: readonly T[], n: number): T | null {
  if (!Number.isInteger(n) || n < 1) return null;
  return idsNewestFirst[n - 1] ?? null;
}

// UID（大きいほど新しく届いた）から、新しい順に n 番目の UID を選ぶ。n 件に満たなければ null
export function nthNewestUid(uids: readonly number[], n: number): number | null {
  if (!Number.isInteger(n) || n < 1 || uids.length < n) return null;
  return [...uids].sort((a, b) => b - a)[n - 1];
}

// 受信時刻が下限未満のものを落とす（検索は秒・日単位のため、取ってきた後に受信時刻で絞る）
export function receivedSince<T extends { receivedAt: Date }>(items: T[], sinceMs?: number): T[] {
  if (sinceMs === undefined || !Number.isFinite(sinceMs)) return items;
  return items.filter((m) => m.receivedAt.getTime() >= sinceMs);
}
