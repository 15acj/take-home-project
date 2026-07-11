// Top-center stats pill: papers / citations / selected, Reset View, mode toggle.
import type { CSSProperties } from "react";
import type { Theme } from "../lib/themes";
import { useAtlasStore } from "../lib/store";
import type { AtlasActions } from "./CitationAtlas";

export default function StatsBar({ t, actions }: { t: Theme; actions: AtlasActions }) {
  const shownCount = useAtlasStore((s) => s.shownCount);
  const edgeCount = useAtlasStore((s) => s.edgeCount);
  const selCount = useAtlasStore((s) => s.selectedIds.length);
  const themeKey = useAtlasStore((s) => s.themeKey);

  const btn: CSSProperties = {
    display: "flex", alignItems: "center", gap: 6, padding: "7px 12px", borderRadius: 8,
    border: "none", background: t.chipBg, color: t.textDim,
    fontFamily: "'Lato',sans-serif", fontSize: 12, fontWeight: 700, cursor: "pointer",
  };

  return (
    <div style={{
      position: "absolute", top: 14, left: "50%", transform: "translateX(-50%)", zIndex: 22,
      display: "flex", alignItems: "center", gap: 14, padding: "8px 8px 8px 16px",
      borderRadius: 12, background: t.solidBg, border: `1px solid ${t.border}`, boxShadow: t.barShadow,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, fontFamily: "'Lato',sans-serif", fontSize: 12, color: t.textDim }}>
        <div><span style={{ color: t.text, fontWeight: 700 }}>{shownCount.toLocaleString()}</span> papers</div>
        <div><span style={{ color: t.text, fontWeight: 700 }}>{edgeCount.toLocaleString()}</span> citations</div>
        <div><span style={{ color: t.text, fontWeight: 700 }}>{selCount}</span> selected</div>
      </div>
      <div style={{ width: 1, height: 20, background: t.border }} />
      <button onClick={() => actions.resetView()} className="hc" style={{ ...btn, ["--hc" as string]: t.text }}>
        Reset View
      </button>
      <button
        onClick={() => actions.toggleMode()}
        title="Toggle light / dark mode"
        className="hc"
        style={{
          display: "flex", alignItems: "center", justifyContent: "center", width: 32, height: 32,
          borderRadius: 8, border: "none", background: t.chipBg, color: t.textDim,
          fontSize: 14, lineHeight: 1, cursor: "pointer", ["--hc" as string]: t.text,
        }}
      >
        {themeKey === "light" ? "☾" : "☀"}
      </button>
    </div>
  );
}
