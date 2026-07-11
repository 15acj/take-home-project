// Bottom-right controls hint chips: Drag / Shift-drag / Scroll / Click.
import type { Theme } from "../lib/themes";

const HINTS: [string, string][] = [
  ["Drag", "Rotate"],
  ["Shift-drag", "Pan"],
  ["Scroll", "Zoom"],
  ["Click", "Select"],
];

export default function ControlsHint({ t }: { t: Theme }) {
  return (
    <div style={{ position: "absolute", bottom: 14, right: 14, width: 400, zIndex: 20, display: "flex", justifyContent: "center", pointerEvents: "none" }}>
      <div style={{
        width: "100%", display: "flex", flexWrap: "nowrap", justifyContent: "space-between", gap: "6px 10px",
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
      </div>
    </div>
  );
}
