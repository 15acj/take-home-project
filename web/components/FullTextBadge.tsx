// "Full text" capability badge — shown when a paper has GROBID XML available, i.e.
// structured full text + figures the copilot can read and answer questions about.
// `chip` shows the icon + label (Paper tab); `icon` is a compact icon-only variant
// with the same tooltip (hover card, selection chips). Driven by node.hasGrobid,
// which is first-paint (no shard fetch).
import type { Theme } from "../lib/themes";

const TOOLTIP =
  "Full text available — the copilot can read and answer questions about the whole paper, including figures.";

function DocIcon({ size = 11 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: "block", flex: "0 0 auto" }}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h6" />
    </svg>
  );
}

export default function FullTextBadge({ t, variant = "chip" }: { t: Theme; variant?: "chip" | "icon" }) {
  if (variant === "icon") {
    return (
      <span
        title={TOOLTIP}
        style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 15, height: 15, flex: "0 0 auto", color: t.accent }}
      >
        <DocIcon size={12} />
      </span>
    );
  }
  return (
    <span
      title={TOOLTIP}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 9px",
        borderRadius: 7, background: t.chipBg, border: `1px solid ${t.border}`,
        fontSize: 11.5, fontWeight: 700, color: t.accent, fontFamily: "'Lato',sans-serif",
        lineHeight: 1, whiteSpace: "nowrap",
      }}
    >
      <DocIcon size={12} />
      Full text
    </span>
  );
}
