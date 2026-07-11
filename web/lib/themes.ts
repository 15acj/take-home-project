// THEMES ported verbatim from the Citation Atlas design (.dc.html).
// Only deepspace/light are wired to the mode toggle, exactly as the design does;
// nebula/observatory ship for parity.

export interface Theme {
  accent: string;
  text: string;
  textDim: string;
  textFaint: string;
  border: string;
  panelBg: string;
  barBg: string;
  cardBg: string;
  inputBg: string;
  chipBg: string;
  botBubble: string;
  trackBg: string;
  bgInner: string;
  bgOuter: string;
  edgeRGB: [number, number, number];
  edgeAlpha: number;
  labelColor: string;
  swatch: string;
  onAccent: string;
  solidBg: string;
  panelShadow: string;
  barShadow: string;
  cardShadow: string;
}

export type ThemeKey = "deepspace" | "light" | "nebula" | "observatory";

export const THEMES: Record<ThemeKey, Theme> = {
  deepspace: {
    accent: "#7fe0ff", text: "#f2f6fc", textDim: "#cbd8ec", textFaint: "#aab8d4",
    border: "rgba(120,160,220,0.15)", panelBg: "#0b1220", barBg: "rgba(6,10,20,0.72)",
    cardBg: "rgba(11,18,32,0.86)", inputBg: "rgba(255,255,255,0.04)", chipBg: "rgba(255,255,255,0.045)",
    botBubble: "rgba(255,255,255,0.05)", trackBg: "rgba(120,160,220,0.2)",
    bgInner: "#0a1224", bgOuter: "#02040a", edgeRGB: [90, 130, 190], edgeAlpha: 0.18,
    labelColor: "rgba(232,238,248,0.92)",
    swatch: "#57d6ff", onAccent: "#04060c", solidBg: "#0b1220",
    panelShadow: "0 20px 50px rgba(0,0,0,0.35)", barShadow: "0 12px 34px rgba(0,0,0,0.32)",
    cardShadow: "0 18px 50px rgba(0,0,0,0.5)",
  },
  light: {
    accent: "#0a6cff", text: "#141b2e", textDim: "#48546c", textFaint: "#8a94aa",
    border: "rgba(30,50,90,0.13)", panelBg: "rgba(255,255,255,0.82)", barBg: "rgba(255,255,255,0.82)",
    cardBg: "rgba(255,255,255,0.9)", inputBg: "rgba(30,50,90,0.045)", chipBg: "rgba(30,50,90,0.045)",
    botBubble: "rgba(30,50,90,0.045)", trackBg: "rgba(30,50,90,0.16)",
    bgInner: "#eef3fa", bgOuter: "#d6deec", edgeRGB: [110, 130, 170], edgeAlpha: 0.28,
    labelColor: "rgba(20,27,46,0.9)",
    swatch: "#0a6cff", onAccent: "#ffffff", solidBg: "#ffffff",
    panelShadow: "0 10px 28px rgba(30,50,90,0.12)", barShadow: "0 6px 18px rgba(30,50,90,0.10)",
    cardShadow: "0 10px 28px rgba(30,50,90,0.15)",
  },
  nebula: {
    accent: "#ea9bff", text: "#f7f1fb", textDim: "#e0d0ec", textFaint: "#c4b4d6",
    border: "rgba(200,140,230,0.16)", panelBg: "#140b1e", barBg: "rgba(11,6,17,0.74)",
    cardBg: "rgba(22,12,32,0.86)", inputBg: "rgba(255,255,255,0.04)", chipBg: "rgba(255,255,255,0.05)",
    botBubble: "rgba(255,255,255,0.05)", trackBg: "rgba(200,140,230,0.22)",
    bgInner: "#160a22", bgOuter: "#050208", edgeRGB: [150, 90, 180], edgeAlpha: 0.18,
    labelColor: "rgba(243,236,248,0.92)",
    swatch: "#e07dff", onAccent: "#04060c", solidBg: "#140b1e",
    panelShadow: "0 20px 50px rgba(0,0,0,0.35)", barShadow: "0 12px 34px rgba(0,0,0,0.32)",
    cardShadow: "0 18px 50px rgba(0,0,0,0.5)",
  },
  observatory: {
    accent: "#f5d47e", text: "#f8f2e6", textDim: "#e8dcc2", textFaint: "#ccbf9c",
    border: "rgba(230,200,150,0.16)", panelBg: "#151009", barBg: "rgba(11,8,4,0.76)",
    cardBg: "rgba(24,18,9,0.88)", inputBg: "rgba(255,255,255,0.035)", chipBg: "rgba(255,255,255,0.04)",
    botBubble: "rgba(255,255,255,0.045)", trackBg: "rgba(230,200,150,0.22)",
    bgInner: "#171207", bgOuter: "#060402", edgeRGB: [180, 150, 90], edgeAlpha: 0.16,
    labelColor: "rgba(244,237,224,0.92)",
    swatch: "#f0c860", onAccent: "#04060c", solidBg: "#151009",
    panelShadow: "0 20px 50px rgba(0,0,0,0.35)", barShadow: "0 12px 34px rgba(0,0,0,0.32)",
    cardShadow: "0 18px 50px rgba(0,0,0,0.5)",
  },
};

export function engineTheme(key: ThemeKey) {
  const th = THEMES[key];
  return {
    bgInner: th.bgInner, bgOuter: th.bgOuter, edgeRGB: th.edgeRGB,
    edgeAlpha: th.edgeAlpha, labelColor: th.labelColor, light: key === "light",
  };
}
