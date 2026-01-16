#!/bin/bash
set -e

# Usage: ./create-pr.sh "Title" "Body" ["BaseBranch"]

TITLE="$1"
BODY="${2:-}"
BASE="${3:-}"

if [ -z "$TITLE" ]; then
  echo "Error: Title is required."
  echo "Usage: ./create-pr.sh <title> [body] [base-branch]"
  exit 1
fi

CMD=(gh pr create --title "$TITLE" --body "$BODY")

if [ -n "$BASE" ]; then
  CMD+=(--base "$BASE")
fi

echo "Creating Pull Request..."
"${CMD[@]}"
