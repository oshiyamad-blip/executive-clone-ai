// 試運転の一覧の区切りを作る。平日（JST の月〜金）の 08:00〜21:00 は件数が多いので30分ごと、
// それ以外（平日の夜間・土日）は件数が少ないので、続いている間を1つの区切りにまとめる（担当の数を減らす）。祝日は見ない。
//   npm run --silent ses:trial:windows -- <startEpochSec> <endEpochSec>   → [[after,before],...]
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const JST_OFFSET = 9 * 3600;
const DAY = 86400;
const DAY_START = 8 * 3600;
const DAY_END = 21 * 3600;
const STEP = 30 * 60;

const jstDayOf = (t: number): number => Math.floor((t + JST_OFFSET) / DAY);
// 1970-01-01（木）が day 0。0=日曜
const isWeekday = (jstDay: number): boolean => {
  const dow = (((jstDay + 4) % 7) + 7) % 7;
  return dow >= 1 && dow <= 5;
};
const epochOf = (jstDay: number, secOfDay: number): number => jstDay * DAY + secOfDay - JST_OFFSET;

function inDaytime(t: number): boolean {
  const day = jstDayOf(t);
  if (!isWeekday(day)) return false;
  const sec = t + JST_OFFSET - day * DAY;
  return sec >= DAY_START && sec < DAY_END;
}

// t より後で最初の「平日 08:00」
function nextDaytimeStart(t: number): number {
  for (let d = jstDayOf(t); d <= jstDayOf(t) + 8; d++) {
    const c = epochOf(d, DAY_START);
    if (c > t && isWeekday(d)) return c;
  }
  return t + DAY;
}

export function windowsOf(start: number, end: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let cur = start;
  while (cur < end) {
    let next: number;
    if (inDaytime(cur)) next = Math.min(cur + STEP, epochOf(jstDayOf(cur), DAY_END), end);
    else next = Math.min(nextDaytimeStart(cur), end);
    out.push([cur, next]);
    cur = next;
  }
  return out;
}

function main(): void {
  const start = Number(process.argv[2]);
  const end = Number(process.argv[3]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start >= end) {
    console.error('使い方: npm run --silent ses:trial:windows -- <startEpochSec> <endEpochSec>');
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(windowsOf(start, end)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
