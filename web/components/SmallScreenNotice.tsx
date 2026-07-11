// Full-screen overlay shown when the viewport is too narrow for the atlas UI.
// The map plus its stats bar, filter panel, and copilot panel need horizontal
// room; below MIN_WIDTH we ask the user to widen their window instead.
import { useEffect, useState } from "react";
import type { Theme } from "../lib/themes";

const MIN_WIDTH = 1300;

export default function SmallScreenNotice({ t }: { t: Theme }) {
  const [tooSmall, setTooSmall] = useState(false);

  useEffect(() => {
    const check = () => setTooSmall(window.innerWidth < MIN_WIDTH);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  if (!tooSmall) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: "0 32px",
        gap: 12,
        background: t.solidBg,
        color: t.text,
        fontFamily: "'Lato',system-ui,sans-serif",
      }}
    >
      <div style={{ fontSize: 40, lineHeight: 1 }}>🖥️</div>
      <div style={{ fontSize: 18, fontWeight: 700 }}>Best viewed on a larger screen</div>
      <div style={{ fontSize: 14, color: t.textDim, maxWidth: 360 }}>
        The Research Atlas is designed for wider displays. Please widen your window
        or open it on a screen at least {MIN_WIDTH}px wide to explore the map.
      </div>
    </div>
  );
}
