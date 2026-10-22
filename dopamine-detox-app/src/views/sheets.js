// 衝動ログ入力シートと、中断理由シート。

import { TARGETS, TRIGGERS } from '../store.js';
import * as impulse from '../impulse.js';
import * as session from '../session.js';
import { el, inputEl, renderChips, toast } from '../dom.js';

/** @typedef {import('../store.js').Target} Target */
/** @typedef {import('../store.js').Trigger} Trigger */
/** @typedef {import('../store.js').Outcome} Outcome */

/** @type {{ id: 1|2|3|4|5, label: string }[]} */
const INTENSITY = [
  { id: 1, label: '1 かすか' },
  { id: 2, label: '2' },
  { id: 3, label: '3' },
  { id: 4, label: '4' },
  { id: 5, label: '5 強い' },
];

/** @type {{ id: Outcome, label: string }[]} */
const OUTCOMES = [
  { id: 'resisted', label: '耐えた' },
  { id: 'gave-in', label: '見てしまった' },
];

/**
 * @typedef {Object} Draft
 * @property {Target} target
 * @property {1|2|3|4|5} intensity
 * @property {Trigger[]} triggers
 * @property {Outcome} outcome
 */

/** @returns {Draft} */
function emptyDraft() {
  return { target: 'sns', intensity: 3, triggers: [], outcome: 'resisted' };
}

let draft = emptyDraft();
/** @type {Target} */
let abortTarget = 'sns';

function paintImpulseSheet() {
  renderChips(el('impulse-targets'), TARGETS, {
    selected: [draft.target],
    onChange: ([id]) => {
      draft.target = id;
      paintImpulseSheet();
    },
  });
  renderChips(el('impulse-intensity'), INTENSITY, {
    selected: [draft.intensity],
    onChange: ([id]) => {
      draft.intensity = id;
      paintImpulseSheet();
    },
  });
  renderChips(el('impulse-triggers'), TRIGGERS, {
    multi: true,
    selected: draft.triggers,
    onChange: (next) => {
      draft.triggers = next;
      paintImpulseSheet();
    },
  });
  renderChips(el('impulse-outcome'), OUTCOMES, {
    selected: [draft.outcome],
    onChange: ([id]) => {
      draft.outcome = id;
      paintImpulseSheet();
    },
  });
}

function paintAbortSheet() {
  renderChips(el('abort-targets'), TARGETS, {
    selected: [abortTarget],
    onChange: ([id]) => {
      abortTarget = id;
      paintAbortSheet();
    },
  });
}

/**
 * @param {string} id
 * @param {boolean} open
 */
function setSheet(id, open) {
  el(id).hidden = !open;
  document.body.style.overflow = open ? 'hidden' : '';
}

/**
 * 衝動ログのシートを開く。
 * @param {Object} [options]
 * @param {Outcome} [options.outcome] 初期値
 */
export function openImpulseSheet(options = {}) {
  draft = { ...emptyDraft(), outcome: options.outcome ?? 'resisted' };
  inputEl('impulse-note').value = '';
  paintImpulseSheet();
  setSheet('impulse-sheet', true);
}

/** 中断理由のシートを開く。 */
export function openAbortSheet() {
  abortTarget = 'sns';
  inputEl('abort-note').value = '';
  paintAbortSheet();
  setSheet('abort-sheet', true);
}

/**
 * シートのイベントを一度だけ配線する。
 * @param {Object} handlers
 * @param {() => void} handlers.onAborted
 */
export function initSheets(handlers) {
  for (const sheetId of ['impulse-sheet', 'abort-sheet']) {
    for (const closer of el(sheetId).querySelectorAll('[data-close]')) {
      closer.addEventListener('click', () => setSheet(sheetId, false));
    }
  }

  el('impulse-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const running = session.getRunning();
    impulse.add({
      target: draft.target,
      intensity: draft.intensity,
      triggers: draft.triggers,
      outcome: draft.outcome,
      note: inputEl('impulse-note').value,
      sessionId: running?.id ?? null,
    });
    setSheet('impulse-sheet', false);
    toast(draft.outcome === 'resisted' ? '耐えた記録を残しました' : '記録しました');
  });

  el('abort-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const running = session.getRunning();
    // 「中断＝その対象に負けた」なので、中断理由はそのまま衝動ログとして残す。
    impulse.add({
      target: abortTarget,
      intensity: 5,
      triggers: [],
      outcome: 'gave-in',
      note: inputEl('abort-note').value,
      sessionId: running?.id ?? null,
    });
    session.abort();
    setSheet('abort-sheet', false);
    handlers.onAborted();
  });

  // Android の戻るジェスチャは拾えないので、Esc だけ対応（PC ブラウザ用）
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    setSheet('impulse-sheet', false);
    setSheet('abort-sheet', false);
  });
}
