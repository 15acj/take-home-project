// "Full Text" capability badge — shown when a paper has GROBID XML available, i.e.
// structured full text + figures the copilot can read and answer questions about.
// `chip` shows the icon + label (Paper tab); `icon` is a compact icon-only variant.
// Both share the portaled hover tooltip. Driven by node.hasGrobid (first-paint).
import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
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

// Shared hover tooltip: portaled to <body> with fixed positioning so it can't be
// clipped by a panel's overflow:hidden or trapped beneath a higher-z sibling panel.
// `align` picks which edge of the tooltip lines up with the anchor: "right" opens
// up-left (compact icon near a right edge), "left" opens up-right (the wider chip).
function Tip({ t, align, children }: { t: Theme; align: "left" | "right"; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ left: align === "right" ? r.right : r.left, top: r.top });
  };
  const hide = () => setPos(null);

  return (
    <span
      ref={ref}
      onMouseEnter={show}
      onMouseLeave={hide}
      style={{ display: "inline-flex", alignItems: "center", flex: "0 0 auto", cursor: "pointer" }}
    >
      {children}
      {pos && typeof document !== "undefined" && createPortal(
        <div
          style={{
            position: "fixed", left: pos.left, top: pos.top,
            transform: `translate(${align === "right" ? "-100%" : "0"}, calc(-100% - 8px))`,
            width: "max-content", maxWidth: 220, zIndex: 9999, pointerEvents: "none",
            padding: "8px 10px", borderRadius: 9,
            // Composite a translucent surface from the theme's solid bg so the blur
            // actually reads (the raw panel/card tokens are near-opaque in dark mode).
            background: `color-mix(in srgb, ${t.solidBg} 38%, transparent)`,
            border: `1px solid ${t.border}`,
            backdropFilter: "blur(30px) saturate(1.8)", WebkitBackdropFilter: "blur(30px) saturate(1.8)",
            boxShadow: t.barShadow, color: t.text, fontSize: 11.5, fontWeight: 600, lineHeight: 1.45,
            fontFamily: "'Lato',sans-serif", textAlign: "left", animation: "fadeop .14s ease",
          }}
        >
          {TOOLTIP}
        </div>,
        document.body,
      )}
    </span>
  );
}

export default function FullTextBadge({ t, variant = "chip" }: { t: Theme; variant?: "chip" | "icon" }) {
  if (variant === "icon") {
    return (
      <Tip t={t} align="right">
        <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 15, height: 15, flex: "0 0 auto", color: t.accent }}>
          <DocIcon size={12} />
        </span>
      </Tip>
    );
  }
  return (
    <Tip t={t} align="left">
      <span
        style={{
          display: "inline-flex", alignItems: "center", gap: 7, padding: "6px 12px",
          borderRadius: 8, background: t.chipBg, border: `1px solid ${t.border}`,
          fontSize: 11.5, fontWeight: 700, color: t.accent, fontFamily: "'Lato',sans-serif",
          lineHeight: 1, whiteSpace: "nowrap",
        }}
      >
        <DocIcon size={12} />
        Full Text
      </span>
    </Tip>
  );
}
