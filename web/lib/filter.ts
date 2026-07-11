// Faithful port of the design's applyFilters() (Citation Atlas.dc.html:442-482),
// reading the real dataset. Field/availability counts and both histograms use the
// same "pass every filter except this one" structure as the design.
import type { AtlasData } from "./loaders";
import type { AtlasState, AvailCounts } from "./store";
import { CITE_MAX, NBINS, YEAR_MAX, YEAR_MIN } from "./store";
import type { ClusterKey } from "./fieldClusters";
import { CLUSTER_KEYS } from "./fieldClusters";

export interface FilterResult {
  keepIds: Set<number>;
  shownCount: number;
  edgeCount: number;
  fieldCounts: Partial<Record<ClusterKey, number>>;
  availCounts: AvailCounts;
  yearBins: number[];
  citeBins: number[];
}

type FilterInputs = Pick<
  AtlasState,
  | "keywordApplied"
  | "topN"
  | "yearMin"
  | "yearMax"
  | "minCites"
  | "activeFields"
  | "availOA"
  | "availPdf"
  | "availGrobid"
>;

export function computeFilter(s: FilterInputs, data: AtlasData): FilterResult {
  const kw = s.keywordApplied.trim().toLowerCase();
  const top = Math.min(s.topN, data.nodes.length);
  const counts: Partial<Record<ClusterKey, number>> = {};
  for (const k of CLUSTER_KEYS) counts[k] = 0;
  const binSpan = (YEAR_MAX + 1 - YEAR_MIN) / NBINS;
  const yearBins = new Array(NBINS).fill(0);
  const citeSpan = CITE_MAX / NBINS;
  const citeBins = new Array(NBINS).fill(0);
  const availCounts: AvailCounts = { oa: 0, pdf: 0, grobid: 0 };
  // At full slider range the year filter is off, so the handful of papers dated
  // outside 1935-2024 (incl. year 0 = unknown) stay visible.
  const fullYearRange = s.yearMin === YEAR_MIN && s.yearMax === YEAR_MAX;

  const keepIds = new Set<number>();
  let shownCount = 0;

  for (let i = 0; i < top; i++) {
    const n = data.nodes[i];
    const kwMatch = kw === "" || data.searchText[i].includes(kw);
    const am =
      (!s.availOA || n.openAccess) &&
      (!s.availPdf || n.hasPdf) &&
      (!s.availGrobid || n.hasGrobid);
    const yearMatch = fullYearRange || (n.year >= s.yearMin && n.year <= s.yearMax);
    const fieldOn = s.activeFields[n.field];

    const passNoYear = n.citations >= s.minCites && fieldOn && kwMatch && am;
    if (passNoYear) {
      let bi = Math.floor((n.year - YEAR_MIN) / binSpan);
      bi = Math.max(0, Math.min(NBINS - 1, bi));
      yearBins[bi]++;
    }
    const passNoCite = yearMatch && fieldOn && kwMatch && am;
    if (passNoCite) {
      let ci = Math.floor(n.citations / citeSpan);
      ci = Math.max(0, Math.min(NBINS - 1, ci));
      citeBins[ci]++;
    }
    const passNonField = yearMatch && n.citations >= s.minCites && kwMatch && am;
    if (passNonField) counts[n.field] = (counts[n.field] || 0) + 1;
    // availability counts respect every OTHER filter but not availability itself
    const passNoAvail = yearMatch && n.citations >= s.minCites && fieldOn && kwMatch;
    if (passNoAvail) {
      if (n.openAccess) availCounts.oa++;
      if (n.hasPdf) availCounts.pdf++;
      if (n.hasGrobid) availCounts.grobid++;
    }
    if (passNonField && fieldOn) {
      keepIds.add(n.id);
      shownCount++;
    }
  }

  let edgeCount = 0;
  for (const e of data.edges) {
    if (keepIds.has(e.source) && keepIds.has(e.target)) edgeCount++;
  }

  return { keepIds, shownCount, edgeCount, fieldCounts: counts, availCounts, yearBins, citeBins };
}
