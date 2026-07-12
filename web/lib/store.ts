// Central UI state, mirroring the design component's this.state one-to-one.
// The engine + loaded data live in refs owned by CitationAtlas (imperative
// singletons, as in the design); this store holds everything renderable.
import { create } from "zustand";
import type { ClusterKey } from "./fieldClusters";
import { CLUSTER_KEYS } from "./fieldClusters";
import type { ContentTypeKey } from "./contentTypes";
import { CONTENT_TYPE_KEYS } from "./contentTypes";
import type { ThemeKey } from "./themes";

// A hybrid-search hit from the copilot's find_similar_papers tool. `rank` is the
// graph node index (== turbopuffer `rank` attribute), so results join straight
// back to the atlas selection.
export interface SimilarResult {
  rank: number;
  id: string;
  title: string;
  year: number;
  cited_by_count: number;
  field: string;
  doi: string | null;
  similarity: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  // When present, the message renders as the interactive similar-papers card
  // (checkbox list + "add to selection") instead of a text bubble.
  results?: SimilarResult[];
  // When present, the message renders as the single-paper "find a specific paper"
  // card (auto-focused in the graph + "add to selection"). matchType labels it:
  // "title" = confident title match, "search" = closest hybrid-search guess.
  paper?: SimilarResult;
  matchType?: "title" | "search";
  // When present, the message renders as a small muted "tool call" indicator line
  // (friendly label) instead of a text bubble/card. Value is the raw tool name.
  tool?: string;
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
  // Transient notice shown under the Selected Papers header, e.g. when the
  // selection cap is hit. Auto-cleared by the setter that raises it.
  selectionNotice: string | null;
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
  selectionNotice: null,
  set: (partial) => set(partial),
}));
