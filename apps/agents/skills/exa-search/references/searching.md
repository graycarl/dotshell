# Searching with Exa

The local helper is `./scripts/search.py` in this skill directory. Use it to run semantic web searches and fetch full page contents.

## Tools

- `search` subcommand — run a semantic query.
- `contents` subcommand — read full content from known URLs.

## How Exa Search Works

Exa uses vector embeddings, not keywords. It finds pages semantically similar to your query. It does not match keywords exactly, directly understand boolean logic (AND/OR/NOT), or validate that results meet your criteria. You are describing a target page, and Exa returns the nearest neighbors in embedding space.

## Writing Good Queries

**Describe the page you want to find**, not the fact you want to know.

| Looking for | Bad query | Good query |
|---|---|---|
| Blog posts about X | "X" | "detailed blog post about X written by a practitioner" |
| Company doing Y | "Y company" | "category:company startup building Y for enterprise" |
| Person at company | "person at company" | "category:people senior engineer at Acme" |

Write queries as natural grammatical phrases.

### Category filters

Use categories to focus the index. Pass with `--category` or write `category:<type>` inline in the query:

```bash
./scripts/search.py search --query "category:research paper sparse attention mechanisms for long context" --num-results 10
./scripts/search.py search --query "category:people VP Engineering AI infrastructure San Francisco" --num-results 10
./scripts/search.py search --query "category:company developer tools for API testing" --num-results 10
```

Available categories: `company`, `research paper`, `news`, `pdf`, `personal site`, `financial report`, `people`.

### `numResults` sizing

Match `numResults` to query precision. Never use a value above 25 — if you need more coverage, run more queries with different angles at n=10-15 rather than one huge query.

| Query precision | numResults | Example |
|---|---|---|
| Named entity (specific person/company) | 5 | `"WaveForms AI founding story funding details"` |
| Precise filter (narrow category + constraints) | 10 | `"category:company developer tools API testing Series A"` |
| Broad discovery (wide category, few constraints) | 15 | `"category:news engineer launches startup 2025 2026"` |

### Query Diversity

When you need to run multiple queries on the same topic, make sure they target genuinely different angles, not just synonym swaps. "overhyped" vs "overrated" vs "disappointment" are the same angle. A skeptic angle vs a builder angle vs a practitioner angle are genuinely different.

**Word order affects embeddings.** "Python async patterns for web scraping" and "web scraping async patterns in Python" can sometimes return different results. Use this to your advantage when you need coverage — run 2-3 phrasings in parallel.

### Encoding Time

If your task involves time ("last week", "recent", "this month"), calculate exact dates from today's date in your environment context first. Then encode dates semantically in the query ("published in March 2026") or use the date filters (`--start-published-date`, `--end-published-date`). Never eyeball dates or reuse dates from examples.

## Anti-Patterns

- Boolean operators ("AND", "NOT") are just words to Exa, not operators.
- Quotes don't force exact phrase matching.
- Very short queries (1-2 words) produce scattered, low-quality results.
- Don't use dates from examples — always calculate from the current date.

## When Searches Return Nothing

If a query returns 0 or only irrelevant results:

1. Make the query longer and more specific.
2. Try a different angle, not a synonym swap.
3. If multiple angles return nothing, the topic likely has limited web coverage — report that rather than fabricating results.

## Fetching Full Content

When snippets are not enough, use the `contents` subcommand:

```bash
./scripts/search.py contents --url https://promising-url-1.com --url https://promising-url-2.com --text
```

If the local fetch fails and you have another fetch tool available, fall back to that. Otherwise, skip the source and work with the remaining results.

## After Getting Results

Exa returns similarity, not validation. You must review titles and snippets and discard irrelevant results using your judgment. Don't assume all results match your criteria.

## Useful Script Flags

- `--text` / `--text-max-chars` — pull page text.
- `--highlights` — pull highlighted snippets.
- `--summary-query` / `--summary-schema` — request a per-result summary.
- `--max-age-hours` — control freshness; prefer this over `--livecrawl`.
- `--type deep` / `--type deep-reasoning` — for hard, multi-hop research questions.
- `--output-schema` / `--system-prompt` — for structured output from deep searches.
