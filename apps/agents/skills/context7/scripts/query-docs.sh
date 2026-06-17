#!/bin/bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AUTH_FILE="$SKILL_DIR/auth.json"

if [ ! -f "$AUTH_FILE" ]; then
  echo "Error: auth.json not found at $AUTH_FILE" >&2
  echo "Copy auth.json.tpl to auth.json and fill in your API key from https://context7.ai/dashboard" >&2
  exit 1
fi

if command -v jq &>/dev/null; then
  CONTEXT7_API_KEY=$(jq -r '.api_key // empty' "$AUTH_FILE")
else
  CONTEXT7_API_KEY=$(python3 -c "import json,sys; d=json.load(open('$AUTH_FILE')); print(d.get('api_key',''))" 2>/dev/null)
fi

if [ -z "${CONTEXT7_API_KEY:-}" ]; then
  echo "Error: api_key is missing or empty in $AUTH_FILE" >&2
  exit 1
fi

if [ $# -lt 2 ]; then
  echo "Usage: $0 <libraryId> <query>" >&2
  echo "Example: $0 /vercel/next.js \"How do I configure Next.js middleware?\"" >&2
  exit 1
fi

LIBRARY_ID="$1"
shift
QUERY="$*"

API_URL="https://context7.com/api/v2/context"
RESPONSE_FILE=$(mktemp)

HTTP_STATUS=$(curl -sS -w "%{http_code}" -o "$RESPONSE_FILE" \
  -G "$API_URL" \
  -H "Authorization: Bearer $CONTEXT7_API_KEY" \
  --data-urlencode "libraryId=$LIBRARY_ID" \
  --data-urlencode "query=$QUERY")

if [ "$HTTP_STATUS" -ne 200 ]; then
  echo "Error: API request failed with HTTP status $HTTP_STATUS" >&2
  echo "Response:" >&2
  cat "$RESPONSE_FILE" >&2
  rm -f "$RESPONSE_FILE"
  exit 1
fi

cat "$RESPONSE_FILE"
rm -f "$RESPONSE_FILE"
