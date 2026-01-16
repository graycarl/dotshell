#!/bin/bash
set -e

# Usage: 
#   ./check-status.sh        (View status of relevant PRs)
#   ./check-status.sh <id>   (View details of specific PR)

PR_ID="${1:-}"

if [ -z "$PR_ID" ]; then
  echo "Checking status of relevant pull requests..."
  gh pr status
else
  echo "Viewing details for PR #$PR_ID..."
  gh pr view "$PR_ID"
fi
