// Bottom-right controls hint chips: Drag / Shift-drag / Scroll, plus manual zoom
// buttons (replacing the old Click/Select hint) for users who prefer buttons over scroll.
import type { Theme } from "../lib/themes";
import type { AtlasActions } from "./CitationAtlas";

const HINTS: [string, string][] = [
  ["Drag", "Rotate"],
  ["Shift-drag", "Pan"],
  ["Scroll", "Zoom"],
];

export default function ControlsHint({ t, actions }: { t: Theme; actions: AtlasActions }) {
  const zoomBtn = {
    display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26,
    borderRadius: 7, border: `1px solid ${t.border}`, background: t.chipBg, color: t.text,
    cursor: "pointer", pointerEvents: "auto", ["--hc" as string]: t.text,
  } as const;

  return (
    <div style={{ position: "absolute", bottom: 14, right: 14, width: 400, zIndex: 20, display: "flex", justifyContent: "center", pointerEvents: "none" }}>
      <div style={{
        width: "100%", display: "flex", flexWrap: "nowrap", alignItems: "center", justifyContent: "space-between", gap: "6px 10px",
        padding: "9px 12px", borderRadius: 12, background: t.panelBg, border: `1px solid ${t.border}`,
        backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)", boxShadow: t.barShadow, boxSizing: "border-box",
      }}>
        {HINTS.map(([chip, label]) => (
          <div key={chip} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{
              padding: "3px 8px", borderRadius: 6, border: `1px solid ${t.border}`, background: t.chipBg,
              fontSize: 10.5, fontWeight: 700, color: t.text, whiteSpace: "nowrap",
            }}>{chip}</span>
            <span style={{ fontSize: 11.5, color: t.textDim }}>{label}</span>
          </div>
        ))}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button onClick={() => actions.zoom(-1)} title="Zoom out" aria-label="Zoom out" className="hc" style={zoomBtn}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: "block" }}>
              <circle cx="10.5" cy="10.5" r="6.5" />
              <path d="M20 20l-5-5M7.5 10.5h6" />
            </svg>
          </button>
          <button onClick={() => actions.zoom(1)} title="Zoom in" aria-label="Zoom in" className="hc" style={zoomBtn}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: "block" }}>
              <circle cx="10.5" cy="10.5" r="6.5" />
              <path d="M20 20l-5-5M7.5 10.5h6M10.5 7.5v6" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
