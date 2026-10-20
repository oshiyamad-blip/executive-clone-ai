// 試運転で、本番バッチ（Claude API）と担当を持ち合うための判定と、営業リストの「_運用」に書く値の作成。
// 「_運用」の読み取り（get_values の保存結果 {range, values}。タブが無い・読めないときは {"values":[]}）を渡す。
// 標準出力は判定と日時だけ（人名・件名・シートのIDは出さない）。
//   npm run --silent ses:trial:handoff -- check <_運用の読み取りファイル> <実行ログの最後の行のC列(epoch秒)> <nowEpochSec>
//   → {"run":bool,"startEpoch":N,"mode":"api|trial|none","reason":"…"}
//   npm run --silent ses:trial:handoff -- rows <_運用の読み取りファイル> <試運転読了 epoch秒> <nowEpochSec>
//   → {"range":"'_運用'!A1:B6","values":[[…]]}
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHandoff, handoffRows, formatJst, HANDOFF_RANGE, type HandoffState } from '../handoff.js';
import { valuesOfSavedRead } from './gate.js';

// 本番バッチがこの時間より前に動いたきりなら、止まっているとみなして試運転で続ける
export const API_STALE_SECONDS = 6 * 60 * 60;

export interface HandoffCheck {
  run: boolean;
  startEpoch: number;
  mode: 'api' | 'trial' | 'none';
  reason: string;
}

// 試運転の回を実行するか。startEpoch は本番が読んだ分を読み直さない対象の始まり（実行ログの C 列と API読了の大きい方）
export function trialCheck(state: HandoffState, logEndEpoch: number, nowEpoch: number): HandoffCheck {
  const startEpoch = Math.max(logEndEpoch, state.apiReadEpoch ?? 0);
  const mode = state.owner ?? 'none';
  if (mode === 'api') {
    const last = state.apiLastRun ? Date.parse(state.apiLastRun) / 1000 : NaN;
    if (Number.isFinite(last) && nowEpoch - last <= API_STALE_SECONDS) {
      return { run: false, startEpoch, mode, reason: '本番バッチが担当中のため見送り' };
    }
    return { run: true, startEpoch, mode, reason: '本番バッチが6時間以上動いていないため試運転で続ける' };
  }
  return { run: true, startEpoch, mode, reason: mode === 'trial' ? '試運転が担当' : '担当が未定のため試運転で続ける' };
}

// 試運転の回の終わりに書く表。担当は今の値のまま（未定なら trial）、試運転読了だけ更新する
export function trialRows(state: HandoffState, trialReadEpoch: number, nowEpoch: number): { range: string; values: string[][] } {
  const owner = state.owner ?? 'trial';
  const next: HandoffState = {
    ...state,
    owner,
    trialReadEpoch,
    reason: state.owner === undefined ? `試運転が担当（${formatJst(nowEpoch * 1000)}）` : state.reason,
  };
  return { range: HANDOFF_RANGE, values: handoffRows(next) };
}

function epochArg(arg: string | undefined, name: string): number {
  if (arg === undefined || !/^\d{1,12}$/.test(arg)) throw new Error(`${name} は epoch秒（整数）で指定してください`);
  return Number(arg);
}

function main(): void {
  const [cmd, file, a, b] = process.argv.slice(2);
  if ((cmd !== 'check' && cmd !== 'rows') || !file) {
    console.error('使い方: npm run --silent ses:trial:handoff -- <check|rows> <_運用の読み取りファイル> <実行ログのC列 または 試運転読了（epoch秒）> <nowEpochSec>');
    process.exitCode = 1;
    return;
  }
  const state = parseHandoff(valuesOfSavedRead(readFileSync(resolve(file), 'utf-8')));
  const epoch = epochArg(a, cmd === 'check' ? '実行ログのC列' : '試運転読了');
  const nowEpoch = epochArg(b, 'nowEpochSec');
  console.log(JSON.stringify(cmd === 'check' ? trialCheck(state, epoch, nowEpoch) : trialRows(state, epoch, nowEpoch)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`担当の引き継ぎの判定に失敗しました: ${err instanceof Error ? err.constructor.name : 'Error'}`);
    process.exitCode = 1;
  }
}
