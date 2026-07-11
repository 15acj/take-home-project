#!/usr/bin/env python3
"""Fetch the top-N most-cited works from the OpenAlex API.

Pulls works sorted by citation count (descending) using cursor paging, writes the
raw records to JSONL and a flattened summary to CSV, and adds a heuristic `suspect`
flag to help spot known OpenAlex citation-count anomalies (kept, never dropped).

Stdlib only - no pip install required.

Examples:
    # small validation batch
    python scripts/fetch_top_cited.py --limit 15 --out-dir scripts/data/sample

    # full run
    python scripts/fetch_top_cited.py --limit 10000 --out-dir scripts/data/full
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

API_URL = "https://api.openalex.org/works"

# Fields requested from OpenAlex. Kept lean but rich enough to inspect and to compute
# the suspect flag. abstract_inverted_index / referenced_works lists are omitted (large,
# not needed for a citation ranking) - easy to add here later if wanted.
SELECT_FIELDS = [
    "id",
    "doi",
    "title",
    "publication_year",
    "publication_date",
    "type",
    "language",
    "cited_by_count",
    "counts_by_year",
    "fwci",
    "authorships",
    "primary_location",
    "best_oa_location",
    "locations",
    "open_access",
    "has_content",
    "content_urls",
    "referenced_works_count",
    "primary_topic",
    "abstract_inverted_index",
    "referenced_works",
    "related_works",
    "topics",
    "keywords",
]

CSV_COLUMNS = [
    "rank",
    "openalex_id",
    "doi",
    "title",
    "type",
    "publication_year",
    "cited_by_count",
    "fwci",
    "first_author",
    "num_authors",
    "source_name",
    "primary_topic_field",
    "oa_status",
    "landing_url",
    "pdf_url",
    "oa_url",
    "grobid_xml_url",
    "language",
    "has_abstract",
    "num_topics",
    "num_referenced_works",
    "num_related_works",
    "suspect",
    "suspect_reasons",
]

MAX_PER_PAGE = 200


def load_env_files() -> None:
    """Minimal .env loader (no dependency). Reads KEY=VALUE lines from a .env next to
    this script and/or in the current dir. Real environment variables take precedence.
    """
    script_dir = os.path.dirname(os.path.abspath(__file__))
    candidates = [os.path.join(script_dir, ".env"), os.path.join(os.getcwd(), ".env")]
    seen: set[str] = set()
    for path in candidates:
        if path in seen or not os.path.isfile(path):
            continue
        seen.add(path)
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key = key.strip()
                val = val.strip().strip('"').strip("'")
                if key and key not in os.environ:  # don't override a real env var
                    os.environ[key] = val


def build_url(cursor: str, per_page: int, mailto: str, api_key: str | None) -> str:
    params = {
        "sort": "cited_by_count:desc",
        "per_page": str(per_page),
        "cursor": cursor,
        "select": ",".join(SELECT_FIELDS),
        "mailto": mailto,
    }
    if api_key:
        params["api_key"] = api_key
    return f"{API_URL}?{urllib.parse.urlencode(params)}"


def fetch_page(url: str, max_retries: int = 5) -> dict:
    """GET one page, retrying with exponential backoff on 429/5xx."""
    attempt = 0
    while True:
        attempt += 1
        req = urllib.request.Request(url, headers={"User-Agent": "top-cited-fetcher/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            # 429 (rate limit) and 5xx are transient -> back off and retry.
            if e.code == 429 or 500 <= e.code < 600:
                if attempt > max_retries:
                    raise RuntimeError(
                        f"Giving up after {max_retries} retries (last HTTP {e.code})."
                    ) from e
                wait = min(2 ** attempt, 60)
                print(f"  HTTP {e.code}; backing off {wait}s (attempt {attempt})", file=sys.stderr)
                time.sleep(wait)
                continue
            # Other 4xx are fatal (bad query, etc.) - surface the body to help debug.
            body = e.read().decode("utf-8", "replace")[:500]
            raise RuntimeError(f"HTTP {e.code} fetching page: {body}") from e
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt > max_retries:
                raise RuntimeError(f"Network error after {max_retries} retries: {e}") from e
            wait = min(2 ** attempt, 60)
            print(f"  network error {e}; retrying in {wait}s (attempt {attempt})", file=sys.stderr)
            time.sleep(wait)


def compute_suspect(work: dict) -> tuple[bool, str]:
    """Heuristic flag for likely citation-count anomalies. Human-inspection aid only.

    See plan: single-year citation concentration is the robust signal; sum(counts_by_year)
    vs total is NOT (counts_by_year only covers ~2012+).
    """
    reasons: list[str] = []
    total = work.get("cited_by_count") or 0

    # 1. Single-year spike: most citations landing in one year is the smoking gun
    #    for merge/count artifacts (e.g. 801,210 of 801,217 in a single year).
    counts = work.get("counts_by_year") or []
    if total > 1000 and counts:
        max_year = max((c.get("cited_by_count") or 0) for c in counts)
        if max_year / total > 0.90:
            reasons.append(f"single_year_spike({max_year}/{total})")

    # 2. Impact mismatch: six-figure citations but field-weighted impact ~average.
    fwci = work.get("fwci")
    if total > 100000 and fwci is not None and fwci < 5:
        reasons.append(f"low_fwci({fwci})")

    return (bool(reasons), ";".join(reasons))


def public_pdf_url(work: dict) -> str | None:
    """Best publicly accessible (no-API-key) PDF link from OpenAlex location data.

    Prefers the best open-access copy, then the primary location, then any other
    hosting location. Distinct from content_urls.pdf, which points at OpenAlex's own
    content store and requires an authenticated API key to download.
    """
    for loc in (work.get("best_oa_location"), work.get("primary_location")):
        url = (loc or {}).get("pdf_url")
        if url:
            return url
    for loc in work.get("locations") or []:
        url = (loc or {}).get("pdf_url")
        if url:
            return url
    return None


def flatten(work: dict, rank: int, suspect: bool, reasons: str) -> dict:
    authorships = work.get("authorships") or []
    first_author = None
    if authorships:
        author = authorships[0].get("author") or {}
        first_author = author.get("display_name")

    source_name = None
    primary_location = work.get("primary_location") or {}
    source = primary_location.get("source") or {}
    source_name = source.get("display_name")

    oa = work.get("open_access") or {}
    primary_topic = work.get("primary_topic") or {}
    field = (primary_topic.get("field") or {}).get("display_name")
    # landing_url + pdf_url are public publisher/repository links (no key needed).
    # grobid_xml_url is OpenAlex's own parsed output from content.openalex.org, which
    # has no public equivalent and requires an API key to download.
    content_urls = work.get("content_urls") or {}
    landing_url = primary_location.get("landing_page_url")
    oa_url = oa.get("oa_url")

    return {
        "rank": rank,
        "openalex_id": work.get("id"),
        "doi": work.get("doi"),
        "title": work.get("title") or work.get("display_name"),
        "type": work.get("type"),
        "publication_year": work.get("publication_year"),
        "cited_by_count": work.get("cited_by_count"),
        "fwci": work.get("fwci"),
        "first_author": first_author,
        "num_authors": len(authorships),
        "source_name": source_name,
        "primary_topic_field": field,
        "oa_status": oa.get("oa_status"),
        "landing_url": landing_url,
        "pdf_url": public_pdf_url(work),
        "oa_url": oa_url,
        "grobid_xml_url": content_urls.get("grobid_xml"),
        "language": work.get("language"),
        "has_abstract": work.get("abstract_inverted_index") is not None,
        "num_topics": len(work.get("topics") or []),
        "num_referenced_works": work.get("referenced_works_count"),
        "num_related_works": len(work.get("related_works") or []),
        "suspect": suspect,
        "suspect_reasons": reasons,
    }


def main() -> int:
    load_env_files()
    default_mailto = os.environ.get("OPENALEX_MAILTO") or "15andrewj@gmail.com"
    default_key = os.environ.get("OPENALEX_API_KEY") or None

    p = argparse.ArgumentParser(description="Fetch top-N most-cited works from OpenAlex.")
    p.add_argument("--limit", type=int, default=10000, help="Number of works to pull (default 10000).")
    p.add_argument("--per-page", type=int, default=MAX_PER_PAGE, help="Results per request (max 200).")
    p.add_argument("--out-dir", default="scripts/data/full", help="Output directory.")
    p.add_argument("--mailto", default=default_mailto, help="Polite-pool contact email (default: $OPENALEX_MAILTO).")
    p.add_argument("--api-key", default=default_key,
                   help="OpenAlex API key (default: $OPENALEX_API_KEY from .env). Optional for metadata.")
    p.add_argument("--sleep", type=float, default=0.1, help="Delay between requests, seconds.")
    args = p.parse_args()

    per_page = max(1, min(args.per_page, MAX_PER_PAGE))
    os.makedirs(args.out_dir, exist_ok=True)
    jsonl_path = os.path.join(args.out_dir, "top_cited.jsonl")
    csv_path = os.path.join(args.out_dir, "top_cited.csv")
    meta_path = os.path.join(args.out_dir, "run_meta.json")

    cursor = "*"
    fetched = 0
    total_cost = 0.0
    n_requests = 0
    n_suspect = 0
    api_total_count = None
    started = time.time()

    print(f"Fetching top {args.limit} works -> {args.out_dir}", file=sys.stderr)

    with open(jsonl_path, "w", encoding="utf-8") as jf, open(csv_path, "w", newline="", encoding="utf-8") as cf:
        writer = csv.DictWriter(cf, fieldnames=CSV_COLUMNS)
        writer.writeheader()

        while fetched < args.limit and cursor:
            page_size = min(per_page, args.limit - fetched)
            url = build_url(cursor, page_size, args.mailto, args.api_key)
            data = fetch_page(url)
            n_requests += 1

            meta = data.get("meta") or {}
            total_cost += meta.get("cost_usd") or 0.0
            api_total_count = meta.get("count", api_total_count)
            cursor = meta.get("next_cursor")

            results = data.get("results") or []
            if not results:
                break

            for work in results:
                if fetched >= args.limit:
                    break
                fetched += 1
                suspect, reasons = compute_suspect(work)
                if suspect:
                    n_suspect += 1
                jf.write(json.dumps(work, ensure_ascii=False) + "\n")
                writer.writerow(flatten(work, fetched, suspect, reasons))

            print(
                f"  req {n_requests}: +{len(results)} (total {fetched}/{args.limit}), "
                f"cost so far ${total_cost:.4f}",
                file=sys.stderr,
            )
            if fetched < args.limit and cursor:
                time.sleep(args.sleep)

    elapsed = time.time() - started
    run_meta = {
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "limit": args.limit,
        "records_written": fetched,
        "requests": n_requests,
        "per_page": per_page,
        "total_cost_usd": round(total_cost, 6),
        "suspect_count": n_suspect,
        "api_reported_total_works": api_total_count,
        "elapsed_seconds": round(elapsed, 1),
        "endpoint": API_URL,
        "sort": "cited_by_count:desc",
        "select_fields": SELECT_FIELDS,
        "mailto": args.mailto,
        "used_api_key": bool(args.api_key),
    }
    with open(meta_path, "w", encoding="utf-8") as mf:
        json.dump(run_meta, mf, indent=2)

    print(
        f"\nDone: {fetched} records in {n_requests} requests, {elapsed:.1f}s, "
        f"cost ${total_cost:.4f}, {n_suspect} flagged suspect.\n"
        f"  {jsonl_path}\n  {csv_path}\n  {meta_path}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
