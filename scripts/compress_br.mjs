// Brotli-compress every built artifact (quality 11) alongside the gzip sidecars, and
// print a raw / gzip / brotli size comparison. Uses Node's built-in zlib — no deps.
// Usage: node scripts/compress_br.mjs [--out web/public/data/v1] [--quality 11]

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, gzipSync, constants } from "node:zlib";

const args = process.argv.slice(2);
const opt = (f, d) => (args.indexOf(f) >= 0 ? args[args.indexOf(f) + 1] : d);
const OUT = opt("--out", "web/public/data/v1");
const QUALITY = parseInt(opt("--quality", "11"), 10);

const brotli = (buf) =>
  brotliCompressSync(buf, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: QUALITY,
      [constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
    },
  });

// collect raw artifacts (skip already-compressed sidecars)
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (!p.endsWith(".gz") && !p.endsWith(".br")) out.push(p);
  }
  return out;
}

const files = walk(OUT);
const kb = (n) => (n / 1024).toFixed(0).padStart(6);
const rows = [];
let totRaw = 0, totGz = 0, totBr = 0;

for (const f of files) {
  const raw = readFileSync(f);
  const br = brotli(raw);
  writeFileSync(f + ".br", br);
  const gzPath = f + ".gz";
  const gz = existsSync(gzPath) ? statSync(gzPath).size : gzipSync(raw, { level: 9 }).length;
  totRaw += raw.length; totGz += gz; totBr += br.length;
  rows.push({ f: f.replace(OUT + "/", ""), raw: raw.length, gz, br: br.length });
}

// print: top-level files individually, details/* aggregated
console.log(`\nquality=${QUALITY}    (KB)      raw     gzip   brotli   br vs gz`);
console.log("-".repeat(58));
const details = rows.filter((r) => r.f.startsWith("details/"));
const top = rows.filter((r) => !r.f.startsWith("details/"));
const line = (label, raw, gz, br) =>
  console.log(`${label.padEnd(22)} ${kb(raw)} ${kb(gz)} ${kb(br)}   ${(100 * (1 - br / gz)).toFixed(1).padStart(5)}%`);
for (const r of top.sort((a, b) => b.raw - a.raw)) line(r.f, r.raw, r.gz, r.br);
if (details.length) {
  const s = (k) => details.reduce((a, r) => a + r[k], 0);
  line(`details/ (${details.length} shards)`, s("raw"), s("gz"), s("br"));
}
console.log("-".repeat(58));
line("TOTAL", totRaw, totGz, totBr);

// first-paint set (excludes deferred keywords + on-click details)
const fp = ["manifest.json", "nodes.bin", "nodes-text.json", "edges.bin", "positions.bin"];
const fpr = rows.filter((r) => fp.includes(r.f));
console.log("\nfirst-paint set:");
line("  gz total", fpr.reduce((a, r) => a + r.raw, 0), fpr.reduce((a, r) => a + r.gz, 0), fpr.reduce((a, r) => a + r.br, 0));
