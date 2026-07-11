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
    "age_years",
    "citations_per_year",
    "recent_2y_citations",
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


def build_url(
    cursor: str,
    per_page: int,
    mailto: str,
    api_key: str | None,
    filter_expr: str | None = None,
    sort: str = "cited_by_count:desc",
) -> str:
    params = {
        "sort": sort,
        "per_page": str(per_page),
        "cursor": cursor,
        "select": ",".join(SELECT_FIELDS),
        "mailto": mailto,
    }
    if filter_expr:
        params["filter"] = filter_expr
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

    # 3. Predated citations: a work can't be cited before it exists, so citations landing
    #    2+ years before publication_year mean the year is wrong -- typically an old classic
    #    reprinted/merged under a recent date (the "2026" reprint failure mode). We require
    #    the predated share to *dominate* (>30%): a small leak is a merged-record artifact on
    #    a genuine paper (e.g. AlexNet's 2012 cites on a 2017 record), while a dominant share
    #    means the record is fundamentally an old work wearing a recent year. The 2y slack
    #    absorbs legit preprint-vs-journal lag.
    py = work.get("publication_year")
    if py and total:
        predated = sum((c.get("cited_by_count") or 0) for c in counts
                       if (c.get("year") is not None and c["year"] < py - 1))
        if predated > 100 and predated / total > 0.30:
            reasons.append(f"predated_citations({predated}/{total}_before_{py})")

    return (bool(reasons), ";".join(reasons))


def citation_metrics(work: dict, data_year: int) -> tuple[int | None, float | None, int]:
    """Cross-era signals used to size recent papers fairly against old ones.

    Returns (age_years, citations_per_year, recent_2y_citations). Raw citation count
    conflates quality with elapsed time; these rates put a 2026 paper on the same
    footing as a 1970 one. Normalization into a display radius happens at build time,
    where the whole-corpus distribution is available. See README for the sizing model.
    """
    total = work.get("cited_by_count") or 0
    py = work.get("publication_year")
    age = max(1, data_year - py + 1) if py else None  # >=1; floor guards future-dated recs
    velocity = (total / age) if age else None
    counts = work.get("counts_by_year") or []
    # trailing ~2y momentum: catches currently-exploding new papers a lifetime rate misses
    recent_2y = sum(
        (c.get("cited_by_count") or 0) for c in counts if (c.get("year") or 0) >= data_year - 2
    )
    return age, velocity, recent_2y


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


def flatten(work: dict, rank: int, suspect: bool, reasons: str, data_year: int) -> dict:
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

    age_years, citations_per_year, recent_2y = citation_metrics(work, data_year)

    return {
        "rank": rank,
        "openalex_id": work.get("id"),
        "doi": work.get("doi"),
        "title": work.get("title") or work.get("display_name"),
        "type": work.get("type"),
        "publication_year": work.get("publication_year"),
        "cited_by_count": work.get("cited_by_count"),
        "age_years": age_years,
        "citations_per_year": round(citations_per_year, 1) if citations_per_year is not None else None,
        "recent_2y_citations": recent_2y,
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


class PageStats:
    """Mutable accumulator shared with the fetch iterators (cost, request count, meta)."""

    def __init__(self) -> None:
        self.requests = 0
        self.cost = 0.0
        self.api_total_count: int | None = None

    def record(self, data: dict) -> str | None:
        meta = data.get("meta") or {}
        self.requests += 1
        self.cost += meta.get("cost_usd") or 0.0
        self.api_total_count = meta.get("count", self.api_total_count)
        return meta.get("next_cursor")


def iter_global(args, per_page, stats: PageStats):
    """Strategy 'global': the classic top-N by citation count across all years."""
    cursor, fetched = "*", 0
    while fetched < args.limit and cursor:
        page = min(per_page, args.limit - fetched)
        url = build_url(cursor, page, args.mailto, args.api_key)
        data = fetch_page(url)
        cursor = stats.record(data)
        results = data.get("results") or []
        if not results:
            break
        for work in results:
            if fetched >= args.limit:
                break
            fetched += 1
            yield work
        print(f"  req {stats.requests}: +{len(results)} (total {fetched}/{args.limit}), "
              f"cost ${stats.cost:.4f}", file=sys.stderr)
        if fetched < args.limit and cursor:
            time.sleep(args.sleep)


def iter_per_year(args, per_page, stats: PageStats):
    """Strategy 'per-year': top-K per publication year, guaranteeing recent cohorts appear.

    Each year is queried independently (filter=publication_year:Y, sorted by citations),
    so 2025/2026 papers are selected on their own terms instead of losing a global
    race to decades-old canon. --limit caps the grand total across all years.

    --min-citations sets a per-cohort floor: a year contributes *up to* per_year works,
    but only those at/above the floor. Thin/incomplete years (e.g. the current year) then
    contribute however few real papers they have instead of being padded to per_year with
    mis-dated reprints and container records. Results are citation-sorted, so we stop a
    year as soon as one drops below the floor.
    """
    floor = args.min_citations or 0
    fetched = 0
    for year in range(args.year_end, args.year_start - 1, -1):
        if fetched >= args.limit:
            break
        target = min(args.per_year, args.limit - fetched)
        cursor, got, exhausted = "*", 0, False
        while got < target and cursor and not exhausted:
            page = min(per_page, target - got)
            url = build_url(cursor, page, args.mailto, args.api_key,
                            filter_expr=f"publication_year:{year}")
            data = fetch_page(url)
            cursor = stats.record(data)
            results = data.get("results") or []
            if not results:
                break
            for work in results:
                if got >= target:
                    break
                if (work.get("cited_by_count") or 0) < floor:
                    exhausted = True  # sorted desc -> nothing below is worth scanning
                    break
                got += 1
                fetched += 1
                yield work
            if got < target and cursor and not exhausted:
                time.sleep(args.sleep)
        print(f"  year {year}: +{got} (total {fetched}/{args.limit}), "
              f"cost ${stats.cost:.4f}", file=sys.stderr)


def main() -> int:
    load_env_files()
    default_mailto = os.environ.get("OPENALEX_MAILTO") or "15andrewj@gmail.com"
    default_key = os.environ.get("OPENALEX_API_KEY") or None

    this_year = datetime.now(timezone.utc).year

    p = argparse.ArgumentParser(description="Fetch top-N most-cited works from OpenAlex.")
    p.add_argument("--strategy", choices=["global", "per-year"], default="global",
                   help="global: top-N by citations across all years (recency-biased). "
                        "per-year: top-K per publication year, so recent cohorts appear.")
    p.add_argument("--limit", type=int, default=10000, help="Overall cap on works pulled (default 10000).")
    p.add_argument("--per-year", type=int, default=None,
                   help="[per-year] works per publication year (default: limit / #years).")
    p.add_argument("--year-start", type=int, default=1900, help="[per-year] earliest year, inclusive.")
    p.add_argument("--year-end", type=int, default=this_year, help="[per-year] latest year, inclusive.")
    p.add_argument("--min-citations", type=int, default=0,
                   help="[per-year] citation floor per cohort; thin years contribute fewer "
                        "than --per-year instead of being padded with junk (default 0 = off).")
    p.add_argument("--per-page", type=int, default=MAX_PER_PAGE, help="Results per request (max 200).")
    p.add_argument("--out-dir", default="scripts/data/full", help="Output directory.")
    p.add_argument("--mailto", default=default_mailto, help="Polite-pool contact email (default: $OPENALEX_MAILTO).")
    p.add_argument("--api-key", default=default_key,
                   help="OpenAlex API key (default: $OPENALEX_API_KEY from .env). Optional for metadata.")
    p.add_argument("--sleep", type=float, default=0.1, help="Delay between requests, seconds.")
    args = p.parse_args()

    if args.strategy == "per-year" and args.per_year is None:
        n_years = max(1, args.year_end - args.year_start + 1)
        args.per_year = max(1, args.limit // n_years)

    per_page = max(1, min(args.per_page, MAX_PER_PAGE))
    os.makedirs(args.out_dir, exist_ok=True)
    jsonl_path = os.path.join(args.out_dir, "top_cited.jsonl")
    csv_path = os.path.join(args.out_dir, "top_cited.csv")
    meta_path = os.path.join(args.out_dir, "run_meta.json")

    stats = PageStats()
    fetched = 0
    n_suspect = 0
    started = time.time()

    if args.strategy == "per-year":
        print(f"Fetching up to {args.limit} works, {args.per_year}/year "
              f"({args.year_start}-{args.year_end}) -> {args.out_dir}", file=sys.stderr)
        works = iter_per_year(args, per_page, stats)
    else:
        print(f"Fetching top {args.limit} works (global) -> {args.out_dir}", file=sys.stderr)
        works = iter_global(args, per_page, stats)

    with open(jsonl_path, "w", encoding="utf-8") as jf, open(csv_path, "w", newline="", encoding="utf-8") as cf:
        writer = csv.DictWriter(cf, fieldnames=CSV_COLUMNS)
        writer.writeheader()

        for work in works:
            fetched += 1
            suspect, reasons = compute_suspect(work)
            if suspect:
                n_suspect += 1
            jf.write(json.dumps(work, ensure_ascii=False) + "\n")
            writer.writerow(flatten(work, fetched, suspect, reasons, this_year))

    elapsed = time.time() - started
    run_meta = {
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "data_year": this_year,
        "strategy": args.strategy,
        "limit": args.limit,
        "per_year": args.per_year if args.strategy == "per-year" else None,
        "year_range": [args.year_start, args.year_end] if args.strategy == "per-year" else None,
        "min_citations": args.min_citations if args.strategy == "per-year" else None,
        "records_written": fetched,
        "requests": stats.requests,
        "per_page": per_page,
        "total_cost_usd": round(stats.cost, 6),
        "suspect_count": n_suspect,
        "api_reported_total_works": stats.api_total_count,
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
        f"\nDone: {fetched} records in {stats.requests} requests, {elapsed:.1f}s, "
        f"cost ${stats.cost:.4f}, {n_suspect} flagged suspect.\n"
        f"  {jsonl_path}\n  {csv_path}\n  {meta_path}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
