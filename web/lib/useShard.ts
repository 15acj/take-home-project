// Hook: resolve a node's Tier-2 detail record from its shard (cached in loaders.ts).
import { useEffect, useState } from "react";
import { fetchDetail, type DetailRecord, type Manifest } from "./loaders";

export function useDetail(manifest: Manifest | null, id: number | null): DetailRecord | null {
  const [detail, setDetail] = useState<DetailRecord | null>(null);
  useEffect(() => {
    if (manifest === null || id === null) {
      setDetail(null);
      return;
    }
    let alive = true;
    setDetail(null);
    fetchDetail(manifest, id).then((rec) => {
      if (alive) setDetail(rec);
    }).catch(() => {});
    return () => {
      alive = false;
    };
  }, [manifest, id]);
  return detail;
}
