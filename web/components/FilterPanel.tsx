// LEFT "Filter & Search" panel — 296px open / 120px collapsed.
// Search, Corpus Size, Fields, Year (dual sliders + histogram),
// Availability, Min. Citations (slider + sqrt histogram).
import { useRef, type CSSProperties } from "react";
import type { Theme } from "../lib/themes";
import { FIELDS, CLUSTER_KEYS, type ClusterKey } from "../lib/fieldClusters";
import { useAtlasStore, TOPN, YEAR_MIN, YEAR_MAX, CITE_MAX, NBINS } from "../lib/store";

const fmt = (n: number) =>
  n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "") + "K" : "" + n;

const sectionLabel = (t: Theme): CSSProperties => ({
  fontSize: 11.5, letterSpacing: "0.01em", fontWeight: 700, color: t.textDim,
});

export default function FilterPanel({ t }: { t: Theme }) {
  const s = useAtlasStore();
  const set = s.set;
  const kwTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onKeyword = (v: string) => {
    set({ keyword: v });
    if (kwTimer.current) clearTimeout(kwTimer.current);
    kwTimer.current = setTimeout(() => useAtlasStore.setState({ keywordApplied: v }), 240);
  };

  const toggleField = (k: ClusterKey) =>
    set({ activeFields: { ...s.activeFields, [k]: !s.activeFields[k] } });
  const toggleAllFields = () => {
    const allOn = CLUSTER_KEYS.every((k) => s.activeFields[k]);
    set({ activeFields: Object.fromEntries(CLUSTER_KEYS.map((k) => [k, !allOn])) as Record<ClusterKey, boolean> });
  };
  const allOn = CLUSTER_KEYS.every((k) => s.activeFields[k]);

  const loaded = Math.min(s.topN, 10000);
  const corpusNote = `Top ${loaded.toLocaleString()} by citation count`;

  const AVAIL: { key: "availOA" | "availPdf" | "availGrobid"; label: string; count: number }[] = [
    { key: "availOA", label: "Open Access", count: s.availCounts.oa },
    { key: "availPdf", label: "Has PDF Link", count: s.availCounts.pdf },
    { key: "availGrobid", label: "Has GROBID XML", count: s.availCounts.grobid },
  ];

  const yearBins = s.yearBins.length ? s.yearBins : new Array(NBINS).fill(0);
  const yearSpan = (YEAR_MAX + 1 - YEAR_MIN) / yearBins.length;
  const maxYearBin = Math.max(1, ...yearBins);

  const citeBins = s.citeBins.length ? s.citeBins : new Array(NBINS).fill(0);
  const citeSpan = CITE_MAX / citeBins.length;
  const maxCiteBin = Math.max(1, ...citeBins.map((v) => Math.sqrt(v)));

  return (
    <div style={{
      position: "absolute", top: 14, left: 14, zIndex: 20, display: "flex", flexDirection: "column",
      width: s.leftOpen ? 296 : 120, maxHeight: "calc(100% - 124px)", borderRadius: 16,
      background: t.panelBg, border: `1px solid ${t.border}`,
      backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)", boxShadow: t.panelShadow, overflow: "hidden",
    }}>
      {s.leftOpen ? (
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "15px 16px 12px", flex: "0 0 auto" }}>
            <div style={{ fontSize: 12, letterSpacing: "0.02em", fontWeight: 700, color: t.textDim }}>Filter & Search</div>
            <div style={{ flex: 1 }} />
            <button
              onClick={() => set({ leftOpen: false })}
              title="Collapse"
              className="hc"
              style={{ width: 24, height: 24, borderRadius: 7, border: "none", background: "transparent", color: t.textDim, cursor: "pointer", fontSize: 16, lineHeight: 1, ["--hc" as string]: t.text }}
            >
              ‹
            </button>
          </div>

          <div style={{ flex: "0 1 auto", minHeight: 0, overflowY: "auto", padding: "0 12px 18px", marginRight: 6 }}>
            {/* search */}
            <div style={{ position: "relative", marginBottom: 20 }}>
              <input
                type="text"
                value={s.keyword}
                onChange={(e) => onKeyword(e.target.value)}
                placeholder="Search titles, authors…"
                style={{
                  width: "100%", padding: "10px 12px 10px 34px", borderRadius: 10,
                  border: `1px solid ${t.border}`, background: t.inputBg, color: t.text,
                  fontFamily: "'Lato',sans-serif", fontSize: 14,
                }}
              />
              <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: t.textFaint, fontSize: 18 }}>⌕</span>
            </div>

            {/* corpus size */}
            <div style={{ marginBottom: 22 }}>
              <div style={{ ...sectionLabel(t), marginBottom: 9 }}>Corpus Size</div>
              <div style={{ display: "flex", gap: 6 }}>
                {TOPN.map((o) => {
                  const on = o.v === s.topN;
                  return (
                    <button
                      key={o.v}
                      onClick={() => set({ topN: o.v })}
                      style={{
                        flex: 1, padding: "9px 4px", borderRadius: 9, fontSize: 13,
                        fontWeight: on ? 700 : 400, cursor: "pointer", fontFamily: "'Lato',sans-serif",
                        border: `1px solid ${on ? t.accent : t.border}`,
                        background: on ? t.chipBg : "transparent",
                        color: on ? t.text : t.textDim,
                      }}
                    >
                      {o.label}
                    </button>
                  );
                })}
              </div>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: t.textDim, marginTop: 14, fontFamily: "'Lato',sans-serif" }}>
                {corpusNote}
              </div>
            </div>

            {/* fields */}
            <div style={{ marginBottom: 22 }}>
              <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
                <span style={sectionLabel(t)}>Fields</span>
                <span style={{ flex: 1 }} />
                <button
                  onClick={toggleAllFields}
                  style={{ fontSize: 11.5, fontWeight: 700, color: t.accent, background: "none", border: "none", cursor: "pointer", fontFamily: "'Lato',sans-serif" }}
                >
                  {allOn ? "None" : "All"}
                </button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {CLUSTER_KEYS.map((k) => {
                  const on = s.activeFields[k];
                  const col = `rgb(${FIELDS[k].rgb.join(",")})`;
                  return (
                    <button
                      key={k}
                      onClick={() => toggleField(k)}
                      style={{
                        display: "flex", alignItems: "center", gap: 9, padding: "6px 8px 6px 0",
                        borderRadius: 8, cursor: "pointer", background: "transparent",
                        border: "1px solid transparent", opacity: on ? 1 : 0.55,
                        width: "100%", fontFamily: "'Lato',sans-serif", textAlign: "left",
                      }}
                    >
                      <span style={{ width: 7, height: 7, borderRadius: "50%", flex: "0 0 auto", background: on ? col : "transparent" }} />
                      <span style={{ flex: 1, textAlign: "left", fontSize: 13.5, fontWeight: 700, color: on ? t.text : t.textFaint }}>
                        {FIELDS[k].label}
                      </span>
                      <span style={{ fontSize: 12.5, fontWeight: 700, fontFamily: "'Lato',sans-serif", color: t.textDim }}>
                        {(s.fieldCounts[k] || 0).toLocaleString()}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* year */}
            <div style={{ marginBottom: 22 }}>
              <div style={{ display: "flex", alignItems: "center", marginBottom: 11 }}>
                <span style={sectionLabel(t)}>Year</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 11.5, fontWeight: 700, fontFamily: "'Lato',sans-serif", color: t.text }}>
                  {s.yearMin} – {s.yearMax}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 40, marginBottom: 10 }}>
                {yearBins.map((cnt, i) => {
                  const bc = YEAR_MIN + yearSpan * (i + 0.5);
                  const inRange = bc >= s.yearMin && bc <= s.yearMax;
                  const hpct = cnt > 0 ? Math.max(7, Math.round((cnt / maxYearBin) * 100)) : 3;
                  return (
                    <div key={i} style={{
                      flex: "1 1 0", minWidth: 0, height: `${hpct}%`, borderRadius: "2px 2px 0 0",
                      background: inRange ? t.accent : t.trackBg, opacity: inRange ? 0.9 : 0.5,
                    }} />
                  );
                })}
              </div>
              <input
                type="range" min={YEAR_MIN} max={YEAR_MAX} value={s.yearMin}
                onChange={(e) => set({ yearMin: Math.min(+e.target.value, s.yearMax) })}
                style={{ width: "100%", marginBottom: 9, background: t.trackBg }}
              />
              <input
                type="range" min={YEAR_MIN} max={YEAR_MAX} value={s.yearMax}
                onChange={(e) => set({ yearMax: Math.max(+e.target.value, s.yearMin) })}
                style={{ width: "100%", background: t.trackBg }}
              />
            </div>

            {/* availability */}
            <div style={{ marginBottom: 22 }}>
              <div style={{ ...sectionLabel(t), marginBottom: 9 }}>Availability</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {AVAIL.map((a) => {
                  const on = s[a.key];
                  return (
                    <button
                      key={a.key}
                      onClick={() => set({ [a.key]: !on } as Partial<typeof s>)}
                      style={{
                        display: "flex", alignItems: "center", gap: 9, padding: "6px 8px 6px 0",
                        borderRadius: 8, cursor: "pointer", background: "transparent",
                        border: "1px solid transparent", opacity: on ? 1 : 0.6,
                        width: "100%", fontFamily: "'Lato',sans-serif", textAlign: "left",
                      }}
                    >
                      <span style={{
                        display: "flex", alignItems: "center", justifyContent: "center",
                        width: 16, height: 16, flex: "0 0 auto", borderRadius: 5,
                        fontSize: 11, fontWeight: 900,
                        border: `1px solid ${on ? t.accent : t.border}`,
                        background: on ? t.accent : "transparent", color: t.onAccent,
                      }}>
                        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke={t.onAccent} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: on ? 1 : 0, display: "block" }}>
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      </span>
                      <span style={{ flex: 1, textAlign: "left", fontSize: 13.5, fontWeight: 700, color: on ? t.text : t.textFaint }}>
                        {a.label}
                      </span>
                      <span style={{ fontSize: 12.5, fontWeight: 700, fontFamily: "'Lato',sans-serif", color: t.textDim }}>
                        {(a.count || 0).toLocaleString()}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* min citations */}
            <div>
              <div style={{ display: "flex", alignItems: "center", marginBottom: 11 }}>
                <span style={sectionLabel(t)}>Min. Citations</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 11.5, fontWeight: 700, fontFamily: "'Lato',sans-serif", color: t.text }}>
                  {fmt(s.minCites)}+
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 40, marginBottom: 10 }}>
                {citeBins.map((cnt, i) => {
                  const bcv = citeSpan * (i + 0.5);
                  const inRange = bcv >= s.minCites;
                  const hpct = cnt > 0 ? Math.max(7, Math.round((Math.sqrt(cnt) / maxCiteBin) * 100)) : 3;
                  return (
                    <div key={i} style={{
                      flex: "1 1 0", minWidth: 0, height: `${hpct}%`, borderRadius: "2px 2px 0 0",
                      background: inRange ? t.accent : t.trackBg, opacity: inRange ? 0.9 : 0.5,
                    }} />
                  );
                })}
              </div>
              <input
                type="range" min={0} max={CITE_MAX} step={500} value={s.minCites}
                onChange={(e) => set({ minCites: +e.target.value })}
                style={{ width: "100%", background: t.trackBg }}
              />
            </div>
          </div>
        </div>
      ) : (
        <button
          onClick={() => set({ leftOpen: true })}
          title="Expand filters"
          className="hc"
          style={{
            width: "100%", display: "flex", alignItems: "center", gap: 9, padding: "13px 14px",
            background: "none", border: "none", color: t.textDim, cursor: "pointer",
            whiteSpace: "nowrap", ["--hc" as string]: t.text,
          }}
        >
          <span style={{ fontSize: 20 }}>⌕</span>
          <span style={{ fontSize: 13, letterSpacing: "0.01em", fontWeight: 700, fontFamily: "'Lato',sans-serif" }}>Filters</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 14, lineHeight: 1 }}>›</span>
        </button>
      )}
    </div>
  );
}
