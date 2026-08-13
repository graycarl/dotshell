#!/usr/bin/env python3
"""Exa Search & Contents helper (standard library only)."""

import argparse
import json
import os
from pathlib import Path
import sys
from typing import Any, Dict, Optional, Sequence, Union
import urllib.error
import urllib.request

API_BASE = os.environ.get("EXA_API_BASE", "https://api.exa.ai").rstrip("/")
API_KEY_ENV = "EXA_API_KEY"
HighlightOpts = Union[bool, Dict[str, Any]]
GENERAL_HELP = """Exa Search Skill Helper\n\nUsage:\n  search.py [search options...]        # default search mode\n  search.py search [search options...]\n  search.py contents [contents options...]\n  search.py answer [answer options...]\n  search.py similar [similar options...]\n\nRun `search.py <command> --help` for detailed flags."""


def ensure_api_key() -> str:
    api_key = os.environ.get(API_KEY_ENV)
    if api_key:
        return api_key
    auth_file = Path(__file__).resolve().parent.parent / "auth.json"
    if auth_file.exists():
        try:
            api_key = json.loads(auth_file.read_text()).get("api_key")
        except (json.JSONDecodeError, OSError):
            api_key = None
        if api_key:
            return api_key
    raise RuntimeError(
        f"Missing {API_KEY_ENV}. Set the environment variable, "
        "or copy auth.json.tpl to auth.json in this skill directory and fill in your key."
    )


def normalize_highlights(raw: Optional[Sequence[str]], max_chars: Optional[int] = None) -> HighlightOpts:
    """Convert --highlights [query] into the current API shape.

    Bare flag -> True (highest-quality default). With a query ->
    {"query": ...} plus optional {"maxCharacters": ...}. A leading numeric
    token is legacy numSentences (deprecated) and is dropped.
    """
    opts: Dict[str, Any] = {}
    if max_chars is not None:
        opts["maxCharacters"] = max_chars
    if raw:
        tokens = list(raw)
        if tokens and tokens[0].isdigit():
            tokens = tokens[1:]
        query = " ".join(tokens).strip() or None
        if query:
            opts["query"] = query
    return opts if opts else True


# category "research paper" was renamed to "publication" upstream; keep the old name working.
CATEGORY_ALIASES = {"research paper": "publication"}


def _normalize_category(cat: Optional[str]) -> Optional[str]:
    if not cat:
        return None
    return CATEGORY_ALIASES.get(cat, cat)


def _build_text_opts(args: argparse.Namespace) -> Optional[Dict[str, Any]]:
    """Build a contents.text object (or True) from the text-related flags."""
    opts: Dict[str, Any] = {}
    if getattr(args, "text_max_chars", None) is not None:
        opts["maxCharacters"] = args.text_max_chars
    if getattr(args, "text_include_html", False):
        opts["includeHtmlTags"] = True
    if getattr(args, "verbosity", None):
        opts["verbosity"] = args.verbosity
    include_sections = getattr(args, "include_sections", None)
    if include_sections:
        opts["includeSections"] = include_sections
    exclude_sections = getattr(args, "exclude_sections", None)
    if exclude_sections:
        opts["excludeSections"] = exclude_sections
    return opts if opts else None


def build_search_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Call Exa /search")
    parser.add_argument("--query", required=True, help="Natural-language query")
    parser.add_argument(
        "--type",
        choices=["instant", "fast", "auto", "deep-lite", "deep", "deep-reasoning"],
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
            "publication",
            "news",
            "personal site",
            "financial report",
            "people",
            "research paper",  # legacy alias -> publication
        ],
    )
    parser.add_argument("--user-location", help="ISO country code, e.g. US")
    parser.add_argument("--start-published-date", help="YYYY-MM-DD or ISO 8601")
    parser.add_argument("--end-published-date", help="YYYY-MM-DD or ISO 8601")
    parser.add_argument("--start-crawl-date", help="ISO 8601 crawl timestamp")
    parser.add_argument("--end-crawl-date", help="ISO 8601 crawl timestamp")
    parser.add_argument("--text", action="store_true", help="Return cached page text")
    parser.add_argument(
        "--text-max-chars",
        type=int,
        dest="text_max_chars",
        help="Limit number of characters when returning text",
    )
    parser.add_argument(
        "--text-include-html",
        action="store_true",
        dest="text_include_html",
        help="Include HTML tags when returning text",
    )
    parser.add_argument(
        "--verbosity",
        choices=["compact", "standard", "full"],
        help="Text verbosity (default compact). Use with --max-age-hours 0 for fresh content",
    )
    parser.add_argument(
        "--include-section",
        dest="include_sections",
        action="append",
        choices=["header", "navigation", "banner", "body", "sidebar", "footer", "metadata"],
        help="Only include these page sections (repeatable)",
    )
    parser.add_argument(
        "--exclude-section",
        dest="exclude_sections",
        action="append",
        choices=["header", "navigation", "banner", "body", "sidebar", "footer", "metadata"],
        help="Exclude these page sections (repeatable)",
    )
    parser.add_argument(
        "--highlights",
        nargs="*",
        help="Return highlights. Bare flag = highest-quality default; pass a query to guide selection",
    )
    parser.add_argument(
        "--highlights-max-chars",
        type=int,
        dest="highlights_max_chars",
        help="Cap total highlight characters per result",
    )
    parser.add_argument(
        "--max-age-hours",
        type=int,
        dest="max_age_hours",
        help="Maximum cached-content age in hours (-1=cache only, 0=always livecrawl, 1-720)",
    )
    parser.add_argument(
        "--livecrawl-timeout",
        type=int,
        dest="livecrawl_timeout",
        help="Livecrawl timeout in milliseconds (10000-90000, API default 10000)",
    )
    parser.add_argument(
        "--summary-query",
        help="Ask Exa to summarize each result with this query",
    )
    parser.add_argument(
        "--summary-schema",
        help="Path to JSON schema file for structured summaries",
    )
    parser.add_argument(
        "--subpages",
        type=int,
        help="Number of subpages to retrieve per result",
    )
    parser.add_argument(
        "--subpage-target",
        dest="subpage_target",
        help="Target for subpage retrieval (e.g. sources, references)",
    )
    parser.add_argument(
        "--extras-links",
        dest="extras_links",
        type=int,
        help="Number of links to return per result",
    )
    parser.add_argument(
        "--extras-image-links",
        dest="extras_image_links",
        type=int,
        help="Number of image links to return per result",
    )
    parser.add_argument(
        "--extras-rich-image-links",
        dest="extras_rich_image_links",
        type=int,
        help="Number of rich image links to return per result",
    )
    parser.add_argument(
        "--extras-rich-links",
        dest="extras_rich_links",
        type=int,
        help="Number of rich links to return per result",
    )
    parser.add_argument(
        "--extras-code-blocks",
        dest="extras_code_blocks",
        type=int,
        help="Number of code blocks to return per result",
    )
    parser.add_argument(
        "--include-text",
        dest="include_texts",
        action="append",
        help="Text phrases results must contain (repeatable)",
    )
    parser.add_argument(
        "--exclude-text",
        dest="exclude_texts",
        action="append",
        help="Text phrases results must not contain (repeatable)",
    )
    parser.add_argument(
        "--moderation",
        action="store_true",
        help="Enable content moderation",
    )
    parser.add_argument(
        "--output-schema",
        dest="output_schema",
        help="Path to JSON schema file for structured search output (works with any search type)",
    )
    parser.add_argument(
        "--system-prompt",
        dest="system_prompt",
        help="Instructions for the search model (use with deep/deep-reasoning)",
    )
    parser.add_argument(
        "--additional-query",
        dest="additional_queries",
        action="append",
        help="Extra query variations for deep-search variants (repeatable, max 10)",
    )
    parser.add_argument(
        "--compliance",
        choices=["hipaa"],
        help="Enterprise compliance mode (requires type instant/fast, cache-only)",
    )
    parser.add_argument(
        "--stream",
        action="store_true",
        help="Stream results as SSE (OpenAI-compatible chunks) instead of a JSON body",
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
    parser.add_argument(
        "--markdown",
        action="store_true",
        help="Print results in Markdown format with inline hyperlinks",
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
        "--verbosity",
        choices=["compact", "standard", "full"],
        help="Text verbosity (default compact). Use with --max-age-hours 0 for fresh content",
    )
    parser.add_argument(
        "--include-section",
        dest="include_sections",
        action="append",
        choices=["header", "navigation", "banner", "body", "sidebar", "footer", "metadata"],
        help="Only include these page sections (repeatable)",
    )
    parser.add_argument(
        "--exclude-section",
        dest="exclude_sections",
        action="append",
        choices=["header", "navigation", "banner", "body", "sidebar", "footer", "metadata"],
        help="Exclude these page sections (repeatable)",
    )
    parser.add_argument(
        "--highlights",
        nargs="*",
        help="Return highlights. Bare flag = highest-quality default; pass a query to guide selection",
    )
    parser.add_argument(
        "--highlights-max-chars",
        type=int,
        dest="highlights_max_chars",
        help="Cap total highlight characters per URL",
    )
    parser.add_argument(
        "--subpages",
        type=int,
        help="Number of subpages to crawl",
    )
    parser.add_argument(
        "--subpage-target",
        dest="subpage_target",
        help="Target for subpage crawling (e.g. references)",
    )
    parser.add_argument(
        "--extras-links",
        dest="extras_links",
        type=int,
        help="Number of links to return per URL",
    )
    parser.add_argument(
        "--extras-image-links",
        dest="extras_image_links",
        type=int,
        help="Number of image links to return per URL",
    )
    parser.add_argument(
        "--extras-rich-image-links",
        dest="extras_rich_image_links",
        type=int,
        help="Number of rich image links to return per URL",
    )
    parser.add_argument(
        "--extras-rich-links",
        dest="extras_rich_links",
        type=int,
        help="Number of rich links to return per URL",
    )
    parser.add_argument(
        "--extras-code-blocks",
        dest="extras_code_blocks",
        type=int,
        help="Number of code blocks to return per URL",
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
        "--max-age-hours",
        type=int,
        dest="max_age_hours",
        help="Maximum cached-content age in hours (-1=cache only, 0=always livecrawl, 1-720)",
    )
    parser.add_argument(
        "--livecrawl-timeout",
        type=int,
        dest="livecrawl_timeout",
        help="Livecrawl timeout in milliseconds (10000-90000, API default 10000)",
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
    parser.add_argument(
        "--markdown",
        action="store_true",
        help="Print results in Markdown format with inline hyperlinks",
    )
    return parser




def build_answer_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Call Exa /answer")
    parser.add_argument("--question", required=True, help="Question to answer")
    parser.add_argument("--text", action="store_true", help="Return the answer as plain text")
    parser.add_argument(
        "--timeout",
        type=int,
        default=30,
        help="HTTP timeout in seconds",
    )
    parser.add_argument("--raw", help="Write raw JSON response to file")
    return parser


def build_similar_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Call Exa /findSimilar (deprecated; prefer search)")
    parser.add_argument("--url", required=True, help="URL to find similar pages for")
    parser.add_argument("--num-results", type=int, default=10, help="Number of similar results")
    parser.add_argument("--text", action="store_true", help="Return cached page text")
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
    parser.add_argument("--start-published-date", help="YYYY-MM-DD or ISO 8601")
    parser.add_argument("--end-published-date", help="YYYY-MM-DD or ISO 8601")
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
    parser.add_argument(
        "--markdown",
        action="store_true",
        help="Print results in Markdown format with inline hyperlinks",
    )
    return parser

def _build_extras(args: argparse.Namespace) -> Optional[Dict[str, Any]]:
    extras: Dict[str, Any] = {}
    if args.extras_links is not None:
        extras["links"] = args.extras_links
    if args.extras_image_links is not None:
        extras["imageLinks"] = args.extras_image_links
    if args.extras_rich_image_links is not None:
        extras["richImageLinks"] = args.extras_rich_image_links
    if args.extras_rich_links is not None:
        extras["richLinks"] = args.extras_rich_links
    if args.extras_code_blocks is not None:
        extras["codeBlocks"] = args.extras_code_blocks
    return extras if extras else None


def build_search_payload(args: argparse.Namespace) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "query": args.query,
        "type": args.type,
        "numResults": args.num_results,
    }
    category = _normalize_category(args.category)
    if category:
        payload["category"] = category
    if getattr(args, "stream", False):
        payload["stream"] = True
    if getattr(args, "additional_queries", None):
        payload["additionalQueries"] = args.additional_queries
    if getattr(args, "compliance", None):
        payload["compliance"] = args.compliance
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
    if args.system_prompt:
        payload["systemPrompt"] = args.system_prompt
    if args.output_schema:
        with open(args.output_schema, "r", encoding="utf-8") as fp:
            payload["outputSchema"] = json.load(fp)
    if args.include_texts:
        payload["includeText"] = args.include_texts
    if args.exclude_texts:
        payload["excludeText"] = args.exclude_texts
    if args.moderation:
        payload["moderation"] = True

    contents: Dict[str, Any] = {}
    text_opts = _build_text_opts(args)
    if text_opts is not None:
        contents["text"] = text_opts
    if args.highlights is not None:
        contents["highlights"] = args.highlights
    summary_opts: Dict[str, Any] = {}
    if args.summary_query:
        summary_opts["query"] = args.summary_query
    if args.summary_schema:
        with open(args.summary_schema, "r", encoding="utf-8") as fp:
            summary_opts["schema"] = json.load(fp)
    if summary_opts:
        contents["summary"] = summary_opts
    if args.subpages is not None:
        contents["subpages"] = args.subpages
    if args.subpage_target is not None:
        contents["subpageTarget"] = args.subpage_target
    extras = _build_extras(args)
    if extras is not None:
        contents["extras"] = extras
    if args.max_age_hours is not None:
        contents["maxAgeHours"] = args.max_age_hours
    if args.livecrawl_timeout is not None:
        contents["livecrawlTimeout"] = args.livecrawl_timeout
    if contents:
        payload["contents"] = contents
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
        args.text
        or args.text_max_chars is not None
        or args.text_include_html
        or args.verbosity is not None
        or bool(args.include_sections)
        or bool(args.exclude_sections)
    )
    if text_requested:
        text_opts = _build_text_opts(args)
        payload["text"] = text_opts or True

    if args.highlights is not None:
        payload["highlights"] = args.highlights

    summary_opts: Dict[str, Any] = {}
    if args.summary_query:
        summary_opts["query"] = args.summary_query
    if args.summary_schema:
        with open(args.summary_schema, "r", encoding="utf-8") as fp:
            summary_opts["schema"] = json.load(fp)
    if summary_opts:
        payload["summary"] = summary_opts

    if args.subpages is not None:
        payload["subpages"] = args.subpages
    if args.subpage_target is not None:
        payload["subpageTarget"] = args.subpage_target
    extras = _build_extras(args)
    if extras is not None:
        payload["extras"] = extras
    if args.max_age_hours is not None:
        payload["maxAgeHours"] = args.max_age_hours
    if args.livecrawl_timeout is not None:
        payload["livecrawlTimeout"] = args.livecrawl_timeout

    return payload


def call_exa(path: str, payload: Dict[str, Any], api_key: str, timeout: int) -> Dict[str, Any]:
    url = path if path.startswith("http") else f"{API_BASE}{path if path.startswith('/') else '/' + path}"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "accept": "application/json",
            "content-type": "application/json",
            "authorization": f"Bearer {api_key}",
            "user-agent": "Mozilla/5.0 (compatible; ExaSearchSkill/2.0)",
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




def build_answer_payload(args: argparse.Namespace) -> Dict[str, Any]:
    payload: Dict[str, Any] = {"query": args.question}
    if args.text:
        payload["text"] = True
    return payload


def build_similar_payload(args: argparse.Namespace) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "url": args.url,
        "numResults": args.num_results,
    }
    if args.include_domains:
        payload["includeDomains"] = args.include_domains
    if args.exclude_domains:
        payload["excludeDomains"] = args.exclude_domains
    if args.start_published_date:
        payload["startPublishedDate"] = args.start_published_date
    if args.end_published_date:
        payload["endPublishedDate"] = args.end_published_date
    contents: Dict[str, Any] = {}
    if args.text:
        contents["text"] = {"maxCharacters": 10000}
    if contents:
        payload["contents"] = contents
    return payload

def execute_search(args: argparse.Namespace) -> Dict[str, Any]:
    api_key = ensure_api_key()
    payload = build_search_payload(args)
    return call_exa("/search", payload, api_key, args.timeout)


def execute_search_stream(args: argparse.Namespace) -> None:
    """Stream /search SSE frames (OpenAI-compatible chunks) to stdout.

    The API only streams for deep search types with outputSchema; otherwise
    it returns a normal JSON body, which we print via print_search_results.
    """
    api_key = ensure_api_key()
    payload = build_search_payload(args)
    url = f"{API_BASE}/search"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "accept": "text/event-stream",
            "content-type": "application/json",
            "authorization": f"Bearer {api_key}",
            "user-agent": "Mozilla/5.0 (compatible; ExaSearchSkill/2.0)",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=args.timeout) as resp:
            if "text/event-stream" not in resp.headers.get("Content-Type", ""):
                body = resp.read().decode("utf-8", errors="ignore")
                results = json.loads(body)
                print_search_results(results, args.table_limit, args.markdown)
                return
            buffer = b""
            for raw in resp:
                buffer += raw
                while b"\n\n" in buffer:
                    frame, buffer = buffer.split(b"\n\n", 1)
                    for line in frame.split(b"\n"):
                        line = line.strip()
                        if not line.startswith(b"data:"):
                            continue
                        data_line = line[5:].strip()
                        if not data_line or data_line == b"[DONE]":
                            continue
                        try:
                            chunk = json.loads(data_line)
                        except json.JSONDecodeError:
                            continue
                        delta = chunk.get("delta")
                        if isinstance(delta, dict):
                            content = delta.get("content")
                        elif isinstance(delta, str):
                            content = delta
                        else:
                            choices = chunk.get("choices") or [{}]
                            content = (choices[0].get("delta") or {}).get("content")
                        if content:
                            print(content, end="", flush=True)
    except urllib.error.HTTPError as err:
        error_body = err.read().decode("utf-8", errors="ignore") if err.fp else ""
        raise RuntimeError(f"Exa API error {err.code}: {error_body.strip() or err.reason}") from err
    except urllib.error.URLError as err:
        raise RuntimeError(f"Failed to reach Exa API: {err.reason}") from err
    print()


def execute_contents(args: argparse.Namespace) -> Dict[str, Any]:
    api_key = ensure_api_key()
    payload = build_contents_payload(args)
    return call_exa("/contents", payload, api_key, args.timeout)




def execute_answer(args: argparse.Namespace) -> Dict[str, Any]:
    api_key = ensure_api_key()
    payload = build_answer_payload(args)
    return call_exa("/answer", payload, api_key, args.timeout)


def execute_similar(args: argparse.Namespace) -> Dict[str, Any]:
    api_key = ensure_api_key()
    payload = build_similar_payload(args)
    return call_exa("/findSimilar", payload, api_key, args.timeout)

def print_search_results(results: Dict[str, Any], limit: Optional[int], markdown: bool = False) -> None:
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
        if markdown:
            print(f"{idx}. [{title}]({url})")
            meta = []
            if published:
                meta.append(f"published: {published}")
            if score is not None:
                meta.append(f"score: {score}")
            if meta:
                print(f"   _{', '.join(meta)}_")
            if row.get("text"):
                snippet = row["text"].strip()
                preview = snippet[:400]
                print(f"   > {preview}{'...' if len(snippet) > 400 else ''}")
            if row.get("highlights"):
                highlights = row["highlights"]
                if isinstance(highlights, list):
                    preview = " ".join(
                        h.strip() if isinstance(h, str) else h.get("snippet", "").strip()
                        for h in highlights[:2]
                    )
                else:
                    preview = str(highlights)[:400]
                if preview:
                    print(f"   highlights: {preview}")
            if row.get("summary"):
                summary = row["summary"]
                if isinstance(summary, str):
                    text = summary.strip()
                else:
                    text = json.dumps(summary, ensure_ascii=False)
                print(f"   summary: {text[:400]}{'...' if len(text) > 400 else ''}")
            print()
        else:
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
                        h.strip() if isinstance(h, str) else h.get("snippet", "").strip()
                        for h in highlights[:2]
                    )
                else:
                    preview = str(highlights)[:280]
                if preview:
                    print(f"    highlights: {preview}")
            if row.get("summary"):
                summary = row["summary"]
                if isinstance(summary, str):
                    text = summary.strip()
                else:
                    text = json.dumps(summary, ensure_ascii=False)
                print(f"    summary: {text[:400]}{'...' if len(text) > 400 else ''}")
            print()

    output = results.get("output")
    if output is not None:
        print("Structured output:")
        if isinstance(output, dict):
            if output.get("content") is not None:
                print(json.dumps(output["content"], ensure_ascii=False, indent=2))
            else:
                print(json.dumps(output, ensure_ascii=False, indent=2))
        else:
            print(str(output)[:800])
        grounding = output.get("grounding") if isinstance(output, dict) else None
        if grounding:
            print("\nGrounding:")
            for entry in grounding:
                field = entry.get("field", "content")
                confidence = entry.get("confidence", "")
                citations = entry.get("citations", [])
                cite_str = ", ".join(
                    f"[{c.get('title') or c.get('url')}]({c.get('url')})" for c in citations
                )
                print(f"  {field} ({confidence}): {cite_str}")

    resolved_type = results.get("resolvedSearchType") or results.get("searchType")
    if resolved_type:
        print(f"search_type: {resolved_type}")
    cost = results.get("costDollars") or {}
    total = cost.get("total")
    if total is not None:
        print(f"cost_usd: {total}")

    if markdown:
        print(f"sources_reviewed: {len(rows)}")


def print_contents_results(results: Dict[str, Any], limit: Optional[int], markdown: bool = False) -> None:
    rows = results.get("results") or results.get("content") or []
    if limit is not None:
        rows = rows[:limit]
    if not rows:
        print("No contents returned")
        return
    for idx, row in enumerate(rows, start=1):
        url = row.get("url") or row.get("id") or "(no url)"
        title = row.get("title")
        if markdown:
            print(f"{idx}. [{title or url}]({url})")
            if row.get("text"):
                snippet = row["text"].strip()
                preview = snippet[:500]
                print(f"   > {preview}{'...' if len(snippet) > 500 else ''}")
            if row.get("highlights"):
                highlights = row["highlights"]
                if isinstance(highlights, list):
                    preview = " ".join(h.strip() if isinstance(h, str) else str(h) for h in highlights[:2])
                else:
                    preview = str(highlights)
                if preview:
                    print(f"   highlights: {preview}")
            if row.get("summary"):
                summary = row["summary"]
                if isinstance(summary, str):
                    text = summary.strip()
                else:
                    text = json.dumps(summary, ensure_ascii=False)
                print(f"   summary: {text[:400]}{'...' if len(text) > 400 else ''}")
            print()
        else:
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

    statuses = results.get("statuses") or []
    for st in statuses:
        if isinstance(st, dict) and st.get("status") == "error":
            err = st.get("error") or {}
            code = err.get("httpStatusCode")
            print(
                f"[error] {st.get('id', '?')}: {err.get('tag', 'unknown')}"
                + (f" (HTTP {code})" if code else "")
            )
    cost = results.get("costDollars") or {}
    total = cost.get("total")
    if total is not None:
        print(f"cost_usd: {total}")

    if markdown:
        print(f"sources_reviewed: {len(rows)}")




def print_answer_results(results: Dict[str, Any]) -> None:
    answer = results.get("answer") or results.get("text")
    if answer is None:
        print("No answer returned")
        print(json.dumps(results, ensure_ascii=False, indent=2))
        return
    print(answer)
    citations = results.get("citations") or results.get("sources") or []
    if citations:
        print()
        print("Citations:")
        for idx, cite in enumerate(citations, start=1):
            if isinstance(cite, dict):
                url = cite.get("url") or cite.get("id") or ""
                title = cite.get("title") or url
                print(f"  [{idx}] [{title}]({url})")
            else:
                print(f"  [{idx}] {cite}")


def print_similar_results(results: Dict[str, Any], limit: Optional[int], markdown: bool = False) -> None:
    rows = results.get("results", [])
    if limit is not None:
        rows = rows[:limit]
    if not rows:
        print("No similar results")
        return
    for idx, row in enumerate(rows, start=1):
        title = row.get("title") or "(untitled)"
        url = row.get("url") or row.get("id") or "(no url)"
        score = row.get("score")
        published = row.get("publishedDate") or row.get("published")
        if markdown:
            print(f"{idx}. [{title}]({url})")
            meta = []
            if published:
                meta.append(f"published: {published}")
            if score is not None:
                meta.append(f"score: {score}")
            if meta:
                print(f"   _{', '.join(meta)}_")
            if row.get("text"):
                snippet = row["text"].strip()
                preview = snippet[:400]
                print(f"   > {preview}{'...' if len(snippet) > 400 else ''}")
            print()
        else:
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
            print()
    if markdown:
        print(f"sources_reviewed: {len(rows)}")

def save_raw_if_requested(data: Dict[str, Any], path: Optional[str]) -> None:
    if not path:
        return
    with open(path, "w", encoding="utf-8") as fp:
        json.dump(data, fp, ensure_ascii=False, indent=2)
    print(f"Saved raw response to {path}")


def _select_parser(command: str) -> argparse.ArgumentParser:
    if command == "search":
        return build_search_parser()
    if command == "contents":
        return build_contents_parser()
    if command == "answer":
        return build_answer_parser()
    if command == "similar":
        return build_similar_parser()
    raise ValueError(f"Unknown command: {command}")


def main(argv: Optional[Sequence[str]] = None) -> int:
    args_list = list(argv) if argv is not None else sys.argv[1:]
    if not args_list or args_list[0] in ("-h", "--help"):
        print(GENERAL_HELP)
        return 0

    if args_list[0] in {"search", "contents", "answer", "similar"}:
        command = args_list[0]
        args_list = args_list[1:]
    else:
        command = "search"

    parser = _select_parser(command)
    args = parser.parse_args(args_list)
    args.command = command
    if hasattr(args, "highlights"):
        args.highlights = normalize_highlights(
            args.highlights, getattr(args, "highlights_max_chars", None)
        )

    try:
        if command == "search":
            if getattr(args, "stream", False):
                execute_search_stream(args)
            else:
                results = execute_search(args)
                save_raw_if_requested(results, args.raw)
                print_search_results(results, args.table_limit, args.markdown)
        elif command == "contents":
            results = execute_contents(args)
            save_raw_if_requested(results, args.raw)
            print_contents_results(results, args.table_limit, args.markdown)
        elif command == "answer":
            results = execute_answer(args)
            save_raw_if_requested(results, args.raw)
            print_answer_results(results)
        else:
            results = execute_similar(args)
            save_raw_if_requested(results, args.raw)
            print_similar_results(results, args.table_limit, args.markdown)
    except Exception as exc:  # noqa: BLE001
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
