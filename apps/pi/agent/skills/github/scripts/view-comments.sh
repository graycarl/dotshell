#!/bin/bash
set -e

# Usage: ./view-comments.sh <pr-number>

PR_NUMBER="$1"

if [ -z "$PR_NUMBER" ]; then
  echo "Error: PR number is required."
  exit 1
fi

# Function to extract numeric ID if a full URL is provided
if [[ "$PR_NUMBER" =~ ^https://github.com/([^/]+)/([^/]+)/pull/([0-9]+)$ ]]; then
  OWNER="${BASH_REMATCH[1]}"
  REPO="${BASH_REMATCH[2]}"
  PR_NUMBER="${BASH_REMATCH[3]}"
else
  # Try to detect repo from current directory if not URL
  REPO_FULL=$(gh repo view --json nameWithOwner -q .nameWithOwner)
  OWNER=$(echo "$REPO_FULL" | cut -d'/' -f1)
  REPO=$(echo "$REPO_FULL" | cut -d'/' -f2)
fi

echo "Fetching comments for $OWNER/$REPO PR #$PR_NUMBER..."

# Fetch Issue Comments (General conversation)
# Transform to unify structure: type="Comment", path=null
ISSUE_COMMENTS=$(gh api "/repos/$OWNER/$REPO/issues/$PR_NUMBER/comments" --jq '[.[] | {type: "Comment", user: .user.login, body: .body, created_at: .created_at, path: null, line: null}]')

# Fetch Review Comments (Code line comments)
# Transform to unify structure: type="Review", path=.path
REVIEW_COMMENTS=$(gh api "/repos/$OWNER/$REPO/pulls/$PR_NUMBER/comments" --jq '[.[] | {type: "Review", user: .user.login, body: .body, created_at: .created_at, path: .path, line: .line}]')

# Merge, Sort by Date, and Print
# Uses jq to format the output for readability
echo "$ISSUE_COMMENTS" "$REVIEW_COMMENTS" | jq -r -s '
  add | sort_by(.created_at) | .[] | 
  "--------------------------------------------------\n" +
  "[\(.created_at)] \(.user) (\(.type))\n" +
  (if .path then "File: \(.path) (Line: \(.line))\n" else "" end) +
  "\n\(.body)\n"
'
