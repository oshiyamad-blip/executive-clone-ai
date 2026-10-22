// 設定画面。データの書き出し／読み込みもここ。

import { getSettings, updateSettings, exportJson, importJson, wipe, isPersistent } from '../store.js';
import { el, inputEl, toast } from '../dom.js';
import { ensureNotifyPermission, requestWakeLock, releaseWakeLock, primeSound } from '../alerts.js';

export const APP_VERSION = '1.0.0';

export function render() {
  const s = getSettings();
  inputEl('set-default-duration').value = String(s.defaultDurationMin);
  inputEl('set-keep-awake').checked = s.keepAwake;
  inputEl('set-notify').checked = s.notify;
  inputEl('set-sound').checked = s.sound;
  inputEl('set-vibrate').checked = s.vibrate;

  const warning = isPersistent() ? '' : '（この端末では保存できていません）';
  el('version-line').textContent = `ドーパミンデトックス v${APP_VERSION}${warning}`;
}

function download() {
  const blob = new Blob([exportJson()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const a = document.createElement('a');
  a.href = url;
  a.download = `detox-${stamp}.json`;
  a.click();
  // revoke を click と同じターンで呼ぶと保存前に失効する端末があるため、少し遅らせる
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * @param {File} file
 */
async function readAndImport(file) {
  try {
    const added = importJson(await file.text());
    toast(`セッション ${added.sessions} 件・衝動 ${added.impulses} 件を追加しました`);
  } catch {
    toast('読み込めませんでした（JSON の形式を確認してください）');
  }
}

export function initSettingsView() {
  inputEl('set-default-duration').addEventListener('change', () => {
    const value = Number(inputEl('set-default-duration').value);
    if (!Number.isFinite(value) || value < 1) {
      render();
      return;
    }
    updateSettings({ defaultDurationMin: Math.min(600, Math.floor(value)) });
  });

  inputEl('set-keep-awake').addEventListener('change', () => {
    const on = inputEl('set-keep-awake').checked;
    updateSettings({ keepAwake: on });
    if (on) void requestWakeLock();
    else releaseWakeLock();
  });

  inputEl('set-notify').addEventListener('change', async () => {
    const on = inputEl('set-notify').checked;
    if (!on) {
      updateSettings({ notify: false });
      return;
    }
    const granted = await ensureNotifyPermission();
    updateSettings({ notify: granted });
    if (!granted) toast('端末の設定で通知が拒否されています');
  });

  inputEl('set-sound').addEventListener('change', () => {
    const on = inputEl('set-sound').checked;
    updateSettings({ sound: on });
    if (on) primeSound();
  });

  inputEl('set-vibrate').addEventListener('change', () => {
    updateSettings({ vibrate: inputEl('set-vibrate').checked });
  });

  el('btn-export').addEventListener('click', download);

  el('btn-import').addEventListener('click', () => inputEl('file-import').click());
  inputEl('file-import').addEventListener('change', () => {
    const file = inputEl('file-import').files?.[0];
    if (file) void readAndImport(file);
    inputEl('file-import').value = ''; // 同じファイルを続けて選べるように
  });

  el('btn-wipe').addEventListener('click', () => {
    if (!confirm('すべてのセッションと衝動ログを削除します。元に戻せません。よろしいですか？')) return;
    wipe();
    toast('すべての記録を削除しました');
  });
}
