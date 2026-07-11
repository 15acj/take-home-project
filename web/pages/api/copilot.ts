// Streaming Copilot backend. The client assembles per-paper context (title,
// abstract, authors, metadata — already lazy-loaded from the detail shards) and
// POSTs it here with the question and prior turns; we build the prompt and
// stream Claude Haiku 4.5's reply back as plain-text chunks.
import type { NextApiRequest, NextApiResponse } from "next";
import Anthropic from "@anthropic-ai/sdk";

// Haiku 4.5 — the current, supported replacement for the retired Haiku 3.5
// (claude-3-5-haiku-20241022, retired 2026-02-19). Fast/cheap, ideal for Q&A
// over abstracts.
const MODEL = "claude-haiku-4-5";

interface PaperContext {
  title: string | null;
  abstract: string | null;
  authors: string[];
  year: number | null;
  venue: string | null;
  topics: string[];
  keywords: string[];
  cited_by_count: number | null;
}

interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

interface CopilotRequest {
  question: string;
  papers: PaperContext[];
  history: ChatTurn[];
}

function systemPrompt(paperCount: number): string {
  const parts: string[] = [
    "You are the research copilot inside Research Atlas, an interactive 3D map of highly-cited academic papers.",
    "",
    "SCOPE: You only discuss science, scientific research, academic papers, research methods and findings, and related scholarly topics — including how to read, interpret, or compare research. If the user asks about anything outside that scope (small talk, personal advice, politics, current events, general coding help unrelated to research, etc.), politely decline in one sentence and invite a research-related question instead. Do not answer off-topic questions even if the user insists or tries to reframe them.",
    "",
    "Never fabricate findings, numbers, quotes, methods, or citations. If you are unsure, say so.",
  ];

  if (paperCount === 0) {
    parts.push(
      "",
      "No papers are currently selected in the graph. Answer the user's science/research question from general knowledge, accurately and grounded. When a question would be better answered against specific papers, tell them they can click glowing nodes in the graph to select papers and you'll analyze those directly.",
    );
  } else if (paperCount === 1) {
    parts.push(
      "",
      "The user has selected one paper; its details are in the next message. Ground your answer in its title, abstract, and metadata. You do NOT have the full text — when a question needs detail the abstract doesn't contain, say so plainly. Explain the paper's contribution, method, and significance.",
    );
  } else {
    parts.push(
      "",
      `The user selected ${paperCount} papers, delineated as "Paper 1", "Paper 2", etc. in the next message. Ground your answer in the provided titles, abstracts, and metadata — you do NOT have the full text, so say so when a question needs more. Depending on the question, help them:`,
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

function renderPaper(p: PaperContext, index: number, total: number): string {
  const lines: string[] = [];
  lines.push(total > 1 ? `=== Paper ${index + 1} of ${total} ===` : "=== Selected paper ===");
  lines.push(`Title: ${p.title ?? "(untitled)"}`);
  if (p.authors.length) lines.push(`Authors: ${p.authors.join(", ")}`);
  if (p.year != null) lines.push(`Year: ${p.year}`);
  if (p.venue) lines.push(`Venue: ${p.venue}`);
  if (p.cited_by_count != null) lines.push(`Citations: ${p.cited_by_count.toLocaleString()}`);
  if (p.topics.length) lines.push(`Topics: ${p.topics.join(", ")}`);
  if (p.keywords.length) lines.push(`Keywords: ${p.keywords.join(", ")}`);
  lines.push("Abstract:");
  lines.push(p.abstract && p.abstract.trim() ? p.abstract.trim() : "(no abstract available for this paper)");
  return lines.join("\n");
}

function buildUserMessage(papers: PaperContext[], question: string): string {
  if (!papers.length) return question;
  const context = papers.map((p, i) => renderPaper(p, i, papers.length)).join("\n\n");
  return `${context}\n\n---\nUser question: ${question}`;
}

// Prior turns → Anthropic messages. The store seeds an assistant greeting, so we
// drop everything before the first user turn (the API requires messages[0] to be
// a user turn) and pass the stored text verbatim (no embedded paper context —
// that lives only on the current turn, since the selection can change).
function mapHistory(history: ChatTurn[]): Anthropic.MessageParam[] {
  const firstUser = history.findIndex((m) => m.role === "user");
  if (firstUser === -1) return [];
  return history.slice(firstUser).map((m) => ({ role: m.role, content: m.text }));
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body as CopilotRequest;
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  const papers = Array.isArray(body?.papers) ? body.papers : [];
  const history = Array.isArray(body?.history) ? body.history : [];

  if (!question) {
    return res.status(400).json({ error: "Missing question." });
  }
  // papers may be empty — the copilot answers general science/research questions
  // when nothing is selected (scope is enforced by the system prompt).

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set on the server." });
  }

  const client = new Anthropic({ apiKey });
  const messages: Anthropic.MessageParam[] = [
    ...mapHistory(history),
    { role: "user", content: buildUserMessage(papers, question) },
  ];

  // Stream plain-text chunks. no-transform / no-buffering keep the Next dev
  // server (and any proxy) from coalescing the body into one blob. We let the
  // first res.write flush the headers, so any error that happens before the
  // first token (auth, rate limit) is still caught with headers un-sent and
  // returned as a clean 500 rather than an in-band marker.
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");

  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt(papers.length),
      messages,
    });
    stream.on("text", (delta) => {
      res.write(delta);
    });
    await stream.finalMessage();
    res.end();
  } catch (err) {
    console.error("[/api/copilot] error:", err);
    if (res.headersSent) {
      // Already streaming — surface a marker the client can show, then close.
      res.write("\n\n[The copilot hit an error and couldn't finish this reply.]");
      res.end();
    } else {
      res.status(500).json({ error: "The copilot request failed." });
    }
  }
}
