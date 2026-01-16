#!/bin/bash
set -euo pipefail

if [ -z "${CONTEXT7_API_KEY:-}" ]; then
  echo "Error: CONTEXT7_API_KEY environment variable is not set." >&2
  echo "Get an API key from https://context7.ai/dashboard and export it before running this script." >&2
  exit 1
fi

if [ $# -lt 2 ]; then
  echo "Usage: $0 <libraryName> <query>" >&2
  echo "Example: $0 next.js \"How do I configure Next.js middleware?\"" >&2
  exit 1
fi

LIBRARY_NAME="$1"
shift
QUERY="$*"

API_URL="https://context7.com/api/v2/libs/search"
RESPONSE_FILE=$(mktemp)

HTTP_STATUS=$(curl -sS -w "%{http_code}" -o "$RESPONSE_FILE" \
  -G "$API_URL" \
  -H "Authorization: Bearer $CONTEXT7_API_KEY" \
  --data-urlencode "libraryName=$LIBRARY_NAME" \
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
