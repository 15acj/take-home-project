// Server-only. Hybrid (dense vector + BM25) semantic search over the paper
// embeddings in turbopuffer, for the copilot's find_similar_papers tool.
//
// Pipeline: expand the query with Haiku (a couple rephrasings) → embed all
// variants with OpenAI (text-embedding-3-small, matching the ingested vectors)
// → per variant run a vector ANN query and a BM25 query in turbopuffer → fuse
// with Reciprocal Rank Fusion in TS → keep only results whose best cosine
// similarity clears a threshold (drops irrelevant papers) → return the top N
// ranked by fused score.
import type Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { Turbopuffer } from "@turbopuffer/turbopuffer";
import type { SimilarResult } from "./store";

const EMBED_MODEL = "text-embedding-3-small"; // MUST match the corpus embeddings
const EXPAND_MODEL = "claude-haiku-4-5";
const RRF_K = 60;
const CANDIDATES = 40; // top_k per sub-query
// Min cosine similarity (1 - cosine_distance) for a paper to count as relevant.
// text-embedding-3-small puts related papers ~0.35–0.6 and unrelated ones <~0.25.
const SIM_THRESHOLD = 0.35;
const ATTRS = ["rank", "title", "year", "cited_by_count", "field", "doi"];

// turbopuffer rows carry the included attributes dynamically alongside id/$dist.
interface Row {
  id: string | number;
  $dist?: number;
  rank?: number;
  title?: string;
  year?: number;
  cited_by_count?: number;
  field?: string;
  doi?: string;
}

export function similarSearchConfigured(): boolean {
  return Boolean(
    process.env.OPENAI_API_KEY &&
      process.env.TURBOPUFFER_API_KEY &&
      process.env.TURBOPUFFER_REGION &&
      process.env.TURBOPUFFER_NAMESPACE,
  );
}

// Ask Haiku for a couple of alternative phrasings to widen recall. Best-effort:
// any failure (or unparseable output) just yields no extra variants.
async function expandQuery(anthropic: Anthropic, query: string): Promise<string[]> {
  try {
    const msg = await anthropic.messages.create({
      model: EXPAND_MODEL,
      max_tokens: 200,
      system:
        "You rephrase a research-paper search query to widen semantic-search recall. Return ONLY a compact JSON array of exactly 2 alternative phrasings (different wording and synonyms, same intent, suitable for searching academic paper titles and abstracts). No prose, no markdown, no code fences.",
      messages: [{ role: "user", content: query }],
    });
    const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start === -1 || end <= start) return [];
    const arr = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(arr)
      ? arr.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

export async function findSimilarPapers(opts: {
  anthropic: Anthropic;
  query: string;
  limit: number;
  excludeRanks: number[];
}): Promise<SimilarResult[]> {
  const query = opts.query.trim();
  if (!query) return [];
  const limit = Math.max(1, Math.min(5, Math.round(opts.limit || 5)));

  const openaiKey = process.env.OPENAI_API_KEY!;
  const region = process.env.TURBOPUFFER_REGION!;
  const namespace = process.env.TURBOPUFFER_NAMESPACE!;

  // 1. Expand → variant set (original + up to 2 rephrasings).
  const rephrasings = await expandQuery(opts.anthropic, query);
  const variants = Array.from(
    new Set([query, ...rephrasings].map((s) => s.trim()).filter(Boolean)),
  ).slice(0, 3);

  // 2. Embed all variants in one call.
  const openai = new OpenAI({ apiKey: openaiKey });
  const emb = await openai.embeddings.create({ model: EMBED_MODEL, input: variants });
  const vectors = emb.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding as number[]);

  // 3. Hybrid retrieve: vector ANN + BM25 per variant, all in parallel.
  const tpuf = new Turbopuffer({ apiKey: process.env.TURBOPUFFER_API_KEY!, region });
  const ns = tpuf.namespace(namespace);
  const annP = variants.map((_, i) =>
    ns.query({
      rank_by: ["vector", "ANN", vectors[i]] as [string, "ANN", number[]],
      top_k: CANDIDATES,
      include_attributes: ATTRS,
    }),
  );
  const bm25P = variants.map((v) =>
    ns.query({
      rank_by: ["text", "BM25", v] as [string, "BM25", string],
      top_k: CANDIDATES,
      include_attributes: ATTRS,
    }),
  );
  const [annRes, bm25Res] = await Promise.all([Promise.all(annP), Promise.all(bm25P)]);

  // 4. RRF fuse across every list; track best cosine similarity from ANN lists.
  interface Acc { score: number; bestSim: number; row: Row; }
  const byId = new Map<string, Acc>();
  const addList = (rows: Row[], isAnn: boolean) => {
    rows.forEach((row, idx) => {
      const id = String(row.id);
      let acc = byId.get(id);
      if (!acc) { acc = { score: 0, bestSim: -1, row }; byId.set(id, acc); }
      acc.score += 1 / (RRF_K + idx);
      if (isAnn && typeof row.$dist === "number") acc.bestSim = Math.max(acc.bestSim, 1 - row.$dist);
      if (!acc.row.title && row.title) acc.row = row; // prefer a row with attributes
    });
  };
  annRes.forEach((r) => addList(r.rows as unknown as Row[], true));
  bm25Res.forEach((r) => addList(r.rows as unknown as Row[], false));

  // 5. Threshold on the dense signal (drops irrelevant papers and BM25-only
  //    keyword hits), exclude the papers already selected, rank by fused score.
  const exclude = new Set(opts.excludeRanks);
  return [...byId.values()]
    .filter((a) => a.bestSim >= SIM_THRESHOLD && a.row.rank != null && !exclude.has(Number(a.row.rank)))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((a) => ({
      rank: Number(a.row.rank),
      id: String(a.row.id),
      title: String(a.row.title ?? ""),
      year: Number(a.row.year ?? 0),
      cited_by_count: Number(a.row.cited_by_count ?? 0),
      field: String(a.row.field ?? ""),
      doi: a.row.doi ? String(a.row.doi) : null,
      similarity: Math.round(a.bestSim * 100) / 100,
    }));
}
