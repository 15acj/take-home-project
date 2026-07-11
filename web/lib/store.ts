// Central UI state, mirroring the design component's this.state one-to-one.
// The engine + loaded data live in refs owned by CitationAtlas (imperative
// singletons, as in the design); this store holds everything renderable.
import { create } from "zustand";
import type { ClusterKey } from "./fieldClusters";
import { CLUSTER_KEYS } from "./fieldClusters";
import type { ContentTypeKey } from "./contentTypes";
import { CONTENT_TYPE_KEYS } from "./contentTypes";
import type { ThemeKey } from "./themes";

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

export interface AvailCounts {
  oa: number;
  pdf: number;
  grobid: number;
}

// Design bounds were 1935-2024 over fake data; the real per-year corpus runs
// through 2026, so the slider max follows it (same visuals, honest range).
export const YEAR_MIN = 1935;
export const YEAR_MAX = 2026;
export const CITE_MAX = 40000;
export const NBINS = 30;

// Corpus size options: the design offered 100/1K/10K/100K over fake data;
// the real corpus caps at 10K, so the ladder is 100/1K/5K/10K.
export const TOPN: { v: number; label: string }[] = [
  { v: 100, label: "100" },
  { v: 1000, label: "1K" },
  { v: 5000, label: "5K" },
  { v: 10000, label: "10K" },
];

export const GREETING: ChatMessage = {
  role: "assistant",
  text: "Hi — I'm your research copilot. Click papers in the graph to select them, then ask me to summarize, compare, or explain their methods.",
};

export interface AtlasState {
  themeKey: ThemeKey;
  leftOpen: boolean;
  rightOpen: boolean;
  keyword: string;
  keywordApplied: string;
  topN: number;
  yearMin: number;
  yearMax: number;
  minCites: number;
  activeFields: Record<ClusterKey, boolean>;
  activeTypes: Record<ContentTypeKey, boolean>;
  availOA: boolean;
  availPdf: boolean;
  availGrobid: boolean;
  copilotTab: "chat" | "details";
  detailId: number | null;
  selectedIds: number[];
  cardNodeId: number | null;
  fieldCounts: Partial<Record<ClusterKey, number>>;
  typeCounts: Partial<Record<ContentTypeKey, number>>;
  availCounts: AvailCounts;
  yearBins: number[];
  citeBins: number[];
  shownCount: number;
  edgeCount: number;
  messages: ChatMessage[];
  chatInput: string;
  typing: boolean;
  ready: boolean;
  set: (partial: Partial<AtlasState>) => void;
}

const allActive = () =>
  Object.fromEntries(CLUSTER_KEYS.map((k) => [k, true])) as Record<ClusterKey, boolean>;

const allTypesActive = () =>
  Object.fromEntries(CONTENT_TYPE_KEYS.map((k) => [k, true])) as Record<ContentTypeKey, boolean>;

// Default filter/search state, shared by the store's initial values and the
// "Reset View" action so both stay in sync.
export const filterDefaults = (): Pick<
  AtlasState,
  | "keyword" | "keywordApplied" | "topN" | "yearMin" | "yearMax" | "minCites"
  | "activeFields" | "activeTypes" | "availOA" | "availPdf" | "availGrobid"
> => ({
  keyword: "",
  keywordApplied: "",
  topN: 1000,
  yearMin: YEAR_MIN,
  yearMax: YEAR_MAX,
  minCites: 0,
  activeFields: allActive(),
  activeTypes: allTypesActive(),
  availOA: false,
  availPdf: false,
  availGrobid: false,
});

export const useAtlasStore = create<AtlasState>((set) => ({
  themeKey: "deepspace",
  leftOpen: true,
  rightOpen: true,
  ...filterDefaults(),
  copilotTab: "chat",
  detailId: null,
  selectedIds: [],
  cardNodeId: null,
  fieldCounts: {},
  typeCounts: {},
  availCounts: { oa: 0, pdf: 0, grobid: 0 },
  yearBins: [],
  citeBins: [],
  shownCount: 0,
  edgeCount: 0,
  messages: [GREETING],
  chatInput: "",
  typing: false,
  ready: false,
  set: (partial) => set(partial),
}));
