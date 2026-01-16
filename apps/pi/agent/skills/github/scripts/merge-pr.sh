#!/bin/bash
set -e

# Usage: ./merge-pr.sh <id>

PR_ID="$1"

if [ -z "$PR_ID" ]; then
  echo "Error: PR ID/URL is required."
  echo "Usage: ./merge-pr.sh <pr-number-or-url>"
  exit 1
fi

echo "Merging PR #$PR_ID using --merge strategy..."
gh pr merge "$PR_ID" --merge --auto
