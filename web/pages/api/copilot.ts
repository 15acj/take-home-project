// Streaming Copilot backend. The client assembles per-paper context (title,
// abstract, authors, metadata — lazy-loaded from the detail shards) plus the
// current filter state, and POSTs it here with the question and prior turns. We
// build the prompt and stream Claude Haiku 4.5's reply back.
//
// The reply is streamed as NDJSON (one JSON object per line) so it can carry
// both assistant text and structured filter actions:
//   {"t":"text","v":"<delta>"}                          — assistant text
//   {"t":"tool","name":"find_similar_papers"}           — a tool was invoked (shown as a muted line)
//   {"t":"action","name":"set_filters","input":{...}}   — a filter change to apply
import type { NextApiRequest, NextApiResponse } from "next";
import Anthropic from "@anthropic-ai/sdk";
import { CLUSTER_KEYS, FIELDS } from "../../lib/fieldClusters";
import { CONTENT_TYPE_KEYS } from "../../lib/contentTypes";
import { findSimilarPapers, findSpecificPaper, similarSearchConfigured } from "../../lib/similar";
import { fetchFullTextForPapers, fullTextConfigured } from "../../lib/fulltext";
import {
  MAX_SELECTED_PAPERS,
  MAX_MESSAGES,
  MAX_TOOL_TURNS,
  PER_PAPER_CONTEXT_CHARS,
  TOTAL_CONTEXT_CHARS,
} from "../../lib/limits";

// Haiku 4.5 — the current, supported replacement for the retired Haiku 3.5
// (claude-3-5-haiku-20241022, retired 2026-02-19). Fast/cheap, ideal for Q&A
// over abstracts and for mapping NL filter requests onto the tool schema.
const MODEL = "claude-haiku-4-5";

// Filter bounds — mirror lib/store.ts (kept as literals here so the API route
// doesn't pull the zustand store + its client deps into the server bundle).
const YEAR_MIN = 1935;
const YEAR_MAX = 2026;
const CITE_MAX = 40000;
const TOP_N = [100, 1000, 5000, 10000];

interface PaperContext {
  title: string | null;
  abstract: string | null;
  authors: string[];
  year: number | null;
  venue: string | null;
  topics: string[];
  keywords: string[];
  cited_by_count: number | null;
  // OpenAlex GROBID full-text URL when the paper has parsed full text, else null.
  // Sent by the client (from the detail shard) so fetch_full_text can dereference it.
  grobid_xml_url: string | null;
}

interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

// Current filter state, sent by the client so the model can make incremental
// changes ("also include neuroscience", "widen the years") off a known base.
interface FiltersSnapshot {
  fields: string[];
  content_types: string[];
  year_min: number;
  year_max: number;
  min_citations: number;
  keyword: string;
  require_pdf: boolean;
  require_open_access: boolean;
  require_full_text: boolean;
  top_n: number;
}

interface CopilotRequest {
  question: string;
  papers: PaperContext[];
  history: ChatTurn[];
  filters?: FiltersSnapshot;
  selectedRanks?: number[];
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: "set_filters",
    description:
      "Adjust which papers the 3D graph shows. Only the parameters you provide change; everything else stays as it is (the current filter state is given to you). Call this when the user asks to show, filter, narrow, or expand the papers on the graph.",
    input_schema: {
      type: "object",
      properties: {
        fields: {
          type: "array",
          items: { type: "string", enum: CLUSTER_KEYS },
          description:
            "Field clusters to show; ALL other fields are hidden, so send the full set you want visible. Clusters: " +
            CLUSTER_KEYS.map((k) => `${k} = ${FIELDS[k].label}`).join("; ") +
            ". Map broad domains to a cluster (machine learning / AI / deep learning -> ai; genetics / molecular biology -> genetics; neuroscience / psychology -> neuro; math / statistics / decision science -> cs). Omit to leave the field selection unchanged.",
        },
        content_types: {
          type: "array",
          items: { type: "string", enum: CONTENT_TYPE_KEYS },
          description:
            "Content types to show; all others hidden, so send the full set you want visible. One or more of: article, book, review, other. Omit to leave unchanged.",
        },
        year_min: { type: "integer", description: `Earliest publication year (min ${YEAR_MIN}).` },
        year_max: { type: "integer", description: `Latest publication year (max ${YEAR_MAX}).` },
        min_citations: { type: "integer", description: `Minimum citation count (0 to ${CITE_MAX}).` },
        keyword: {
          type: "string",
          description:
            "Free-text search over paper titles and authors. Use for specific topics or terms not captured by a broad field cluster. Empty string clears the search.",
        },
        require_pdf: { type: "boolean", description: "If true, show only papers that have a PDF link." },
        require_open_access: { type: "boolean", description: "If true, show only open-access papers." },
        require_full_text: { type: "boolean", description: "If true, show only papers with parsed full text available." },
        top_n: {
          type: "integer",
          enum: TOP_N,
          description: "Corpus size — how many of the top-cited papers to load (100, 1000, 5000, or 10000).",
        },
      },
    },
  },
  {
    name: "reset_filters",
    description:
      "Reset all graph filters to defaults: all fields and content types shown, full year range, zero minimum citations, no availability requirements, corpus 1000, no search. Call this when the user asks to reset or clear the filters.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "find_similar_papers",
    description:
      "Find papers semantically similar to a topic or to the currently selected paper(s), using hybrid vector + keyword search over the entire corpus. Call this when the user asks to find, discover, surface, recommend, or search for papers on a topic, or papers similar/related to the selected one(s). This is different from set_filters, which only narrows the papers already on the graph — use find_similar_papers to pull in new papers by relevance.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What to search for. For a topic request, use the user's topic or description. For 'papers similar to this', synthesize the query from the selected paper's title and main topics (given in the message). Make it a rich descriptive phrase, not a single keyword.",
        },
        limit: { type: "integer", description: "How many results to return (3–5). Default 5." },
      },
      required: ["query"],
    },
  },
  {
    name: "find_specific_paper",
    description:
      "Locate ONE specific paper the user has named or described — by its title (full or partial), or a phrasing like \"the paper on X by author Y\", \"look up <title>\", \"do we have <paper>\". Tries an exact title match first and falls back to semantic search. The result is auto-focused in the graph and shown as a card the user can add to their selection. Use this (not find_similar_papers) whenever the user is after one particular, identifiable paper. Use find_similar_papers instead when they want several papers on a topic or papers related to the current selection.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The paper to locate. Prefer the exact title if the user gave one (verbatim); otherwise pass the fullest identifying description they provided (title fragment, author + topic, etc.).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch_full_text",
    description:
      'Retrieve the FULL parsed text (methods, experiments, results, figure/table ' +
      'captions, equations, discussion, limitations) of one or more of the SELECTED ' +
      'papers — but ONLY for papers marked "Full text: available" in the context. ' +
      "Call this ONLY when answering the question needs detail the abstract doesn't " +
      "contain: how a method or experiment works, dataset/hyperparameter specifics, " +
      "what a figure or table shows, an exact result or number, an equation, ablations, " +
      "or stated limitations. Do NOT call it for questions the title/abstract already " +
      "answer (what the paper is about, its headline contribution, its year/venue/" +
      "citations). If the question spans multiple selected papers (summarize, compare, " +
      "contrast, or synthesize) and several are marked available, pass ALL of their " +
      'indices in one call so you read every applicable paper. Never pass the index of ' +
      'a paper marked "Full text: not available".',
    input_schema: {
      type: "object",
      properties: {
        papers: {
          type: "array",
          items: { type: "integer" },
          description:
            'The 1-based indices of the selected papers to read, matching the "Paper N" ' +
            "labels in the context (use [1] when a single paper is selected). Include " +
            "every applicable available paper for a cross-paper question.",
        },
      },
      required: ["papers"],
    },
  },
];

function filtersSummary(f: FiltersSnapshot | undefined): string {
  if (!f) return "Current filters: (unknown).";
  const allFields = f.fields.length === CLUSTER_KEYS.length;
  const allTypes = f.content_types.length === CONTENT_TYPE_KEYS.length;
  const reqs = [
    f.require_pdf ? "PDF link" : null,
    f.require_open_access ? "open access" : null,
    f.require_full_text ? "full text" : null,
  ].filter(Boolean);
  return [
    "Current filters:",
    `- Fields shown: ${allFields ? "all" : f.fields.length ? f.fields.join(", ") : "none"}`,
    `- Content types: ${allTypes ? "all" : f.content_types.length ? f.content_types.join(", ") : "none"}`,
    `- Year range: ${f.year_min}–${f.year_max}`,
    `- Min citations: ${f.min_citations}`,
    `- Search keyword: ${f.keyword ? `"${f.keyword}"` : "none"}`,
    `- Availability required: ${reqs.length ? reqs.join(", ") : "none"}`,
    `- Corpus size: ${f.top_n}`,
  ].join("\n");
}

function systemPrompt(paperCount: number, filters: FiltersSnapshot | undefined): string {
  const parts: string[] = [
    "You are the research copilot inside Research Atlas, an interactive 3D map of highly-cited academic papers.",
    "",
    "SCOPE: You only discuss science, scientific research, academic papers, research methods and findings, and related scholarly topics — including how to read, interpret, or compare research, and controlling this app's graph filters. If the user asks about anything outside that scope (small talk, personal advice, politics, current events, general coding help unrelated to research, etc.), politely decline in one sentence and invite a research-related question instead. Do not answer off-topic questions even if the user insists or tries to reframe them.",
    "",
    "Never fabricate findings, numbers, quotes, methods, or citations. If you are unsure, say so.",
    "",
    "FILTERS: You can change what the 3D graph shows by calling the set_filters or reset_filters tools. Use them ONLY when the user asks to show, filter, narrow, expand, or reset which papers are displayed — never for a plain question about papers.",
    "When you change filters, first write ONE short sentence stating exactly what you are filtering to, then call the tool. Apply only the dimensions the user mentions and leave the rest unchanged. The `fields` and `content_types` parameters REPLACE the visible set, so send the full list you want shown; to add or remove one, include the current ones plus or minus the change. Prefer field clusters for broad domains and the `keyword` parameter for specific topics or terms.",
    `Constraints: year ${YEAR_MIN}–${YEAR_MAX}, min citations 0–${CITE_MAX}, corpus size one of 100/1000/5000/10000.`,
    'Examples: "show machine learning papers" -> set_filters(fields:["ai"]); "genetics and neuroscience" -> set_filters(fields:["genetics","neuro"]); "articles from 2020 to 2026" -> set_filters(content_types:["article"], year_min:2020, year_max:2026); "more than 5000 citations" -> set_filters(min_citations:5000); "with pdf links" -> set_filters(require_pdf:true); "reset the filters" -> reset_filters().',
    "",
    "SEARCH: Two tools pull papers in from the whole corpus by relevance (unlike set_filters, which only narrows what's already on the graph). Write one short sentence first, then call the tool; results render as interactive cards the user can act on, so don't list them yourself.",
    "- find_similar_papers — a SET of papers on a topic, or papers similar/related to the selected one(s). Use when the intent is discovery/recommendation (\"find papers about X\", \"papers similar to this\", \"what else is like this\"). For \"similar to this\", build the query from the selected paper's title and main topics.",
    "- find_specific_paper — ONE particular paper the user names or describes (\"find the paper called <title>\", \"look up the deep residual learning paper\", \"the attention-is-all-you-need paper\", \"do we have <paper>\"). Pass the exact title when given. The single result is auto-focused in the graph and can be added to the selection.",
    "Route by intent: a specific, identifiable paper -> find_specific_paper; a topic or \"papers like X\" -> find_similar_papers. E.g. \"find the transformer paper\" -> find_specific_paper; \"papers about attention mechanisms\" -> find_similar_papers.",
    "",
    "FULL TEXT: For a SELECTED paper marked \"Full text: available\", you can read its complete parsed text with the fetch_full_text tool. Use it ONLY when the question needs detail the abstract can't give — how a method or experiment works, dataset/hyperparameter specifics, what a figure or table shows, an exact result or number, an equation, ablations, or stated limitations. Do NOT fetch for questions the title/abstract already answer (what the paper is about, its headline contribution, its metadata). When the question spans multiple selected papers (summarize, compare, contrast, synthesize) and several are marked available, fetch ALL of their indices in one call. Only pass indices of papers marked available; if a paper the question needs has no full text, say so and answer from its abstract. After the tool returns, ground your answer in the retrieved text and be explicit about which paper each detail comes from.",
    "",
    "IMPORTANT — questions about a paper that isn't selected: fetch_full_text and in-depth analysis work ONLY on papers in the CURRENT selection (the ones detailed in the next message). A paper you surface with find_specific_paper or find_similar_papers is NOT selected — it renders only as a card — so you CANNOT read its full text or analyze it in depth until the user adds it to their selection. So when the user asks a substantive question about a specific paper that is not in the current selection (e.g. \"what are the limitations of the AlphaFold paper\" with nothing selected): locate it with find_specific_paper if it isn't already on screen, then tell the user to add it to their selection first (with the \"Add to Graph Selection\" button on the paper card, or by clicking its node in the graph) before you can answer in depth. Do NOT repeatedly re-call find_specific_paper for the same paper, and do NOT just say you lack access to the full text — the correct response is to ask them to select it. You may still give a brief answer from general knowledge or the abstract while inviting them to select it for a grounded, detailed analysis.",
    "",
    filtersSummary(filters),
  ];

  if (paperCount === 0) {
    parts.push(
      "",
      "No papers are currently selected in the graph. Answer the user's science/research question from general knowledge, accurately and grounded. When a question would be better answered against specific papers, tell them they can add papers to the selection — by clicking glowing nodes in the graph, or with the \"Add to Graph Selection\" button on a paper card you surface with find_specific_paper / find_similar_papers — and you'll analyze those directly. In particular, if they ask a detailed question about ONE specific named paper (its methods, results, limitations, etc.), locate it with find_specific_paper and then ask them to add it to their selection so you can read its full text and answer in depth — you cannot fetch full text for a paper that isn't selected.",
    );
  } else if (paperCount === 1) {
    parts.push(
      "",
      "The user has selected one paper; its details are in the next message. Ground your answer in its title, abstract, and metadata. If the paper is marked \"Full text: available\" and the question needs detail beyond the abstract (methods, figures, specific results), call fetch_full_text to read it; if it has no full text, say so when a question needs more than the abstract. Explain the paper's contribution, method, and significance.",
    );
  } else {
    parts.push(
      "",
      `The user selected ${paperCount} papers, delineated as "Paper 1", "Paper 2", etc. in the next message. Ground your answer in the provided titles, abstracts, and metadata. When a question needs detail beyond the abstracts (methods, figures, specific results) and the relevant papers are marked "Full text: available", call fetch_full_text — for a cross-paper task (summarize/compare/synthesize), pass every applicable available paper's index in one call. Say so for any needed paper that has no full text. Depending on the question, help them:`,
      "- Summarize the selection (individually and as a set).",
      "- Compare and contrast the papers' methods, approaches, assumptions, or scope.",
      "- Identify connections between them — shared methodological lineage, common themes, complementary or competing results, how one builds on another.",
      "- Synthesize across them into the bigger picture.",
      'Always be explicit about which paper a claim comes from (short title or "Paper N"). If the papers are only loosely related, say that honestly instead of inventing links.',
    );
  }

  parts.push(
    "",
    "Style: lead with the direct answer, then support it. Be concise and concrete. Use citation counts, year, and venue as supporting context, not as the headline. Plain text — no markdown headers.",
  );
  return parts.join("\n");
}

// `body` is the already-budgeted abstract/full-text for this paper: a string to
// include, "" when the paper genuinely has no abstract, or null when its text was
// dropped to stay under the total context budget (metadata is still shown so the
// model knows the paper exists).
function renderPaper(p: PaperContext, index: number, total: number, body: string | null): string {
  const lines: string[] = [];
  lines.push(total > 1 ? `=== Paper ${index + 1} of ${total} ===` : "=== Selected paper ===");
  lines.push(`Title: ${p.title ?? "(untitled)"}`);
  if (p.authors.length) lines.push(`Authors: ${p.authors.join(", ")}`);
  if (p.year != null) lines.push(`Year: ${p.year}`);
  if (p.venue) lines.push(`Venue: ${p.venue}`);
  if (p.cited_by_count != null) lines.push(`Citations: ${p.cited_by_count.toLocaleString()}`);
  if (p.topics.length) lines.push(`Topics: ${p.topics.join(", ")}`);
  if (p.keywords.length) lines.push(`Keywords: ${p.keywords.join(", ")}`);
  lines.push(
    p.grobid_xml_url
      ? "Full text: available (use fetch_full_text to read it when the question needs paper internals)"
      : "Full text: not available (only the abstract below)",
  );
  lines.push("Abstract:");
  lines.push(
    body === null
      ? "(text omitted — context budget reached)"
      : body || "(no abstract available for this paper)",
  );
  return lines.join("\n");
}

// Distribute the total context-character budget across the selected papers' text.
// Each paper's body is capped at PER_PAPER_CONTEXT_CHARS; the running total is
// capped at TOTAL_CONTEXT_CHARS. Papers whose text would overflow the total are
// truncated to fit, then omitted entirely once the budget is spent. This bounds
// per-turn input cost even when full paper text is included for many papers.
function budgetBodies(papers: PaperContext[]): (string | null)[] {
  let remaining = TOTAL_CONTEXT_CHARS;
  return papers.map((p) => {
    const raw = p.abstract && p.abstract.trim() ? p.abstract.trim() : "";
    if (!raw) return "";
    if (remaining <= 0) return null;
    const cap = Math.min(PER_PAPER_CONTEXT_CHARS, remaining);
    remaining -= Math.min(raw.length, cap);
    return raw.length <= cap ? raw : raw.slice(0, cap).trimEnd() + " …[truncated]";
  });
}

function buildUserMessage(papers: PaperContext[], question: string): string {
  if (!papers.length) return question;
  const bodies = budgetBodies(papers);
  const context = papers.map((p, i) => renderPaper(p, i, papers.length, bodies[i])).join("\n\n");
  return `${context}\n\n---\nUser question: ${question}`;
}

// Prior turns → Anthropic messages. The store seeds an assistant greeting, so we
// drop everything before the first user turn (the API requires messages[0] to be
// a user turn) and pass the stored text verbatim (no embedded paper context —
// that lives only on the current turn, since the selection can change).
function mapHistory(history: ChatTurn[]): Anthropic.MessageParam[] {
  // Clamp to the last MAX_MESSAGES turns so a crafted oversized history can't
  // blow up per-request cost (defense-in-depth behind the client-side cap).
  const clamped = history.length > MAX_MESSAGES ? history.slice(-MAX_MESSAGES) : history;
  const firstUser = clamped.findIndex((m) => m.role === "user");
  if (firstUser === -1) return [];
  // Drop UI-only turns that carry no text (tool-call indicator lines, and the
  // results/paper cards) — they'd otherwise become empty-content assistant
  // messages, which the API rejects.
  return clamped
    .slice(firstUser)
    .filter((m) => m.text && m.text.trim())
    .map((m) => ({ role: m.role, content: m.text }));
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body as CopilotRequest;
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  // Clamp the paper count server-side (defense-in-depth behind the UI cap) so a
  // client that ignores the selection limit can't force an oversized context.
  const papers = (Array.isArray(body?.papers) ? body.papers : []).slice(0, MAX_SELECTED_PAPERS);
  const history = Array.isArray(body?.history) ? body.history : [];
  const filters = body?.filters;
  const selectedRanks = Array.isArray(body?.selectedRanks)
    ? body.selectedRanks.filter((n): n is number => typeof n === "number")
    : [];

  if (!question) {
    return res.status(400).json({ error: "Missing question." });
  }
  // papers may be empty — the copilot answers general science/research questions
  // (and can still set filters) when nothing is selected.

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set on the server." });
  }

  const client = new Anthropic({ apiKey });
  const messages: Anthropic.MessageParam[] = [
    ...mapHistory(history),
    { role: "user", content: buildUserMessage(papers, question) },
  ];

  // NDJSON stream. no-transform / no-buffering keep the Next dev server (and any
  // proxy) from coalescing the body; we let the first res.write flush the
  // headers so a pre-stream error (auth, rate limit) is still returned as a
  // clean 500 with headers un-sent rather than an in-band line.
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");

  // If the client stops the request (hits the stop button → aborts the fetch),
  // the connection closes. Abort the in-flight Claude stream so we don't keep
  // generating (and billing) tokens no one will read, and stop writing to the
  // dead socket.
  let clientGone = false;
  let activeStream: ReturnType<typeof client.messages.stream> | null = null;
  res.on("close", () => {
    if (res.writableEnded) return; // normal completion, not a client abort
    clientGone = true;
    try { activeStream?.abort(); } catch { /* already settled */ }
  });
  const writeLine = (obj: unknown) => {
    if (!clientGone) res.write(JSON.stringify(obj) + "\n");
  };

  try {
    // Bounded agentic loop. Most turns are single-pass: fire-and-forget tools
    // (filters, search) render as client actions and DON'T continue the loop, so
    // behavior is unchanged for them. fetch_full_text is different — its result
    // must go back to the model to be reasoned over — so when it runs we append a
    // tool_result turn and re-invoke the model (up to MAX_TOOL_TURNS).
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      if (clientGone) break;
      const stream = client.messages.stream({
        model: MODEL,
        max_tokens: 1024,
        system: systemPrompt(papers.length, filters),
        tools: TOOLS,
        messages,
      });
      activeStream = stream;
      stream.on("text", (delta) => writeLine({ t: "text", v: delta }));
      const final = await stream.finalMessage();

      const toolUses = final.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      if (!toolUses.length) break;

      // Replay this assistant turn (text + tool_use blocks) so the tool_result we
      // may append next references valid tool_use ids.
      messages.push({ role: "assistant", content: final.content });

      // The API requires a tool_result for EVERY tool_use in the turn we continue.
      // We build one per block; the fire-and-forget acks are only sent to the model
      // if fetch_full_text also ran this turn (otherwise we break without them).
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      let continueLoop = false;
      const ack = (id: string, content: string) =>
        toolResults.push({ type: "tool_result", tool_use_id: id, content });

      for (const block of toolUses) {
        // Surface the tool call itself as a muted line in the chat (name only).
        writeLine({ t: "tool", name: block.name });

        if (block.name === "fetch_full_text") {
          // Read the selected paper(s) and feed the text back to the model.
          try {
            const text = await fetchFullTextForPapers(
              block.input as { papers?: unknown },
              papers,
            );
            ack(block.id, text);
          } catch (e) {
            console.error("[/api/copilot] full-text fetch failed:", e);
            ack(block.id, "Full-text retrieval failed — answer from the abstract(s) and note that the full text couldn't be loaded.");
          }
          continueLoop = true;
        } else if (block.name === "find_similar_papers") {
          const input = block.input as { query?: string; limit?: number };
          const query = typeof input?.query === "string" ? input.query.trim() : "";
          if (!query) {
            ack(block.id, "No query provided.");
          } else if (!similarSearchConfigured()) {
            writeLine({ t: "text", v: "\n\n(Similar-paper search isn't configured on the server.)" });
            ack(block.id, "Similar-paper search isn't configured.");
          } else {
            try {
              const results = await findSimilarPapers({
                anthropic: client,
                query,
                limit: input.limit ?? 5,
                excludeRanks: selectedRanks,
              });
              writeLine({ t: "action", name: "show_similar", input: { query, results } });
              ack(block.id, "Results were shown to the user as cards.");
            } catch (e) {
              console.error("[/api/copilot] similar search failed:", e);
              writeLine({ t: "text", v: "\n\n(Similar-paper search failed — please try again.)" });
              ack(block.id, "Similar-paper search failed.");
            }
          }
        } else if (block.name === "find_specific_paper") {
          const input = block.input as { query?: string };
          const query = typeof input?.query === "string" ? input.query.trim() : "";
          if (!query) {
            ack(block.id, "No query provided.");
          } else if (!similarSearchConfigured()) {
            writeLine({ t: "text", v: "\n\n(Paper lookup isn't configured on the server.)" });
            ack(block.id, "Paper lookup isn't configured.");
          } else {
            try {
              const { paper, matchType } = await findSpecificPaper({
                anthropic: client,
                query,
                excludeRanks: selectedRanks,
              });
              if (paper) {
                writeLine({ t: "action", name: "show_paper", input: { query, paper, matchType } });
                ack(block.id, "The paper was shown to the user as a card.");
              } else {
                writeLine({ t: "text", v: "\n\nI couldn't find that specific paper in the corpus — try the exact title, or ask me to find similar papers instead." });
                ack(block.id, "No matching paper found.");
              }
            } catch (e) {
              console.error("[/api/copilot] specific-paper search failed:", e);
              writeLine({ t: "text", v: "\n\n(Paper lookup failed — please try again.)" });
              ack(block.id, "Paper lookup failed.");
            }
          }
        } else {
          // set_filters / reset_filters apply on the client.
          writeLine({ t: "action", name: block.name, input: block.input });
          ack(block.id, "Filters were applied.");
        }
      }

      // Only fetch_full_text needs another model turn to answer over its result.
      // For filter/search-only turns, stop here (unchanged single-pass behavior).
      if (!continueLoop) break;
      messages.push({ role: "user", content: toolResults });
    }
    if (!clientGone) res.end();
  } catch (err) {
    // The client aborting (stop button) surfaces as an abort/closed-socket error
    // here — that's expected, not a failure, so don't log it or try to write to
    // the dead connection.
    if (clientGone) return;
    console.error("[/api/copilot] error:", err);
    if (res.headersSent) {
      writeLine({ t: "text", v: "\n\n[The copilot hit an error and couldn't finish this reply.]" });
      res.end();
    } else {
      res.status(500).json({ error: "The copilot request failed." });
    }
  }
}
