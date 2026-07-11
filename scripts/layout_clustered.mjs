// Offline field-clustered 3D layout precompute (replaces layout_3d.mjs in the pipeline).
//
// Verbatim port of the design's force3d.js _layout(): each of the 8 visual clusters
// (web/lib/field-clusters.json) gets a center on a Fibonacci sphere, nodes seed near
// their cluster center pulled inward by citation count, then Barnes-Hut repulsion +
// edge springs refine positions. This reproduces exactly the clustered look the
// Citation Atlas design computes at runtime, but offline, so the client renders
// frozen positions with zero layout cost.
//
// Reads manifest.json + nodes.bin (citations, fieldIdx) + edges.bin, writes
// positions.bin as Int16-quantized [x,y,z] and patches positions.scale + hash into
// manifest.json (same encoding as layout_3d.mjs; client decode unchanged).
//
// Usage: node scripts/layout_clustered.mjs [--out web/public/data/v1]

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const opt = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : def;
};
const OUT = opt("--out", "web/public/data/v1");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---- inputs ----
const manifest = JSON.parse(readFileSync(join(OUT, "manifest.json"), "utf8"));
const N = manifest.counts.nodes;
const E = manifest.counts.edges;

const { clusters, fieldToCluster } = JSON.parse(
  readFileSync(join(ROOT, "web/lib/field-clusters.json"), "utf8"),
);
const clusterKeys = Object.keys(clusters);

const toAB = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const nodesAB = toAB(readFileSync(join(OUT, "nodes.bin")));
const offsets = Object.fromEntries(manifest.nodesBin.layout.map((f) => [f.name, f.offset]));
const citations = new Uint32Array(nodesAB, offsets.citations, N);
const fieldIdx = new Uint8Array(nodesAB, offsets.fieldIdx, N);

const edgesAB = toAB(readFileSync(join(OUT, "edges.bin")));
const src = new Uint16Array(edgesAB, 0, E);
const dst = new Uint16Array(edgesAB, E * 2, E);

const nodes = Array.from({ length: N }, (_, i) => {
  const fieldName = manifest.colorLegend.fields[fieldIdx[i]];
  const field = fieldToCluster[fieldName];
  if (!field) throw new Error(`unmapped field: ${fieldName}`);
  return { field, citations: citations[i], x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
});
const edges = Array.from({ length: E }, (_, i) => [src[i], dst[i]]);

console.error(`Clustered layout: ${N} nodes / ${E} edges / ${clusterKeys.length} clusters ...`);

// ---- verbatim port of force3d.js mulberry32 + Octree + _layout() ----
function mulberry32(a){return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}

class Octree {
  constructor(cx, cy, cz, half) { this.cx=cx; this.cy=cy; this.cz=cz; this.half=half; this.mass=0; this.mx=0; this.my=0; this.mz=0; this.node=null; this.children=null; }
  insert(n) {
    if (this.mass === 0) { this.node = n; this.mass = 1; this.mx = n.x; this.my = n.y; this.mz = n.z; return; }
    if (this.children === null && this.node) { const old=this.node; this.node=null; this._subdivide(); this._place(old); }
    this._place(n); this.mass++; this.mx+=n.x; this.my+=n.y; this.mz+=n.z;
  }
  _subdivide() { this.children=[]; const h=this.half/2;
    for (let i=0;i<8;i++){ const ox=(i&1)?h:-h, oy=(i&2)?h:-h, oz=(i&4)?h:-h; this.children.push(new Octree(this.cx+ox,this.cy+oy,this.cz+oz,h)); } }
  _place(n){ let idx=0; if(n.x>this.cx)idx|=1; if(n.y>this.cy)idx|=2; if(n.z>this.cz)idx|=4; this.children[idx].insert(n); }
  force(n, theta, k2, out) {
    if (this.mass===0 || (this.node===n && this.mass===1)) return;
    const comx=this.mx/this.mass, comy=this.my/this.mass, comz=this.mz/this.mass;
    let dx=n.x-comx, dy=n.y-comy, dz=n.z-comz; let d2=dx*dx+dy*dy+dz*dz+0.01; const d=Math.sqrt(d2);
    if (this.children===null || (this.half*2)/d < theta) { const f=(k2*this.mass)/d2; out.x+=(dx/d)*f; out.y+=(dy/d)*f; out.z+=(dz/d)*f; }
    else { for (const c of this.children) c.force(n, theta, k2, out); }
  }
}

function layout(allNodes, allEdges, fieldKeys) {
  const rand = mulberry32(7);
  const centers = {};
  fieldKeys.forEach((f, i) => {
    const phi = Math.acos(1 - 2*(i+0.5)/fieldKeys.length);
    const theta = Math.PI*(1+Math.sqrt(5))*(i+0.5); const R=360;
    centers[f] = [R*Math.sin(phi)*Math.cos(theta), R*Math.sin(phi)*Math.sin(theta), R*Math.cos(phi)];
  });
  const maxC = Math.max(...allNodes.map(n=>n.citations));
  for (const n of allNodes) {
    const c = centers[n.field];
    const spread = 120 + (1 - n.citations/maxC)*260;
    n.x = c[0]*(0.55+0.45*(1-n.citations/maxC)) + (rand()-0.5)*spread;
    n.y = c[1]*(0.55+0.45*(1-n.citations/maxC)) + (rand()-0.5)*spread;
    n.z = c[2]*(0.55+0.45*(1-n.citations/maxC)) + (rand()-0.5)*spread;
    n.vx=n.vy=n.vz=0;
  }
  const N=allNodes.length;
  const iters = N>1500?90:140;
  const springLen=46, springK=0.02, repel=2600*(N>1200?0.7:1), theta=1.1, damping=0.86;
  const t0 = Date.now();
  for (let it=0; it<iters; it++) {
    let minx=1e9,miny=1e9,minz=1e9,maxx=-1e9,maxy=-1e9,maxz=-1e9;
    for (const n of allNodes){ if(n.x<minx)minx=n.x; if(n.y<miny)miny=n.y; if(n.z<minz)minz=n.z; if(n.x>maxx)maxx=n.x; if(n.y>maxy)maxy=n.y; if(n.z>maxz)maxz=n.z; }
    const cx=(minx+maxx)/2, cy=(miny+maxy)/2, cz=(minz+maxz)/2;
    const half=Math.max(maxx-minx,maxy-miny,maxz-minz)/2+10;
    const tree=new Octree(cx,cy,cz,half);
    for (const n of allNodes) tree.insert(n);
    const out={x:0,y:0,z:0};
    for (const n of allNodes){ out.x=0;out.y=0;out.z=0; tree.force(n,theta,repel,out);
      n.vx+=out.x; n.vy+=out.y; n.vz+=out.z; n.vx-=n.x*0.012; n.vy-=n.y*0.012; n.vz-=n.z*0.012; }
    for (const [si,ti] of allEdges){ const a=allNodes[si], b=allNodes[ti];
      let dx=b.x-a.x,dy=b.y-a.y,dz=b.z-a.z; const d=Math.sqrt(dx*dx+dy*dy+dz*dz)+0.01;
      const f=(d-springLen)*springK; const fx=(dx/d)*f, fy=(dy/d)*f, fz=(dz/d)*f;
      a.vx+=fx;a.vy+=fy;a.vz+=fz; b.vx-=fx;b.vy-=fy;b.vz-=fz; }
    for (const n of allNodes){ n.vx*=damping;n.vy*=damping;n.vz*=damping; n.x+=n.vx;n.y+=n.vy;n.z+=n.vz; }
    if ((it+1)%15===0) console.error(`  iter ${it+1}/${iters} (${((Date.now()-t0)/1000).toFixed(1)}s)`);
  }
  let cx=0,cy=0,cz=0; for(const n of allNodes){cx+=n.x;cy+=n.y;cz+=n.z;} cx/=N;cy/=N;cz/=N;
  for (const n of allNodes){ n.x-=cx;n.y-=cy;n.z-=cz; }
}

layout(nodes, edges, clusterKeys);

// ---- normalize to the design's world extent ----
// The design's runtime layout of buildGraph(2400) spans maxAbs ≈ 695, and its camera
// constants (dist 980, fov 760) frame that extent. A 10k-node corpus expands further
// under the same forces, which would put the default camera inside the cloud; rescale
// so the shipped positions match the design's framing exactly.
const DESIGN_EXTENT = 695;
{
  let ext = 0;
  for (const nd of nodes) ext = Math.max(ext, Math.abs(nd.x), Math.abs(nd.y), Math.abs(nd.z));
  const k = DESIGN_EXTENT / ext;
  for (const nd of nodes) { nd.x *= k; nd.y *= k; nd.z *= k; }
}

// ---- quantize to Int16 (same encoding as layout_3d.mjs) ----
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

// ---- patch manifest ----
manifest.positions.scale = maxAbs;
manifest.positions.note = "decode: value/32767*scale";
manifest.positions.layoutModel = "force3d field-clustered (Fibonacci-sphere centers, Barnes-Hut + springs)";
manifest.hashes = manifest.hashes || {};
manifest.hashes["positions.bin"] = createHash("sha256").update(posBin).digest("hex").slice(0, 8);
writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));

// ---- cluster separation sanity check ----
const sums = new Map(clusterKeys.map((k) => [k, [0, 0, 0, 0]]));
nodes.forEach((n) => {
  const s = sums.get(n.field);
  s[0] += n.x; s[1] += n.y; s[2] += n.z; s[3]++;
});
let minCenterDist = Infinity;
const cents = [...sums.values()].map(([x, y, z, c]) => [x / c, y / c, z / c]);
for (let i = 0; i < cents.length; i++) {
  for (let j = i + 1; j < cents.length; j++) {
    const d = Math.hypot(cents[i][0]-cents[j][0], cents[i][1]-cents[j][1], cents[i][2]-cents[j][2]);
    minCenterDist = Math.min(minCenterDist, d);
  }
}
console.error(
  `positions.bin: ${(posBin.length / 1024) | 0} KB raw, ` +
  `${(gzipSync(posBin, { level: 9 }).length / 1024) | 0} KB gz, maxAbs=${maxAbs.toFixed(1)}, ` +
  `min cluster-centroid separation=${minCenterDist.toFixed(1)}`,
);
