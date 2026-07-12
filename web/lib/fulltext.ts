// Server-only. Fetches and parses a paper's FULL text from OpenAlex's GROBID
// store, on demand, for the copilot's fetch_full_text tool.
//
// OpenAlex serves GROBID/TEI XML at content.openalex.org/works/<W…>.grobid-xml.
// That endpoint (a) requires an API key, (b) 302-redirects to a signed Cloudflare
// R2 object, and (c) returns the TEI **gzip-compressed** (Content-Type
// binary/octet-stream). So we follow redirects, gunzip when we see the gzip magic
// bytes, then convert the TEI into plain text the model can read.
//
// Cost is bounded by the same per-paper / total character budgets the abstract
// path uses (lib/limits.ts): full papers can be hundreds of KB, so each body is
// capped and the running total is capped, mirroring budgetBodies() in copilot.ts.
import { gunzipSync } from "node:zlib";
import { PER_PAPER_CONTEXT_CHARS, TOTAL_CONTEXT_CHARS } from "./limits";

// Only ever dereference URLs on this host. The grobid_xml_url arrives in the
// request body (client-assembled from the detail shard), and the model supplies
// only paper indices — never a URL — but we still validate the host as an SSRF
// guard against a crafted client.
const CONTENT_PREFIX = "https://content.openalex.org/works/";
const FETCH_TIMEOUT_MS = 20_000;

// The subset of PaperContext this module needs. Kept structural so copilot.ts can
// pass its own PaperContext objects without a shared import cycle.
export interface FullTextPaper {
  title: string | null;
  grobid_xml_url: string | null;
}

export function fullTextConfigured(): boolean {
  return Boolean(process.env.OPENALEX_API_KEY);
}

// --- TEI → plain text -------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    const rep = ENTITIES[body.toLowerCase()];
    return rep ?? m;
  });
}

// Convert GROBID TEI into readable running text: keep section headings and
// figure/table captions (they matter for "what does Figure 2 show" questions),
// drop the header metadata and the back-matter reference list (pure noise that
// would eat the budget). Case-insensitive throughout — the live feed is
// proper-cased TEI but a cached copy may be lowercased HTML-wrapped.
export function teiToText(xml: string): string {
  let s = xml;
  // 1. Drop bibliographic header + back matter (references / bibliography).
  s = s.replace(/<teiheader\b[^>]*>[\s\S]*?<\/teiheader>/gi, " ");
  s = s.replace(/<back\b[^>]*>[\s\S]*?<\/back>/gi, " ");
  s = s.replace(/<listbibl\b[^>]*>[\s\S]*?<\/listbibl>/gi, " ");
  // 2. Turn structure into text markers before stripping tags.
  s = s.replace(/<head\b[^>]*>([\s\S]*?)<\/head>/gi, (_m, h) => `\n\n## ${h}\n`);
  s = s.replace(/<figdesc\b[^>]*>([\s\S]*?)<\/figdesc>/gi, (_m, c) => `\n[Figure/Table: ${c}]\n`);
  s = s.replace(/<\/p\s*>/gi, "\n\n");
  s = s.replace(/<\/div\s*>/gi, "\n");
  // 3. Strip all remaining tags, decode entities, normalize whitespace.
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v]+/g, " ");
  s = s.replace(/ *\n */g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

// --- fetch ------------------------------------------------------------------

// Fetch the raw GROBID XML for one URL: append the API key, follow the redirect
// to R2, and gunzip the body when it's gzip-compressed. Throws on non-2xx or
// timeout so the caller can note the failure per paper.
async function fetchGrobidXml(url: string): Promise<string> {
  const key = process.env.OPENALEX_API_KEY!;
  const sep = url.includes("?") ? "&" : "?";
  const withKey = `${url}${sep}api_key=${encodeURIComponent(key)}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(withKey, { redirect: "follow", signal: ctrl.signal });
    if (!res.ok) throw new Error(`grobid fetch ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // gzip magic bytes 0x1f 0x8b — the R2 objects are stored gzipped and served
    // without a Content-Encoding header, so we decompress explicitly.
    const bytes = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf;
    return bytes.toString("utf-8");
  } finally {
    clearTimeout(timer);
  }
}

// Resolve the model's chosen 1-based paper indices against the selected papers,
// fetch + parse full text for those that have it, and assemble one budgeted
// tool_result string. Returns text suitable to hand straight back to the model.
export async function fetchFullTextForPapers(
  input: { papers?: unknown },
  papers: FullTextPaper[],
): Promise<string> {
  if (!fullTextConfigured()) {
    return "Full-text retrieval isn't configured on the server (OPENALEX_API_KEY missing). Answer from the abstract instead.";
  }

  // Normalize + de-dupe the requested indices; keep only in-range papers that
  // actually have a valid OpenAlex content URL.
  const raw = Array.isArray(input?.papers) ? input.papers : [];
  const wanted = Array.from(
    new Set(
      raw
        .map((n) => (typeof n === "number" ? Math.round(n) : Number(n)))
        .filter((n) => Number.isFinite(n)),
    ),
  );

  const targets: { idx: number; paper: FullTextPaper }[] = [];
  const unavailable: number[] = [];
  for (const idx of wanted) {
    const paper = papers[idx - 1];
    if (!paper) continue; // out of range
    const url = paper.grobid_xml_url;
    if (url && url.startsWith(CONTENT_PREFIX)) targets.push({ idx, paper });
    else unavailable.push(idx);
  }

  if (!targets.length) {
    return "None of the requested papers have retrievable full text — answer from their abstracts and say the full text isn't available.";
  }

  // Fetch all requested papers in parallel, then budget the combined text so a
  // few large papers can't blow the per-turn input cost.
  const fetched = await Promise.all(
    targets.map(async ({ idx, paper }) => {
      try {
        const xml = await fetchGrobidXml(paper.grobid_xml_url!);
        return { idx, paper, text: teiToText(xml), ok: true as const };
      } catch (e) {
        console.error(`[fetch_full_text] Paper ${idx} failed:`, e);
        return { idx, paper, text: "", ok: false as const };
      }
    }),
  );

  let remaining = TOTAL_CONTEXT_CHARS;
  const blocks: string[] = [];
  for (const { idx, paper, text, ok } of fetched) {
    const label = `=== Full text: Paper ${idx}${paper.title ? ` — ${paper.title}` : ""} ===`;
    if (!ok) {
      blocks.push(`${label}\n(Couldn't retrieve full text for this paper — use its abstract.)`);
      continue;
    }
    const clean = text.trim();
    if (!clean) {
      blocks.push(`${label}\n(Full text came back empty — use its abstract.)`);
      continue;
    }
    if (remaining <= 0) {
      blocks.push(`${label}\n(Full text omitted — context budget reached.)`);
      continue;
    }
    const cap = Math.min(PER_PAPER_CONTEXT_CHARS, remaining);
    const body = clean.length <= cap ? clean : clean.slice(0, cap).trimEnd() + " …[truncated]";
    remaining -= body.length;
    blocks.push(`${label}\n${body}`);
  }

  if (unavailable.length) {
    blocks.push(
      `(No full text available for Paper ${unavailable.join(", Paper ")} — use the abstract for ${unavailable.length > 1 ? "those" : "that"}.)`,
    );
  }

  return blocks.join("\n\n");
}
