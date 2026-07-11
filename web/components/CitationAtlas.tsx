// Root of the Citation Atlas — the React port of the design's DC Component class.
// Owns the imperative singletons (engine, loaded data) in refs, wires the engine
// callbacks, runs the applyFilters effect, and composes every overlay.
import { useCallback, useEffect, useRef, useState } from "react";
import { ForceGraph3D } from "../lib/force3d";
import { loadAtlas, loadSearchKeywords, fetchDetail, type AtlasData } from "../lib/loaders";
import { computeFilter } from "../lib/filter";
import { FIELDS } from "../lib/fieldClusters";
import { THEMES, engineTheme, type ThemeKey } from "../lib/themes";
import { useAtlasStore, filterDefaults } from "../lib/store";
import StatsBar from "./StatsBar";
import Legend from "./Legend";
import ControlsHint from "./ControlsHint";
import HoverCard from "./HoverCard";
import FilterPanel from "./FilterPanel";
import CopilotPanel from "./CopilotPanel";
import SmallScreenNotice from "./SmallScreenNotice";

export interface AtlasActions {
  setTheme: (key: ThemeKey) => void;
  toggleMode: () => void;
  resetView: () => void;
  zoom: (dir: number) => void;
  focusNode: (id: number) => void;
  toggleSelect: (id: number) => void;
  removeSelected: (id: number) => void;
  clearSelection: () => void;
  closeCard: () => void;
  send: (text: string) => void;
  degree: (id: number) => number;
}

export default function CitationAtlas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const engineRef = useRef<ForceGraph3D | null>(null);
  const dataRef = useRef<AtlasData | null>(null);
  const stickyRef = useRef<number | null>(null);
  const dismissedRef = useRef<number | null>(null);
  const [kwVersion, setKwVersion] = useState(0);

  const S = useAtlasStore;
  const themeKey = useAtlasStore((s) => s.themeKey);
  const ready = useAtlasStore((s) => s.ready);
  const keywordApplied = useAtlasStore((s) => s.keywordApplied);
  const topN = useAtlasStore((s) => s.topN);
  const yearMin = useAtlasStore((s) => s.yearMin);
  const yearMax = useAtlasStore((s) => s.yearMax);
  const minCites = useAtlasStore((s) => s.minCites);
  const activeFields = useAtlasStore((s) => s.activeFields);
  const activeTypes = useAtlasStore((s) => s.activeTypes);
  const availOA = useAtlasStore((s) => s.availOA);
  const availPdf = useAtlasStore((s) => s.availPdf);
  const availGrobid = useAtlasStore((s) => s.availGrobid);

  const t = THEMES[themeKey];

  // ---- port of _onHud: card positioning + sticky/dismiss logic ----
  const onHud = useCallback((hud: { card: { id: number; x: number; y: number; hover: boolean } | null }) => {
    const el = cardRef.current;
    if (!el) return;
    const c = hud.card;
    const hide = () => {
      el.style.opacity = "0";
      if (S.getState().cardNodeId !== null) S.setState({ cardNodeId: null });
    };
    const show = (card: { id: number; x: number; y: number }) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const w = 288, margin = 16;
      let x = card.x + 18, y = card.y - 20;
      if (x + w > rect.width - margin) x = card.x - w - 18;
      x = Math.max(margin, Math.min(rect.width - w - margin, x));
      y = Math.max(margin, Math.min(rect.height - 210, y));
      el.style.transform = `translate(${x}px, ${y}px)`;
      el.style.opacity = "1";
      if (card.id !== S.getState().cardNodeId) S.setState({ cardNodeId: card.id });
    };
    if (!c) { hide(); return; }
    if (c.hover) {
      // hovering a node: permanently dismiss any sticky (selection) card that isn't this one
      if (stickyRef.current != null && stickyRef.current !== c.id) dismissedRef.current = stickyRef.current;
      show(c);
    } else {
      // card driven by the last-selected node
      if (c.id === dismissedRef.current) { hide(); return; }
      stickyRef.current = c.id;
      show(c);
    }
  }, [S]);

  // ---- componentDidMount equivalent: engine + data ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    const engine = new ForceGraph3D(canvas, {
      theme: engineTheme(S.getState().themeKey),
      fields: FIELDS,
      onSelect: (node: { id: number }) => {
        // Selecting a node pins its card open immediately, so it stays up until
        // the user hovers a different node or dismisses it — no longer dependent
        // on an empty-space frame arriving to establish stickiness. Deselecting
        // (toggling off) unpins.
        const isSel = engine.selected.has(node.id);
        dismissedRef.current = null;
        stickyRef.current = isSel ? node.id : null;
        S.setState({ selectedIds: [...engine.selected] as number[], detailId: node.id });
      },
      onHover: () => {},
      onHud,
    });
    engineRef.current = engine;
    const ro = new ResizeObserver(() => engine.resize());
    ro.observe(canvas);

    loadAtlas().then((data) => {
      if (disposed) return;
      dataRef.current = data;
      engine.setData(data.nodes, data.edges);
      S.setState({ ready: true });
      const idle = (cb: () => void) =>
        "requestIdleCallback" in window ? (window as any).requestIdleCallback(cb) : setTimeout(cb, 800);
      idle(() => {
        loadSearchKeywords(data).then(() => {
          if (!disposed) setKwVersion((n) => n + 1);
        }).catch(() => {});
      });
    }).catch((err) => console.error("failed to load atlas data", err));

    return () => {
      disposed = true;
      engine.dispose();
      ro.disconnect();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- port of applyFilters(): re-runs whenever any filter input changes ----
  useEffect(() => {
    const engine = engineRef.current, data = dataRef.current;
    if (!ready || !engine || !data) return;
    const res = computeFilter(
      { keywordApplied, topN, yearMin, yearMax, minCites, activeFields, activeTypes, availOA, availPdf, availGrobid },
      data,
    );
    engine.setVisible(res.keepIds);
    S.setState({
      shownCount: res.shownCount,
      edgeCount: res.edgeCount,
      fieldCounts: res.fieldCounts,
      typeCounts: res.typeCounts,
      availCounts: res.availCounts,
      yearBins: res.yearBins,
      citeBins: res.citeBins,
    });
  }, [S, ready, keywordApplied, topN, yearMin, yearMax, minCites, activeFields, activeTypes, availOA, availPdf, availGrobid, kwVersion]);

  // ---- actions shared with the panels (the DC class methods) ----
  const scrollChat = useCallback(() => {
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, []);

  const actions: AtlasActions = {
    setTheme: (key) => {
      engineRef.current?.setTheme(engineTheme(key));
      S.setState({ themeKey: key });
    },
    toggleMode: () => {
      const key = S.getState().themeKey === "light" ? "deepspace" : "light";
      engineRef.current?.setTheme(engineTheme(key));
      S.setState({ themeKey: key });
    },
    resetView: () => {
      engineRef.current?.resetView();
      engineRef.current?.selected.clear();
      stickyRef.current = null;
      dismissedRef.current = null;
      if (cardRef.current) cardRef.current.style.opacity = "0";
      S.setState({ ...filterDefaults(), selectedIds: [], detailId: null, cardNodeId: null });
    },
    zoom: (dir) => engineRef.current?.zoom(dir),
    focusNode: (id) => engineRef.current?.focusNode(id),
    toggleSelect: (id) => {
      const engine = engineRef.current;
      if (!engine) return;
      engine.toggleSelect(id);
      S.setState({ selectedIds: [...engine.selected] as number[] });
    },
    removeSelected: (id) => {
      const engine = engineRef.current;
      if (!engine) return;
      engine.selected.delete(id);
      S.setState({ selectedIds: [...engine.selected] as number[] });
    },
    clearSelection: () => {
      engineRef.current?.selected.clear();
      S.setState({ selectedIds: [] });
    },
    closeCard: () => {
      dismissedRef.current = S.getState().cardNodeId;
      if (cardRef.current) cardRef.current.style.opacity = "0";
      if (S.getState().cardNodeId !== null) S.setState({ cardNodeId: null });
    },
    send: (text) => {
      const msg = (text || "").trim();
      if (!msg) return;
      const engine = engineRef.current, data = dataRef.current;
      const ids = engine ? ([...engine.selected] as number[]) : [];

      // Prior turns (before this one) become the chat history sent to the route.
      const history = S.getState().messages;
      S.setState({ messages: [...history, { role: "user", text: msg }], chatInput: "", typing: true });
      if (inputRef.current) {
        inputRef.current.style.height = "auto";
        inputRef.current.style.overflowY = "hidden";
      }
      scrollChat();

      const appendAssistant = (text: string) =>
        S.setState({ messages: [...S.getState().messages, { role: "assistant", text }], typing: false });
      const replaceLast = (text: string) => {
        const cur = S.getState().messages.slice();
        cur[cur.length - 1] = { role: "assistant", text };
        S.setState({ messages: cur });
      };
      // Sticky autoscroll: while a reply streams in, only follow the bottom if
      // the user is already there — if they've scrolled up to read, leave them
      // (the panel's "scroll to latest" button takes them back).
      const nearBottom = () => {
        const el = scrollRef.current;
        return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      };

      (async () => {
        try {
          // Assemble per-paper context when papers are selected: title/metadata
          // from the in-memory node, abstract + rich fields from the (memoized)
          // detail shard. With no selection, papers is empty and the copilot
          // answers general science/research questions.
          let papers: unknown[] = [];
          if (data && ids.length) {
            const details = await Promise.all(
              ids.map((id) => fetchDetail(data.manifest, id).catch(() => null)),
            );
            papers = ids.map((id, i) => {
              const node = data.nodes[id];
              const d = details[i];
              return {
                title: d?.title ?? node?.title ?? null,
                abstract: d?.abstract ?? null,
                authors: d?.authors?.map((a) => a.name).filter((n): n is string => !!n)
                  ?? (node?.authors ? [node.authors] : []),
                year: d?.year ?? node?.year ?? null,
                venue: d?.venue ?? null,
                topics: d?.topics ?? [],
                keywords: d?.keywords ?? [],
                cited_by_count: d?.cited_by_count ?? node?.citations ?? null,
              };
            });
          }

          const res = await fetch("/api/copilot", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question: msg, papers, history }),
          });
          if (!res.ok || !res.body) throw new Error(`copilot ${res.status}`);

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let acc = "";
          let started = false;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            if (!chunk) continue;
            acc += chunk;
            const stick = nearBottom(); // capture before the DOM grows
            if (!started) {
              started = true;
              appendAssistant(acc); // clears typing, drops the empty-bubble case
            } else {
              replaceLast(acc);
            }
            if (stick) scrollChat();
          }
          if (!started) {
            appendAssistant("The copilot returned an empty response — try asking again.");
          }
        } catch {
          if (S.getState().typing) {
            // Failed before any tokens streamed — show a fresh error bubble.
            appendAssistant("Sorry — I couldn't reach the copilot. Check that the server is running and ANTHROPIC_API_KEY is set, then try again.");
          } else {
            // Failed mid-stream — note it on the partial reply.
            const cur = S.getState().messages;
            const last = cur[cur.length - 1];
            replaceLast((last?.text ?? "") + "\n\n[connection lost]");
          }
        } finally {
          if (S.getState().typing) S.setState({ typing: false });
          if (nearBottom()) scrollChat();
        }
      })();
    },
    degree: (id) => {
      const engine = engineRef.current;
      return engine?.adj?.get(id)?.length ?? 0;
    },
  };

  return (
    <div style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", color: t.text, fontFamily: "'Lato',system-ui,sans-serif" }}>
      <div style={{ position: "relative", flex: 1, minHeight: 0, overflow: "hidden" }}>
        <canvas
          ref={canvasRef}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block", touchAction: "none" }}
        />

        <StatsBar t={t} actions={actions} />
        <Legend t={t} />
        <ControlsHint t={t} actions={actions} />

        {/* floating detail card (positioned imperatively by onHud) */}
        <div ref={cardRef} style={{ position: "absolute", zIndex: 15, width: 288, pointerEvents: "auto", opacity: 0, willChange: "transform" }}>
          <HoverCard t={t} dataRef={dataRef} actions={actions} />
        </div>

        <FilterPanel t={t} />
        <CopilotPanel t={t} dataRef={dataRef} actions={actions} scrollRef={scrollRef} inputRef={inputRef} />
      </div>

      <SmallScreenNotice t={t} />
    </div>
  );
}
