#!/usr/bin/env python3
"""Transform the raw top-cited JSONL into CDN-optimized artifacts for the 3D graph viz.

Produces (into --out):
  manifest.json      metadata: counts, citation scale domain, color legends, byte offsets
  nodes.bin          SoA binary: Uint32 citations[N], Uint16 year[N],
                     Uint8 domainIdx[N], Uint8 fieldIdx[N], Uint8 flags[N] (bit0=suspect)
  nodes-text.json    title[], author[](first), topicIdx[] + topicTable[]  (string-table encoded)
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
import gzip
import hashlib
import json
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


def is_suspect(work: dict) -> bool:
    """Same citation-anomaly heuristic as the fetch script: single-year spike + impact mismatch."""
    total = work.get("cited_by_count") or 0
    counts = work.get("counts_by_year") or []
    if total > 1000 and counts:
        top = max((c.get("cited_by_count") or 0) for c in counts)
        if top / total > 0.90:
            return True
    fwci = work.get("fwci")
    return total > 100000 and fwci is not None and fwci < 5


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
    args = p.parse_args()

    print(f"Loading {args.inp} ...", file=sys.stderr)
    rows = [json.loads(line) for line in open(args.inp, encoding="utf-8")]
    n = len(rows)
    index = {short_id(r["id"]): i for i, r in enumerate(rows)}
    print(f"  {n} nodes", file=sys.stderr)

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
    flags = array.array("B", (1 if is_suspect(r) else 0 for r in rows))
    assert citations.itemsize == 4 and years.itemsize == 2
    nodes_bin = le_bytes(citations) + le_bytes(years) + le_bytes(dom) + le_bytes(fld) + le_bytes(flags)
    write_gz(os.path.join(args.out, "nodes.bin"), nodes_bin)

    # --- nodes-text.json: title, first author, topic index ---
    nodes_text = {
        "title": [r.get("title") or "" for r in rows],
        "author": [first_author(r) for r in rows],
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
                "landing_url": (r.get("primary_location") or {}).get("landing_page_url"),
                "pdf_url": public_pdf_url(r),
                "oa_url": (r.get("open_access") or {}).get("oa_url"),
                "grobid_xml_url": (r.get("content_urls") or {}).get("grobid_xml"),
                "abstract": reconstruct_abstract(r.get("abstract_inverted_index")),
                "authors": all_authors(r),
                "topics": [t.get("display_name") for t in (r.get("topics") or [])],
                "keywords": [k.get("display_name") for k in (r.get("keywords") or [])],
                "biblio": r.get("biblio"),
            })
        blob = json.dumps(recs, separators=(",", ":"), ensure_ascii=False).encode()
        write_gz(os.path.join(details_dir, f"shard-{s:03d}.json"), blob)
    print(f"  {n_shards} detail shards -> details/", file=sys.stderr)

    # --- citation scale domain (sqrt/log sizing + p95 clamp for the anomaly) ---
    cit_sorted = sorted(r.get("cited_by_count") or 0 for r in rows)
    cit_domain = {
        "min": cit_sorted[0], "p50": percentile(cit_sorted, 0.50),
        "p95": percentile(cit_sorted, 0.95), "p99": percentile(cit_sorted, 0.99),
        "max": cit_sorted[-1],
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
                {"name": "domainIdx", "type": "Uint8", "offset": 6 * n},
                {"name": "fieldIdx", "type": "Uint8", "offset": 7 * n},
                {"name": "flags", "type": "Uint8", "offset": 8 * n},
            ],
            "flags": {"suspect": 1},
        },
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
        },
    }
    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)

    print(f"Done -> {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
