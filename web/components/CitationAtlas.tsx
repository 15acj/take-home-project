// Root of the Citation Atlas — the React port of the design's DC Component class.
// Owns the imperative singletons (engine, loaded data) in refs, wires the engine
// callbacks, runs the applyFilters effect, and composes every overlay.
import { useCallback, useEffect, useRef, useState } from "react";
import { ForceGraph3D } from "../lib/force3d";
import { loadAtlas, loadSearchKeywords, fetchDetail, type AtlasData } from "../lib/loaders";
import { computeFilter } from "../lib/filter";
import { FIELDS, CLUSTER_KEYS, type ClusterKey } from "../lib/fieldClusters";
import { CONTENT_TYPE_KEYS, type ContentTypeKey } from "../lib/contentTypes";
import { THEMES, engineTheme, type ThemeKey } from "../lib/themes";
import { useAtlasStore, filterDefaults, YEAR_MIN, YEAR_MAX, CITE_MAX, TOPN, type AtlasState, type SimilarResult } from "../lib/store";
import { MAX_SELECTED_PAPERS, MAX_MESSAGES } from "../lib/limits";
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
  focusPaper: (result: SimilarResult) => void;
  showPaperCard: (id: number) => void;
  toggleSelect: (id: number) => void;
  removeSelected: (id: number) => void;
  selectPapers: (results: SimilarResult[]) => void;
  resolveTitle: (title: string) => number | null;
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
  // title -> graph node index, built lazily. The turbopuffer `rank` attribute is
  // NOT the graph node index (the graph drops "suspect" records the embed set
  // keeps, so the two orderings diverge), so similar-paper results are joined to
  // the graph by their (byte-identical) title instead.
  const titleIndexRef = useRef<Map<string, number> | null>(null);
  const stickyRef = useRef<number | null>(null);
  const dismissedRef = useRef<number | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      maxSelected: MAX_SELECTED_PAPERS,
      onLimit: () =>
        flashNotice(`You can add up to ${MAX_SELECTED_PAPERS} papers to the chat. Remove one to add another.`),
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

  // Raise a transient notice under the Selected Papers header (e.g. the
  // selection cap was hit), auto-clearing after a few seconds.
  const flashNotice = useCallback((text: string) => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    S.setState({ selectionNotice: text });
    noticeTimerRef.current = setTimeout(() => S.setState({ selectionNotice: null }), 4000);
  }, [S]);

  // Build (once) and return the title -> graph node index map used to resolve
  // search results to graph nodes (see titleIndexRef).
  const titleToIndex = (): Map<string, number> | null => {
    if (!titleIndexRef.current && dataRef.current) {
      const map = new Map<string, number>();
      const nodes = dataRef.current.nodes;
      for (let i = 0; i < nodes.length; i++) {
        const key = nodes[i].title?.trim();
        if (key && !map.has(key)) map.set(key, i); // first = highest-cited
      }
      titleIndexRef.current = map;
    }
    return titleIndexRef.current;
  };

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
    // Centre a paper and pop its hover card (used by the Selected Papers list).
    // setHover drives the engine's card for that node; the engine only overrides
    // hoverId on canvas pointer-move, so the card persists while the user stays
    // in the panel. Clear any prior dismissal so the card isn't suppressed.
    showPaperCard: (id) => {
      const engine = engineRef.current;
      if (!engine) return;
      dismissedRef.current = null;
      engine.focusNode(id);
      engine.setHover(id);
      S.setState({ detailId: id });
    },
    // Auto-focus a "find a specific paper" result: resolve it to its graph node
    // by title, centre it and pop its hover card (like showPaperCard). No-ops if
    // the paper isn't in the graph (some corpus records are dropped from it).
    focusPaper: (result) => {
      const engine = engineRef.current;
      const id = titleToIndex()?.get((result.title || "").trim()) ?? null;
      if (!engine || id == null) return;
      dismissedRef.current = null;
      engine.focusNode(id);
      engine.setHover(id);
      S.setState({ detailId: id });
    },
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
    resolveTitle: (title) => titleToIndex()?.get((title || "").trim()) ?? null,
    selectPapers: (results) => {
      const engine = engineRef.current;
      const map = titleToIndex();
      if (!engine || !map || !results.length) return;
      // Resolve each result to its graph node index by title; skip any already
      // selected (de-dup) or not in the graph.
      const ids: number[] = [];
      for (const r of results) {
        const idx = map.get((r.title || "").trim());
        if (idx != null && !engine.selected.has(idx)) ids.push(idx);
      }
      if (!ids.length) return;
      // Enforce the selection cap: only add up to the remaining capacity, and
      // tell the user if some were dropped.
      const room = MAX_SELECTED_PAPERS - engine.selected.size;
      if (room <= 0) {
        flashNotice(`You can add up to ${MAX_SELECTED_PAPERS} papers to the chat. Remove one to add another.`);
        return;
      }
      const dropped = ids.length - room;
      const toAdd = dropped > 0 ? ids.slice(0, room) : ids;
      if (dropped > 0) {
        flashNotice(`Added ${room} — the chat is capped at ${MAX_SELECTED_PAPERS} papers.`);
      }
      for (const id of toAdd) engine.selected.add(id);
      // The engine's card defaults to the LAST-selected node; override it to the
      // FIRST (top-ranked) added paper so the hover card matches detailId.
      dismissedRef.current = null;
      engine.setHover(ids[0]);
      engine.focusNode(ids[0]);
      S.setState({ selectedIds: [...engine.selected] as number[], detailId: ids[0] });
      // The Selected Papers list grows and shrinks the chat area — keep the chat
      // pinned to the bottom so the latest content stays in view.
      scrollChat();
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
      // Hard message cap per session — bounds total API cost. When reached, show
      // one notice instead of sending, and don't append it more than once.
      const cur = S.getState().messages;
      if (cur.length >= MAX_MESSAGES) {
        const already = cur[cur.length - 1]?.text?.startsWith("You've reached the");
        if (!already) {
          S.setState({
            messages: [...cur, {
              role: "assistant",
              text: `You've reached the ${MAX_MESSAGES}-message limit for this session. Reload the page to start a new session.`,
            }],
            typing: false,
          });
          scrollChat();
        }
        return;
      }
      const engine = engineRef.current, data = dataRef.current;
      const ids = engine ? ([...engine.selected] as number[]) : [];

      // Prior turns (before this one) become the chat history sent to the route,
      // and a snapshot of the current filters lets the copilot make incremental
      // changes ("also include neuroscience") off a known base.
      const st = S.getState();
      const history = st.messages;
      const filters = {
        fields: CLUSTER_KEYS.filter((k) => st.activeFields[k]),
        content_types: CONTENT_TYPE_KEYS.filter((k) => st.activeTypes[k]),
        year_min: st.yearMin,
        year_max: st.yearMax,
        min_citations: st.minCites,
        keyword: st.keywordApplied,
        require_pdf: st.availPdf,
        require_open_access: st.availOA,
        require_full_text: st.availGrobid,
        top_n: st.topN,
      };
      S.setState({ messages: [...history, { role: "user", text: msg }], chatInput: "", typing: true });
      if (inputRef.current) {
        inputRef.current.style.height = "auto";
        inputRef.current.style.overflowY = "hidden";
      }
      scrollChat();

      const appendAssistant = (text: string) =>
        S.setState({ messages: [...S.getState().messages, { role: "assistant", text }], typing: false });
      const appendResults = (results: SimilarResult[]) =>
        S.setState({ messages: [...S.getState().messages, { role: "assistant", text: "", results }], typing: false });
      const appendPaper = (paper: SimilarResult, matchType: "title" | "search") =>
        S.setState({ messages: [...S.getState().messages, { role: "assistant", text: "", paper, matchType }], typing: false });
      // A muted "tool call" indicator line. Leaves `typing` alone — the following
      // card/filter effect and the finally block manage it.
      const appendTool = (name: string) =>
        S.setState({ messages: [...S.getState().messages, { role: "assistant", text: "", tool: name }] });
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

      // Apply a filter action from the copilot. Writes the same store keys the
      // FilterPanel writes, so the existing applyFilters effect recomputes the
      // graph. Everything is clamped/validated — a bad value can't break state.
      const applyFilterAction = (name: string, input: unknown) => {
        if (name === "reset_filters") {
          S.setState(filterDefaults());
          return;
        }
        if (name !== "set_filters" || !input || typeof input !== "object") return;
        const inp = input as Record<string, unknown>;
        const patch: Partial<AtlasState> = {};

        if (Array.isArray(inp.fields)) {
          const on = new Set(inp.fields as string[]);
          patch.activeFields = Object.fromEntries(
            CLUSTER_KEYS.map((k) => [k, on.has(k)]),
          ) as Record<ClusterKey, boolean>;
        }
        if (Array.isArray(inp.content_types)) {
          const on = new Set(inp.content_types as string[]);
          patch.activeTypes = Object.fromEntries(
            CONTENT_TYPE_KEYS.map((k) => [k, on.has(k)]),
          ) as Record<ContentTypeKey, boolean>;
        }
        const clampInt = (v: unknown, lo: number, hi: number): number | null => {
          const n = typeof v === "number" ? v : Number(v);
          return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : null;
        };
        const cur = S.getState();
        if ("year_min" in inp || "year_max" in inp) {
          const lo = "year_min" in inp ? clampInt(inp.year_min, YEAR_MIN, YEAR_MAX) : null;
          const hi = "year_max" in inp ? clampInt(inp.year_max, YEAR_MIN, YEAR_MAX) : null;
          const a = lo ?? cur.yearMin;
          const b = hi ?? cur.yearMax;
          patch.yearMin = Math.min(a, b);
          patch.yearMax = Math.max(a, b);
        }
        if ("min_citations" in inp) {
          const c = clampInt(inp.min_citations, 0, CITE_MAX);
          if (c != null) patch.minCites = c;
        }
        if (typeof inp.keyword === "string") {
          patch.keyword = inp.keyword;
          patch.keywordApplied = inp.keyword.trim();
        }
        if (typeof inp.require_pdf === "boolean") patch.availPdf = inp.require_pdf;
        if (typeof inp.require_open_access === "boolean") patch.availOA = inp.require_open_access;
        if (typeof inp.require_full_text === "boolean") patch.availGrobid = inp.require_full_text;
        if ("top_n" in inp) {
          const n = Number(inp.top_n);
          if (TOPN.some((o) => o.v === n)) patch.topN = n;
        }
        if (Object.keys(patch).length) S.setState(patch);
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
            body: JSON.stringify({ question: msg, papers, history, filters, selectedRanks: ids }),
          });
          if (!res.ok || !res.body) throw new Error(`copilot ${res.status}`);

          // Parse the NDJSON stream: {"t":"text","v":...} streams into the
          // assistant bubble; {"t":"action",...} applies a filter change.
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          let acc = "";
          let started = false;      // any assistant text shown yet
          let didAction = false;    // a filter action was applied this turn
          let similarShown = false; // a similar-papers card was appended this turn

          const pushText = (delta: string) => {
            acc += delta;
            const stick = nearBottom(); // capture before the DOM grows
            if (!started) {
              started = true;
              appendAssistant(acc); // clears typing, drops the empty-bubble case
            } else {
              replaceLast(acc);
            }
            if (stick) scrollChat();
          };
          const handleLine = (line: string) => {
            const s = line.trim();
            if (!s) return;
            let obj: { t?: string; v?: unknown; name?: unknown; input?: unknown };
            try { obj = JSON.parse(s); } catch { return; }
            if (obj.t === "text" && typeof obj.v === "string") pushText(obj.v);
            else if (obj.t === "tool" && typeof obj.name === "string") appendTool(obj.name);
            else if (obj.t === "action" && typeof obj.name === "string") {
              if (obj.name === "show_similar") {
                similarShown = true;
                const input = obj.input as { results?: SimilarResult[] } | undefined;
                const results = Array.isArray(input?.results) ? input.results : [];
                if (results.length) appendResults(results);
                else appendAssistant("I couldn't find papers similar enough to that — try describing the topic differently.");
                // The results card is the payload the user asked for — scroll it
                // fully into view (incl. the "Add to selection" button), rather
                // than deferring to the sticky-scroll used for streaming text.
                scrollChat();
              } else if (obj.name === "show_paper") {
                similarShown = true;
                const input = obj.input as { paper?: SimilarResult; matchType?: "title" | "search" } | undefined;
                if (input?.paper) appendPaper(input.paper, input.matchType === "title" ? "title" : "search");
                else appendAssistant("I couldn't find that specific paper — try the exact title, or ask me to find similar papers instead.");
                scrollChat();
              } else {
                didAction = true;
                applyFilterAction(obj.name, obj.input);
              }
            }
          };

          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
              handleLine(buf.slice(0, nl));
              buf = buf.slice(nl + 1);
            }
          }
          buf += decoder.decode();
          if (buf.trim()) handleLine(buf);

          if (!started && !similarShown) {
            appendAssistant(didAction
              ? "Done — updated the graph filters."
              : "The copilot returned an empty response — try asking again.");
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
