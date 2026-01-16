#!/usr/bin/env python3
"""Exa Search & Contents helper (standard library only)."""

import argparse
import json
import os
import sys
from typing import Any, Dict, Optional, Sequence, Tuple
import urllib.error
import urllib.request

API_BASE = os.environ.get("EXA_API_BASE", "https://api.exa.ai").rstrip("/")
API_KEY_ENV = "EXA_API_KEY"
HighlightArg = Optional[Tuple[int, Optional[str]]]
GENERAL_HELP = """Exa Search Skill Helper\n\nUsage:\n  search.py [search options...]        # default search mode\n  search.py search [search options...]\n  search.py contents [contents options...]\n\nRun `search.py search --help` or `search.py contents --help` for detailed flags."""


def ensure_api_key() -> str:
    api_key = os.environ.get(API_KEY_ENV)
    if not api_key:
        raise RuntimeError(
            f"Missing {API_KEY_ENV}. Please export your Exa API key before running."
        )
    return api_key


def normalize_highlights(raw: Optional[Sequence[str]]) -> HighlightArg:
    if not raw:
        return None
    if len(raw) == 1:
        return (3, raw[0])
    try:
        num_sentences = int(raw[0])
        query = " ".join(raw[1:]) or None
        return (num_sentences, query)
    except ValueError:
        return (3, " ".join(raw))


def build_search_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Call Exa /search")
    parser.add_argument("--query", required=True, help="Natural-language query")
    parser.add_argument(
        "--type",
        choices=["auto", "fast", "neural", "deep"],
        default="auto",
    )
    parser.add_argument("--num-results", type=int, default=10)
    parser.add_argument(
        "--include-domain",
        dest="include_domains",
        action="append",
        help="Restrict to specific domain (repeatable)",
    )
    parser.add_argument(
        "--exclude-domain",
        dest="exclude_domains",
        action="append",
        help="Exclude domain (repeatable)",
    )
    parser.add_argument(
        "--category",
        choices=[
            "company",
            "research paper",
            "news",
            "pdf",
            "github",
            "tweet",
            "personal site",
            "financial report",
            "people",
        ],
    )
    parser.add_argument("--user-location", help="ISO country code, e.g. US")
    parser.add_argument("--start-published-date", help="YYYY-MM-DD or ISO 8601")
    parser.add_argument("--end-published-date", help="YYYY-MM-DD or ISO 8601")
    parser.add_argument("--start-crawl-date", help="ISO 8601 crawl timestamp")
    parser.add_argument("--end-crawl-date", help="ISO 8601 crawl timestamp")
    parser.add_argument("--text", action="store_true", help="Return cached page text")
    parser.add_argument(
        "--highlights",
        nargs="*",
        help="Include highlighted snippets. Optionally pass numSentences and query",
    )
    parser.add_argument(
        "--livecrawl",
        choices=["never", "always", "fallback"],
        help="Control live crawling behavior",
    )
    parser.add_argument("--summary-model", help="Request Exa server-side summary via model")
    parser.add_argument(
        "--summary-prompt",
        default="Summarize this page",
        help="Prompt for server-side summary (if model provided)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=30,
        help="HTTP timeout in seconds",
    )
    parser.add_argument("--raw", help="Write raw JSON response to file")
    parser.add_argument(
        "--table-limit",
        type=int,
        help="Limit number of rows printed to stdout",
    )
    return parser


def build_contents_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Call Exa /contents")
    parser.add_argument(
        "--url",
        dest="urls",
        action="append",
        help="URL to fetch (repeatable)",
    )
    parser.add_argument(
        "--id",
        dest="ids",
        action="append",
        help="Document ID obtained from a previous search",
    )
    parser.add_argument("--text", action="store_true", help="Return page text")
    parser.add_argument(
        "--text-max-chars",
        type=int,
        help="Limit number of characters when returning text",
    )
    parser.add_argument(
        "--text-include-html",
        action="store_true",
        help="Include HTML tags when returning text",
    )
    parser.add_argument(
        "--highlights",
        nargs="*",
        help="Include highlighted snippets. Optionally pass numSentences and query",
    )
    parser.add_argument(
        "--highlights-per-url",
        type=int,
        help="Number of highlight snippets per URL",
    )
    parser.add_argument(
        "--summary-query",
        help="Ask Exa to summarize each document with this query",
    )
    parser.add_argument(
        "--summary-schema",
        help="Path to JSON schema file for structured summaries",
    )
    parser.add_argument(
        "--livecrawl",
        choices=["never", "fallback", "preferred", "always"],
        help="Control live crawling behavior",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=30,
        help="HTTP timeout in seconds",
    )
    parser.add_argument("--raw", help="Write raw JSON response to file")
    parser.add_argument(
        "--table-limit",
        type=int,
        help="Limit number of rows printed to stdout",
    )
    return parser


def build_search_payload(args: argparse.Namespace) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "query": args.query,
        "type": args.type,
        "numResults": args.num_results,
    }
    if args.category:
        payload["category"] = args.category
    if args.user_location:
        payload["userLocation"] = args.user_location
    if args.start_published_date:
        payload["startPublishedDate"] = args.start_published_date
    if args.end_published_date:
        payload["endPublishedDate"] = args.end_published_date
    if args.start_crawl_date:
        payload["startCrawlDate"] = args.start_crawl_date
    if args.end_crawl_date:
        payload["endCrawlDate"] = args.end_crawl_date
    if args.include_domains:
        payload["includeDomains"] = args.include_domains
    if args.exclude_domains:
        payload["excludeDomains"] = args.exclude_domains

    contents: Dict[str, Any] = {}
    if args.text:
        contents["text"] = True
    if args.highlights is not None:
        num_sentences, query = args.highlights
        contents["highlights"] = {
            "numSentences": num_sentences,
            **({"query": query} if query else {}),
        }
    if contents:
        payload["contents"] = contents
    if args.livecrawl:
        payload["livecrawl"] = args.livecrawl
    if args.summary_model:
        payload["summary"] = {
            "prompt": args.summary_prompt,
            "model": args.summary_model,
        }
    return payload


def build_contents_payload(args: argparse.Namespace) -> Dict[str, Any]:
    payload: Dict[str, Any] = {}
    if args.urls:
        payload["urls"] = args.urls
    if args.ids:
        payload["ids"] = args.ids
    if not payload:
        raise RuntimeError("At least one --url or --id must be provided.")

    text_requested = (
        args.text or args.text_max_chars is not None or args.text_include_html
    )
    if text_requested:
        text_opts: Dict[str, Any] = {}
        if args.text_max_chars is not None:
            text_opts["maxCharacters"] = args.text_max_chars
        if args.text_include_html:
            text_opts["includeHtmlTags"] = True
        payload["text"] = text_opts or True

    highlight_opts: Dict[str, Any] = {}
    if args.highlights is not None:
        num_sentences, query = args.highlights
        highlight_opts["numSentences"] = num_sentences
        if query:
            highlight_opts["query"] = query
    if args.highlights_per_url is not None:
        highlight_opts["highlightsPerUrl"] = args.highlights_per_url
    if highlight_opts:
        payload["highlights"] = highlight_opts

    summary_opts: Dict[str, Any] = {}
    if args.summary_query:
        summary_opts["query"] = args.summary_query
    if args.summary_schema:
        with open(args.summary_schema, "r", encoding="utf-8") as fp:
            summary_opts["schema"] = json.load(fp)
    if summary_opts:
        payload["summary"] = summary_opts

    if args.livecrawl:
        payload["livecrawl"] = args.livecrawl

    return payload


def call_exa(path: str, payload: Dict[str, Any], api_key: str, timeout: int) -> Dict[str, Any]:
    url = path if path.startswith("http") else f"{API_BASE}{path if path.startswith('/') else '/' + path}"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
    except urllib.error.HTTPError as err:  # type: ignore[no-redef]
        error_body = err.read().decode("utf-8", errors="ignore") if err.fp else ""
        raise RuntimeError(
            f"Exa API error {err.code}: {error_body.strip() or err.reason}"
        ) from err
    except urllib.error.URLError as err:
        raise RuntimeError(f"Failed to reach Exa API: {err.reason}") from err

    try:
        return json.loads(body)
    except json.JSONDecodeError as err:
        raise RuntimeError("Received invalid JSON from Exa API") from err


def execute_search(args: argparse.Namespace) -> Dict[str, Any]:
    api_key = ensure_api_key()
    payload = build_search_payload(args)
    return call_exa("/search", payload, api_key, args.timeout)


def execute_contents(args: argparse.Namespace) -> Dict[str, Any]:
    api_key = ensure_api_key()
    payload = build_contents_payload(args)
    return call_exa("/contents", payload, api_key, args.timeout)


def print_search_results(results: Dict[str, Any], limit: Optional[int]) -> None:
    rows = results.get("results", [])
    if limit is not None:
        rows = rows[:limit]
    if not rows:
        print("No results")
        return
    for idx, row in enumerate(rows, start=1):
        title = row.get("title") or "(untitled)"
        url = row.get("url") or row.get("id") or "(no url)"
        score = row.get("score")
        published = row.get("publishedDate") or row.get("published")
        print(f"[{idx}] {title}")
        if score is not None:
            print(f"    score: {score}")
        if published:
            print(f"    published: {published}")
        print(f"    url: {url}")
        if row.get("text"):
            snippet = row["text"].strip()
            preview = snippet[:280]
            print(f"    text: {preview}{'...' if len(snippet) > 280 else ''}")
        if row.get("highlights"):
            highlights = row["highlights"]
            if isinstance(highlights, list):
                preview = " \n".join(
                    h.get("snippet", "").strip() for h in highlights[:2]
                )
            else:
                preview = str(highlights)[:280]
            if preview:
                print(f"    highlights: {preview}")
        print()


def print_contents_results(results: Dict[str, Any], limit: Optional[int]) -> None:
    rows = results.get("results") or results.get("content") or []
    if limit is not None:
        rows = rows[:limit]
    if not rows:
        print("No contents returned")
        return
    for idx, row in enumerate(rows, start=1):
        url = row.get("url") or row.get("id") or "(no url)"
        title = row.get("title")
        print(f"[{idx}] {title or url}")
        print(f"    url: {url}")
        if row.get("text"):
            snippet = row["text"].strip()
            preview = snippet[:400]
            print(f"    text: {preview}{'...' if len(snippet) > 400 else ''}")
        if row.get("highlights"):
            highlights = row["highlights"]
            if isinstance(highlights, list):
                preview = " \n".join(h.strip() if isinstance(h, str) else str(h) for h in highlights[:2])
            else:
                preview = str(highlights)
            if preview:
                print(f"    highlights: {preview}")
        if row.get("summary"):
            summary = row["summary"]
            if isinstance(summary, str):
                text = summary.strip()
            else:
                text = json.dumps(summary)
            print(f"    summary: {text[:400]}{'...' if len(text) > 400 else ''}")
        print()


def save_raw_if_requested(data: Dict[str, Any], path: Optional[str]) -> None:
    if not path:
        return
    with open(path, "w", encoding="utf-8") as fp:
        json.dump(data, fp, ensure_ascii=False, indent=2)
    print(f"Saved raw response to {path}")


def main(argv: Optional[Sequence[str]] = None) -> int:
    args_list = list(argv) if argv is not None else sys.argv[1:]
    if not args_list or args_list[0] in ("-h", "--help"):
        print(GENERAL_HELP)
        return 0

    if args_list[0] in {"search", "contents"}:
        command = args_list[0]
        args_list = args_list[1:]
    else:
        command = "search"

    parser = build_search_parser() if command == "search" else build_contents_parser()
    args = parser.parse_args(args_list)
    args.command = command
    args.highlights = normalize_highlights(args.highlights)

    try:
        if command == "search":
            results = execute_search(args)
            save_raw_if_requested(results, args.raw)
            print_search_results(results, args.table_limit)
        else:
            results = execute_contents(args)
            save_raw_if_requested(results, args.raw)
            print_contents_results(results, args.table_limit)
    except Exception as exc:  # noqa: BLE001
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
