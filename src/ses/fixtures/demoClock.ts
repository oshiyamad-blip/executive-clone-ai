// demo の受信日時を「実行日の前日」に寄せる。fixture は 2026-07-16 に届いた想定で書いてあるが、
// 一次選抜は受信からの経過日数（鮮度）を見るため、固定の日付のままだと日が経つほど古い案件・要員として扱われ、
// demo の区分（成立候補・交渉提案・参考提案・要確認）が実行日によって変わってしまう
const FIXTURE_BASE_DAY_MS = Date.parse('2026-07-16T00:00:00+09:00');
const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function demoReceivedAt(iso: string): Date {
  const todayJst = Math.floor((Date.now() + JST_OFFSET_MS) / DAY_MS) * DAY_MS - JST_OFFSET_MS;
  const shiftDays = Math.round((todayJst - DAY_MS - FIXTURE_BASE_DAY_MS) / DAY_MS);
  return new Date(Date.parse(iso) + shiftDays * DAY_MS);
}
