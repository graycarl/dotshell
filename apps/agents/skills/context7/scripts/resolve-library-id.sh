#!/bin/bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$SKILL_DIR/scripts/_common.sh"

context7_load_api_key

# Usage: resolve-library-id.sh [--fast] <libraryName> <query>
FAST="${CONTEXT7_FAST:-0}"

if [ $# -ge 1 ] && [ "$1" == "--fast" ]; then
  FAST=1
  shift
fi

if [ $# -lt 2 ]; then
  echo "Usage: $0 [--fast] <libraryName> <query>" >&2
  echo "Example: $0 next.js \"How do I configure Next.js middleware?\"" >&2
  echo "Use --fast or set CONTEXT7_FAST=1 to skip LLM reranking and return faster vector-search results." >&2
  exit 1
fi

LIBRARY_NAME="$1"
shift
QUERY="$*"

API_URL="https://context7.com/api/v2/libs/search"

FAST_ARGS=()
if [ "$FAST" == "1" ]; then
  FAST_ARGS=(--data-urlencode "fast=true")
fi

context7_curl "$API_URL" \
  -G --data-urlencode "libraryName=$LIBRARY_NAME" \
  --data-urlencode "query=$QUERY" \
  ${FAST_ARGS[@]+"${FAST_ARGS[@]}"}
