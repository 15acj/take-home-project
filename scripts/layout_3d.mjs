// Offline 3D force-directed layout precompute.
//
// Reads the manifest + edges.bin produced by build_graph_data.py, runs the same
// engine react-force-graph-3d uses (d3-force-3d) to convergence, and writes
// positions.bin as Int16-quantized [x,y,z] coords. Patches positions.scale (maxAbs)
// and a content hash back into manifest.json so the client can decode with one multiply.
//
// Usage: node scripts/layout_3d.mjs [--out web/public/data/v1] [--ticks 300]

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  forceSimulation, forceManyBody, forceLink, forceCenter, forceX, forceY, forceZ,
} from "d3-force-3d";

const args = process.argv.slice(2);
const opt = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : def;
};
const OUT = opt("--out", "web/public/data/v1");
const TICKS = parseInt(opt("--ticks", "300"), 10);

const manifest = JSON.parse(readFileSync(join(OUT, "manifest.json"), "utf8"));
const N = manifest.counts.nodes;
const E = manifest.counts.edges;

// --- load edges.bin (Uint16 SoA: src[E] then dst[E]) ---
const buf = readFileSync(join(OUT, "edges.bin"));
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const src = new Uint16Array(ab, 0, E);
const dst = new Uint16Array(ab, E * 2, E);

const nodes = Array.from({ length: N }, (_, i) => ({ index: i }));
const links = Array.from({ length: E }, (_, i) => ({ source: src[i], target: dst[i] }));

console.error(`Laying out ${N} nodes / ${E} edges over ${TICKS} ticks ...`);

// Match react-force-graph-3d defaults, with weak per-axis centering so the ~12.5%
// isolated nodes stay bounded instead of drifting to infinity.
const sim = forceSimulation(nodes, 3)
  .force("charge", forceManyBody().strength(-30).theta(0.9))
  .force("link", forceLink(links).id((d) => d.index).distance(30).iterations(1))
  .force("center", forceCenter(0, 0, 0))
  .force("x", forceX(0).strength(0.03))
  .force("y", forceY(0).strength(0.03))
  .force("z", forceZ(0).strength(0.03))
  .stop();

const t0 = Date.now();
for (let i = 0; i < TICKS; i++) {
  sim.tick();
  if ((i + 1) % 50 === 0) console.error(`  tick ${i + 1}/${TICKS}`);
}
console.error(`  simulation done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// --- quantize to Int16 ---
let maxAbs = 0;
for (const nd of nodes) {
  maxAbs = Math.max(maxAbs, Math.abs(nd.x), Math.abs(nd.y), Math.abs(nd.z));
}
const q = 32767 / maxAbs;
const pos = new Int16Array(N * 3);
for (let i = 0; i < N; i++) {
  pos[i * 3] = Math.round(nodes[i].x * q);
  pos[i * 3 + 1] = Math.round(nodes[i].y * q);
  pos[i * 3 + 2] = Math.round(nodes[i].z * q);
}
const posBin = Buffer.from(pos.buffer, pos.byteOffset, pos.byteLength);
writeFileSync(join(OUT, "positions.bin"), posBin);
writeFileSync(join(OUT, "positions.bin.gz"), gzipSync(posBin, { level: 9 }));

// --- patch manifest ---
manifest.positions.scale = maxAbs;
manifest.positions.note = "decode: value/32767*scale";
manifest.hashes = manifest.hashes || {};
manifest.hashes["positions.bin"] = createHash("sha256").update(posBin).digest("hex").slice(0, 8);
writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));

console.error(
  `positions.bin: ${(posBin.length / 1024) | 0} KB raw, ` +
  `${(gzipSync(posBin, { level: 9 }).length / 1024) | 0} KB gz, maxAbs=${maxAbs.toFixed(1)}`,
);
