#!/usr/bin/env bash
# 週次バッチ（ストーリー構築）の cron / systemd 用ラッパー。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# cron の最小 PATH 対策
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"

mkdir -p logs
LOG="logs/weekly.log"
stamp() { date '+%Y-%m-%dT%H:%M:%S%z'; }

echo "[$(stamp)] weekly start" >> "$LOG"
if npm run weekly >> "$LOG" 2>&1; then
  echo "[$(stamp)] weekly done" >> "$LOG"
else
  code=$?
  echo "[$(stamp)] weekly FAILED (exit $code)" >> "$LOG"
  exit "$code"
fi
