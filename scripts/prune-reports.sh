#!/usr/bin/env bash
# Prune old reports/swarm/<unix-ts>/ dirs to keep the repo lean.
#
# Each backtest run writes a new directory containing swarm.md +
# swarm.json + snapshot.json (~50 KB total). Without TTL these
# accumulate forever; at hourly cron that's ~720 dirs / month and ~36
# MB of git bloat. Only the most recent dir is actually consumed
# (bundle-snapshot.mjs reads it as the fallback when data/ isn't
# present); the rest are historical record only.
#
# Usage:
#   ./scripts/prune-reports.sh                  # keep last 168 (week of hourly)
#   ./scripts/prune-reports.sh --keep 24        # keep last 24 (day of hourly)
#   ./scripts/prune-reports.sh --keep 0         # delete all (DANGER)
#   ./scripts/prune-reports.sh --dry-run        # show what would go
#
# Run from repo root.

set -e

KEEP=168
DRY_RUN=0
DIR="reports/swarm"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP="$2"; shift 2 ;;
    --dry-run|-n) DRY_RUN=1; shift ;;
    --dir) DIR="$2"; shift 2 ;;
    --help|-h)
      grep -E '^# ' "$0" | sed 's/^# //'
      exit 0 ;;
    *) echo "unknown arg: $1"; exit 1 ;;
  esac
done

if [ ! -d "$DIR" ]; then
  echo "no $DIR directory; nothing to prune"
  exit 0
fi

# List numeric-name dirs sorted ascending (oldest first), drop the
# last $KEEP, target the rest for deletion. macOS `head -n -K` is
# unsupported (BSD head doesn't accept negative counts), so we use
# awk-based slicing for portability — works on macOS, Linux, GHA.
all=$(ls -1 "$DIR" 2>/dev/null | grep -E '^[0-9]+$' | sort -n)
total=$(echo "$all" | grep -c . || true)
drop=$(( total - KEEP ))
if [ "$drop" -le 0 ]; then
  to_del=""
else
  to_del=$(echo "$all" | awk -v n="$drop" 'NR<=n')
fi

if [ -z "$to_del" ]; then
  echo "have $total dirs, keeping last $KEEP — nothing to prune"
  exit 0
fi

count=$(echo "$to_del" | wc -l | tr -d ' ')
echo "would prune $count report dirs (keeping the latest $KEEP)"

if [ "$DRY_RUN" = "1" ]; then
  echo "$to_del" | head -10 | sed 's/^/  /'
  if [ "$count" -gt 10 ]; then
    echo "  ... ($((count - 10)) more)"
  fi
  exit 0
fi

echo "$to_del" | while read d; do
  if git ls-files --error-unmatch "$DIR/$d" >/dev/null 2>&1; then
    git rm -rf "$DIR/$d" >/dev/null
  else
    rm -rf "$DIR/$d"
  fi
done
echo "done."
