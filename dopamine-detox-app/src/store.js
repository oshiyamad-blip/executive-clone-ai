// 状態の単一の真実の源。端末内（localStorage）だけに保存し、外へは一切送らない。

/**
 * @typedef {'sns'|'video'|'news'|'game'|'shopping'|'message'|'other'} Target
 * @typedef {'bored'|'anxious'|'tired'|'lonely'|'stress'|'habit'|'notification'} Trigger
 * @typedef {'resisted'|'gave-in'} Outcome
 */

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {number} startedAt        開始時刻（epoch ms）
 * @property {number} durationMs       予定していた長さ
 * @property {number|null} endedAt     終了時刻。実行中は null
 * @property {'running'|'done'|'aborted'} status
 */

/**
 * @typedef {Object} Impulse
 * @property {string} id
 * @property {number} at
 * @property {Target} target
 * @property {1|2|3|4|5} intensity
 * @property {Trigger[]} triggers
 * @property {Outcome} outcome
 * @property {string} note
 * @property {string|null} sessionId   セッション中の記録なら、そのセッションID
 */

/**
 * @typedef {Object} Settings
 * @property {number} defaultDurationMin
 * @property {boolean} keepAwake
 * @property {boolean} notify
 * @property {boolean} sound
 * @property {boolean} vibrate
 */

/**
 * @typedef {Object} State
 * @property {number} version
 * @property {Session[]} sessions
 * @property {Impulse[]} impulses
 * @property {Settings} settings
 */

const KEY = 'dopamine-detox/v1';
export const SCHEMA_VERSION = 1;

/** @type {{ id: Target, label: string }[]} */
export const TARGETS = [
  { id: 'sns', label: 'SNS' },
  { id: 'video', label: '動画' },
  { id: 'news', label: 'ニュース' },
  { id: 'game', label: 'ゲーム' },
  { id: 'shopping', label: '買い物' },
  { id: 'message', label: 'メッセージ' },
  { id: 'other', label: 'その他' },
];

/** @type {{ id: Trigger, label: string }[]} */
export const TRIGGERS = [
  { id: 'bored', label: '退屈' },
  { id: 'anxious', label: '不安' },
  { id: 'tired', label: '疲れ' },
  { id: 'lonely', label: '寂しさ' },
  { id: 'stress', label: 'ストレス' },
  { id: 'habit', label: 'クセ' },
  { id: 'notification', label: '通知' },
];

/** @type {Settings} */
const DEFAULT_SETTINGS = {
  defaultDurationMin: 30,
  keepAwake: true,
  notify: true,
  sound: true,
  vibrate: true,
};

/** @returns {State} */
function emptyState() {
  return { version: SCHEMA_VERSION, sessions: [], impulses: [], settings: { ...DEFAULT_SETTINGS } };
}

// localStorage は Android の「サイトデータ削除」やプライベート閲覧で落ちうる。
// 失敗してもアプリ自体は動くよう、メモリ上の state で縮退する。
let persistent = true;

/**
 * 保存された JSON を、欠けたキーを埋めながら State に整える。
 * @param {unknown} raw
 * @returns {State}
 */
export function normalize(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  const obj = /** @type {Record<string, unknown>} */ (raw);
  return {
    version: SCHEMA_VERSION,
    sessions: Array.isArray(obj.sessions) ? /** @type {Session[]} */ (obj.sessions) : [],
    impulses: Array.isArray(obj.impulses) ? /** @type {Impulse[]} */ (obj.impulses) : [],
    settings: {
      ...base.settings,
      ...(obj.settings && typeof obj.settings === 'object' ? obj.settings : {}),
    },
  };
}

/** @returns {State} */
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyState();
    return normalize(JSON.parse(raw));
  } catch {
    persistent = false;
    return emptyState();
  }
}

/** @type {State} */
let state = load();

/** @type {Set<() => void>} */
const listeners = new Set();

/** @returns {State} */
export function getState() {
  return state;
}

/** @returns {Settings} */
export function getSettings() {
  return state.settings;
}

/** 保存が効いているか（false なら再読み込みで記録が消える） @returns {boolean} */
export function isPersistent() {
  return persistent;
}

/**
 * @param {() => void} fn
 * @returns {() => void} 解除する関数
 */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function commit() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    persistent = true;
  } catch {
    persistent = false;
  }
  for (const fn of listeners) fn();
}

/**
 * State を差し替えて保存する。
 * @param {(current: State) => State} updater
 */
export function update(updater) {
  state = updater(state);
  commit();
}

/**
 * @param {Partial<Settings>} patch
 */
export function updateSettings(patch) {
  update((s) => ({ ...s, settings: { ...s.settings, ...patch } }));
}

/** @returns {string} */
export function newId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 書き出し用の JSON 文字列 @returns {string} */
export function exportJson() {
  return JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2);
}

/**
 * 書き出した JSON を取り込む。同じ id は上書きせず、新しいものだけ足す。
 * @param {string} text
 * @returns {{ sessions: number, impulses: number }} 追加された件数
 */
export function importJson(text) {
  const incoming = normalize(JSON.parse(text));
  const sessionIds = new Set(state.sessions.map((s) => s.id));
  const impulseIds = new Set(state.impulses.map((i) => i.id));
  const sessions = incoming.sessions.filter((s) => s && s.id && !sessionIds.has(s.id));
  const impulses = incoming.impulses.filter((i) => i && i.id && !impulseIds.has(i.id));
  update((s) => ({
    ...s,
    sessions: [...s.sessions, ...sessions].sort((a, b) => a.startedAt - b.startedAt),
    impulses: [...s.impulses, ...impulses].sort((a, b) => a.at - b.at),
  }));
  return { sessions: sessions.length, impulses: impulses.length };
}

/** すべての記録を消す（設定は残す）。 */
export function wipe() {
  update((s) => ({ ...emptyState(), settings: s.settings }));
}
