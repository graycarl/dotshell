---
name: exa-search
description: Use Exa's /search and /contents APIs to perform internet-scale retrieval, filter by domain/date, and fetch cached page text, highlights, or summaries.
---

# Exa Search Skill

Use this skill whenever you need live-ish web search results, filtered link discovery, or cached page contents via the Exa Search API.

## Setup

1. Export your Exa API key.
   ```bash
   export EXA_API_KEY="sk-your-key"
   ```
2. (Optional) override the base URL via `EXA_API_BASE` (defaults to `https://api.exa.ai`).

_No third-party dependencies are required; the helper script only uses Python's standard library._

## Usage

The helper supports both `/search` and `/contents`:

```bash
# Search (default command)
./scripts/search.py --query "latest AI news" --type fast --num-results 5
./scripts/search.py search --query "vector database benchmark" --include-domain arxiv.org --text
./scripts/search.py search --query "China CRM market" --start-published-date 2024-01-01 --end-published-date 2024-12-31 --table-limit 3 --raw out.json
./scripts/search.py search --query "best langgraph tutorials" --highlights 2 "key steps" --text

# Get contents for known URLs or IDs
echo 'https://docs.exa.ai/reference/search' | \
  xargs ./scripts/search.py contents --url --text --highlights 2
./scripts/search.py contents --url https://exa.ai/blog --text --text-max-chars 2000
./scripts/search.py contents --id https://docs.exa.ai/reference/search \
  --summary-query "Key takeaways" --table-limit 1
./scripts/search.py contents --url https://exa.ai \
  --summary-schema examples/schema-company.json --text
```

Key search flags:
- `--type`: `auto` (default), `fast`, `neural`, `deep`.
- `--num-results`: up to 100 (subject to plan/type limits).
- `--include-domain` / `--exclude-domain`: repeatable filters.
- Date filters: `--start-published-date`, `--end-published-date`, `--start-crawl-date`, `--end-crawl-date`.
- `--category`: focus on `news`, `research paper`, `github`, `people`, etc.
- Content extraction: `--text` for cached body, `--highlights [numSentences query]` for snippets.
- Output: `--table-limit N` controls stdout preview, `--raw file.json` saves full API response.

Key contents flags:
- Targets: provide one or more `--url` or `--id` (IDs come from previous search results).
- `--text`, `--text-max-chars`, `--text-include-html` for body retrieval.
- `--highlights [numSentences query]`, `--highlights-per-url` for excerpt control.
- `--summary-query` or `--summary-schema <file>` for free-form or structured summaries.
- `--livecrawl` controls freshness (`never`, `fallback`, `preferred`, `always`).

## Workflow

1. **Search**: craft the query, tune filters, choose search type.
2. **Inspect**: review terminal output or saved JSON; note interesting result IDs/URLs.
3. **Contents**: pass those IDs/URLs to the `contents` subcommand to retrieve full text, highlights, or summaries.
4. **Iterate**: adjust highlights, livecrawl, or summary schema depending on downstream consumption (RAG, dashboards, etc.).

## Reference

- Search reference: <https://docs.exa.ai/reference/search>
- Contents reference: <https://docs.exa.ai/reference/get-contents>
- Quickstart / SDK examples: <https://docs.exa.ai/reference/quickstart>

## Troubleshooting

- `401 Unauthorized`: ensure `EXA_API_KEY` is set and valid.
- Empty results: broaden query, remove restrictive filters, or try `--type neural`/`deep`.
- Slow responses: prefer cached content (`--text`), avoid live crawl when possible.
- Contents call errors: confirm each URL/ID exists and is crawlable; try `--livecrawl fallback` for stale links.
