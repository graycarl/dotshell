---
name: exa-search
description: Use Exa's /search and /contents APIs to perform internet-scale retrieval, filter by domain/date, and fetch cached page text, highlights, or summaries.
---

# Exa Search Skill

Use this skill whenever you need live-ish web search results, filtered link discovery, or cached page contents via the Exa Search API.

## Setup

Provide an Exa API key one of two ways:

1. **Environment variable** (checked first):
   ```bash
   export EXA_API_KEY="sk-your-key"
   ```
2. **auth.json** (fallback, checked if the env var is unset):
   ```bash
   cp auth.json.tpl auth.json
   # then edit auth.json and fill in your key
   ```
   `auth.json` format: `{"api_key": "your_key_here"}`. It is not committed to version control (`**/auth.json` is gitignored at the repo root).

`(Optional)` override the base URL via `EXA_API_BASE` (defaults to `https://api.exa.ai`).

_No third-party dependencies are required; the helper script only uses Python's standard library._

## Usage

The helper supports `/search`, `/contents`, `/answer`, and `/findSimilar`:

```bash
# Search (default command)
./scripts/search.py --query "latest AI news" --type fast --num-results 5
./scripts/search.py search --query "vector database benchmark" --include-domain arxiv.org --text
./scripts/search.py search --query "China CRM market" --start-published-date 2024-01-01 --end-published-date 2024-12-31 --table-limit 3 --raw out.json
./scripts/search.py search --query "best langgraph tutorials" --highlights 2 "key steps" --text
./scripts/search.py search --query "latest AI news" --summary-query "Main takeaways" --num-results 5
./scripts/search.py search --query "top 5 AI startups founded in 2024" \
  --type deep-reasoning --output-schema examples/schema-startups.json
./scripts/search.py search --query "LLM benchmarks 2024" \
  --category "research paper" --subpages 2 --extras-links 3 --include-text "MMLU"

# Get contents for known URLs or IDs
echo 'https://docs.exa.ai/reference/search' | \
  xargs ./scripts/search.py contents --url --text --highlights 2
./scripts/search.py contents --url https://exa.ai/blog --text --text-max-chars 2000
./scripts/search.py contents --id https://docs.exa.ai/reference/search \
  --summary-query "Key takeaways" --table-limit 1
./scripts/search.py contents --url https://exa.ai \
  --summary-schema examples/schema-company.json --text

# Direct answer
./scripts/search.py answer --question "What is the latest valuation of SpaceX?" --text

# Find similar pages (deprecated; prefer search with a query)
./scripts/search.py similar --url https://exa.ai --num-results 5 --text
```

Key search flags:
- `--type`: `instant`, `fast`, `auto` (default), `deep-lite`, `deep`, `deep-reasoning`.
- `--num-results`: up to 100 (subject to plan/type limits).
- `--include-domain` / `--exclude-domain`: repeatable filters.
- Date filters: `--start-published-date`, `--end-published-date`, `--start-crawl-date`, `--end-crawl-date`.
- `--category`: focus on `company`, `research paper`, `news`, `pdf`, `personal site`, `financial report`, `people`.
- Content extraction: `--text` for cached body, `--highlights [numSentences query]` for snippets.
- `--summary-query` or `--summary-schema <file>` for free-form or structured summaries per result.
- `--output-schema <file>`: structured output schema (best with `deep` / `deep-reasoning`).
- `--system-prompt`: instructions for the search model (best with `deep` / `deep-reasoning`).
- Content enrichment: `--subpages N`, `--subpage-target`, and `--extras-*` flags (links, image-links, rich-image-links, rich-links, code-blocks).
- Text filters: `--include-text` / `--exclude-text` (repeatable); `--moderation` enables content moderation.
- Freshness: `--max-age-hours` (preferred) controls cached-content age; `-1`=cache only, `0`=always livecrawl, positive=max cache age. `--livecrawl` is deprecated.
- `--livecrawl-timeout`: livecrawl timeout in milliseconds (default 10000).
- Output: `--table-limit N` controls stdout preview, `--raw file.json` saves full API response. `--markdown` prints Markdown with inline hyperlinks and ends with `sources_reviewed: N`.

Key contents flags:
- Targets: provide one or more `--url` or `--id` (IDs come from previous search results).
- `--text`, `--text-max-chars`, `--text-include-html` for body retrieval.
- `--highlights [numSentences query]`, `--highlights-per-url` for excerpt control.
- `--summary-query` or `--summary-schema <file>` for free-form or structured summaries.
- `--subpages N`, `--subpage-target`, `--images`, and `--extras-*` flags for richer content.
- Freshness: `--max-age-hours` (preferred) controls cached-content age; `--livecrawl` is deprecated.
- `--livecrawl-timeout`: livecrawl timeout in milliseconds (default 10000).
- Output: `--table-limit N` controls stdout preview, `--raw file.json` saves full API response, `--markdown` prints Markdown with inline hyperlinks and ends with `sources_reviewed: N`.

## Workflow

1. **Search**: craft the query, tune filters, choose search type.
2. **Inspect**: review terminal output or saved JSON; note interesting result IDs/URLs.
3. **Contents**: pass those IDs/URLs to the `contents` subcommand to retrieve full text, highlights, or summaries.
4. **Iterate**: adjust highlights, max-age-hours, or summary schema depending on downstream consumption (RAG, dashboards, etc.).

## Research Orchestration

For anything beyond a simple fact lookup, treat Exa as a research assistant rather than a single search call. The goal is to keep raw search output out of the main context window while producing a well-sourced, deduplicated answer.

### Query Complexity

Assess the query before acting:

- **Extremely Simple** (fact lookup, 1-2 pages): Run the search directly with this skill.
- **Moderate** (a fast, low-effort search): Use 1 subagent to keep the main context clean.
- **Advanced** (clear topic, a few parallel searches): Launch 2-4 parallel subagents, then compile.
- **Complex** (cross-referencing, exhaustive coverage, multi-hop chains): Full multi-pass with parallel subagents.

If the query could be either Moderate or Complex, ask the user which depth they prefer before proceeding.

### Subagent Dispatch Template

When delegating, point the subagent to this skill and tell it exactly what to return:

```markdown
Read this skill's references/searching.md for query-writing guidance.

Run the following searches using ./scripts/search.py:
- [query 1]
- [query 2]

Validation criteria: [what makes a result qualify]

Return: [compact format, e.g. markdown table with columns X, Y, Z].

End with EXACTLY: `sources_reviewed: N` where N is the sum of `numResults` across every search call.
```

Aim for 3-5 searches per subagent. Launch independent workstreams in parallel.

### Compile Results

1. **Deduplicate**: drop exact URL duplicates; merge same-entity rows from different sources.
2. **Validate coverage**: check for missing time periods, geographies, or entity types.
3. **Fill gaps**: run targeted follow-up searches for anything missing.
4. **Format**: prefer tables, inline hyperlinks, and a short answer that fits one screen. Open with: "I used Exa to review {X} sources across {Y} subagents. Here's what was found:"

### Multi-Pass Queries

Some questions need sequential passes:

- **Entity chaining**: find companies → find people at those companies → enrich people.
- **Exploratory → targeted**: scout broadly, then search deeply in the most promising directions.
- **Criteria discovery**: first find what practitioners actually value, then find candidates matching those criteria.

Between passes, deduplicate and assess coverage before the next round.

### Date Calculation

If the query involves time ("last week", "recent", "past 6 months"), calculate exact dates from today's date first. Encode them in the query or use the date filters. Never reuse dates from examples.

### Reference files

For detailed guidance, see the files in `references/`:

- `references/searching.md` — writing effective semantic queries
- `references/extraction.md` — pulling structured data from results
- `references/filtering.md` — hard and soft filters
- `references/synthesis.md` — writing a narrative answer with citations
- `references/source-quality.md` — judging source credibility

## Reference

- Search reference: <https://docs.exa.ai/reference/search>
- Contents reference: <https://docs.exa.ai/reference/get-contents>
- Quickstart / SDK examples: <https://docs.exa.ai/reference/quickstart>

## Troubleshooting

- `401 Unauthorized`: ensure `EXA_API_KEY` is set and valid.
- Empty results: broaden query, remove restrictive filters, or try `--type deep` / `--deep-reasoning`.
- Slow responses: prefer cached content (`--text`), use `--max-age-hours` to avoid unnecessary livecrawls.
- Contents call errors: confirm each URL/ID exists and is crawlable; try `--max-age-hours 24` or `--livecrawl fallback` for stale links.
