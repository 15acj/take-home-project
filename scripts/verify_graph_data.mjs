// End-to-end integrity check for the built graph artifacts. Loads every file the
// way the client will and asserts cross-file index alignment.
// Usage: node scripts/verify_graph_data.mjs [--out web/public/data/v1]

import { readFileSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : "web/public/data/v1";

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "  ok  " : " FAIL "} ${msg}`);
  if (!cond) failures++;
};

const M = JSON.parse(readFileSync(join(OUT, "manifest.json"), "utf8"));
const N = M.counts.nodes;
const E = M.counts.edges;

const readBin = (name) => {
  const b = readFileSync(join(OUT, name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

// --- nodes.bin via manifest offsets ---
const nb = readBin("nodes.bin");
const off = Object.fromEntries(M.nodesBin.layout.map((l) => [l.name, l.offset]));
const citations = new Uint32Array(nb, off.citations, N);
const years = new Uint16Array(nb, off.year, N);
const flags = new Uint8Array(nb, off.flags, N);
check(citations.length === N, `nodes.bin decodes N=${N} citations`);
let sorted = true;
for (let i = 1; i < N; i++) if (citations[i] > citations[i - 1]) { sorted = false; break; }
check(sorted, `citations fully descending (top=${citations[0]}, tail=${citations[N - 1]})`);
const suspects = flags.reduce((a, f) => a + (f & 1), 0);
// suspect rate varies by fetch strategy (global pull ~0; per-year surfaces mis-dated
// recent-cohort records) -- assert only a sane ceiling, not an exact count.
check(suspects < N * 0.15, `suspect flag within sane bound (${suspects}/${N}, ${(100 * suspects / N).toFixed(1)}%)`);
const oaN = flags.reduce((a, f) => a + ((f >> 1) & 1), 0);
const pdfN = flags.reduce((a, f) => a + ((f >> 2) & 1), 0);
const grobidN = flags.reduce((a, f) => a + ((f >> 3) & 1), 0);
check(oaN > 0 && oaN < N, `openAccess flag populated (${oaN})`);
check(pdfN > 0 && pdfN < N, `hasPdf flag populated (${pdfN})`);
check(grobidN > 0 && grobidN <= pdfN, `hasGrobid flag populated (${grobidN}) and <= hasPdf`);
const sizeScore = new Uint16Array(nb, off.sizeScore, N);
check(sizeScore.length === N && Math.max(...sizeScore) === 65535,
  `sizeScore decodes, max hits 65535 (p99 clamp)`);

// --- field -> cluster mapping coverage ---
const FC = JSON.parse(readFileSync(new URL("../web/lib/field-clusters.json", import.meta.url), "utf8"));
const unmapped = M.colorLegend.fields.filter((f) => !FC.fieldToCluster[f]);
check(unmapped.length === 0, `every manifest field maps to a cluster${unmapped.length ? ` (missing: ${unmapped.join(", ")})` : ""}`);

// --- edges.bin ---
const eb = readBin("edges.bin");
const src = new Uint16Array(eb, 0, E);
const dst = new Uint16Array(eb, E * 2, E);
let maxIdx = 0, selfLoops = 0;
const deg = new Uint32Array(N);
for (let i = 0; i < E; i++) {
  maxIdx = Math.max(maxIdx, src[i], dst[i]);
  if (src[i] === dst[i]) selfLoops++;
  deg[src[i]]++; deg[dst[i]]++;
}
check(maxIdx < N, `all edge indices < N (max=${maxIdx})`);
check(selfLoops === 0, `no self-loops`);

// --- positions.bin ---
const pb = readBin("positions.bin");
const pos = new Int16Array(pb, 0, N * 3);
const scale = M.positions.scale;
let finite = true, posMax = 0;
for (let i = 0; i < N * 3; i++) {
  const v = (pos[i] / 32767) * scale;
  if (!Number.isFinite(v)) finite = false;
  posMax = Math.max(posMax, Math.abs(v));
}
check(pos.length === N * 3, `positions.bin has ${N * 3} Int16s`);
check(finite && posMax <= scale + 1e-6, `decoded coords finite within ±scale (${scale.toFixed(1)})`);

// --- nodes-text.json ---
const T = JSON.parse(readFileSync(join(OUT, "nodes-text.json"), "utf8"));
check(T.title.length === N && T.author.length === N && T.topicIdx.length === N,
  `nodes-text arrays all length N`);
check(Array.isArray(T.authorsDisplay) && T.authorsDisplay.length === N,
  `nodes-text authorsDisplay length N`);
check(Math.max(...T.topicIdx) < T.topicTable.length, `every topicIdx resolves in topicTable`);

// --- search-kw.json ---
const K = JSON.parse(readFileSync(join(OUT, "search-kw.json"), "utf8"));
const kwMax = K.kwIdx.reduce((m, lst) => lst.reduce((a, x) => Math.max(a, x), m), 0);
check(K.kwIdx.length === N && kwMax < K.kwTable.length, `every kwIdx resolves in kwTable`);

// --- detail shard round-trip (top node) ---
const SH = M.shardSize;
const shard0 = JSON.parse(readFileSync(join(OUT, `details/shard-000.json`), "utf8"));
check(shard0.length === SH, `shard-000 has ${SH} records`);
const top = shard0[0];
check(top.cited_by_count === citations[0], `shard top record citations match nodes.bin`);
check(typeof top.abstract === "string" && top.abstract.length > 0, `top record has abstract text`);
check("venue" in top && "publication_date" in top, `shard records carry venue + publication_date`);

// --- summary ---
console.log("\n--- graph summary ---");
console.log(`nodes ${N} | edges ${E} | shards ${M.counts.shards}`);
console.log(`top node: "${T.title[0].slice(0, 50)}" — ${citations[0]} cites, degree ${deg[0]}`);
const isolated = deg.reduce((a, d) => a + (d === 0 ? 1 : 0), 0);
console.log(`isolated nodes (degree 0): ${isolated} (${(100 * isolated / N).toFixed(1)}%)`);
console.log(`citation domain: ${JSON.stringify(M.citationDomain)}`);

console.log(failures ? `\n${failures} CHECK(S) FAILED` : `\nALL CHECKS PASSED`);
process.exit(failures ? 1 : 0);
