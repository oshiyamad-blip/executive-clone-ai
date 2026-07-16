#!/usr/bin/env bash
# 日次・週次バッチを cron に登録する（冪等: 何度実行しても重複しない）。
#
# 使い方:
#   ./scripts/install-cron.sh            # 既定スケジュールで登録（日次3:00 / 週次 日曜4:00）
#   DAILY_CRON="30 2 * * *" WEEKLY_CRON="0 5 * * 0" ./scripts/install-cron.sh  # 時刻変更
#
# 解除: crontab -l | grep -v '# executive-clone-ai' | crontab -
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MARKER="# executive-clone-ai"
DAILY_TIME="${DAILY_CRON:-0 3 * * *}"
WEEKLY_TIME="${WEEKLY_CRON:-0 4 * * 0}"

# 既存 crontab から本アプリの行だけ除去（他の設定は保持）
current="$(crontab -l 2>/dev/null | grep -v "$MARKER" || true)"

new_lines="$(printf '%s %s/scripts/run-daily.sh %s (daily)\n%s %s/scripts/run-weekly.sh %s (weekly)\n' \
  "$DAILY_TIME" "$ROOT" "$MARKER" \
  "$WEEKLY_TIME" "$ROOT" "$MARKER")"

{
  [ -n "$current" ] && printf '%s\n' "$current"
  printf '%s\n' "$new_lines"
} | crontab -

echo "cron に登録しました:"
crontab -l | grep "$MARKER"
