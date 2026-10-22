// DOM とフォーマットの薄いヘルパー。

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
export function el(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`要素が見つかりません: #${id}`);
  return node;
}

/**
 * @param {string} id
 * @returns {HTMLInputElement}
 */
export function inputEl(id) {
  return /** @type {HTMLInputElement} */ (el(id));
}

/**
 * @param {HTMLElement} node
 * @param {boolean} visible
 */
export function show(node, visible) {
  node.hidden = !visible;
}

/**
 * mm:ss（1時間以上なら h:mm:ss）
 * @param {number} ms
 * @returns {string}
 */
export function fmtClock(ms) {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * 「1時間25分」「40分」「45秒」
 * @param {number} ms
 * @returns {string}
 */
export function fmtDuration(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return `${Math.max(0, Math.round(ms / 1000))}秒`;
  if (min < 60) return `${min}分`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}時間` : `${h}時間${m}分`;
}

/**
 * @param {number} ts
 * @returns {string} "14:05"
 */
export function fmtTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** @param {number} ts @returns {number} その日の 00:00 の epoch ms */
export function dayStart(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/**
 * @param {number} ts
 * @returns {string} "今日" / "昨日" / "8月24日(日)"
 */
export function fmtDay(ts) {
  const today = dayStart(Date.now());
  const target = dayStart(ts);
  const diffDays = Math.round((today - target) / 86400000);
  if (diffDays === 0) return '今日';
  if (diffDays === 1) return '昨日';
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日(${WEEKDAYS[d.getDay()]})`;
}

/** @type {ReturnType<typeof setTimeout>|undefined} */
let toastTimer;

/**
 * @param {string} message
 */
export function toast(message) {
  const node = el('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 2200);
}

/**
 * チップ（丸ボタン）の選択グループを描画する。
 * multi=false は単一選択（role=radio）、true は複数選択（aria-pressed のトグル）。
 *
 * @template T
 * @param {HTMLElement} container
 * @param {{ id: T, label: string }[]} items
 * @param {Object} options
 * @param {boolean} [options.multi]
 * @param {T[]} options.selected
 * @param {(next: T[]) => void} options.onChange
 */
export function renderChips(container, items, options) {
  const multi = options.multi ?? false;
  container.replaceChildren(
    ...items.map((item) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      btn.textContent = item.label;
      const on = options.selected.includes(item.id);
      if (multi) {
        btn.setAttribute('aria-pressed', String(on));
      } else {
        btn.setAttribute('role', 'radio');
        btn.setAttribute('aria-checked', String(on));
      }
      btn.addEventListener('click', () => {
        if (multi) {
          const next = options.selected.includes(item.id)
            ? options.selected.filter((x) => x !== item.id)
            : [...options.selected, item.id];
          options.onChange(next);
        } else {
          options.onChange([item.id]);
        }
      });
      return btn;
    }),
  );
}
