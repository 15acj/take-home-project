#!/usr/bin/env python3
"""Embed the top-cited papers into turbopuffer for hybrid (vector + BM25) search.

Reads the raw top-cited JSONL, reconstructs each abstract from OpenAlex's
`abstract_inverted_index`, embeds `title + abstract` with OpenAI, and upserts the
vectors plus metadata into a turbopuffer namespace with full-text search enabled on the
text attribute (so the app can run true hybrid retrieval: dense ANN + BM25 with RRF).

Canonical key: the raw JSONL is written in year-major order, so we re-sort by
`cited_by_count` desc here. The resulting index `0..N-1` == citation rank == the graph
node index used across every built artifact (nodes.bin / details / positions.bin). We
store that as the `rank` attribute so vector hits line up with the graph.

Unlike the stdlib-only build pipeline, this one-off ingestion tool uses the official
`openai` and `turbopuffer` SDKs. Install with: pip install -r scripts/requirements.txt

Credentials come from scripts/.env (see .env.example): OPENAI_API_KEY, TURBOPUFFER_API_KEY,
TURBOPUFFER_REGION, TURBOPUFFER_NAMESPACE.

Examples:
  python3 scripts/embed_turbopuffer.py --dry-run --limit 3      # build texts, no API calls
  python3 scripts/embed_turbopuffer.py --limit 20               # small real ingest
  python3 scripts/embed_turbopuffer.py --query "protein folding" --limit 0   # hybrid smoke test
  python3 scripts/embed_turbopuffer.py                          # full run (~9,874 rows)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

DEFAULT_JSONL = "data/full/top_cited.jsonl"
DEFAULT_MODEL = "text-embedding-3-small"  # 1536 dims
DEFAULT_LIMIT = 10000
DEFAULT_BATCH = 256
# OpenAI embedding inputs cap at 8191 tokens; ~4 chars/token, keep a safety margin.
MAX_EMBED_CHARS = 8000 * 4

# ------------------------------------------------------------------ helpers

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


def _nested_name(work: dict, key: str) -> str:
    """primary_topic.<key>.display_name, or ''."""
    node = (work.get("primary_topic") or {}).get(key) or {}
    return node.get("display_name") or ""


def build_embed_text(work: dict) -> str:
    """title + reconstructed abstract (title-only when no abstract), length-capped."""
    title = (work.get("title") or "").strip()
    abstract = reconstruct_abstract(work.get("abstract_inverted_index")) or ""
    text = f"{title}\n\n{abstract}".strip() if abstract else title
    return text[:MAX_EMBED_CHARS]


def load_rows(jsonl_path: str, limit: int) -> list[dict]:
    """Read the JSONL, sort by cited_by_count desc (canonical rank), take top `limit`."""
    rows: list[dict] = []
    with open(jsonl_path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    # Canonical contract: index == citation rank. Match build_graph_data.py.
    rows.sort(key=lambda r: -(r.get("cited_by_count") or 0))
    if limit and limit > 0:
        rows = rows[:limit]
    return rows


def build_record(rank: int, work: dict) -> dict:
    """turbopuffer upsert row (minus the vector, which is filled in after embedding)."""
    text = build_embed_text(work)
    return {
        "id": short_id(work["id"]),
        "_text": text,  # popped before upsert; used as embed input + BM25 attribute
        "rank": rank,
        "title": (work.get("title") or ""),
        "year": work.get("publication_year") or 0,
        "cited_by_count": work.get("cited_by_count") or 0,
        "field": _nested_name(work, "field"),
        "domain": _nested_name(work, "domain"),
        "doi": work.get("doi") or "",
    }


def chunked(seq: list, n: int):
    for i in range(0, len(seq), n):
        yield seq[i : i + n]


# ------------------------------------------------------------------ clients

def openai_client():
    from openai import OpenAI

    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        sys.exit("OPENAI_API_KEY is not set (scripts/.env or environment).")
    return OpenAI(api_key=key)


def turbopuffer_namespace(namespace: str):
    import turbopuffer

    key = os.environ.get("TURBOPUFFER_API_KEY")
    region = os.environ.get("TURBOPUFFER_REGION")
    if not key or not region:
        sys.exit("TURBOPUFFER_API_KEY and TURBOPUFFER_REGION must be set (scripts/.env).")
    client = turbopuffer.Turbopuffer(api_key=key, region=region)
    return client.namespace(namespace)


def embed_texts(client, model: str, texts: list[str]) -> list[list[float]]:
    resp = client.embeddings.create(model=model, input=texts)
    # Preserve input order; the API returns items with an `index` field.
    items = sorted(resp.data, key=lambda d: d.index)
    return [it.embedding for it in items]


# ------------------------------------------------------------------ commands

def cmd_ingest(args, records: list[dict]) -> None:
    client = openai_client()
    ns = turbopuffer_namespace(args.namespace)
    schema = {"text": {"type": "string", "full_text_search": True}}

    total = len(records)
    done = 0
    t0 = time.time()
    approx_chars = 0
    for batch in chunked(records, args.batch_size):
        texts = [r["_text"] for r in batch]
        approx_chars += sum(len(t) for t in texts)
        vectors = embed_texts(client, args.model, texts)

        upsert_rows = []
        for r, vec in zip(batch, vectors):
            row = {k: v for k, v in r.items() if k != "_text"}
            row["vector"] = vec
            row["text"] = r["_text"]  # indexed for BM25 (hybrid)
            upsert_rows.append(row)

        ns.write(
            upsert_rows=upsert_rows,
            distance_metric="cosine_distance",
            schema=schema,
        )
        done += len(batch)
        print(f"  upserted {done}/{total}  ({time.time() - t0:.1f}s)", flush=True)

    est_tokens = approx_chars / 4
    # text-embedding-3-small: $0.02 / 1M tokens
    est_cost = est_tokens / 1_000_000 * 0.02
    print(
        f"Done: {done} rows into namespace '{args.namespace}' "
        f"(~{est_tokens/1e6:.2f}M tokens, ~${est_cost:.4f}) in {time.time() - t0:.1f}s"
    )


QUERY_ATTRS = ["title", "year", "cited_by_count", "rank", "field"]


def cmd_query(args) -> None:
    ns = turbopuffer_namespace(args.namespace)
    top_k = args.top_k
    mode = args.mode

    if mode == "bm25":
        # Keyword / full-text only (no embedding needed).
        resp = ns.query(
            rank_by=("text", "BM25", args.query),
            top_k=top_k,
            include_attributes=QUERY_ATTRS,
        )
        rows = resp.rows
        label = "BM25 (keyword / full-text)"
    elif mode == "vector":
        # Dense-embedding ANN only (a.k.a. semantic / vector search).
        qvec = embed_texts(openai_client(), args.model, [args.query])[0]
        resp = ns.query(
            rank_by=("vector", "ANN", qvec),
            top_k=top_k,
            include_attributes=QUERY_ATTRS,
        )
        rows = resp.rows
        label = "Vector / semantic (ANN)"
    else:  # hybrid
        qvec = embed_texts(openai_client(), args.model, [args.query])[0]
        resp = ns.multi_query(
            queries=[
                {"rank_by": ("vector", "ANN", qvec), "top_k": top_k,
                 "include_attributes": QUERY_ATTRS},
                {"rank_by": ("text", "BM25", args.query), "top_k": top_k,
                 "include_attributes": QUERY_ATTRS},
            ],
            rerank_by=("RRF",),
        )
        rows = resp.results[0].rows
        label = "Hybrid (vector + BM25, RRF)"

    print(f"{label} results for: {args.query!r}\n")
    for i, row in enumerate(rows, 1):
        title = getattr(row, "title", "") or ""
        year = getattr(row, "year", "")
        cites = getattr(row, "cited_by_count", "")
        rank = getattr(row, "rank", "")
        field = getattr(row, "field", "") or ""
        print(f"{i:2}. [{row.id}] rank={rank} {year} · {cites} cites · {field}")
        print(f"    {title}")


def cmd_dry_run(records: list[dict], sample: int) -> None:
    print(f"Prepared {len(records)} records (sorted by cited_by_count desc). Sample:\n")
    for r in records[:sample]:
        text = r["_text"]
        preview = text[:300].replace("\n", " ")
        print(f"rank={r['rank']} id={r['id']} cites={r['cited_by_count']} "
              f"field={r['field']!r} domain={r['domain']!r}")
        print(f"  embed_text[{len(text)} chars]: {preview}...")
        print()


# ------------------------------------------------------------------ main

def main() -> None:
    load_env_files()
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--jsonl", default=DEFAULT_JSONL,
                   help=f"input JSONL (default: {DEFAULT_JSONL}, relative to scripts/)")
    p.add_argument("--limit", type=int, default=DEFAULT_LIMIT,
                   help=f"max papers to embed, top-cited first (default: {DEFAULT_LIMIT}; 0 = all)")
    p.add_argument("--batch-size", type=int, default=DEFAULT_BATCH,
                   help=f"embed+upsert batch size (default: {DEFAULT_BATCH})")
    p.add_argument("--model", default=DEFAULT_MODEL,
                   help=f"OpenAI embedding model (default: {DEFAULT_MODEL})")
    p.add_argument("--namespace", default=os.environ.get("TURBOPUFFER_NAMESPACE"),
                   help="turbopuffer namespace (default: $TURBOPUFFER_NAMESPACE)")
    p.add_argument("--dry-run", action="store_true",
                   help="build embed texts and print a sample; no API calls")
    p.add_argument("--query", default=None,
                   help="query-only mode: run a search and print top hits (no ingest)")
    p.add_argument("--mode", choices=["vector", "bm25", "hybrid"], default="hybrid",
                   help="search mode for --query: vector/semantic (ANN), bm25 (keyword), "
                        "or hybrid (both, RRF). Default: hybrid")
    p.add_argument("--top-k", type=int, default=10, help="results to show in --query mode")
    args = p.parse_args()

    # Resolve --jsonl relative to the scripts/ dir so the default works from anywhere.
    if not os.path.isabs(args.jsonl):
        args.jsonl = os.path.join(os.path.dirname(os.path.abspath(__file__)), args.jsonl)

    if args.query:
        if not args.namespace:
            sys.exit("--namespace or $TURBOPUFFER_NAMESPACE is required for --query mode.")
        cmd_query(args)
        return

    if not args.namespace and not args.dry_run:
        sys.exit("--namespace or $TURBOPUFFER_NAMESPACE is required for ingest.")

    works = load_rows(args.jsonl, args.limit)
    records = [build_record(i, w) for i, w in enumerate(works)]

    if args.dry_run:
        cmd_dry_run(records, sample=min(3, len(records)))
        return

    cmd_ingest(args, records)


if __name__ == "__main__":
    main()
