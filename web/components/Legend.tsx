// Bottom-left legend: one dot per visual cluster, 4-column grid.
import type { Theme } from "../lib/themes";
import { FIELDS, CLUSTER_KEYS } from "../lib/fieldClusters";

export default function Legend({ t }: { t: Theme }) {
  return (
    <div style={{
      position: "absolute", left: 16, bottom: 14, zIndex: 20,
      display: "grid", gridTemplateColumns: "repeat(4, max-content)", gap: "8px 16px",
      padding: "10px 14px", borderRadius: 12, background: t.panelBg, border: `1px solid ${t.border}`,
      backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)",
    }}>
      {CLUSTER_KEYS.map((k) => (
        <div key={k} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, fontWeight: 700, color: t.textDim }}>
          <span style={{ width: 9, height: 9, borderRadius: "50%", background: `rgb(${FIELDS[k].rgb.join(",")})` }} />
          {FIELDS[k].label}
        </div>
      ))}
    </div>
  );
}
