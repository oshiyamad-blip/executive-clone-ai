// 衝動ログ。1タップで残せることを最優先に、詳細はすべて任意にしている。

import { update, newId } from './store.js';

/** @typedef {import('./store.js').Impulse} Impulse */

/**
 * @param {Object} input
 * @param {import('./store.js').Target} input.target
 * @param {1|2|3|4|5} [input.intensity]
 * @param {import('./store.js').Trigger[]} [input.triggers]
 * @param {import('./store.js').Outcome} [input.outcome]
 * @param {string} [input.note]
 * @param {string|null} [input.sessionId]
 * @returns {Impulse}
 */
export function add(input) {
  /** @type {Impulse} */
  const entry = {
    id: newId(),
    at: Date.now(),
    target: input.target,
    intensity: input.intensity ?? 3,
    triggers: input.triggers ?? [],
    outcome: input.outcome ?? 'resisted',
    note: (input.note ?? '').trim(),
    sessionId: input.sessionId ?? null,
  };
  update((s) => ({ ...s, impulses: [...s.impulses, entry] }));
  return entry;
}

/** @param {string} id */
export function remove(id) {
  update((s) => ({ ...s, impulses: s.impulses.filter((x) => x.id !== id) }));
}
