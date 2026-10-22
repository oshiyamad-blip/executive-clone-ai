// セッション画面。表示は常に「今の時刻」から組み立て直す（内部カウンタを持たない）。

import { getSettings, updateSettings } from '../store.js';
import * as session from '../session.js';
import { el, inputEl, show, fmtClock, fmtDuration, toast } from '../dom.js';
import {
  requestWakeLock,
  releaseWakeLock,
  reacquireWakeLock,
  ensureNotifyPermission,
  primeSound,
  fireCompletionAlert,
} from '../alerts.js';
import { openImpulseSheet, openAbortSheet } from './sheets.js';

/** @type {{ id: number, label: string }[]} */
const PRESETS = [15, 25, 30, 45, 60, 90].map((min) => ({ id: min, label: `${min}分` }));

let selectedMin = 30;
/** @type {ReturnType<typeof setInterval>|undefined} */
let ticker;
/** 完了の合図を二重に鳴らさないための番人 */
let alertedSessionId = '';

function paintPresets() {
  const container = el('duration-chips');
  container.replaceChildren(
    ...PRESETS.map((preset) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      btn.textContent = preset.label;
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(preset.id === selectedMin));
      btn.addEventListener('click', () => {
        selectedMin = preset.id;
        inputEl('custom-duration').value = '';
        render();
      });
      return btn;
    }),
  );
}

/**
 * ダイヤルの円弧を進捗（0..1）に合わせる。
 * @param {number} ratio
 */
function paintArc(ratio) {
  const arc = el('dial-arc');
  arc.setAttribute('stroke-dashoffset', String(Math.round(1000 * (1 - ratio))));
  // 長さ0でも stroke-linecap: round は点を描いてしまうので、始まる前は消しておく
  arc.style.opacity = ratio <= 0.001 ? '0' : '1';
}

/** 画面全体を今の状態から描き直す。 */
export function render() {
  const running = session.getRunning();
  const dial = el('dial');

  show(el('session-idle'), !running);
  show(el('session-running'), Boolean(running));

  if (running) {
    const left = session.remainingMs(running);
    el('dial-time').textContent = fmtClock(left);
    el('dial-caption').textContent = `${fmtDuration(running.durationMs)}のセッション`;
    dial.className = 'dial';
    paintArc(session.progress(running));
    show(el('session-result'), false);
    return;
  }

  paintPresets();
  const last = session.getLastFinished();
  // 直前の結果は、終わってから10分だけ出す（それ以降は次を始める画面に戻す）
  const fresh = last && last.endedAt !== null && Date.now() - last.endedAt < 10 * 60 * 1000;

  if (fresh && last) {
    const done = last.status === 'done';
    dial.className = done ? 'dial' : 'dial is-aborted';
    paintArc(done ? 1 : session.servedMs(last) / last.durationMs);
    el('dial-time').textContent = done ? fmtDuration(last.durationMs) : fmtDuration(session.servedMs(last));
    el('dial-caption').textContent = done ? '完了' : '中断';
    el('result-note').textContent = done
      ? `${fmtDuration(last.durationMs)}、離れていられました。`
      : `${fmtDuration(session.servedMs(last))}で中断。記録は残しました。`;
    show(el('session-result'), true);
    show(el('session-idle'), false);
  } else {
    dial.className = 'dial';
    paintArc(0);
    el('dial-time').textContent = fmtClock(selectedMin * 60000);
    el('dial-caption').textContent = '今日のセッションを始める';
    show(el('session-result'), false);
  }
}

/** 時間切れを確定させ、必要なら合図を鳴らす。 */
function tick() {
  const running = session.getRunning();
  const finished = session.settle();
  if (finished && finished.id !== alertedSessionId) {
    alertedSessionId = finished.id;
    releaseWakeLock();
    fireCompletionAlert(getSettings(), `${fmtDuration(finished.durationMs)}のセッションが終わりました。`);
  }
  if (!running && !finished && ticker !== undefined) {
    clearInterval(ticker);
    ticker = undefined;
  }
  render();
}

function startTicker() {
  if (ticker !== undefined) return;
  // 0.5秒間隔。表示は毎回 Date.now() から計算するので、間引かれてもズレない。
  ticker = setInterval(tick, 500);
}

/** @returns {number} 選択中の長さ（ミリ秒） */
function chosenDurationMs() {
  const custom = Number(inputEl('custom-duration').value);
  const min = Number.isFinite(custom) && custom >= 1 ? Math.min(600, Math.floor(custom)) : selectedMin;
  return min * 60000;
}

async function onStart() {
  const durationMs = chosenDurationMs();
  const started = session.start(durationMs);
  if (!started) return;

  const settings = getSettings();
  // 音と通知の許可は「開始」というユーザー操作の中でしか取れない。
  if (settings.sound) primeSound();
  if (settings.notify) {
    const granted = await ensureNotifyPermission();
    if (!granted) updateSettings({ notify: false });
  }
  if (settings.keepAwake) void requestWakeLock();

  startTicker();
  render();
}

export function initSessionView() {
  selectedMin = getSettings().defaultDurationMin;
  if (!PRESETS.some((p) => p.id === selectedMin)) {
    inputEl('custom-duration').value = String(selectedMin);
  }

  el('btn-start').addEventListener('click', () => void onStart());
  el('btn-again').addEventListener('click', () => void onStart());
  el('btn-resist').addEventListener('click', () => openImpulseSheet({ outcome: 'resisted' }));
  el('btn-abort').addEventListener('click', () => openAbortSheet());

  inputEl('custom-duration').addEventListener('input', () => {
    const value = Number(inputEl('custom-duration').value);
    if (Number.isFinite(value) && value >= 1) {
      selectedMin = Math.min(600, Math.floor(value));
      paintPresets();
      render();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    reacquireWakeLock();
    tick(); // 画面を離れている間に終わっていた場合をここで拾う
  });

  // 再起動直後に実行中だったセッションを引き継ぐ
  const resumed = session.getRunning();
  if (resumed) {
    // アプリを閉じている間に終わっていたなら、合図は鳴らさず結果だけ確定させる
    if (session.remainingMs(resumed) <= 0) alertedSessionId = resumed.id;
    if (getSettings().keepAwake) void requestWakeLock();
    startTicker();
    tick();
  } else {
    render();
  }
}

/** 中断が確定したあとの後片付け。 */
export function afterAbort() {
  releaseWakeLock();
  if (ticker !== undefined) {
    clearInterval(ticker);
    ticker = undefined;
  }
  render();
  toast('中断を記録しました');
}
