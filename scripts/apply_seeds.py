#!/usr/bin/env python3
"""Merge canonical landmark papers (scripts/seeds.json) into the dataset, with de-dup.

Why this exists: this OpenAlex snapshot fragments or omits several landmark papers
(Attention Is All You Need, BERT, GPT-3, ...). This step injects canonical versions so
the graph isn't missing its most important nodes. Every seeded record is flagged
`seeded: true` with `seed_count_source: "manual"` and keeps `openalex_cited_by_count`
for provenance, so the override is never silently mistaken for OpenAlex ground truth.

Two kinds of seed:
  * openalex_id set  -> fetch the real record (real metadata + references, so it wires
    into the citation graph) and scale counts_by_year up to true_citations.
  * openalex_id null -> hand-construct a minimal valid record with a synthetic id and a
    recent-weighted counts_by_year so node sizing works.

De-dup: for each seed we drop any existing row matching its id, its `replaces` ids, its
DOI, or its normalized title -- so a fragment/mis-dated copy is replaced, not doubled.

Run AFTER fetch, BEFORE build:  fetch -> apply_seeds -> build --drop-suspect -> layout.
Stdlib only. Edits top_cited.jsonl in place (writes a .pre-seed backup first).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
import urllib.parse
import urllib.request

SELECT = ",".join([
    "id", "doi", "title", "display_name", "publication_year", "publication_date", "type",
    "language", "cited_by_count", "counts_by_year", "fwci", "authorships",
    "primary_location", "best_oa_location", "locations", "open_access", "has_content",
    "content_urls", "referenced_works_count", "primary_topic", "abstract_inverted_index",
    "referenced_works", "related_works", "topics", "keywords", "biblio",
])


def api_key() -> str | None:
    env = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if os.path.isfile(env):
        for line in open(env, encoding="utf-8"):
            if line.startswith("OPENALEX_API_KEY"):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return os.environ.get("OPENALEX_API_KEY")


def fetch_works(ids: list[str], key: str | None) -> dict[str, dict]:
    """Fetch full OpenAlex records for a batch of short ids."""
    if not ids:
        return {}
    params = {"filter": "openalex_id:" + "|".join(ids), "per_page": "50",
              "select": SELECT, "mailto": "15andrewj@gmail.com"}
    if key:
        params["api_key"] = key
    url = "https://api.openalex.org/works?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=60) as r:
        results = json.loads(r.read()).get("results") or []
    return {w["id"].rsplit("/", 1)[-1]: w for w in results}


def short_id(url: str | None) -> str | None:
    return url.rsplit("/", 1)[-1] if url else None


def norm(t: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", (t or "").lower())


def synth_counts(year: int, total: int, data_year: int) -> list[dict]:
    """Recent-weighted counts_by_year so a hand-constructed seed gets a realistic node size
    (~12% of citations in each of the last 3 complete years; remainder spread over its life)."""
    counts, recent_each = [], round(0.12 * total)
    recent = [data_year - 3, data_year - 2, data_year - 1]
    for y in recent:
        counts.append({"year": y, "cited_by_count": recent_each})
    remain = total - recent_each * len(recent)
    early = [y for y in range(year, data_year - 3)]
    if early and remain > 0:
        per = remain // len(early)
        for y in early:
            counts.append({"year": y, "cited_by_count": per})
    counts.sort(key=lambda c: c["year"])
    return counts


def scale_counts(rec: dict, true_total: int) -> None:
    """Scale a real record's counts_by_year up to the true total, preserving temporal shape."""
    orig = rec.get("cited_by_count") or 0
    if orig > 0:
        f = true_total / orig
        for c in rec.get("counts_by_year") or []:
            c["cited_by_count"] = round((c.get("cited_by_count") or 0) * f)
    rec["openalex_cited_by_count"] = orig
    rec["cited_by_count"] = true_total


def build_synthetic(seed: dict, data_year: int) -> dict:
    sid = seed["synthetic_id"]
    total = seed["true_citations"]
    return {
        "id": f"https://openalex.org/{sid}",
        "doi": seed.get("doi"),
        "title": seed["title"],
        "display_name": seed["title"],
        "publication_year": seed["year"],
        "type": "article",
        "cited_by_count": total,
        "openalex_cited_by_count": None,
        "counts_by_year": synth_counts(seed["year"], total, data_year),
        "fwci": None,
        "authorships": [{"author": {"display_name": n}, "institutions": []}
                        for n in seed.get("authors", [])],
        "primary_topic": {
            "display_name": seed.get("topic") or seed["field"],
            "domain": {"display_name": seed["domain"]},
            "field": {"display_name": seed["field"]},
        },
        "topics": [{"display_name": seed.get("topic") or seed["field"]}],
        "keywords": [],
        "open_access": {"is_oa": True, "oa_status": "green"},
        "has_content": {},
        "content_urls": {},
        "referenced_works": [f"https://openalex.org/{r}" for r in seed.get("references", [])],
        "related_works": [],
        "abstract_inverted_index": None,
    }


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    spec = json.load(open(os.path.join(here, "seeds.json"), encoding="utf-8"))
    data_year = spec.get("data_year", 2026)
    seeds = spec["seeds"]
    jsonl = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, "data/full/top_cited.jsonl")

    key = api_key()
    real_ids = [s["openalex_id"] for s in seeds if s.get("openalex_id")]
    print(f"Fetching {len(real_ids)} real seed records from OpenAlex ...", file=sys.stderr)
    fetched = fetch_works(real_ids, key)

    # Build seed records + the set of identifiers each one supersedes.
    seed_recs, drop_ids, drop_dois, drop_titles = [], set(), set(), set()
    for s in seeds:
        if s.get("openalex_id"):
            rec = fetched.get(s["openalex_id"])
            if not rec:
                print(f"  WARN: {s['name']} ({s['openalex_id']}) not returned by API; skipping",
                      file=sys.stderr)
                continue
            scale_counts(rec, s["true_citations"])
            title = rec.get("title") or rec.get("display_name")
            drop_ids.add(s["openalex_id"])
        else:
            rec = build_synthetic(s, data_year)
            title = rec["title"]
        rec["seeded"] = True
        rec["seed_name"] = s["name"]
        rec["seed_count_source"] = "manual"
        seed_recs.append(rec)
        drop_ids.update(s.get("replaces", []))
        if rec.get("doi"):
            drop_dois.add(rec["doi"].lower())
        drop_titles.add(norm(title))
        print(f"  seed: {s['name']:24} cites={rec['cited_by_count']:>7} "
              f"({'real ' + s['openalex_id'] if s.get('openalex_id') else 'synthetic'})",
              file=sys.stderr)

    # Load dataset, drop anything a seed supersedes, then append the seeds.
    rows = [json.loads(l) for l in open(jsonl, encoding="utf-8")]
    before = len(rows)
    kept = []
    removed = 0
    for r in rows:
        if (short_id(r.get("id")) in drop_ids
                or (r.get("doi") or "").lower() in drop_dois
                or norm(r.get("title")) in drop_titles):
            removed += 1
            continue
        kept.append(r)
    kept.extend(seed_recs)

    shutil.copyfile(jsonl, jsonl + ".pre-seed")
    with open(jsonl, "w", encoding="utf-8") as f:
        for r in kept:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    print(f"\nDe-dup removed {removed} existing rows; added {len(seed_recs)} seeds.\n"
          f"  {before} -> {len(kept)} records\n  backup: {jsonl}.pre-seed", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
