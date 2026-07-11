#!/usr/bin/env python3
"""Explore the top-cited OpenAlex dataset: coverage & distribution stats.

Reads the raw JSONL pulled by fetch_top_cited.py and prints a report covering:
  - distribution across domains (and top fields)
  - open-access share (by is_oa and by oa_status)
  - PDF url coverage (OpenAlex content pdf vs. any public/landing pdf)
  - GROBID XML url coverage
  - a few adjacent coverage stats (abstract, references, DOI) for context

Stdlib only. Text report to stdout; add --json to also emit machine-readable stats.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter


# ------------------------------------------------------------------ field accessors

def domain_of(work: dict) -> str:
    return ((work.get("primary_topic") or {}).get("domain") or {}).get("display_name") or "Unknown"


def field_of(work: dict) -> str:
    return ((work.get("primary_topic") or {}).get("field") or {}).get("display_name") or "Unknown"


def content_pdf_url(work: dict) -> str | None:
    """OpenAlex-hosted full-text pdf (content.openalex.org)."""
    return (work.get("content_urls") or {}).get("pdf")


def grobid_xml_url(work: dict) -> str | None:
    """OpenAlex-hosted GROBID-parsed XML."""
    return (work.get("content_urls") or {}).get("grobid_xml")


def public_pdf_url(work: dict) -> str | None:
    """Any publisher/repository pdf reachable from the work's locations."""
    for loc in (work.get("best_oa_location"), work.get("primary_location")):
        url = (loc or {}).get("pdf_url")
        if url:
            return url
    for loc in work.get("locations") or []:
        url = (loc or {}).get("pdf_url")
        if url:
            return url
    return None


# ------------------------------------------------------------------ reporting helpers

def pct(n: int, total: int) -> str:
    return f"{100 * n / total:5.1f}%" if total else "  n/a"


def bar(n: int, total: int, width: int = 30) -> str:
    filled = round(width * n / total) if total else 0
    return "█" * filled + "·" * (width - filled)


def print_dist(title: str, counter: Counter, total: int, limit: int | None = None) -> None:
    print(f"\n{title}")
    print("-" * len(title))
    items = counter.most_common(limit)
    label_w = max((len(k) for k, _ in items), default=0)
    for label, count in items:
        print(f"  {label:<{label_w}}  {count:>6,}  {pct(count, total)}  {bar(count, total)}")
    if limit is not None and len(counter) > limit:
        rest = sum(counter.values()) - sum(c for _, c in items)
        print(f"  {'(other)':<{label_w}}  {rest:>6,}  {pct(rest, total)}")


def print_coverage(title: str, flags: dict[str, int], total: int) -> None:
    print(f"\n{title}")
    print("-" * len(title))
    label_w = max(len(k) for k in flags)
    for label, count in flags.items():
        print(f"  {label:<{label_w}}  {count:>6,} / {total:,}  {pct(count, total)}  {bar(count, total)}")


# ------------------------------------------------------------------ main

def main() -> int:
    p = argparse.ArgumentParser(description="Explore the top-cited dataset.")
    p.add_argument("--in", dest="inp", default="scripts/data/full/top_cited.jsonl")
    p.add_argument("--top-fields", type=int, default=15, help="How many fields to list.")
    p.add_argument("--json", action="store_true", help="Also print a JSON stats block to stderr.")
    args = p.parse_args()

    rows = [json.loads(line) for line in open(args.inp, encoding="utf-8")]
    n = len(rows)
    if not n:
        print("No records.", file=sys.stderr)
        return 1

    domains = Counter(domain_of(r) for r in rows)
    fields = Counter(field_of(r) for r in rows)
    oa_status = Counter((r.get("open_access") or {}).get("oa_status") or "unknown" for r in rows)

    # coverage counts
    is_oa = sum(1 for r in rows if (r.get("open_access") or {}).get("is_oa"))
    has_content_pdf = sum(1 for r in rows if content_pdf_url(r))
    has_public_pdf = sum(1 for r in rows if public_pdf_url(r))
    has_any_pdf = sum(1 for r in rows if content_pdf_url(r) or public_pdf_url(r))
    has_grobid = sum(1 for r in rows if grobid_xml_url(r))
    has_content_flag = sum(1 for r in rows if (r.get("has_content") or {}).get("grobid_xml"))
    has_abstract = sum(1 for r in rows if r.get("abstract_inverted_index"))
    has_doi = sum(1 for r in rows if r.get("doi"))
    has_refs = sum(1 for r in rows if r.get("referenced_works"))

    # ---- report ----
    print("=" * 60)
    print(f"  Top-cited dataset exploration — {n:,} works")
    print(f"  source: {args.inp}")
    print("=" * 60)

    print_dist("Distribution across domains", domains, n)
    print_dist(f"Top {args.top_fields} fields", fields, n, limit=args.top_fields)

    print_coverage("Open access", {
        "is_oa (open access)": is_oa,
        "closed / not OA":     n - is_oa,
    }, n)
    print_dist("OA status breakdown", oa_status, n)

    print_coverage("PDF url coverage", {
        "OpenAlex content pdf": has_content_pdf,
        "public/landing pdf":   has_public_pdf,
        "any pdf url":          has_any_pdf,
    }, n)

    print_coverage("GROBID XML coverage", {
        "content_urls.grobid_xml": has_grobid,
        "has_content.grobid_xml flag": has_content_flag,
    }, n)

    print_coverage("Other coverage (context)", {
        "abstract":           has_abstract,
        "DOI":                has_doi,
        "referenced_works":   has_refs,
    }, n)

    print()

    if args.json:
        stats = {
            "n": n,
            "domains": dict(domains),
            "fields": dict(fields),
            "oa_status": dict(oa_status),
            "coverage": {
                "is_oa": is_oa,
                "content_pdf": has_content_pdf,
                "public_pdf": has_public_pdf,
                "any_pdf": has_any_pdf,
                "grobid_xml": has_grobid,
                "grobid_flag": has_content_flag,
                "abstract": has_abstract,
                "doi": has_doi,
                "referenced_works": has_refs,
            },
        }
        json.dump(stats, sys.stderr, indent=2, ensure_ascii=False)
        print(file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
