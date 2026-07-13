#!/bin/bash
# Common helpers for Context7 skill scripts.
# This file is sourced by the other scripts; do not run it directly.

set -euo pipefail

# Load CONTEXT7_API_KEY from the environment variable or auth.json.
# Sets the global CONTEXT7_API_KEY variable and exports it.
context7_load_api_key() {
  if [ -n "${CONTEXT7_API_KEY:-}" ]; then
    export CONTEXT7_API_KEY
    return 0
  fi

  local skill_dir
  skill_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  local auth_file="$skill_dir/auth.json"

  if [ ! -f "$auth_file" ]; then
    echo "Error: No API key found. Set CONTEXT7_API_KEY env var, or copy auth.json.tpl to auth.json and fill in your key from https://context7.ai/dashboard" >&2
    return 1
  fi

  local key
  if command -v jq &>/dev/null; then
    key=$(jq -r '.api_key // empty' "$auth_file")
  else
    key=$(python3 -c "import json,sys; d=json.load(open('$auth_file')); print(d.get('api_key',''))" 2>/dev/null || true)
  fi

  if [ -z "${key:-}" ]; then
    echo "Error: api_key is missing or empty in $auth_file" >&2
    return 1
  fi

  export CONTEXT7_API_KEY="$key"
}

# Parse a JSON error response and extract a human-readable message.
# Falls back to the raw body if parsing fails.
context7_parse_error() {
  local body_file="$1"
  if [ ! -s "$body_file" ]; then
    return 0
  fi

  local msg
  if command -v jq &>/dev/null; then
    msg=$(jq -r '.message // .error // empty' "$body_file" 2>/dev/null || true)
  else
    msg=$(python3 -c "import json,sys; d=json.load(open('$body_file')); print(d.get('message') or d.get('error',''))" 2>/dev/null || true)
  fi

  if [ -n "${msg:-}" ]; then
    echo "$msg"
  else
    cat "$body_file"
  fi
}

# Perform an authenticated GET request to the Context7 API with retry logic.
# Usage: context7_curl <base-url> [extra curl args ...]
# Writes the response body to stdout and returns 0 on HTTP 200.
# Handles 429 (rate limit) and 503 (service unavailable) with exponential backoff.
# Other 4xx/5xx errors are reported immediately with a parsed message.
context7_curl() {
  local url="$1"
  shift

  local max_retries=3
  local attempt=1
  local delay=2

  local headers
  local body
  local status
  local err_msg
  local retry_after

  while true; do
    headers=$(mktemp)
    body=$(mktemp)

    status=$(curl -sS -w "%{http_code}" -D "$headers" -o "$body" \
      -H "Authorization: Bearer $CONTEXT7_API_KEY" \
      "$@" \
      "$url" || true)

    # If curl itself failed (e.g. network error), treat as 503 and retry.
    if [ -z "${status:-}" ] || ! [[ "$status" =~ ^[0-9]+$ ]]; then
      if [ "$attempt" -ge "$max_retries" ]; then
        echo "Error: Network request failed (curl error). Is the network reachable?" >&2
        rm -f "$headers" "$body"
        return 1
      fi
      echo "Warning: Network request failed. Retrying after ${delay}s... (attempt $attempt/$max_retries)" >&2
      sleep "$delay"
      attempt=$((attempt + 1))
      delay=$((delay * 2))
      rm -f "$headers" "$body"
      continue
    fi

    if [ "$status" -eq 200 ]; then
      cat "$body"
      rm -f "$headers" "$body"
      return 0
    fi

    err_msg=$(context7_parse_error "$body")

    case "$status" in
      429)
        retry_after=$(grep -i '^Retry-After:' "$headers" | awk '{print $2}' | tr -d '\r' || true)
        if [ -n "${retry_after:-}" ] && [[ "$retry_after" =~ ^[0-9]+$ ]]; then
          delay="$retry_after"
        fi
        if [ "$attempt" -ge "$max_retries" ]; then
          echo "Error: Rate limit exceeded (HTTP 429). $err_msg" >&2
          rm -f "$headers" "$body"
          return 1
        fi
        echo "Warning: Rate limited (HTTP 429). Retrying after ${delay}s... (attempt $attempt/$max_retries)" >&2
        sleep "$delay"
        attempt=$((attempt + 1))
        delay=$((delay * 2))
        rm -f "$headers" "$body"
        ;;
      503)
        if [ "$attempt" -ge "$max_retries" ]; then
          echo "Error: Service unavailable (HTTP 503). $err_msg" >&2
          rm -f "$headers" "$body"
          return 1
        fi
        echo "Warning: Service unavailable (HTTP 503). Retrying after ${delay}s... (attempt $attempt/$max_retries)" >&2
        sleep "$delay"
        attempt=$((attempt + 1))
        delay=$((delay * 2))
        rm -f "$headers" "$body"
        ;;
      400)
        echo "Error: Bad request (HTTP 400). $err_msg" >&2
        rm -f "$headers" "$body"
        return 1
        ;;
      401)
        echo "Error: Unauthorized (HTTP 401). $err_msg" >&2
        rm -f "$headers" "$body"
        return 1
        ;;
      402)
        echo "Error: Quota or spending limit reached (HTTP 402). $err_msg" >&2
        rm -f "$headers" "$body"
        return 1
        ;;
      404)
        echo "Error: Not found (HTTP 404). $err_msg" >&2
        rm -f "$headers" "$body"
        return 1
        ;;
      *)
        echo "Error: API request failed with HTTP status $status. $err_msg" >&2
        rm -f "$headers" "$body"
        return 1
        ;;
    esac
  done
}
