// Floating hover/selection detail card (288px). Rendered inside the wrapper div
// that CitationAtlas positions imperatively via the engine's onHud callback.
// Uses first-paint data only — no shard fetch needed here.
import type { CSSProperties, MutableRefObject } from "react";
import type { Theme } from "../lib/themes";
import type { AtlasData } from "../lib/loaders";
import { FIELDS } from "../lib/fieldClusters";
import { useAtlasStore } from "../lib/store";
import type { AtlasActions } from "./CitationAtlas";

const darken = (rgb: number[]) =>
  `rgb(${Math.round(rgb[0] * 0.5)},${Math.round(rgb[1] * 0.5)},${Math.round(rgb[2] * 0.5)})`;

export default function HoverCard({
  t, dataRef, actions,
}: {
  t: Theme;
  dataRef: MutableRefObject<AtlasData | null>;
  actions: AtlasActions;
}) {
  const cardNodeId = useAtlasStore((s) => s.cardNodeId);
  const selectedIds = useAtlasStore((s) => s.selectedIds);
  const themeKey = useAtlasStore((s) => s.themeKey);
  const light = themeKey === "light";

  const node = cardNodeId !== null ? dataRef.current?.nodes[cardNodeId] : null;
  if (!node) return null;

  const rgb = FIELDS[node.field].rgb;
  const color = `rgb(${rgb.join(",")})`;
  const labelColor = light ? darken(rgb) : color;
  const degree = actions.degree(node.id);
  const sel = selectedIds.includes(node.id);

  return (
    <div style={{
      padding: "14px 15px 15px", borderRadius: 14, background: t.cardBg, border: `1px solid ${t.border}`,
      boxShadow: t.cardShadow, backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9 }}>
        <span style={{ width: 9, height: 9, borderRadius: "50%", background: color }} />
        <span style={{ fontSize: 11.5, letterSpacing: "0.02em", color: labelColor, fontWeight: 900 }}>
          {FIELDS[node.field].label}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11.5, fontFamily: "'Lato',sans-serif", color: t.textFaint }}>
          #{node.rank.toLocaleString()}
        </span>
        <button
          onClick={() => actions.closeCard()}
          title="Close"
          className="hc"
          style={{
            width: 20, height: 20, margin: "-3px -3px -3px 2px", border: "none", background: "transparent",
            color: t.textFaint, cursor: "pointer", fontSize: 16, lineHeight: 1, ["--hc" as string]: t.text,
          }}
        >
          ×
        </button>
      </div>
      <div style={{ fontSize: 15.5, fontWeight: 700, lineHeight: 1.34, marginBottom: 8, textWrap: "pretty" } as CSSProperties}>
        {node.title}
      </div>
      <div style={{ fontSize: 13, color: t.textDim, marginBottom: 12 }}>
        {node.authors} · {node.year}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 13 }}>
        <div>
          <div style={{ fontSize: 19, fontWeight: 600, fontFamily: "'Lato',sans-serif", color: t.text }}>
            {node.citations.toLocaleString()}
          </div>
          <div style={{ fontSize: 11, color: t.textFaint, letterSpacing: "0.04em" }}>Citations</div>
        </div>
        <div>
          <div style={{ fontSize: 19, fontWeight: 600, fontFamily: "'Lato',sans-serif", color: t.text }}>
            {degree}
          </div>
          <div style={{ fontSize: 11, color: t.textFaint, letterSpacing: "0.04em" }}>Links</div>
        </div>
      </div>
      <button
        onClick={() => actions.toggleSelect(node.id)}
        style={{
          width: "100%", padding: 9, borderRadius: 9, cursor: "pointer",
          fontFamily: "'Lato',sans-serif", fontSize: 12.5, fontWeight: 500,
          border: `1px solid ${sel ? t.border : t.accent}`,
          background: sel ? "transparent" : t.accent,
          color: sel ? t.textDim : t.onAccent,
        }}
      >
        {sel ? "Remove from selection" : "Add to selection"}
      </button>
    </div>
  );
}
