// Typed access to the shared field->cluster mapping (single source of truth,
// also consumed by scripts/layout_clustered.mjs which positions the clusters).
import data from "./field-clusters.json";

export type ClusterKey =
  | "genetics"
  | "ai"
  | "physics"
  | "chemistry"
  | "medicine"
  | "neuro"
  | "cs"
  | "economics";

export interface ClusterDef {
  label: string;
  hue: number;
  rgb: [number, number, number];
}

export const FIELDS = data.clusters as Record<ClusterKey, ClusterDef>;
export const FIELD_TO_CLUSTER = data.fieldToCluster as Record<string, ClusterKey>;
export const CLUSTER_KEYS = Object.keys(FIELDS) as ClusterKey[];
