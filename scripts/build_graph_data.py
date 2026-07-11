#!/usr/bin/env python3
"""Transform the raw top-cited JSONL into CDN-optimized artifacts for the 3D graph viz.

Produces (into --out):
  manifest.json      metadata: counts, citation scale domain, color legends, byte offsets
  nodes.bin          SoA binary: Uint32 citations[N], Uint16 year[N], Uint16 sizeScore[N],
                     Uint8 domainIdx[N], Uint8 fieldIdx[N], Uint8 flags[N]
                     (flags bit0=suspect, bit1=openAccess, bit2=hasPdf, bit3=hasGrobid;
                     2-byte fields precede 1-byte fields to keep Uint16 offsets even for any N)
  nodes-text.json    title[], author[](first), authorsDisplay[], topicIdx[] + topicTable[]
  search-kw.json     kwIdx[][] + kwTable[]  (keyword search terms; loaded after first paint)
  edges.bin          Uint16 SoA: src[E] then dst[E], sorted, deduped (N<65536 so 16-bit is safe)
  details/shard-NNN.json  Tier-2 full details, SHARD records each

Node index (0..N-1, citation-rank order = input order) is the canonical key across every file.
positions.bin is produced separately by layout_3d.mjs, which also patches positionScale into the
manifest.

Stdlib only. gzip sidecars (.gz) are written for each artifact; Brotli is left to the CDN.
"""

from __future__ import annotations

import argparse
import array
import datetime
import gzip
import hashlib
import json
import math
import os
import shutil
import sys

# ------------------------------------------------------------------ helpers

def short_id(url: str | None) -> str | None:
    return url.rsplit("/", 1)[-1] if url else None


def reconstruct_abstract(inv: dict | None) -> str | None:
    """Rebuild plain text from OpenAlex's abstract_inverted_index (word -> [positions])."""
    if not inv:
        return None
    pos: dict[int, str] = {}
    for word, positions in inv.items():
        for p in positions:
            pos[p] = word
    return " ".join(pos[k] for k in sorted(pos))


def first_author(work: dict) -> str:
    a = work.get("authorships") or []
    return ((a[0].get("author") or {}).get("display_name") or "") if a else ""


def authors_display(work: dict) -> str:
    """Compact display string for cards/lists: "A", "A, B", or "A et al."."""
    names = [((a.get("author") or {}).get("display_name") or "")
             for a in work.get("authorships") or []]
    names = [x for x in names if x]
    if not names:
        return ""
    if len(names) <= 2:
        return ", ".join(names)
    return f"{names[0]} et al."


def all_authors(work: dict) -> list[dict]:
    out = []
    for a in work.get("authorships") or []:
        out.append({
            "name": (a.get("author") or {}).get("display_name"),
            "institutions": [i.get("display_name") for i in (a.get("institutions") or []) if i.get("display_name")],
        })
    return out


def public_pdf_url(work: dict) -> str | None:
    for loc in (work.get("best_oa_location"), work.get("primary_location")):
        url = (loc or {}).get("pdf_url")
        if url:
            return url
    for loc in work.get("locations") or []:
        url = (loc or {}).get("pdf_url")
        if url:
            return url
    return None


def flag_byte(work: dict) -> int:
    """Per-node filter bits: bit0=suspect, bit1=openAccess, bit2=hasPdf, bit3=hasGrobid."""
    b = 1 if is_suspect(work) else 0
    if (work.get("open_access") or {}).get("is_oa"):
        b |= 2
    if public_pdf_url(work):
        b |= 4
    if (work.get("has_content") or {}).get("grobid_xml"):
        b |= 8
    return b


def is_suspect(work: dict) -> bool:
    """Same citation-anomaly heuristic as the fetch script: single-year spike, impact
    mismatch, or citations predating the publication year (mis-dated old reprint).
    Seeded canonical records (apply_seeds.py) are always trusted."""
    if work.get("seeded"):
        return False
    total = work.get("cited_by_count") or 0
    counts = work.get("counts_by_year") or []
    if total > 1000 and counts:
        top = max((c.get("cited_by_count") or 0) for c in counts)
        if top / total > 0.90:
            return True
    fwci = work.get("fwci")
    if total > 100000 and fwci is not None and fwci < 5:
        return True
    # citations 2+ years before publication_year are impossible; a dominant predated share
    # (>30%) means the record is an old work mis-dated to a recent year (a small leak is a
    # merged-record artifact on a genuine paper, so it's spared).
    py = work.get("publication_year")
    if py and total:
        predated = sum((c.get("cited_by_count") or 0) for c in counts
                       if (c.get("year") is not None and c["year"] < py - 1))
        if predated > 100 and predated / total > 0.30:
            return True
    return False


SIZE_MOMENTUM_YEARS = 3  # trailing window for the "cited now" rate


def size_scores(rows: list[dict], data_year: int,
                suspect: list[bool] | None = None) -> tuple[list[float], dict]:
    """Per-node display size in [0,1], comparable across publication eras.

    Raw citation count sizes nodes by *accumulated* attention, which is mostly a function
    of age -- a 2026 paper can't out-count a 1970 one no matter how important, so it would
    render as a dot. The obvious fix, lifetime velocity (citations/age), is a trap: it
    divides the *lifetime* count by age, so a mis-dated old reprint (e.g. a 1950 classic
    relabeled 2026, age=1) gets an enormous fake rate -- the same failure mode as FWCI.

    The only signal immune to a wrong publication_year is actual recent citation activity
    from counts_by_year: a genuinely-2026 paper cannot have 11k citations with ~0 of them
    in the last two years. So we size by trailing-window *momentum* -- citations per year
    over the last SIZE_MOMENTUM_YEARS -- which is a rate (age-fair across eras), rewards
    work being cited right now, and quietly starves mis-dated reprints and long-dead
    classics. log1p compresses the megahits; min..p99 normalization keeps one citation
    anomaly from flattening the scale. Raw `citations` stays in nodes.bin, so the viz can
    still offer an all-time sizing toggle alongside this current-relevance one.
    """
    d = data_year
    suspect = suspect or [False] * len(rows)
    raws: list[float] = []
    for r in rows:
        counts = r.get("counts_by_year") or []
        recent = sum((x.get("cited_by_count") or 0) for x in counts
                     if d - SIZE_MOMENTUM_YEARS <= (x.get("year") or 0) <= d)
        raws.append(math.log1p(recent / SIZE_MOMENTUM_YEARS))

    # Normalize against the *clean* distribution so one anomaly can't compress the scale;
    # suspects still get a score (clamped into [0,1] like everyone else), just no vote.
    clean = sorted(v for v, s in zip(raws, suspect) if not s) or sorted(raws)
    lo = clean[0]
    p99 = percentile([int(v * 1000) for v in clean], 0.99) / 1000.0
    span = (p99 - lo) or 1.0
    scores = [min(1.0, max(0.0, (v - lo) / span)) for v in raws]
    meta = {
        "model": f"log1p(mean citations/yr over last {SIZE_MOMENTUM_YEARS}y), min..p99 normalized",
        "dataYear": data_year,
        "normalizedOver": "non-suspect nodes only",
        "note": ("size by recent citation momentum (robust to mis-dated years); "
                 "raw citations retained for an all-time sizing toggle"),
    }
    return scores, meta


def percentile(sorted_vals: list[int], q: float) -> int:
    if not sorted_vals:
        return 0
    i = min(len(sorted_vals) - 1, int(q * (len(sorted_vals) - 1)))
    return sorted_vals[i]


def le_bytes(a: "array.array") -> bytes:
    """Little-endian bytes for a typed array, regardless of host byte order."""
    if sys.byteorder == "big":
        a = array.array(a.typecode, a)
        a.byteswap()
    return a.tobytes()


def write_gz(path: str, data: bytes) -> None:
    with open(path, "wb") as f:
        f.write(data)
    with gzip.open(path + ".gz", "wb", compresslevel=9) as f:
        f.write(data)


def sha8(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:8]


# ------------------------------------------------------------------ main

def main() -> int:
    p = argparse.ArgumentParser(description="Build CDN artifacts for the 3D force-graph viz.")
    p.add_argument("--in", dest="inp", default="scripts/data/full/top_cited.jsonl")
    p.add_argument("--out", default="web/public/data/v1")
    p.add_argument("--shard", type=int, default=100, help="Records per detail shard.")
    p.add_argument("--drop-suspect", action="store_true",
                   help="Exclude suspect-flagged records (mis-dated reprints, count "
                        "anomalies, citation-farm spikes) from the built dataset entirely.")
    args = p.parse_args()

    print(f"Loading {args.inp} ...", file=sys.stderr)
    rows = [json.loads(line) for line in open(args.inp, encoding="utf-8")]
    if args.drop_suspect:
        before = len(rows)
        rows = [r for r in rows if not is_suspect(r)]
        print(f"  dropped {before - len(rows)} suspect records ({len(rows)} kept)", file=sys.stderr)
    # Canonical contract: node index = citation rank. The per-year fetch strategy
    # writes year-major order, so always re-sort by citations here.
    rows.sort(key=lambda r: -(r.get("cited_by_count") or 0))
    n = len(rows)
    index = {short_id(r["id"]): i for i, r in enumerate(rows)}
    print(f"  {n} nodes", file=sys.stderr)

    # data_year anchors age/velocity for node sizing; prefer the fetch's recorded year.
    data_year = datetime.datetime.now(datetime.timezone.utc).year
    meta_path = os.path.join(os.path.dirname(args.inp), "run_meta.json")
    if os.path.isfile(meta_path):
        try:
            data_year = json.load(open(meta_path)).get("data_year") or data_year
        except (ValueError, OSError):
            pass

    os.makedirs(args.out, exist_ok=True)
    details_dir = os.path.join(args.out, "details")
    if os.path.isdir(details_dir):
        shutil.rmtree(details_dir)
    os.makedirs(details_dir)

    # --- edges: intra-set, deduped, sorted, columnar Uint16 SoA ---
    edge_set = set()
    for r in rows:
        s = index[short_id(r["id"])]
        for x in r.get("referenced_works") or []:
            t = index.get(short_id(x))
            if t is not None and t != s:
                edge_set.add((s, t))
    edges = sorted(edge_set)
    src = array.array("H", (a for a, _ in edges))
    dst = array.array("H", (b for _, b in edges))
    edges_bin = le_bytes(src) + le_bytes(dst)
    write_gz(os.path.join(args.out, "edges.bin"), edges_bin)
    print(f"  {len(edges)} edges -> edges.bin ({len(edges_bin)//1024} KB)", file=sys.stderr)

    # --- string tables for categorical fields ---
    def table(values):
        uniq = sorted(set(values))
        idx = {v: i for i, v in enumerate(uniq)}
        return uniq, [idx[v] for v in values]

    domains = [((r.get("primary_topic") or {}).get("domain") or {}).get("display_name") or "Unknown" for r in rows]
    fields = [((r.get("primary_topic") or {}).get("field") or {}).get("display_name") or "Unknown" for r in rows]
    topics = [(r.get("primary_topic") or {}).get("display_name") or "" for r in rows]
    domain_table, domain_idx = table(domains)
    field_table, field_idx = table(fields)
    topic_table, topic_idx = table(topics)
    assert len(domain_table) < 256 and len(field_table) < 256, "categorical index exceeds Uint8"

    # --- nodes.bin: SoA numerics ---
    citations = array.array("I", (r.get("cited_by_count") or 0 for r in rows))
    years = array.array("H", (r.get("publication_year") or 0 for r in rows))
    dom = array.array("B", domain_idx)
    fld = array.array("B", field_idx)
    suspect_mask = [is_suspect(r) for r in rows]
    flags = array.array("B", (flag_byte(r) for r in rows))
    scores, size_meta = size_scores(rows, data_year, suspect_mask)
    size = array.array("H", (min(65535, round(s * 65535)) for s in scores))  # [0,1] -> Uint16
    assert citations.itemsize == 4 and years.itemsize == 2 and size.itemsize == 2
    # 2-byte fields (year, sizeScore) precede the 1-byte fields so every Uint16 view lands
    # on an even byte offset for any N (odd N would misalign a trailing Uint16 otherwise).
    nodes_bin = (le_bytes(citations) + le_bytes(years) + le_bytes(size)
                 + le_bytes(dom) + le_bytes(fld) + le_bytes(flags))
    write_gz(os.path.join(args.out, "nodes.bin"), nodes_bin)

    # --- nodes-text.json: title, first author, topic index ---
    nodes_text = {
        "title": [r.get("title") or "" for r in rows],
        "author": [first_author(r) for r in rows],
        "authorsDisplay": [authors_display(r) for r in rows],
        "topicIdx": topic_idx,
        "topicTable": topic_table,
    }
    nt = json.dumps(nodes_text, separators=(",", ":"), ensure_ascii=False).encode()
    write_gz(os.path.join(args.out, "nodes-text.json"), nt)

    # --- search-kw.json: keyword terms, string-table encoded (loaded post-paint) ---
    kw_lists = [[k.get("display_name", "") for k in (r.get("keywords") or [])] for r in rows]
    kw_table, _ = table([x for lst in kw_lists for x in lst])
    kw_pos = {v: i for i, v in enumerate(kw_table)}
    search_kw = {"kwTable": kw_table, "kwIdx": [[kw_pos[x] for x in lst] for lst in kw_lists]}
    sk = json.dumps(search_kw, separators=(",", ":"), ensure_ascii=False).encode()
    write_gz(os.path.join(args.out, "search-kw.json"), sk)

    # --- detail shards ---
    n_shards = (n + args.shard - 1) // args.shard
    details_hasher = hashlib.sha256()  # content hash of all shards -> shard cache-bust token
    for s in range(n_shards):
        chunk = rows[s * args.shard:(s + 1) * args.shard]
        recs = []
        for r in chunk:
            recs.append({
                "id": short_id(r["id"]),
                "title": r.get("title"),
                "year": r.get("publication_year"),
                "type": r.get("type"),
                "cited_by_count": r.get("cited_by_count"),
                "fwci": r.get("fwci"),
                "doi": r.get("doi"),
                "venue": ((r.get("primary_location") or {}).get("source") or {}).get("display_name"),
                "publication_date": r.get("publication_date"),
                "landing_url": (r.get("primary_location") or {}).get("landing_page_url"),
                "pdf_url": public_pdf_url(r),
                "oa_url": (r.get("open_access") or {}).get("oa_url"),
                "grobid_xml_url": (r.get("content_urls") or {}).get("grobid_xml"),
                "abstract": reconstruct_abstract(r.get("abstract_inverted_index")),
                "authors": all_authors(r),
                "topics": [t.get("display_name") for t in (r.get("topics") or [])],
                "keywords": [k.get("display_name") for k in (r.get("keywords") or [])],
                "biblio": r.get("biblio"),
                "seeded": bool(r.get("seeded")),
                "seed_count_source": r.get("seed_count_source"),
            })
        blob = json.dumps(recs, separators=(",", ":"), ensure_ascii=False).encode()
        details_hasher.update(blob)
        write_gz(os.path.join(details_dir, f"shard-{s:03d}.json"), blob)
    details_hash = details_hasher.hexdigest()[:8]
    print(f"  {n_shards} detail shards -> details/", file=sys.stderr)

    # --- citation scale domain (sqrt/log sizing + p95 clamp) ---
    # Computed over non-suspect nodes so a single anomaly (e.g. the 801k record) can't
    # blow out the percentiles the client uses to clamp node size.
    cit_sorted = sorted((r.get("cited_by_count") or 0)
                        for r, s in zip(rows, suspect_mask) if not s) \
        or sorted(r.get("cited_by_count") or 0 for r in rows)
    cit_domain = {
        "min": cit_sorted[0], "p50": percentile(cit_sorted, 0.50),
        "p95": percentile(cit_sorted, 0.95), "p99": percentile(cit_sorted, 0.99),
        "max": cit_sorted[-1],
        "excludesSuspect": True,
    }

    # --- manifest ---
    manifest = {
        "version": "v1",
        "counts": {"nodes": n, "edges": len(edges), "shards": n_shards},
        "shardSize": args.shard,
        "citationDomain": cit_domain,
        "colorLegend": {"domains": domain_table, "fields": field_table},
        "nodesBin": {
            "count": n,
            "layout": [
                {"name": "citations", "type": "Uint32", "offset": 0},
                {"name": "year", "type": "Uint16", "offset": 4 * n},
                {"name": "sizeScore", "type": "Uint16", "offset": 6 * n,
                 "decode": "value/65535 -> [0,1] display size"},
                {"name": "domainIdx", "type": "Uint8", "offset": 8 * n},
                {"name": "fieldIdx", "type": "Uint8", "offset": 9 * n},
                {"name": "flags", "type": "Uint8", "offset": 10 * n},
            ],
            "flags": {"suspect": 1, "openAccess": 2, "hasPdf": 4, "hasGrobid": 8},
        },
        "sizeModel": size_meta,
        "edgesBin": {"count": len(edges), "type": "Uint16", "layout": "src[E] then dst[E]"},
        "positions": {"file": "positions.bin", "type": "Int16", "layout": "x,y,z interleaved",
                      "scale": None, "note": "decode: value/32767*scale; filled by layout_3d.mjs"},
        "files": {
            "nodesBin": "nodes.bin", "nodesText": "nodes-text.json",
            "searchKw": "search-kw.json", "edgesBin": "edges.bin",
            "positions": "positions.bin", "detailsPattern": "details/shard-{shard:03d}.json",
        },
        "hashes": {
            "nodes.bin": sha8(nodes_bin), "nodes-text.json": sha8(nt),
            "search-kw.json": sha8(sk), "edges.bin": sha8(edges_bin),
            "details": details_hash,
        },
    }
    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)

    print(f"Done -> {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
