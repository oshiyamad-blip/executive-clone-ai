// 端末側の合図まわり（画面ロック抑止・通知・音・振動）。
// どれも対応していない端末があるため、すべて「失敗しても黙って諦める」方針。

/** @typedef {import('./store.js').Settings} Settings */

/** @type {WakeLockSentinel|null} */
let sentinel = null;
let wakeWanted = false;

/**
 * 画面を消さないようにする。Android Chrome は対応しているが、
 * 画面を伏せる／他アプリに移ると自動解除されるため、復帰時に取り直す。
 */
export async function requestWakeLock() {
  wakeWanted = true;
  if (!('wakeLock' in navigator)) return;
  if (sentinel && !sentinel.released) return;
  try {
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => {
      sentinel = null;
    });
  } catch {
    sentinel = null; // 電池セーバー中などは取得できない
  }
}

export function releaseWakeLock() {
  wakeWanted = false;
  void sentinel?.release().catch(() => {});
  sentinel = null;
}

/** 画面復帰時に呼ぶ。必要ならロックを取り直す。 */
export function reacquireWakeLock() {
  if (wakeWanted && document.visibilityState === 'visible') void requestWakeLock();
}

/**
 * 通知の許可を求める。ユーザー操作の中から呼ぶこと。
 * @returns {Promise<boolean>}
 */
export async function ensureNotifyPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

/**
 * @param {string} title
 * @param {string} body
 */
async function notify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    // Android Chrome は new Notification() が使えず、Service Worker 経由が必須。
    const reg = await navigator.serviceWorker?.ready;
    await reg?.showNotification(title, { body, icon: './assets/icon-192.png', tag: 'detox-session' });
  } catch {
    /* 通知できなくても本体の動作には影響させない */
  }
}

/** @type {AudioContext|null} */
let audio = null;

/** ユーザー操作のタイミングで音の準備をしておく（自動再生制限の回避）。 */
export function primeSound() {
  try {
    const Ctor = window.AudioContext ?? /** @type {any} */ (window).webkitAudioContext;
    if (!Ctor) return;
    audio ??= new Ctor();
    void audio.resume();
  } catch {
    audio = null;
  }
}

/** 短い和音を2回。音源ファイルを持たずに済ませる。 */
function chime() {
  if (!audio) return;
  try {
    const now = audio.currentTime;
    for (const [i, freq] of [523.25, 659.25].entries()) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const at = now + i * 0.18;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.25, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.6);
      osc.connect(gain).connect(audio.destination);
      osc.start(at);
      osc.stop(at + 0.65);
    }
  } catch {
    /* 無音で続行 */
  }
}

/**
 * セッション完了の合図。
 * @param {Settings} settings
 * @param {string} body
 */
export function fireCompletionAlert(settings, body) {
  if (settings.sound) chime();
  if (settings.vibrate && 'vibrate' in navigator) navigator.vibrate([180, 90, 180]);
  if (settings.notify) void notify('セッション完了', body);
}
