#!/usr/bin/env bash
# Delete old GitHub Actions workflow runs to keep the Actions UI tidy.
#
# Usage:
#   ./scripts/clean-runs.sh                    # delete all failed + cancelled runs
#   ./scripts/clean-runs.sh failure            # only failed
#   ./scripts/clean-runs.sh success --keep 20  # keep the 20 most recent successes, delete the rest
#
# Requires `gh` (GitHub CLI) authenticated to a user with admin on the repo.

set -e

REPO="elysian-12/pythia-engine"
WORKFLOW="refresh-snapshot.yml"
KEEP=0
STATUSES=("failure" "cancelled")

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --workflow) WORKFLOW="$2"; shift 2 ;;
    --help|-h)
      grep -E '^# ' "$0" | sed 's/^# //'
      exit 0 ;;
    *) STATUSES=("$1"); shift ;;
  esac
done

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI not found. Install: brew install gh"
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "gh not authenticated. Run: gh auth login"
  exit 1
fi

for status in "${STATUSES[@]}"; do
  echo "==> Listing $status runs (workflow=$WORKFLOW, repo=$REPO, keep=$KEEP)"
  ids=$(gh run list --workflow="$WORKFLOW" --status="$status" --limit 200 \
                    --repo "$REPO" --json databaseId \
        | jq -r ".[$KEEP:][].databaseId")
  if [[ -z "$ids" ]]; then
    echo "    (none)"
    continue
  fi
  count=$(echo "$ids" | wc -l | tr -d ' ')
  echo "    deleting $count run(s)"
  echo "$ids" | xargs -I {} gh run delete {} --repo "$REPO"
done

echo "done."
