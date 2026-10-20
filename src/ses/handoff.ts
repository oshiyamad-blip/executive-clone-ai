// Claude API の残高があるあいだは本番バッチ、尽きたら試運転（Claude Code の定期実行）に引き継ぎ、残高が戻れば本番に戻る。
// どちらが担当中かは営業リストのスプレッドシートの隠しタブ「_運用」に置く（試運転は本番の「_状態」の表計算を知らないため）。
// 見出し「項目」「値」の下に1行1項目: 担当（api / trial）・API最終実行・API読了・試運転読了・理由。値はすべて文字列。
import { handoffEnabled, isDemo, extractModel, llmProviderName, properSalesSpreadsheetId } from './config.js';
import { salesListConfigured, sheetsApi } from './proper/salesList.js';
import { withGoogleRetry, quoteTab } from '../database/sheetBook.js';
import { generateText } from '../llm/index.js';
import { isCreditExhausted, creditExhaustedInRun, resetCreditExhausted } from '../llm/errors.js';
import { recordHealEvent } from './heal/events.js';
import { notifyHandoff } from './notify.js';
import { safeErr } from './redact.js';

export const HANDOFF_TAB = '_運用';
export const HANDOFF_RANGE = `${quoteTab(HANDOFF_TAB)}!A1:B6`;
const READ_RANGE = `${quoteTab(HANDOFF_TAB)}!A1:B20`;

export type HandoffOwner = 'api' | 'trial';
export type CreditProbe = 'ok' | 'exhausted' | 'unknown';

export interface HandoffState {
  owner?: HandoffOwner;
  apiLastRun?: string; // 本番が最後に収集から書き込みまで終えた日時（ISO）
  apiReadEpoch?: number; // 本番が処理し終えた受信時刻の上限（epoch秒）
  trialReadEpoch?: number; // 試運転が処理し終えた受信時刻の上限（epoch秒）
  reason?: string; // 最後に担当が替わった理由
}

const LABELS = { owner: '担当', apiLastRun: 'API最終実行', apiReadEpoch: 'API読了', trialReadEpoch: '試運転読了', reason: '理由' } as const;

function epochOf(v: string): number | undefined {
  return /^\d{1,12}$/.test(v) ? Number(v) : undefined;
}

// 「_運用」の読み取り（見出しの行を含んでも含まなくてもよい）を状態として解釈する。読めない値は無いものとして扱う
export function parseHandoff(values: string[][]): HandoffState {
  const state: HandoffState = {};
  for (const row of values) {
    if (!Array.isArray(row)) continue;
    const key = String(row[0] ?? '').trim();
    const v = String(row[1] ?? '').trim();
    if (v === '') continue;
    if (key === LABELS.owner) {
      if (v === 'api' || v === 'trial') state.owner = v;
    } else if (key === LABELS.apiLastRun) {
      if (Number.isFinite(Date.parse(v))) state.apiLastRun = v.slice(0, 40);
    } else if (key === LABELS.apiReadEpoch) {
      const n = epochOf(v);
      if (n !== undefined) state.apiReadEpoch = n;
    } else if (key === LABELS.trialReadEpoch) {
      const n = epochOf(v);
      if (n !== undefined) state.trialReadEpoch = n;
    } else if (key === LABELS.reason) {
      state.reason = v.slice(0, 200);
    }
  }
  return state;
}

// 書き込む表（見出しつき。A1:B6）
export function handoffRows(state: HandoffState): string[][] {
  return [
    ['項目', '値'],
    [LABELS.owner, state.owner ?? ''],
    [LABELS.apiLastRun, state.apiLastRun ?? ''],
    [LABELS.apiReadEpoch, state.apiReadEpoch === undefined ? '' : String(state.apiReadEpoch)],
    [LABELS.trialReadEpoch, state.trialReadEpoch === undefined ? '' : String(state.trialReadEpoch)],
    [LABELS.reason, state.reason ?? ''],
  ];
}

// 日本時間の「2026/10/25 12:03」
export function formatJst(ms: number): string {
  const d = new Date(ms + 9 * 60 * 60 * 1000).toISOString();
  return `${d.slice(0, 4)}/${d.slice(5, 7)}/${d.slice(8, 10)} ${d.slice(11, 16)}`;
}

export interface ApiRunDecision {
  run: boolean;
  floorMs: number | null; // 収集の受信時刻の下限（試運転が読んだ分を読み直さない）
  reason: string;
}

// 本番バッチが今回の回を担当するか。試運転が担当中なら、残高の確認（credit）が ok のときだけ戻る。
// 担当が api・未定なら今までどおり実行する
export function decideApiRun(state: HandoffState, nowMs: number, credit: CreditProbe = 'unknown'): ApiRunDecision {
  if (state.owner !== 'trial') return { run: true, floorMs: null, reason: '本番バッチが担当' };
  if (credit !== 'ok') {
    return { run: false, floorMs: null, reason: credit === 'exhausted' ? '試運転が担当中のため見送り（API残高切れ）' : '試運転が担当中のため見送り（API残高を確かめられない）' };
  }
  const t = state.trialReadEpoch;
  const floorMs = t !== undefined && t > 0 && t * 1000 <= nowMs ? t * 1000 : null;
  return { run: true, floorMs, reason: 'API残高が戻ったため本番バッチに戻る' };
}

// ===== 営業リストの「_運用」の入出力 =====

// 読めない・タブが無い・営業リスト未設定は空の状態（担当は未定）
export async function readHandoff(): Promise<HandoffState> {
  const spreadsheetId = properSalesSpreadsheetId();
  if (!spreadsheetId) return {};
  try {
    const api = sheetsApi();
    if (!api) return {};
    const res = await withGoogleRetry(() => api.spreadsheets.values.get({ spreadsheetId, range: READ_RANGE }));
    return parseHandoff((res.data.values ?? []) as string[][]);
  } catch {
    return {};
  }
}

// タブが無ければ隠しタブで作ってから書く。書けなければ warn を記録して続ける
export async function writeHandoff(state: HandoffState): Promise<boolean> {
  const spreadsheetId = properSalesSpreadsheetId();
  if (!spreadsheetId) return false;
  try {
    const api = sheetsApi();
    if (!api) throw new Error('Google認証が未設定');
    const meta = await withGoogleRetry(() => api.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties(title))' }));
    if (!(meta.data.sheets ?? []).some((s) => s.properties?.title === HANDOFF_TAB)) {
      await withGoogleRetry(() =>
        api.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: HANDOFF_TAB, hidden: true } } }] } }),
      );
    }
    await withGoogleRetry(() =>
      api.spreadsheets.values.update({ spreadsheetId, range: HANDOFF_RANGE, valueInputOption: 'RAW', requestBody: { values: handoffRows(state) } }),
    );
    return true;
  } catch (err) {
    recordHealEvent('warn', `営業リストの「${HANDOFF_TAB}」（試運転との担当の引き継ぎ）を書けませんでした: ${safeErr(err)}`);
    return false;
  }
}

// ===== 残高の確認 =====

let probeOverride: (() => Promise<CreditProbe>) | null = null;

// 自己検証用: 実際の API を呼ばずに残高の確認結果を差し替える
export function __setCreditProbeForTest(fn: (() => Promise<CreditProbe>) | null): void {
  probeOverride = fn;
}

// 最小のリクエストを1回送って残高を確かめる。残高不足だけを exhausted とし、その他の失敗は unknown（担当は変えない）
export async function probeLlmCredit(): Promise<CreditProbe> {
  if (probeOverride) return probeOverride();
  if (isDemo() || llmProviderName() !== 'anthropic') return 'ok';
  try {
    await generateText('接続確認', [{ role: 'user', content: 'ok' }], { model: extractModel(), maxTokens: 1, maxRetries: 0, timeoutMs: 30_000 });
    return 'ok';
  } catch (err) {
    return isCreditExhausted(err) ? 'exhausted' : 'unknown';
  }
}

// ===== 本番バッチの流れ =====

let handoffFloorMs: number | null = null;

// 試運転から戻った回の収集の下限（試運転が読んだ分を読み直さない）。無ければ null
export function handoffCollectFloorMs(): number | null {
  return handoffFloorMs;
}

export interface HandoffBegin {
  proceed: boolean; // false なら収集以降を行わず終える
  state: HandoffState;
}

// 収集の前に呼ぶ。試運転が担当中なら残高を確かめ、戻れなければ見送る（異常終了にはしない）
export async function beginHandoff(now: Date = new Date()): Promise<HandoffBegin> {
  handoffFloorMs = null;
  resetCreditExhausted();
  if (!handoffEnabled() || !salesListConfigured()) return { proceed: true, state: {} };
  const state = await readHandoff();
  if (state.owner !== 'trial') return { proceed: true, state };

  const credit = await probeLlmCredit();
  resetCreditExhausted(); // 確認の呼び出しで見た残高切れを、この回の本処理の判断に持ち込まない
  const decision = decideApiRun(state, now.getTime(), credit);
  if (!decision.run) {
    const message = `SESバッチ: ${decision.reason}`;
    console.log(message);
    recordHealEvent('info', message);
    return { proceed: false, state };
  }
  const next: HandoffState = { ...state, owner: 'api', reason: `API残高が戻った（${formatJst(now.getTime())}）` };
  await writeHandoff(next);
  handoffFloorMs = decision.floorMs;
  const message = 'API残高が戻ったため、試運転から本番バッチに戻ります';
  console.log(`SESバッチ: ${message}`);
  recordHealEvent('info', message);
  return { proceed: true, state: next };
}

// 回の終わりに呼ぶ。残高切れを見ていれば試運転に引き継ぎ（この回の窓は試運転が読み直す）、
// 書き込みまで正常に終えていれば本番の読了を進める
export async function finishHandoff(begin: HandoffBegin, now: Date, completed: boolean): Promise<void> {
  if (!handoffEnabled() || !salesListConfigured()) return;
  if (creditExhaustedInRun()) {
    const next: HandoffState = { ...begin.state, owner: 'trial', reason: `API残高切れ（${formatJst(now.getTime())}）` };
    await writeHandoff(next);
    const message = 'Claude API の残高が尽きたため、次の回から試運転の定期実行に引き継ぎます';
    console.log(`SESバッチ: ${message}`);
    recordHealEvent('warn', message);
    await notifyHandoff(message);
    return;
  }
  if (!completed) return;
  await writeHandoff({ ...begin.state, owner: 'api', apiLastRun: now.toISOString(), apiReadEpoch: Math.floor(now.getTime() / 1000) });
}
