#!/bin/bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$SKILL_DIR/scripts/_common.sh"

context7_load_api_key

if [ $# -lt 2 ]; then
  echo "Usage: $0 <libraryId> <query>" >&2
  echo "Example: $0 /vercel/next.js \"How do I configure Next.js middleware?\"" >&2
  exit 1
fi

LIBRARY_ID="$1"
shift
QUERY="$*"

API_URL="https://context7.com/api/v2/context"

context7_curl "$API_URL" \
  -G --data-urlencode "libraryId=$LIBRARY_ID" \
  --data-urlencode "query=$QUERY"
