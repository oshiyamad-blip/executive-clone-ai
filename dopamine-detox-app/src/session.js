// デトックスセッションのドメインロジック。
// 残り時間は必ず「開始時刻＋長さ－現在時刻」で求める。setInterval の積算に頼ると、
// 画面ロックやタブのスロットリングでカウントが遅れる（Android では確実に起きる）。

import { getState, update, newId } from './store.js';

/** @typedef {import('./store.js').Session} Session */

/** @returns {Session|null} 実行中のセッション */
export function getRunning() {
  const running = getState().sessions.filter((s) => s.status === 'running');
  return running.length ? running[running.length - 1] : null;
}

/** @returns {Session|null} 最後に終わったセッション */
export function getLastFinished() {
  const finished = getState().sessions.filter((s) => s.status !== 'running');
  return finished.length ? finished[finished.length - 1] : null;
}

/**
 * @param {Session} session
 * @param {number} [now]
 * @returns {number} 残りミリ秒（0 未満にはしない）
 */
export function remainingMs(session, now = Date.now()) {
  return Math.max(0, session.startedAt + session.durationMs - now);
}

/**
 * @param {Session} session
 * @param {number} [now]
 * @returns {number} 0..1 の進捗
 */
export function progress(session, now = Date.now()) {
  if (session.durationMs <= 0) return 1;
  const done = (now - session.startedAt) / session.durationMs;
  return Math.min(1, Math.max(0, done));
}

/** 実際に座っていた時間（中断ならそこまで） @param {Session} s @returns {number} */
export function servedMs(s) {
  if (s.status === 'running') return Math.min(s.durationMs, Date.now() - s.startedAt);
  return Math.max(0, (s.endedAt ?? s.startedAt) - s.startedAt);
}

/**
 * セッションを開始する。実行中のものがあれば何もしない。
 * @param {number} durationMs
 * @returns {Session|null}
 */
export function start(durationMs) {
  if (getRunning()) return null;
  /** @type {Session} */
  const session = {
    id: newId(),
    startedAt: Date.now(),
    durationMs,
    endedAt: null,
    status: 'running',
  };
  update((s) => ({ ...s, sessions: [...s.sessions, session] }));
  return session;
}

/**
 * 実行中のセッションを中断する。
 * @returns {Session|null} 中断したセッション
 */
export function abort() {
  const running = getRunning();
  if (!running) return null;
  const ended = { ...running, status: /** @type {const} */ ('aborted'), endedAt: Date.now() };
  update((s) => ({ ...s, sessions: s.sessions.map((x) => (x.id === ended.id ? ended : x)) }));
  return ended;
}

/**
 * 時間切れの実行中セッションを完了に確定させる。
 * アプリを閉じている間に終わっていた場合もここで拾うため、起動時と毎tickで呼ぶ。
 * @returns {Session|null} このタイミングで完了になったセッション
 */
export function settle() {
  const running = getRunning();
  if (!running || remainingMs(running) > 0) return null;
  const ended = {
    ...running,
    status: /** @type {const} */ ('done'),
    endedAt: running.startedAt + running.durationMs,
  };
  update((s) => ({ ...s, sessions: s.sessions.map((x) => (x.id === ended.id ? ended : x)) }));
  return ended;
}

/**
 * @param {string} id
 */
export function remove(id) {
  update((s) => ({
    ...s,
    sessions: s.sessions.filter((x) => x.id !== id),
    // セッションを消したら、それに紐づく衝動ログは単独の記録として残す
    impulses: s.impulses.map((i) => (i.sessionId === id ? { ...i, sessionId: null } : i)),
  }));
}
