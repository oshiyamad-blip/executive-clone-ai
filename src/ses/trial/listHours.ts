// Gmail の検索が after:/before:（epoch秒）を受け付けず nextPageToken も返さないときの、時間単位の一覧の補助。
//   npm run --silent ses:trial:listhours -- plan <startEpochSec> <endEpochSec> [nowEpochSec]   → {"hours":[0..H],"groups":[[..],..],"queries":["..",..]}（queries[h] が時間 h の基本クエリ）
//   npm run --silent ses:trial:listhours -- fix <RUN_DIR> <startEpochSec> [endEpochSec]       → {"read":N,"kept":K,"dropped":D}
// 時間 h は「いまから h 時間前〜h+1 時間前」（クエリは newer_than:{h+1}h older_than:{h}h。h=0 は newer_than:1h）。
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inDaytime } from './windows.js';

const HOUR = 3600;
const QUIET_GROUP_MAX = 6;

// 件名だけで要員メールと分かる語（mailKind.ts の SUBJECT_ENGINEER_RE の「〜情報/紹介」型）。一覧の量を減らすため検索から外す。
// 「要員」「人材」単独は「要員募集」のように案件の件名にも出るため除外語にしない
const ENGINEER_SUBJECT_PHRASES = ['要員情報', '要員紹介', '人材情報', '人材紹介', '技術者情報', '技術者紹介', 'エンジニア紹介'];

// 時間 h の一覧の基本クエリ（要員メールの件名を除く）。h=0 は newer_than:1h
export function listQueryOf(h: number): string {
  const range = h === 0 ? 'newer_than:1h' : `newer_than:${h + 1}h older_than:${h}h`;
  return `label:SES ${range} ${ENGINEER_SUBJECT_PHRASES.map((w) => `-subject:"${w}"`).join(' ')}`;
}

// 時間 h（いまから h 時間前〜h+1 時間前）が平日 JST 08:00〜21:00 にかかるか
const isBusyHour = (h: number, now: number): boolean => inDaytime(now - (h + 1) * HOUR) || inDaytime(now - h * HOUR - 1);

// 対象の始まりから now までを覆う時間の並びと、担当の区切り。平日の昼は1時間ずつ、それ以外は6時間まで。
// end が now より前でも now まで覆う（範囲外の行は fix で落とす）
export function hourGroups(start: number, _end: number, now: number): { hours: number[]; groups: number[][] } {
  const count = Math.max(1, Math.ceil((now - start) / HOUR));
  const hours = Array.from({ length: count }, (_, i) => i);
  const groups: number[][] = [];
  let quiet: number[] = [];
  const flush = (): void => {
    if (quiet.length > 0) groups.push(quiet);
    quiet = [];
  };
  for (const h of hours) {
    if (isBusyHour(h, now)) {
      flush();
      groups.push([h]);
    } else {
      quiet.push(h);
      if (quiet.length >= QUIET_GROUP_MAX) flush();
    }
  }
  flush();
  return { hours, groups };
}

// Gmail のメッセージID（16進）の上位ビットは internalDate（ms）を 20bit 左に寄せたもの
export function internalDateOfId(id: string): number {
  return Number(BigInt('0x' + id) >> 20n);
}

// 一覧の行（threadId\tlatestMsgId\tinternalDateMs\tfrom\tsubject\tmsgCount）を範囲で絞り、threadId で重複を除く（internalDate が大きい行を残す）
export function fixListRows(lines: string[], start: number, end?: number): { rows: string[]; read: number; dropped: number } {
  const best = new Map<string, { ms: number; line: string }>();
  let read = 0;
  for (const line of lines) {
    if (line.trim() === '') continue;
    read++;
    const f = line.split('\t');
    const ms = Number(f[2]);
    if (!f[0] || !Number.isFinite(ms)) continue;
    if (ms < start * 1000 || (end !== undefined && ms > end * 1000)) continue;
    const cur = best.get(f[0]);
    if (!cur || ms > cur.ms) best.set(f[0], { ms, line });
  }
  const rows = [...best.values()].map((v) => v.line);
  return { rows, read, dropped: read - rows.length };
}

function main(): void {
  const [cmd, a, b, c] = process.argv.slice(2);
  if (cmd === 'plan') {
    const start = Number(a);
    const end = Number(b);
    const now = c !== undefined ? Number(c) : Math.floor(Date.now() / 1000);
    if (![start, end, now].every(Number.isInteger) || start >= now) {
      console.error('使い方: npm run --silent ses:trial:listhours -- plan <startEpochSec> <endEpochSec> [nowEpochSec]');
      process.exitCode = 1;
      return;
    }
    const plan = hourGroups(start, end, now);
    console.log(JSON.stringify({ ...plan, queries: plan.hours.map(listQueryOf) }));
    return;
  }
  if (cmd === 'fix') {
    const start = Number(b);
    const end = c !== undefined ? Number(c) : undefined;
    if (!a || !Number.isInteger(start) || (end !== undefined && !Number.isInteger(end))) {
      console.error('使い方: npm run --silent ses:trial:listhours -- fix <RUN_DIR> <startEpochSec> [endEpochSec]');
      process.exitCode = 1;
      return;
    }
    const dir = join(a, 'list');
    const files = readdirSync(dir).filter((f) => /^s.*\.tsv$/.test(f));
    const lines = files.flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n'));
    const res = fixListRows(lines, start, end);
    writeFileSync(join(dir, 'w00.tsv'), res.rows.length > 0 ? res.rows.join('\n') + '\n' : '');
    for (const f of files) unlinkSync(join(dir, f));
    console.log(JSON.stringify({ read: res.read, kept: res.rows.length, dropped: res.dropped }));
    return;
  }
  console.error('使い方: plan | fix（詳細は docs/ses-trial-runbook.md）');
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
