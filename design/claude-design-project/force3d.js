// Self-contained 3D force-directed graph engine rendered on a 2D canvas
// with a rotating perspective camera. No external dependencies.
// Layout is computed once for the full graph; filtering toggles node
// visibility so positions stay stable and filtering is instant.

function mulberry32(a){return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}

// ---- Barnes-Hut octree for O(n log n) repulsion ----
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

export class ForceGraph3D {
  constructor(canvas, opts = {}) {
    this.canvas = canvas; this.ctx = canvas.getContext("2d");
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.allNodes=[]; this.allEdges=[]; this.adj=new Map(); this.visible=new Set();
    this.theme = opts.theme; this.fields = opts.fields;
    this.onSelect = opts.onSelect || (()=>{});
    this.onHover = opts.onHover || (()=>{});
    this.onHud = opts.onHud || (()=>{});
    this.selected = new Set(); this.hoverId = -1;
    this.yaw=0.6; this.pitch=-0.32; this.dist=980; this.panX=0; this.panY=0;
    this.targetYaw=this.yaw; this.targetPitch=this.pitch; this.targetDist=this.dist;
    this.autoRotate=true; this.fov=760; this._projCache=[];
    this._bindEvents(); this.resize();
    this._raf = requestAnimationFrame(this._loop.bind(this));
  }

  setTheme(t){ this.theme = t; }

  setData(nodes, edges) {
    this.allNodes = nodes.map(n => ({ ...n }));
    this.idIndex = new Map(this.allNodes.map((n,i)=>[n.id,i]));
    this.adj = new Map(); for (const n of this.allNodes) this.adj.set(n.id, []);
    this.allEdges = [];
    for (const e of edges) {
      const si=this.idIndex.get(e.source), ti=this.idIndex.get(e.target);
      if (si===undefined||ti===undefined) continue;
      this.allEdges.push([si, ti, e.cross]);
      this.adj.get(e.source).push(e.target); this.adj.get(e.target).push(e.source);
    }
    this._layout();
    this.visible = new Set(this.allNodes.map(n=>n.id));
  }

  setVisible(idSet){ this.visible = idSet; }

  _layout() {
    const rand = mulberry32(7);
    const fieldKeys = Object.keys(this.fields);
    const centers = {};
    fieldKeys.forEach((f, i) => {
      const phi = Math.acos(1 - 2*(i+0.5)/fieldKeys.length);
      const theta = Math.PI*(1+Math.sqrt(5))*(i+0.5); const R=360;
      centers[f] = [R*Math.sin(phi)*Math.cos(theta), R*Math.sin(phi)*Math.sin(theta), R*Math.cos(phi)];
    });
    const maxC = Math.max(...this.allNodes.map(n=>n.citations));
    for (const n of this.allNodes) {
      const c = centers[n.field];
      const spread = 120 + (1 - n.citations/maxC)*260;
      n.x = c[0]*(0.55+0.45*(1-n.citations/maxC)) + (rand()-0.5)*spread;
      n.y = c[1]*(0.55+0.45*(1-n.citations/maxC)) + (rand()-0.5)*spread;
      n.z = c[2]*(0.55+0.45*(1-n.citations/maxC)) + (rand()-0.5)*spread;
      n.vx=n.vy=n.vz=0; n.r = 1.6 + Math.sqrt(n.citations)/22;
    }
    const N=this.allNodes.length;
    const iters = N>1500?90:140;
    const springLen=46, springK=0.02, repel=2600*(N>1200?0.7:1), theta=1.1, damping=0.86;
    for (let it=0; it<iters; it++) {
      let minx=1e9,miny=1e9,minz=1e9,maxx=-1e9,maxy=-1e9,maxz=-1e9;
      for (const n of this.allNodes){ if(n.x<minx)minx=n.x; if(n.y<miny)miny=n.y; if(n.z<minz)minz=n.z; if(n.x>maxx)maxx=n.x; if(n.y>maxy)maxy=n.y; if(n.z>maxz)maxz=n.z; }
      const cx=(minx+maxx)/2, cy=(miny+maxy)/2, cz=(minz+maxz)/2;
      const half=Math.max(maxx-minx,maxy-miny,maxz-minz)/2+10;
      const tree=new Octree(cx,cy,cz,half);
      for (const n of this.allNodes) tree.insert(n);
      const out={x:0,y:0,z:0};
      for (const n of this.allNodes){ out.x=0;out.y=0;out.z=0; tree.force(n,theta,repel,out);
        n.vx+=out.x; n.vy+=out.y; n.vz+=out.z; n.vx-=n.x*0.012; n.vy-=n.y*0.012; n.vz-=n.z*0.012; }
      for (const [si,ti] of this.allEdges){ const a=this.allNodes[si], b=this.allNodes[ti];
        let dx=b.x-a.x,dy=b.y-a.y,dz=b.z-a.z; const d=Math.sqrt(dx*dx+dy*dy+dz*dz)+0.01;
        const f=(d-springLen)*springK; const fx=(dx/d)*f, fy=(dy/d)*f, fz=(dz/d)*f;
        a.vx+=fx;a.vy+=fy;a.vz+=fz; b.vx-=fx;b.vy-=fy;b.vz-=fz; }
      for (const n of this.allNodes){ n.vx*=damping;n.vy*=damping;n.vz*=damping; n.x+=n.vx;n.y+=n.vy;n.z+=n.vz; }
    }
    let cx=0,cy=0,cz=0; for(const n of this.allNodes){cx+=n.x;cy+=n.y;cz+=n.z;} cx/=N;cy/=N;cz/=N;
    for (const n of this.allNodes){ n.x-=cx;n.y-=cy;n.z-=cz; }
  }

  setSelection(set){ this.selected = new Set(set); }
  toggleSelect(id){ if(this.selected.has(id)) this.selected.delete(id); else this.selected.add(id); }
  setHover(id){ this.hoverId=id; }

  focusNode(id){ const i=this.idIndex.get(id); if(i===undefined)return; this.autoRotate=false; this._focusTarget=this.allNodes[i]; this.targetDist=360; }
  resetView(){ this.autoRotate=true; this._focusTarget=null; this.targetDist=980; this.panX=0; this.panY=0; this.targetPitch=-0.32; }

  resize() {
    const rect=this.canvas.getBoundingClientRect();
    this.w=rect.width; this.h=rect.height;
    this.canvas.width=Math.max(1,rect.width*this.dpr); this.canvas.height=Math.max(1,rect.height*this.dpr);
    this.ctx.setTransform(this.dpr,0,0,this.dpr,0,0);
  }

  _bindEvents() {
    const c=this.canvas; let dragging=false,panning=false,moved=false,lx=0,ly=0,downX=0,downY=0;
    c.addEventListener("pointerdown", e => { dragging=true; moved=false; panning=(e.button===2||e.shiftKey||e.metaKey);
      lx=e.clientX; ly=e.clientY; downX=e.clientX; downY=e.clientY; this.autoRotate=false; this._focusTarget=null;
      try{c.setPointerCapture(e.pointerId);}catch(_){}} );
    c.addEventListener("pointermove", e => { const rect=c.getBoundingClientRect(); this._mouse={x:e.clientX-rect.left,y:e.clientY-rect.top};
      if (dragging){ const dx=e.clientX-lx,dy=e.clientY-ly; lx=e.clientX; ly=e.clientY;
        if (Math.abs(e.clientX-downX)+Math.abs(e.clientY-downY)>4) moved=true;
        if (panning){ this.panX+=dx; this.panY+=dy; }
        else { this.targetYaw+=dx*0.006; this.targetPitch+=dy*0.006; this.targetPitch=Math.max(-1.45,Math.min(1.45,this.targetPitch)); }
      } else this._hoverPick(); });
    c.addEventListener("pointerup", e => { dragging=false; if(!moved) this._clickPick(); try{c.releasePointerCapture(e.pointerId);}catch(_){}} );
    c.addEventListener("pointerleave", ()=>{ if(this.hoverId!==-1){ this.hoverId=-1; this.onHover(null);} });
    c.addEventListener("contextmenu", e=>e.preventDefault());
    c.addEventListener("wheel", e=>{ e.preventDefault(); this.targetDist*=(1+Math.sign(e.deltaY)*0.12); this.targetDist=Math.max(180,Math.min(2600,this.targetDist)); }, {passive:false});
  }

  _project(n) {
    const cy=Math.cos(this.yaw), sy=Math.sin(this.yaw);
    let x=n.x*cy - n.z*sy, z=n.x*sy + n.z*cy, y=n.y;
    const cp=Math.cos(this.pitch), sp=Math.sin(this.pitch);
    let y2=y*cp - z*sp, z2=y*sp + z*cp;
    const zc=z2 + this.dist; if (zc<=1) return null;
    const scale=this.fov/zc;
    return { sx:this.w/2+this.panX+x*scale, sy:this.h/2+this.panY+y2*scale, depth:zc, scale };
  }

  _hoverPick(){ if(!this._mouse)return; const id=this._pickAt(this._mouse.x,this._mouse.y);
    if (id!==this.hoverId){ this.hoverId=id; this.onHover(id>=0?this.allNodes[this.idIndex.get(id)]:null); }
    this.canvas.style.cursor = id>=0?"pointer":"grab"; }
  _clickPick(){ if(!this._mouse)return; const id=this._pickAt(this._mouse.x,this._mouse.y);
    if (id>=0){ this.toggleSelect(id); this.onSelect(this.allNodes[this.idIndex.get(id)]); } }
  _pickAt(mx,my){ let best=-1,bestDepth=1e9;
    for (const p of this._projCache){ if(!p.proj)continue; const dx=p.proj.sx-mx,dy=p.proj.sy-my;
      const rad=Math.max(6,p.node.r*p.proj.scale+4); const d=Math.sqrt(dx*dx+dy*dy);
      if (d<rad && p.proj.depth<bestDepth){ best=p.node.id; bestDepth=p.proj.depth; } }
    return best; }

  _loop() {
    this._raf=requestAnimationFrame(this._loop.bind(this));
    if (this.autoRotate) this.targetYaw+=0.0006;
    this.yaw+=(this.targetYaw-this.yaw)*0.1; this.pitch+=(this.targetPitch-this.pitch)*0.1; this.dist+=(this.targetDist-this.dist)*0.09;
    if (this._focusTarget){ const p=this._project(this._focusTarget); if(p){ this.panX+=(this.w/2-p.sx)*0.1; this.panY+=(this.h/2-p.sy)*0.1; } }
    this._render();
  }

  _render() {
    const ctx=this.ctx, th=this.theme; const light=!!th.light;
    const g=ctx.createRadialGradient(this.w*0.5,this.h*0.44,40,this.w*0.5,this.h*0.5,Math.max(this.w,this.h)*0.82);
    g.addColorStop(0,th.bgInner); g.addColorStop(1,th.bgOuter);
    ctx.fillStyle=g; ctx.fillRect(0,0,this.w,this.h);

    const cache=[];
    for (const n of this.allNodes){ if(!this.visible.has(n.id))continue; cache.push({node:n, proj:this._project(n)}); }
    cache.sort((a,b)=>(b.proj?b.proj.depth:1e9)-(a.proj?a.proj.depth:1e9));
    this._projCache=cache;
    const projById=new Map(); for (const c of cache) if(c.proj) projById.set(c.node.id,c.proj);

    ctx.globalCompositeOperation=light?"source-over":"lighter"; ctx.lineWidth=1;
    const hoverN=this.hoverId>=0 && this.visible.has(this.hoverId) ? this.allNodes[this.idIndex.get(this.hoverId)] : null;
    const neighborSet=new Set();
    if (hoverN){ neighborSet.add(hoverN.id); for (const nb of this.adj.get(hoverN.id)) neighborSet.add(nb); }
    for (const [si,ti] of this.allEdges) {
      const a=this.allNodes[si], b=this.allNodes[ti];
      const pa=projById.get(a.id), pb=projById.get(b.id); if(!pa||!pb) continue;
      const involved = hoverN && neighborSet.has(a.id) && neighborSet.has(b.id);
      const selInvolved = this.selected.has(a.id)||this.selected.has(b.id);
      let alpha = th.edgeAlpha*Math.min(1,900/((pa.depth+pb.depth)/2));
      if (hoverN && !involved) alpha*=0.1;
      if (involved) alpha=0.55; if (selInvolved) alpha=Math.max(alpha,0.42);
      if (alpha<0.01) continue;
      const col = (involved||selInvolved)?this.fields[a.field].rgb:th.edgeRGB;
      ctx.strokeStyle=`rgba(${col[0]},${col[1]},${col[2]},${alpha})`;
      ctx.beginPath(); ctx.moveTo(pa.sx,pa.sy); ctx.lineTo(pb.sx,pb.sy); ctx.stroke();
    }

    for (const c of cache) {
      const p=c.proj; if(!p)continue; const n=c.node;
      const [r,gc,bl]=this.fields[n.field].rgb;
      const size=Math.max(1.3,n.r*p.scale);
      let bright=Math.min(1,640/p.depth);
      if (hoverN && !neighborSet.has(n.id)) bright*=0.26;
      const isSel=this.selected.has(n.id);
      const halo=size*(isSel?4.0:(n.famous?3.0:2.3));
      const grd=ctx.createRadialGradient(p.sx,p.sy,0,p.sx,p.sy,halo);
      grd.addColorStop(0,`rgba(${r},${gc},${bl},${0.4*bright})`);
      grd.addColorStop(0.45,`rgba(${r},${gc},${bl},${0.1*bright})`);
      grd.addColorStop(1,`rgba(${r},${gc},${bl},0)`);
      ctx.fillStyle=grd; ctx.beginPath(); ctx.arc(p.sx,p.sy,halo,0,7); ctx.fill();
      ctx.fillStyle=`rgba(${Math.round(r*0.8)},${Math.round(gc*0.8)},${Math.round(bl*0.8)},${bright*0.8})`;
      ctx.beginPath(); ctx.arc(p.sx,p.sy,size,0,7); ctx.fill();
    }

    ctx.globalCompositeOperation="source-over";
    for (const c of cache) {
      const p=c.proj; if(!p)continue; const n=c.node; if(!this.selected.has(n.id))continue;
      const [r,gc,bl]=this.fields[n.field].rgb; const size=Math.max(1.3,n.r*p.scale);
      ctx.strokeStyle="rgba(255,255,255,0.92)"; ctx.lineWidth=1.6; ctx.beginPath(); ctx.arc(p.sx,p.sy,size+6,0,7); ctx.stroke();
      ctx.strokeStyle=`rgba(${r},${gc},${bl},0.9)`; ctx.lineWidth=1.6; ctx.beginPath(); ctx.arc(p.sx,p.sy,size+9.5,0,7); ctx.stroke();
    }

    ctx.textBaseline="middle";
    const labelable=cache.filter(c=>c.proj && (c.node.id===this.hoverId || this.selected.has(c.node.id) || (c.node.famous && c.proj.depth<this.dist*0.9)))
      .sort((a,b)=>a.proj.depth-b.proj.depth).slice(0,16);
    for (const c of labelable) {
      const p=c.proj, n=c.node; const size=Math.max(1.3,n.r*p.scale);
      const txt=n.title.length>44?n.title.slice(0,42)+"…":n.title;
      const tx=p.sx+size+16, ty=p.sy;
      const strong = n.id===this.hoverId||this.selected.has(n.id);
      ctx.font = strong?"900 13.5px 'Lato', system-ui":"700 12.5px 'Lato', system-ui";
      const wdt=ctx.measureText(txt).width;
      ctx.fillStyle=light?"rgba(255,255,255,0.78)":"rgba(0,0,0,0.5)"; ctx.fillRect(tx-4,ty-9,wdt+8,18);
      ctx.fillStyle=strong?(light?"#0a1020":"#ffffff"):th.labelColor; ctx.fillText(txt,tx,ty);
    }

    this._hudTick=(this._hudTick||0)+1;
    if (this._hudTick%2===0) {
      const sel=[...this.selected].filter(id=>this.visible.has(id));
      const last=sel[sel.length-1]; let card=null;
      if (this.hoverId>=0 && projById.get(this.hoverId)){ const p=projById.get(this.hoverId); card={id:this.hoverId,x:p.sx,y:p.sy,hover:true}; }
      else if (last!==undefined && projById.get(last)){ const p=projById.get(last); card={id:last,x:p.sx,y:p.sy,hover:false}; }
      this.onHud({ card });
    }
  }

  dispose(){ cancelAnimationFrame(this._raf); }
}
