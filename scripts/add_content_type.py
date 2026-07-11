#!/usr/bin/env python3
"""One-off: add typeIdx/typeTable (raw OpenAlex work type per node) to an already-built
nodes-text.json, without re-running the full pipeline.

The canonical source is build_graph_data.py (which now emits these fields on every build).
This patch exists so the *currently shipped* artifacts gain the field without regenerating
nodes.bin / positions.bin / the layout scale — i.e. without disturbing the 3D layout.

Node order == citation rank. The detail shards are written in that exact order (shard s =
rows[s*shardSize:(s+1)*shardSize]) and carry each record's `type`, so concatenating them in
order yields the per-node type aligned to nodes-text.json. Only nodes-text.json and the
manifest's hash for it change; every other file (and its hash) is left untouched.

Usage: python3 scripts/add_content_type.py [--out web/public/data/v1]
Then regenerate the .gz/.br sidecars: node scripts/compress_br.mjs
"""
import argparse
import hashlib
import json
import os
import sys


def table(values):
    uniq = sorted(set(values))
    idx = {v: i for i, v in enumerate(uniq)}
    return uniq, [idx[v] for v in values]


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", default="web/public/data/v1")
    args = p.parse_args()

    manifest_path = os.path.join(args.out, "manifest.json")
    with open(manifest_path, encoding="utf-8") as f:
        manifest = json.load(f)

    n = manifest["counts"]["nodes"]
    n_shards = manifest["counts"]["shards"]

    # Reassemble per-node type from the detail shards, in node order.
    types = []
    for s in range(n_shards):
        shard_path = os.path.join(args.out, "details", f"shard-{s:03d}.json")
        with open(shard_path, encoding="utf-8") as f:
            recs = json.load(f)
        types.extend((r.get("type") or "unknown") for r in recs)

    if len(types) != n:
        print(f"ERROR: reassembled {len(types)} types but manifest expects {n} nodes",
              file=sys.stderr)
        return 1

    type_table, type_idx = table(types)
    assert len(type_table) < 256, "type index exceeds Uint8"

    text_path = os.path.join(args.out, "nodes-text.json")
    with open(text_path, encoding="utf-8") as f:
        nodes_text = json.load(f)
    if len(nodes_text["title"]) != n:
        print("ERROR: nodes-text.json length does not match node count", file=sys.stderr)
        return 1

    nodes_text["typeIdx"] = type_idx
    nodes_text["typeTable"] = type_table

    nt = json.dumps(nodes_text, separators=(",", ":"), ensure_ascii=False).encode()
    with open(text_path, "wb") as f:
        f.write(nt)

    manifest["hashes"]["nodes-text.json"] = hashlib.sha256(nt).hexdigest()[:8]
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)

    dist = {t: types.count(t) for t in type_table}
    print(f"Added type to {n} nodes. Raw types ({len(type_table)}):", file=sys.stderr)
    for t, c in sorted(dist.items(), key=lambda kv: -kv[1]):
        print(f"  {c:6d}  {t}", file=sys.stderr)
    print(f"New nodes-text.json hash: {manifest['hashes']['nodes-text.json']}", file=sys.stderr)
    print("Now run: node scripts/compress_br.mjs", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
