# Research Atlas

An interactive 3D map of the ~10,000 most-cited papers in science. Each paper is a
node placed in space by its research field; citations between papers are the edges.
You can fly through the cloud, filter it, search it, and ask an AI copilot questions
about the papers you've selected.

Data comes from the [OpenAlex](https://openalex.org) API. The layout, node sizes, and
edges are all precomputed offline into compact binary artifacts, so the client renders
the full graph with zero layout cost.

**Live app:** https://take-home-project-nine.vercel.app/

## Key functionality

- **3D force-directed graph** — 10k nodes / edges rendered on a custom WebGL engine,
  positioned by an offline field-clustered layout (8 visual clusters over OpenAlex's
  27 fields). Fly-through camera, hover cards, click-to-inspect.
- **Filtering** — by field, content type (article / book / review / other), year range,
  citation count, open-access availability, and top-N cutoff.
- **Search** — instant lexical search over titles/authors/topics, backed by a keyword
  index; plus semantic hybrid search (dense vectors + BM25) via turbopuffer.
- **AI Copilot** — a chat panel (Claude Haiku 4.5) that answers questions over the
  papers you've selected. It streams answers and can drive the UI through tool calls:
  set/reset filters from natural language, find similar papers, locate a specific
  paper, and pull a paper's full text (via OpenAlex GROBID) as extra context.

## Repository layout

```
scripts/    Data pipeline — fetch from OpenAlex, clean, layout, and build web artifacts
web/        The Next.js frontend (the deployed app)
design/     Original design prototype the frontend is a 1:1 port of
claude-code-transcripts/   Claude Code session logs from building the project
```

### `scripts/` — data pipeline

Turns a raw OpenAlex pull into the CDN-optimized artifacts the frontend loads. See
[`scripts/README-graph-data.md`](scripts/README-graph-data.md) for the full artifact
schema and build steps.

- `fetch_top_cited.py` — pulls the top-N most-cited works from OpenAlex (stdlib only).
- `explore_data.py` — coverage/distribution stats over the raw pull.
- `build_graph_data.py` — transforms the JSONL into binary artifacts (`nodes.bin`,
  `edges.bin`, `nodes-text.json`, detail shards, manifest).
- `layout_clustered.mjs` — precomputes the field-clustered 3D layout → `positions.bin`.
- `verify_graph_data.mjs` / `compress_br.mjs` — verify artifacts, emit Brotli sidecars.
- `embed_turbopuffer.py` — embeds titles+abstracts into turbopuffer for hybrid search.
- `add_content_type.py`, `apply_seeds.py`, `seeds.json` — surgical artifact patches.

Pipeline order after data/mapping changes:
`build_graph_data.py` → `layout_clustered.mjs` → `verify_graph_data.mjs` → `compress_br.mjs`
(all take `--out web/public/data/v1`).

### `web/` — frontend

Next.js (pages router) + React + zustand, deployed on Vercel.

- `pages/index.tsx` — the app; `pages/api/copilot.ts` — streaming Copilot backend.
- `components/` — `CitationAtlas` (the graph), `FilterPanel`, `CopilotPanel`,
  `Legend`, `HoverCard`, `StatsBar`, etc.
- `lib/` — `force3d.js` (render engine), `loaders.ts` (artifact decoding), `store.ts`
  (zustand state), `filter.ts`, `similar.ts` (hybrid search), `fulltext.ts`,
  `field-clusters.json` (the load-bearing field→cluster mapping), `themes.ts`.
- `public/data/v1/` — the built graph artifacts served to the client.

### `design/` — prototype

The original Claude-generated design prototype. The `web/` frontend is a faithful
port of this; `web/lib/force3d.js` is the design's engine, and styling mirrors it via
inline theme tokens for visual fidelity.

## Running locally

**Frontend**
```bash
cd web
yarn install
yarn dev        # http://localhost:3000
```
The Copilot route needs `ANTHROPIC_API_KEY` (and turbopuffer/OpenAI keys for hybrid
search) in `web/.env.local`.

**Data pipeline**
```bash
pip install -r scripts/requirements.txt   # only for embeddings; the core build is stdlib-only
# then follow scripts/README-graph-data.md
```
Credentials for the pipeline (OpenAI, turbopuffer) live in `scripts/.env`.

> **Note:** Credential files (`web/.env.local`, `scripts/.env`) are gitignored and
> **not committed** — create them locally with your own API keys.
