// 記録画面。今日のサマリーと、セッション／衝動をまぜた時系列。

import { getState, TARGETS, TRIGGERS } from '../store.js';
import * as session from '../session.js';
import * as impulse from '../impulse.js';
import { el, fmtTime, fmtDay, fmtDuration, dayStart } from '../dom.js';

/** @typedef {import('../store.js').Session} Session */
/** @typedef {import('../store.js').Impulse} Impulse */

/** 時系列に並べるための共通形 @typedef {{ at: number, node: HTMLElement }} Row */

const TARGET_LABEL = new Map(TARGETS.map((t) => [t.id, t.label]));
const TRIGGER_LABEL = new Map(TRIGGERS.map((t) => [t.id, t.label]));

/** 表示する最大件数。古い記録は残るが、一覧が重くならないよう頭打ちにする。 */
const MAX_ROWS = 300;

/**
 * @param {string} value
 * @param {string} unit
 * @param {string} label
 * @returns {HTMLElement}
 */
function stat(value, unit, label) {
  const box = document.createElement('div');
  box.className = 'stat';
  const v = document.createElement('div');
  v.className = 'stat__value';
  v.textContent = value;
  if (unit) {
    const u = document.createElement('span');
    u.className = 'stat__unit';
    u.textContent = unit;
    v.append(u);
  }
  const l = document.createElement('div');
  l.className = 'stat__label';
  l.textContent = label;
  box.append(v, l);
  return box;
}

function renderSummary() {
  const { sessions, impulses } = getState();
  const from = dayStart(Date.now());

  const todaySessions = sessions.filter((s) => s.startedAt >= from);
  const servedMin = Math.round(todaySessions.reduce((sum, s) => sum + session.servedMs(s), 0) / 60000);
  const doneCount = todaySessions.filter((s) => s.status === 'done').length;

  const todayImpulses = impulses.filter((i) => i.at >= from);
  const resisted = todayImpulses.filter((i) => i.outcome === 'resisted').length;

  el('summary').replaceChildren(
    stat(String(servedMin), '分', '今日の実施'),
    stat(String(doneCount), '本', '完了'),
    stat(`${resisted}/${todayImpulses.length}`, '', '耐えた/衝動'),
  );
}

/**
 * @param {Session} s
 * @returns {HTMLElement}
 */
function sessionRow(s) {
  const row = document.createElement('div');
  row.className = s.status === 'done' ? 'entry' : 'entry entry--muted';

  const time = document.createElement('div');
  time.className = 'entry__time';
  time.textContent = fmtTime(s.startedAt);

  const body = document.createElement('div');
  body.className = 'entry__body';
  const main = document.createElement('div');
  main.className = 'entry__main';
  main.textContent = `セッション ${fmtDuration(s.durationMs)}`;
  const meta = document.createElement('div');
  meta.className = 'entry__meta';
  if (s.status === 'done') meta.textContent = '完了';
  else if (s.status === 'aborted') meta.textContent = `中断（${fmtDuration(session.servedMs(s))}）`;
  else meta.textContent = '実行中';
  body.append(main, meta);

  row.append(time, body, delButton('このセッションの記録を削除', () => session.remove(s.id)));
  return row;
}

/**
 * @param {Impulse} i
 * @returns {HTMLElement}
 */
function impulseRow(i) {
  const row = document.createElement('div');
  row.className = i.outcome === 'resisted' ? 'entry' : 'entry entry--muted';

  const time = document.createElement('div');
  time.className = 'entry__time';
  time.textContent = fmtTime(i.at);

  const body = document.createElement('div');
  body.className = 'entry__body';
  const main = document.createElement('div');
  main.className = 'entry__main';
  const outcome = i.outcome === 'resisted' ? '耐えた' : '見てしまった';
  main.textContent = `${TARGET_LABEL.get(i.target) ?? i.target} — ${outcome}`;

  const parts = [`強さ ${i.intensity}`];
  const triggers = i.triggers.map((t) => TRIGGER_LABEL.get(t) ?? t).filter(Boolean);
  if (triggers.length) parts.push(triggers.join('・'));
  if (i.note) parts.push(i.note);

  const meta = document.createElement('div');
  meta.className = 'entry__meta';
  meta.textContent = parts.join(' / ');
  body.append(main, meta);

  row.append(time, body, delButton('この記録を削除', () => impulse.remove(i.id)));
  return row;
}

/**
 * @param {string} label
 * @param {() => void} onClick
 * @returns {HTMLButtonElement}
 */
function delButton(label, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'entry__del';
  btn.textContent = '×';
  btn.setAttribute('aria-label', label);
  btn.addEventListener('click', () => {
    if (confirm(`${label}しますか？`)) onClick();
  });
  return btn;
}

export function render() {
  renderSummary();

  const { sessions, impulses } = getState();
  /** @type {Row[]} */
  const rows = [
    ...sessions.map((s) => ({ at: s.startedAt, node: sessionRow(s) })),
    ...impulses.map((i) => ({ at: i.at, node: impulseRow(i) })),
  ].sort((a, b) => b.at - a.at);

  const list = el('log-list');
  if (rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'まだ記録がありません。\nセッションを1本やるところから。';
    empty.style.whiteSpace = 'pre-line';
    list.replaceChildren(empty);
    return;
  }

  /** @type {HTMLElement[]} */
  const children = [];
  let currentDay = -1;
  for (const row of rows.slice(0, MAX_ROWS)) {
    const day = dayStart(row.at);
    if (day !== currentDay) {
      currentDay = day;
      const heading = document.createElement('h2');
      heading.className = 'log__day';
      heading.textContent = fmtDay(row.at);
      children.push(heading);
    }
    children.push(row.node);
  }
  if (rows.length > MAX_ROWS) {
    const more = document.createElement('p');
    more.className = 'empty';
    more.textContent = `ほか ${rows.length - MAX_ROWS} 件（書き出した JSON には全部入っています）`;
    children.push(more);
  }
  list.replaceChildren(...children);
}
