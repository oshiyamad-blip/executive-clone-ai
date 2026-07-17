#!/usr/bin/env bash
# 月次バッチ（検収 → 運用ダッシュボード表示）の cron / systemd 用ラッパー。
# 発行(billing:issue)・下書き作成(billing:drafts)は承認後に手動実行する運用のため、
# ここでは自動実行しない（詳細は docs/billing-operations.md）。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# cron の最小 PATH 対策: よくある node の場所と nvm を読み込む
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"

mkdir -p logs
LOG="logs/monthly.log"
stamp() { date '+%Y-%m-%dT%H:%M:%S%z'; }

echo "[$(stamp)] monthly start" >> "$LOG"
if npm run billing:inspect >> "$LOG" 2>&1 && npm run billing:status >> "$LOG" 2>&1; then
  echo "[$(stamp)] monthly done" >> "$LOG"
else
  code=$?
  echo "[$(stamp)] monthly FAILED (exit $code)" >> "$LOG"
  exit "$code"
fi

# 先回り提案と経営レポート（失敗しても月次バッチ全体は失敗にしない）
npm run match >> "$LOG" 2>&1 || echo "[$(stamp)] match skipped/failed" >> "$LOG"
npm run billing:report >> "$LOG" 2>&1 || echo "[$(stamp)] report skipped/failed" >> "$LOG"
