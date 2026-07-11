# Graph viz data pipeline

Turns the raw top-cited pull into CDN-optimized artifacts for the 3D force-directed graph.

## Build

```bash
# 1. transform JSONL -> artifacts (Python stdlib only)
python3 scripts/build_graph_data.py \
  --in scripts/data/full/top_cited.jsonl --out web/public/data/v1 [--shard 100]

# 2. precompute the 3D layout (Node; installs d3-force-3d)
cd scripts && npm install && cd ..
node scripts/layout_3d.mjs --out web/public/data/v1 [--ticks 300]

# 3. verify end-to-end
node scripts/verify_graph_data.mjs --out web/public/data/v1

# 4. (optional) also emit Brotli sidecars + print a gz-vs-br size table
node scripts/compress_br.mjs --out web/public/data/v1 [--quality 11]
```

Output: `web/public/data/v1/` — each artifact has a `.gz` sidecar (always) and a `.br` sidecar
(after step 4). Brotli q11 runs ~20% smaller than gzip here (first-paint set 527 → 419 KB); it's
noise-like on `positions.bin` (Int16-quantized), so gzip is fine there. Serve static `.br` where
you can't rely on CDN on-the-fly Brotli; otherwise `.gz` + CDN Brotli suffices.

## Artifact schema

**Node index `0..N-1` (citation-rank order) is the canonical key** — `nodes.bin`, `nodes-text.json`,
`positions.bin`, `search-kw.json`, and detail shards are all aligned to it; edges reference it.

| File | Format | Purpose | ~gz |
|---|---|---|---|
| `manifest.json` | JSON | counts, offsets, citation domain, color legends, position scale | 1 KB |
| `nodes.bin` | binary SoA | `Uint32 citations[N]`, `Uint16 year[N]`, `Uint8 domainIdx/fieldIdx/flags[N]` (`flags` bit0 = suspect). Byte offsets in `manifest.nodesBin.layout` | 30 KB |
| `nodes-text.json` | JSON | `title[]`, `author[]` (first), `topicIdx[]` + `topicTable[]` | 366 KB |
| `positions.bin` | `Int16[N*3]` | x,y,z interleaved; decode `value/32767*manifest.positions.scale` | 58 KB |
| `edges.bin` | `Uint16` SoA | `src[E]` then `dst[E]`, sorted & deduped (N<65536) | 70 KB |
| `search-kw.json` | JSON | `kwIdx[][]` + `kwTable[]`; **load after first paint** | 303 KB |
| `details/shard-NNN.json` | JSON | Tier-2: abstract, urls, all authors+institutions, topics, keywords, biblio. `SHARD` records each | ~58 KB ea |

First-paint set = `manifest + nodes.bin + nodes-text.json + edges.bin + positions.bin` ≈ **525 KB gz**.

## Client loader (reference)

```js
const M = await (await fetch("data/v1/manifest.json")).json();
const N = M.counts.nodes, E = M.counts.edges;
const bin = async (f) => (await (await fetch(`data/v1/${f}`)).arrayBuffer());

const nb = await bin("nodes.bin"), o = Object.fromEntries(M.nodesBin.layout.map(l => [l.name, l.offset]));
const citations = new Uint32Array(nb, o.citations, N);
const domainIdx = new Uint8Array(nb, o.domainIdx, N);

const eb = await bin("edges.bin");
const src = new Uint16Array(eb, 0, E), dst = new Uint16Array(eb, E*2, E);

const pb = await bin("positions.bin"), P = new Int16Array(pb, 0, N*3), s = M.positions.scale;
const T = await (await fetch("data/v1/nodes-text.json")).json();

const nodes = Array.from({length:N}, (_,i) => ({
  id:i, val:citations[i], color: M.colorLegend.domains[domainIdx[i]],
  fx:(P[i*3]/32767)*s, fy:(P[i*3+1]/32767)*s, fz:(P[i*3+2]/32767)*s,   // frozen precomputed layout
}));
const links = Array.from({length:E}, (_,i) => ({ source:src[i], target:dst[i] }));
// react-force-graph-3d: <ForceGraph3D graphData={{nodes,links}} cooldownTicks={0}
//   nodeVal={n => Math.sqrt(Math.min(n.val, M.citationDomain.p99))}   // sqrt + p99 clamp
//   nodeLabel={n => T.title[n.id]} onNodeClick={n => fetchShard(Math.floor(n.id / M.shardSize))}
```

Search: build an in-memory lowercased index from `T.title` + `T.author` (+ `topicTable`) at load
(instant substring over 10k); fold in `search-kw.json` once it arrives. Matches drive
`nodeVisibility`.

## CDN notes

- Serve `.gz` with `Content-Encoding: gzip` (let the CDN add Brotli on the fly); `.bin` as
  `application/octet-stream`.
- Version via the `v1/` path; `manifest.json` short TTL, everything under it long/immutable.
  Per-file `manifest.hashes` can drive `?v=<hash>` cache-busting if you keep filenames stable.
