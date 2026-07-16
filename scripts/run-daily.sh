#!/usr/bin/env bash
# 日次バッチ（収集 → シグナル抽出）の cron / systemd 用ラッパー。
# cron は最小限の環境で実行されるため、PATH と node を明示的に用意する。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# cron の最小 PATH 対策: よくある node の場所と nvm を読み込む
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"

mkdir -p logs
LOG="logs/daily.log"
stamp() { date '+%Y-%m-%dT%H:%M:%S%z'; }

echo "[$(stamp)] daily start" >> "$LOG"
if npm run daily >> "$LOG" 2>&1; then
  echo "[$(stamp)] daily done" >> "$LOG"
else
  code=$?
  echo "[$(stamp)] daily FAILED (exit $code)" >> "$LOG"
  exit "$code"
fi
