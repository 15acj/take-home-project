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

// --- find_specific_paper (one known paper by title, hybrid fallback) knobs ---
const TITLE_CANDIDATES = 20; // BM25 top_k per variant when locating a specific paper
// A candidate counts as a confident title match when the query's terms are almost
// entirely present in the candidate title. Recall drives the score; DICE_FLOOR
// guards against a short query coincidentally matching a long, unrelated title.
const TITLE_MATCH_THRESHOLD = 0.8;
const DICE_FLOOR = 0.34;
const MIN_QUERY_TOKENS = 3; // below this, "find the exact paper" is too ambiguous — use hybrid

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

// Ask Haiku for a couple of *likely exact titles* for the paper the user is
// naming/describing. Widens BM25 recall so a description ("the deep residual
// learning paper") can still surface the literal title. Best-effort like above.
async function expandTitleQuery(anthropic: Anthropic, query: string): Promise<string[]> {
  try {
    const msg = await anthropic.messages.create({
      model: EXPAND_MODEL,
      max_tokens: 200,
      system:
        "The user is trying to name ONE specific academic paper (by its title, a partial title, or a short description). Return ONLY a compact JSON array of exactly 2 strings: your best guesses at the paper's EXACT published title (or very close phrasings). No prose, no markdown, no code fences.",
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

// Normalize a string to lowercase alphanumeric word tokens (punctuation → spaces).
// Stopwords are intentionally kept: many real titles are stopword-dominated
// ("Attention Is All You Need"), so dropping them would wreck the overlap.
function titleTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

// How well `title` matches `query`: the fraction of the query's distinct tokens
// present in the title (recall), so a partial title still matches the full one.
// Returns 0 when the Dice coefficient is below a floor, which stops a very short
// query from scoring high against a long, mostly-unrelated title.
function titleSimilarity(query: string, title: string): number {
  const q = new Set(titleTokens(query));
  const t = new Set(titleTokens(title));
  if (!q.size || !t.size) return 0;
  let inter = 0;
  for (const w of q) if (t.has(w)) inter++;
  const recall = inter / q.size;
  const dice = (2 * inter) / (q.size + t.size);
  return dice >= DICE_FLOOR ? recall : 0;
}

function rowToResult(row: Row, similarity: number): SimilarResult {
  return {
    rank: Number(row.rank),
    id: String(row.id),
    title: String(row.title ?? ""),
    year: Number(row.year ?? 0),
    cited_by_count: Number(row.cited_by_count ?? 0),
    field: String(row.field ?? ""),
    doi: row.doi ? String(row.doi) : null,
    similarity: Math.round(similarity * 100) / 100,
  };
}

// Locate ONE specific paper the user named or described. Tries a title match
// first (BM25 recall over the corpus + a title-string-similarity gate); if no
// candidate is close enough, falls back to the hybrid semantic search and
// returns its single best guess. `matchType` lets the UI label the result
// ("Title match" vs "Closest match").
export async function findSpecificPaper(opts: {
  anthropic: Anthropic;
  query: string;
  excludeRanks: number[];
}): Promise<{ paper: SimilarResult | null; matchType: "title" | "search" }> {
  const query = opts.query.trim();
  if (!query) return { paper: null, matchType: "search" };

  // 1. Expand → variant set (original + up to 2 likely-exact-title rephrasings).
  const rephrasings = await expandTitleQuery(opts.anthropic, query);
  const variants = Array.from(
    new Set([query, ...rephrasings].map((s) => s.trim()).filter(Boolean)),
  ).slice(0, 3);

  // 2. BM25 retrieve per variant (title lives inside the FTS-indexed `text`).
  const region = process.env.TURBOPUFFER_REGION!;
  const namespace = process.env.TURBOPUFFER_NAMESPACE!;
  const tpuf = new Turbopuffer({ apiKey: process.env.TURBOPUFFER_API_KEY!, region });
  const ns = tpuf.namespace(namespace);
  const bm25Res = await Promise.all(
    variants.map((v) =>
      ns.query({
        rank_by: ["text", "BM25", v] as [string, "BM25", string],
        top_k: TITLE_CANDIDATES,
        include_attributes: ATTRS,
      }),
    ),
  );

  // 3. Pool candidates by id, preferring a row that carries the title attribute.
  const byId = new Map<string, Row>();
  for (const r of bm25Res) {
    for (const row of r.rows as unknown as Row[]) {
      const id = String(row.id);
      const existing = byId.get(id);
      if (!existing || (!existing.title && row.title)) byId.set(id, row);
    }
  }

  // 4. Title-similarity gate: score each candidate as the best match across all
  //    variants, so a rephrased exact title can win even if the raw query was a
  //    loose description.
  let best: { row: Row; score: number } | null = null;
  for (const row of byId.values()) {
    if (row.rank == null || !row.title) continue;
    let score = 0;
    for (const v of variants) score = Math.max(score, titleSimilarity(v, String(row.title)));
    if (!best || score > best.score) best = { row, score };
  }

  const enoughTokens = variants.some((v) => titleTokens(v).length >= MIN_QUERY_TOKENS);
  if (best && enoughTokens && best.score >= TITLE_MATCH_THRESHOLD) {
    return { paper: rowToResult(best.row, best.score), matchType: "title" };
  }

  // 5. No close title match → hybrid search, single best guess. We don't exclude
  //    already-selected papers: re-locating and re-focusing one is valid, and the
  //    client's "add" step skips anything already in the selection.
  const hits = await findSimilarPapers({
    anthropic: opts.anthropic,
    query,
    limit: 1,
    excludeRanks: [],
  });
  return { paper: hits[0] ?? null, matchType: "search" };
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
