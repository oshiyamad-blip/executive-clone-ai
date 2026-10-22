// 試運転で、営業リストの A・B の未着手がたまっていてバッチを見送るかを調べる（本番バッチの pauseGate と同じ判定）。
// 「全体」の B1:M1000 などの読み取り（get_values の保存結果 {range, values}。見出しの行を含む）を渡す。
// 標準出力は件数と真偽だけ（人名・件名・シートのIDは出さない）。
//   npm run --silent ses:trial:gate -- <全体の読み取りファイル> <running|paused> [pause=50] [resume=25]
//   → {"untouchedAB":N,"wasPaused":bool,"paused":bool,"resumed":bool}
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countUntouchedAB, decidePause } from '../pauseGate.js';
import { clampResume } from '../config.js';

export interface GateReport {
  untouchedAB: number;
  wasPaused: boolean;
  paused: boolean;
  resumed: boolean;
}

// get_values の保存結果（JSON）から値の表を取り出す。形が違えば例外
export function valuesOfSavedRead(text: string): string[][] {
  const parsed = JSON.parse(text) as { values?: unknown };
  if (!parsed || !Array.isArray(parsed.values)) throw new Error('values がありません');
  return parsed.values.map((row) => (Array.isArray(row) ? row.map((c) => String(c ?? '')) : []));
}

// ファイルの読み込み以外の中心の処理（純関数）。resume が pause 以上なら pause−1 に丸める（本番と同じ）
export function gateReport(values: string[][], wasPaused: boolean, pause = 50, resume = 25): GateReport {
  const untouchedAB = countUntouchedAB(values);
  const decision = decidePause(untouchedAB, wasPaused, pause, clampResume(pause, resume));
  return { untouchedAB, wasPaused, ...decision };
}

function numberArg(arg: string | undefined, name: string, def: number): number {
  if (arg === undefined) return def;
  const m = new RegExp(`^(?:${name}=)?(\\d+)$`).exec(arg);
  if (!m) throw new Error(`${name} は 0 以上の整数で指定してください`);
  return Number(m[1]);
}

function main(): void {
  const [file, state, pauseArg, resumeArg] = process.argv.slice(2);
  if (!file || (state !== 'running' && state !== 'paused')) {
    console.error('使い方: npm run --silent ses:trial:gate -- <全体の読み取りファイル> <running|paused> [pause=50] [resume=25]');
    process.exitCode = 1;
    return;
  }
  const values = valuesOfSavedRead(readFileSync(resolve(file), 'utf-8'));
  console.log(JSON.stringify(gateReport(values, state === 'paused', numberArg(pauseArg, 'pause', 50), numberArg(resumeArg, 'resume', 25))));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`見送りの判定に失敗しました: ${err instanceof Error ? err.constructor.name : 'Error'}`);
    process.exitCode = 1;
  }
}
