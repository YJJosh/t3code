#!/usr/bin/env bash
set -euo pipefail

launcher="${XDG_BIN_HOME:-$HOME/.local/bin}/t3-dulli"
[[ -x "$launcher" ]] || {
  echo "T3 Dulli launcher is not installed: $launcher" >&2
  exit 1
}

pkill -u "$UID" -x t3-dulli-clean >/dev/null 2>&1 || true
for _ in {1..50}; do
  if ! pgrep -u "$UID" -x t3-dulli-clean >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

nohup "$launcher" >"${TMPDIR:-/tmp}/t3-dulli.log" 2>&1 &
disown || true
echo "Restarted T3 Dulli"
