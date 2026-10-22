// 営業リストの A・B の未着手がたまったらバッチを止め、減ったら再開する。
// 営業が手を付けないまま候補がたまるなら、収集・抽出・照合を回さず使用量を抑える。
// 数えるもの: 「全体」タブの行のうち、優先度が A（A 提案推奨）か B（B 条件交渉）で、対応状況が未着手（空も未着手）の行数。
// 止める: その数が SES_PAUSE_AB_UNTOUCHED 以上。再開: 止めている間に SES_RESUME_AB_UNTOUCHED 以下になったら。
// 再開した回のメールは新しい順に SES_RESUME_MAX_MAILS 通まで（収集の下限 floorMs を状態に残す。数えられなければ直近 SES_RESUME_LOOKBACK_HOURS 時間）。
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { healDataDir, durableStateInSheets, pauseAbUntouched, resumeAbUntouched, resumeLookbackHours, resumeMaxMails, collectDays } from './config.js';
import { nthNewestReceivedMs } from './mail/index.js';
import { sheetsDbConfigured, readStateJson, writeStateJson } from '../database/sheets.js';
import { readSalesAllValues, salesListConfigured, SALES_PRIORITIES, SALES_STATUSES } from './proper/salesList.js';
import { recordHealEvent } from './heal/events.js';
import { notifyPaused } from './notify.js';
import { safeErr } from './redact.js';

const STATE_KEY = 'pauseGate';

export interface PauseState {
  paused: boolean;
  pausedAt?: string; // 止め始めた日時（ISO）
  count?: number; // 直近の判定時の未着手の行数
  floorMs?: number; // 再開した回の収集の下限（受信時刻がこれ未満のメールは読まない）
}

// 「全体」の読み取り（行0が見出し）から、A・B で対応状況が未着手（空も含む）の行数を数える。
// 列は見出しの名前で探す（B:M だけの読み取りでも動くように）。見出しに無ければ 0
export function countUntouchedAB(values: string[][]): number {
  const header = (values[0] ?? []).map((h) => String(h ?? '').trim());
  const priorityCol = header.indexOf('優先度');
  const statusCol = header.indexOf('対応状況');
  if (priorityCol < 0 || statusCol < 0) return 0;
  let n = 0;
  for (const row of values.slice(1)) {
    const priority = String(row[priorityCol] ?? '').trim();
    // 条件付き書式と同じく、先頭の記号（A / B）でも見る
    const isAB = priority === SALES_PRIORITIES.a || priority === SALES_PRIORITIES.b || priority.startsWith('A ') || priority.startsWith('B ');
    if (!isAB) continue;
    const status = String(row[statusCol] ?? '').trim();
    if (status === '' || status === SALES_STATUSES[0]) n += 1;
  }
  return n;
}

// 止めるか・再開するか。pauseAt <= 0 はゲート無効（止めていた状態は解く）
export function decidePause(count: number, wasPaused: boolean, pauseAt: number, resumeAt: number): { paused: boolean; resumed: boolean } {
  if (pauseAt <= 0) return { paused: false, resumed: wasPaused };
  if (wasPaused) {
    const paused = count > resumeAt;
    return { paused, resumed: !paused };
  }
  return { paused: count >= pauseAt, resumed: false };
}

// 収集の下限。止めている間（営業リストを読めずゲートが続く回）は、止めていた間の古いメールを読まないよう
// max(残した floorMs, 今−lookbackHours)。止めていなければ再開した回に残した floorMs。
// 無い・読めない・未来の値は無いものとして扱う（時計のずれで全メールを止めない）。下限が無ければ null
export function collectFloorMs(state: PauseState | null, nowMs: number, lookbackHours: number): number | null {
  const f = state?.floorMs;
  const stored = typeof f === 'number' && Number.isFinite(f) && f > 0 && f <= nowMs ? f : null;
  if (state?.paused !== true) return stored;
  return Math.max(stored ?? -Infinity, nowMs - lookbackHours * 60 * 60 * 1000);
}

// 再開した回の収集の下限。nth は「新しい順に n 通目の受信時刻」: 数ならその時刻（その時刻ちょうどのメールも読む）、
// null は n 通に満たない（止めていた間のメールが少ない）ので窓全体（今−収集日数。処理済みは処理済みIDで除かれる）、
// 'error' は数えられなかったので今−遡り時間
export function resumeFloorMs(nth: number | null | 'error', nowMs: number, days: number, lookbackHours: number): number {
  if (nth === 'error') return nowMs - lookbackHours * 60 * 60 * 1000;
  if (nth === null) return nowMs - days * 24 * 60 * 60 * 1000;
  return nth;
}

// 新しい順に SES_RESUME_MAX_MAILS 通目の時刻を数えて下限にする。失敗しても例外にせず、件数だけの警告を残して予備の下限にする
async function resumeFloorNow(now: Date): Promise<number> {
  let nth: number | null | 'error';
  try {
    nth = await nthNewestReceivedMs(resumeMaxMails(), now);
  } catch (err) {
    nth = 'error';
    recordHealEvent('warn', `再開の下限: 新しい順の ${resumeMaxMails()} 通目を数えられなかったため、直近 ${resumeLookbackHours()} 時間のメールから読みます: ${safeErr(err)}`);
  }
  return resumeFloorMs(nth, now.getTime(), collectDays(), resumeLookbackHours());
}

// 保存された値（「_状態」タブのセルは人も編集できる）を状態として解釈する。読めなければ null
export function pauseStateFrom(value: unknown): PauseState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.paused !== 'boolean') return null;
  const state: PauseState = { paused: v.paused };
  if (typeof v.pausedAt === 'string') state.pausedAt = v.pausedAt.slice(0, 40);
  if (typeof v.count === 'number' && Number.isFinite(v.count)) state.count = v.count;
  if (typeof v.floorMs === 'number' && Number.isFinite(v.floorMs)) state.floorMs = v.floorMs;
  return state;
}

function inSheets(): boolean {
  return durableStateInSheets() && sheetsDbConfigured();
}

function filePath(): string {
  return join(process.cwd(), healDataDir(), 'pause-gate.json');
}

// 読めない・壊れている場合は null（止めていない扱い）
export async function loadPauseState(): Promise<PauseState | null> {
  try {
    if (inSheets()) return pauseStateFrom(await readStateJson<unknown>(STATE_KEY));
    if (!existsSync(filePath())) return null;
    return pauseStateFrom(JSON.parse(readFileSync(filePath(), 'utf-8')));
  } catch {
    return null;
  }
}

// 書けなければ warn を記録して続ける
async function savePauseState(state: PauseState): Promise<void> {
  try {
    if (inSheets()) {
      await writeStateJson(STATE_KEY, state);
      return;
    }
    const dir = join(process.cwd(), healDataDir());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filePath(), JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    recordHealEvent('warn', `営業リストの未着手による見送りの状態を保存できませんでした: ${safeErr(err)}`);
  }
}

export interface PauseGateOutcome {
  paused: boolean; // 止める（止めたまま）。呼び出し側は収集以降を行わない
  resumed: boolean; // 今回の回で再開した
  count: number | null; // 数えた行数（判定しなかった場合は null）
}

// 本番の通常バッチの冒頭で呼ぶ。営業リストが未設定・ゲート無効・営業リストを読めない場合は何もせず続ける
export async function applyPauseGate(now: Date = new Date()): Promise<PauseGateOutcome> {
  const none: PauseGateOutcome = { paused: false, resumed: false, count: null };
  const pauseAt = pauseAbUntouched();
  if (pauseAt <= 0 || !salesListConfigured()) {
    // 止めたまま設定を外すと状態が残り、古いメールを全部読んだり、後で戻したときに通知なしで止まったりするため、ここで解く
    if ((await loadPauseState())?.paused === true) {
      const message = `見送りを解除（ゲート無効または営業リスト未設定）。新しい順に ${resumeMaxMails()} 通のメールから読む`;
      console.log(`SESバッチ: ${message}`);
      recordHealEvent('info', message);
      await savePauseState({ paused: false, floorMs: await resumeFloorNow(now) });
      return { paused: false, resumed: true, count: null };
    }
    return none;
  }

  const values = await readSalesAllValues();
  if (!values) {
    recordHealEvent('warn', '営業リストの「全体」タブを読めないため、未着手の件数を確かめずにバッチを続けます');
    return none;
  }
  const state = await loadPauseState();
  const wasPaused = state?.paused === true;
  const count = countUntouchedAB(values);
  const resumeAt = resumeAbUntouched();
  const decision = decidePause(count, wasPaused, pauseAt, resumeAt);

  if (decision.paused) {
    const message = `SESバッチ: 営業リストの A・B の未着手が ${count} 行のため見送り（${resumeAt} 行以下で再開）`;
    console.log(message);
    recordHealEvent('warn', message);
    await savePauseState({ paused: true, pausedAt: wasPaused ? state?.pausedAt ?? now.toISOString() : now.toISOString(), count });
    if (!wasPaused) await notifyPaused(message);
    return { paused: true, resumed: false, count };
  }
  if (decision.resumed) {
    const message = `再開（A・B の未着手 ${count} 行）。新しい順に ${resumeMaxMails()} 通のメールから読む`;
    console.log(`SESバッチ: ${message}`);
    recordHealEvent('info', message);
    await savePauseState({ paused: false, floorMs: await resumeFloorNow(now) });
    return { paused: false, resumed: true, count };
  }
  return { paused: false, resumed: false, count };
}
