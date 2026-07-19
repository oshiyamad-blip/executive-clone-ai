// 月計算の共有ユーティリティ（純関数のみ・I/O禁止）。
// タイムゾーンは実行環境のローカル時刻で統一する（運用はJST前提 — docs/deploy-gcp.md）。
// UTC/ローカルの混在はバッチ間で「対象月」がズレる実害になるため、
// 月の解釈・日付のYYYY-MM-DD化は必ずこのモジュールを経由すること。

export function formatMonth(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

// base の前月（YYYY-MM）
export function previousMonth(base: Date): string {
  return formatMonth(new Date(base.getFullYear(), base.getMonth() - 1, 1));
}

// 'YYYY-MM' の初日0:00・末日23:59:59.999（ローカル時刻）
export function monthBounds(monthStr: string): { start: Date; end: Date } {
  const [y, m] = monthStr.split('-').map(Number);
  return { start: new Date(y, m - 1, 1), end: new Date(y, m, 0, 23, 59, 59, 999) };
}

// 期間が対象月と重なるか。start未指定=無期限開始、end未指定=無期限継続
export function overlapsMonth(period: { start?: Date; end?: Date }, monthStr: string): boolean {
  const { start, end } = monthBounds(monthStr);
  const periodStart = period.start ?? new Date(-8640000000000000);
  const periodEnd = period.end ?? new Date(8640000000000000);
  return periodStart <= end && periodEnd >= start;
}

// ローカル時刻基準の YYYY-MM-DD（toISOString はUTC変換で日付が前日にズレるため使わない）
export function toLocalYmd(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
