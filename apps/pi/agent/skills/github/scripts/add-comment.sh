#!/bin/bash
set -e

# Usage: ./add-comment.sh <id> "Comment Body"

PR_ID="$1"
COMMENT="$2"

if [ -z "$PR_ID" ] || [ -z "$COMMENT" ]; then
  echo "Error: PR ID and Comment Body are required."
  echo "Usage: ./add-comment.sh <pr-number-or-url> <comment-text>"
  exit 1
fi

echo "Adding comment to PR #$PR_ID..."
gh pr comment "$PR_ID" --body "$COMMENT"
