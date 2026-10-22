// 起動とタブ切り替え。

import { subscribe, getState } from './store.js';
import * as sessionView from './views/session.js';
import * as logView from './views/log.js';
import * as settingsView from './views/settings.js';
import { initSheets, openImpulseSheet } from './views/sheets.js';
import { el, fmtDuration, dayStart } from './dom.js';
import * as session from './session.js';

/** @typedef {'session'|'log'|'settings'} ViewName */

const TITLES = { session: 'セッション', log: '記録', settings: '設定' };

/** @type {ViewName} */
let current = 'session';

function renderTopline() {
  const { sessions, impulses } = getState();
  const from = dayStart(Date.now());
  const todaySessions = sessions.filter((s) => s.startedAt >= from);
  const count = impulses.filter((i) => i.at >= from).length;

  if (todaySessions.length === 0 && count === 0) {
    el('today-line').textContent = '今日はまだ記録がありません';
    return;
  }
  const servedMs = todaySessions.reduce((sum, s) => sum + session.servedMs(s), 0);
  el('today-line').textContent = `今日 ${fmtDuration(servedMs)} ／ 衝動 ${count} 件`;
}

/** 今表示している画面だけを描き直す。 */
function render() {
  renderTopline();
  // セッション中は画面側に大きな記録ボタンが出るので、FAB は引っ込める
  el('fab-impulse').hidden = current === 'session' && session.getRunning() !== null;
  if (current === 'session') sessionView.render();
  else if (current === 'log') logView.render();
  else settingsView.render();
}

/**
 * @param {ViewName} name
 */
function switchTo(name) {
  current = name;
  el('view-title').textContent = TITLES[name];
  for (const view of /** @type {ViewName[]} */ (['session', 'log', 'settings'])) {
    el(`view-${view}`).hidden = view !== name;
  }
  for (const btn of document.querySelectorAll('.tabbar__btn')) {
    const active = btn.getAttribute('data-view') === name;
    btn.classList.toggle('is-active', active);
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }
  window.scrollTo(0, 0);
  render();
}

function initTabs() {
  for (const btn of document.querySelectorAll('.tabbar__btn')) {
    btn.addEventListener('click', () => {
      const name = btn.getAttribute('data-view');
      if (name === 'session' || name === 'log' || name === 'settings') switchTo(name);
    });
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // file:// で開いたときは登録できないので、失敗しても無視してよい
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

function main() {
  initTabs();
  initSheets({ onAborted: () => sessionView.afterAbort() });
  settingsView.initSettingsView();
  sessionView.initSessionView();

  el('fab-impulse').addEventListener('click', () => openImpulseSheet());

  // 保存のたびに、表示中の画面を追従させる
  subscribe(render);

  switchTo('session');
  registerServiceWorker();
}

main();
