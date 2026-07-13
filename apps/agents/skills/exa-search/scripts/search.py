#!/usr/bin/env python3
"""Exa Search & Contents helper (standard library only)."""

import argparse
import json
import os
from pathlib import Path
import sys
from typing import Any, Dict, Optional, Sequence, Tuple
import urllib.error
import urllib.request

API_BASE = os.environ.get("EXA_API_BASE", "https://api.exa.ai").rstrip("/")
API_KEY_ENV = "EXA_API_KEY"
HighlightArg = Optional[Tuple[int, Optional[str]]]
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
            "research paper",
            "news",
            "pdf",
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
        help="(Deprecated) Control live crawling behavior. Use --max-age-hours instead.",
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
        help="Path to JSON schema file for structured search output (use with deep/deep-reasoning)",
    )
    parser.add_argument(
        "--system-prompt",
        dest="system_prompt",
        help="Instructions for the search model (use with deep/deep-reasoning)",
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
        "--images",
        type=int,
        help="Number of images to return for each URL",
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
        "--livecrawl",
        choices=["never", "fallback", "preferred", "always"],
        help="(Deprecated) Control live crawling behavior. Use --max-age-hours instead.",
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
    if args.text:
        contents["text"] = True
    if args.highlights is not None:
        num_sentences, query = args.highlights
        contents["highlights"] = {
            "numSentences": num_sentences,
            **({"query": query} if query else {}),
        }
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
    if args.livecrawl:
        payload["livecrawl"] = args.livecrawl
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

    if args.subpages is not None:
        payload["subpages"] = args.subpages
    if args.subpage_target is not None:
        payload["subpageTarget"] = args.subpage_target
    if args.images is not None:
        payload["images"] = args.images
    extras = _build_extras(args)
    if extras is not None:
        payload["extras"] = extras
    if args.livecrawl:
        payload["livecrawl"] = args.livecrawl
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
            "x-api-key": api_key,
            "user-agent": "Mozilla/5.0 (compatible; ExaSearchSkill/1.0)",
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
        args.highlights = normalize_highlights(args.highlights)

    try:
        if command == "search":
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
