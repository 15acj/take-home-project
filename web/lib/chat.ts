// Mocked copilot replies, ported verbatim from the design's _genReply().
import type { AtlasNode } from "./loaders";
import { FIELDS } from "./fieldClusters";

export const PROMPTS = [
  "Summarize the selected papers",
  "How are these connected?",
  "Explain the key method",
  "Why are these so highly cited?",
];

export function genReply(q: string, sel: AtlasNode[]): string {
  if (!sel.length)
    return "Select one or more papers in the graph first — click any glowing node. Then I can summarize them, compare their methods, or trace how they cite each other.";
  const titles = sel.map((p) => `“${p.title}” (${p.authors}, ${p.year})`);
  const ql = q.toLowerCase();
  const fields = [...new Set(sel.map((p) => FIELDS[p.field].label))];
  const totalCites = sel.reduce((a, p) => a + p.citations, 0);
  if (sel.length === 1) {
    const p = sel[0];
    if (ql.includes("method"))
      return `The central contribution of ${titles[0]} is methodological: it introduced an approach in ${FIELDS[p.field].label.toLowerCase()} that later work adopted almost verbatim. With ${p.citations.toLocaleString()} citations it functions as a foundational reference — most of its downstream edges in the graph point back to it as a "method cite."`;
    if (ql.includes("why") || ql.includes("cited"))
      return `${titles[0]} is cited ${p.citations.toLocaleString()} times because it became the canonical reference for its technique — the kind of paper you cite by reflex when you use the method. Its position near the dense core of the ${FIELDS[p.field].label.toLowerCase()} cluster reflects that gravitational pull.`;
    return `${titles[0]} sits in ${FIELDS[p.field].label} with ${p.citations.toLocaleString()} citations. It anchors a tight neighborhood of follow-on work — select a few of its neighbors and I can explain how they build on it.`;
  }
  if (ql.includes("connect") || ql.includes("related") || ql.includes("relationship")) {
    return `You've selected ${sel.length} papers spanning ${fields.join(", ")}. In the citation graph they connect through shared methodological lineage: the more recent ones cite the earlier ones as foundational references. The visible edges between them trace that intellectual descent — highlighted in cluster color when you hover a node.`;
  }
  if (ql.includes("compare") || ql.includes("differ")) {
    return `Comparing your selection: ${titles.join("; ")}. They differ mainly in scope — earlier works establish general principles while later ones operationalize them. Collectively they account for roughly ${totalCites.toLocaleString()} citations, a signal of how load-bearing this thread is across ${fields.join(" and ")}.`;
  }
  return `Here's a synthesis of your ${sel.length} selected papers (${fields.join(", ")}): ${titles.slice(0, 3).join("; ")}${sel.length > 3 ? `, and ${sel.length - 3} more` : ""}. Together they form a coherent citation cluster — the seminal results seed the region and the surrounding nodes extend or apply them. Combined they hold about ${totalCites.toLocaleString()} citations. Ask me to compare their methods or trace how they cite one another.`;
}
