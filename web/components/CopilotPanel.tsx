// RIGHT "Copilot" panel — 400px open / 128px collapsed. Chat/Paper tabs,
// Selected Papers list, mocked chat (canned replies + typing indicator),
// shard-backed Paper detail view.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, CSSProperties, MutableRefObject, RefObject } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Theme } from "../lib/themes";
import type { AtlasData } from "../lib/loaders";
import { FIELDS } from "../lib/fieldClusters";
import { useAtlasStore, type SimilarResult } from "../lib/store";
import { MAX_SELECTED_PAPERS, MAX_MESSAGES } from "../lib/limits";
import { PROMPTS, STARTER_PROMPTS } from "../lib/chat";
import { useDetail } from "../lib/useShard";
import FullTextBadge from "./FullTextBadge";
import type { AtlasActions } from "./CitationAtlas";

// Assistant replies arrive as markdown; render them. Links open in a new tab.
const mdComponents = {
  a: (props: ComponentProps<"a">) => <a {...props} target="_blank" rel="noopener noreferrer" />,
};

const fmtCites = (n: number) =>
  n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "") + "K" : "" + n;

// Interactive similar-papers card: checkbox list (all checked by default) + a
// button to add the checked papers to the graph selection.
function SimilarResults({ results, t, actions }: { results: SimilarResult[]; t: Theme; actions: AtlasActions }) {
  const [checked, setChecked] = useState<Set<number>>(() => new Set(results.map((r) => r.rank)));
  // Button state is DERIVED from the live selection, not latched: the checked
  // papers that aren't already in the graph selection. So it disables once
  // everything checked is added, and re-enables the moment you check a new paper
  // or clear/reset the selection. selectPapers also de-dups as a safety net.
  const selectedIds = useAtlasStore((s) => s.selectedIds);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const pending = results.filter((r) => {
    if (!checked.has(r.rank)) return false;
    const idx = actions.resolveTitle(r.title);
    return idx != null && !selectedSet.has(idx);
  });
  // Respect the selection cap: only as many as there's room for can be added.
  const room = MAX_SELECTED_PAPERS - selectedIds.length;
  const full = room <= 0;
  const addCount = Math.min(pending.length, Math.max(0, room));
  const canAdd = addCount > 0;
  const allOn = checked.size === results.length;
  const toggle = (rank: number) =>
    setChecked((prev) => {
      const n = new Set(prev);
      if (n.has(rank)) n.delete(rank); else n.add(rank);
      return n;
    });
  const toggleAll = () => setChecked(allOn ? new Set() : new Set(results.map((r) => r.rank)));
  const add = () => {
    if (!canAdd) return;
    actions.selectPapers(pending);
  };

  return (
    <div style={{ width: "100%", borderRadius: "4px 14px 14px 14px", background: t.botBubble, border: `1px solid ${t.border}`, padding: "12px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: t.text }}>Similar papers</span>
        <span style={{ flex: 1 }} />
        <button
          onClick={toggleAll}
          style={{ fontSize: 11.5, fontWeight: 700, color: t.accent, background: "none", border: "none", cursor: "pointer", fontFamily: "'Lato',sans-serif", padding: 0 }}
        >
          {allOn ? "None" : "All"}
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {results.map((r) => {
          const on = checked.has(r.rank);
          return (
            <button
              key={r.rank}
              onClick={() => toggle(r.rank)}
              style={{
                display: "flex", alignItems: "flex-start", gap: 9, padding: "6px", borderRadius: 9,
                cursor: "pointer", background: on ? t.chipBg : "transparent",
                border: `1px solid ${on ? t.border : "transparent"}`, width: "100%",
                textAlign: "left", fontFamily: "'Lato',sans-serif",
              }}
            >
              <span style={{
                marginTop: 1, display: "flex", alignItems: "center", justifyContent: "center",
                width: 16, height: 16, flex: "0 0 auto", borderRadius: 5,
                border: `1px solid ${on ? t.accent : t.border}`, background: on ? t.accent : "transparent",
              }}>
                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke={t.onAccent} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: on ? 1 : 0, display: "block" }}>
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 13, fontWeight: 700, color: t.text, lineHeight: 1.35 }}>{r.title || "(untitled)"}</span>
                <span style={{ display: "block", fontSize: 11.5, fontWeight: 700, color: t.textDim, marginTop: 3 }}>
                  {r.year || "—"} · {fmtCites(r.cited_by_count)} cites{r.field ? ` · ${r.field}` : ""} · {Math.round(r.similarity * 100)}% match
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <button
        onClick={add}
        disabled={!canAdd}
        style={{
          marginTop: 12, width: "100%", padding: "9px 12px", borderRadius: 9, border: "none",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
          cursor: canAdd ? "pointer" : "default",
          fontFamily: "'Lato',sans-serif", fontSize: 12.5, fontWeight: 700,
          background: canAdd ? t.accent : t.chipBg, color: canAdd ? t.onAccent : t.textDim,
        }}
      >
        {canAdd ? (
          `Add ${addCount} to Graph Selection`
        ) : full && pending.length > 0 ? (
          `Selection full (${MAX_SELECTED_PAPERS} max)`
        ) : checked.size === 0 ? (
          "Select Papers to Add"
        ) : (
          <>
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke={t.textDim} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: "block", flex: "0 0 auto" }}>
              <polyline points="20 6 9 17 4 12" />
            </svg>
            Added to Selection
          </>
        )}
      </button>
    </div>
  );
}

// Single-paper card from the "find a specific paper" tool. Auto-focuses the
// paper in the graph on mount, and offers to add it to the selection. matchType
// labels the header: a confident title match vs the closest hybrid-search guess.
function SpecificResult({ paper, matchType, t, actions }: { paper: SimilarResult; matchType?: "title" | "search"; t: Theme; actions: AtlasActions }) {
  const selectedIds = useAtlasStore((s) => s.selectedIds);
  const idx = actions.resolveTitle(paper.title);
  const inGraph = idx != null;
  const added = inGraph && selectedIds.includes(idx as number);
  const full = selectedIds.length >= MAX_SELECTED_PAPERS;
  const canAdd = inGraph && !added && !full;

  // Centre the paper in the graph as soon as the card appears (once).
  useEffect(() => {
    actions.focusPaper(paper);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ width: "100%", borderRadius: "4px 14px 14px 14px", background: t.botBubble, border: `1px solid ${t.border}`, padding: "12px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: t.text }}>
          {matchType === "title" ? "Title match" : "Closest match"}
        </span>
      </div>
      <div style={{ padding: "0 2px" }}>
        <span style={{ display: "block", fontSize: 13, fontWeight: 700, color: t.text, lineHeight: 1.35 }}>{paper.title || "(untitled)"}</span>
        <span style={{ display: "block", fontSize: 11.5, fontWeight: 700, color: t.textDim, marginTop: 3 }}>
          {paper.year || "—"} · {fmtCites(paper.cited_by_count)} cites{paper.field ? ` · ${paper.field}` : ""} · {Math.round(paper.similarity * 100)}% match
        </span>
      </div>
      <button
        onClick={() => canAdd && actions.selectPapers([paper])}
        disabled={!canAdd}
        style={{
          marginTop: 12, width: "100%", padding: "9px 12px", borderRadius: 9, border: "none",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
          cursor: canAdd ? "pointer" : "default",
          fontFamily: "'Lato',sans-serif", fontSize: 12.5, fontWeight: 700,
          background: canAdd ? t.accent : t.chipBg, color: canAdd ? t.onAccent : t.textDim,
        }}
      >
        {added ? (
          <>
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke={t.textDim} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: "block", flex: "0 0 auto" }}>
              <polyline points="20 6 9 17 4 12" />
            </svg>
            Added to Selection
          </>
        ) : !inGraph ? (
          "Not shown on the graph"
        ) : full ? (
          `Selection full (${MAX_SELECTED_PAPERS} max)`
        ) : (
          "Add to Graph Selection"
        )}
      </button>
    </div>
  );
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function fmtDate(iso: string | null | undefined, fallbackYear: number): string {
  if (iso) {
    const [y, m, d] = iso.split("-").map(Number);
    if (y && m && d) return `${MONTHS[m - 1]} ${d}, ${y}`;
    if (y) return String(y);
  }
  return fallbackYear ? String(fallbackYear) : "—";
}

const darken = (rgb: number[]) =>
  `rgb(${Math.round(rgb[0] * 0.5)},${Math.round(rgb[1] * 0.5)},${Math.round(rgb[2] * 0.5)})`;

export default function CopilotPanel({
  t, dataRef, actions, scrollRef, inputRef,
}: {
  t: Theme;
  dataRef: MutableRefObject<AtlasData | null>;
  actions: AtlasActions;
  scrollRef: RefObject<HTMLDivElement>;
  inputRef: RefObject<HTMLTextAreaElement>;
}) {
  const s = useAtlasStore();
  const set = s.set;
  const light = s.themeKey === "light";
  const nodes = dataRef.current?.nodes;

  // Keep the newest selected paper in view: when the list grows past its
  // max-height and starts scrolling, snap to the bottom so the just-added
  // paper is visible. Only scrolls on additions, not removals.
  const selListRef = useRef<HTMLDivElement>(null);
  const prevSelCount = useRef(s.selectedIds.length);
  const [selCollapsed, setSelCollapsed] = useState(false);
  useEffect(() => {
    const el = selListRef.current;
    if (el && s.selectedIds.length > prevSelCount.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevSelCount.current = s.selectedIds.length;
  }, [s.selectedIds.length]);

  const lastSel = s.selectedIds.length ? s.selectedIds[s.selectedIds.length - 1] : null;
  const activeDetailId =
    s.detailId != null && s.selectedIds.includes(s.detailId) ? s.detailId : lastSel;
  const detailNode = activeDetailId != null && nodes ? nodes[activeDetailId] : null;
  const detail = useDetail(dataRef.current?.manifest ?? null, activeDetailId);

  const chatTab = s.copilotTab !== "details";
  const detailsTab = s.copilotTab === "details";
  // Hard message cap: once reached, block the input entirely (mirrors the
  // guard in the send() action, so the UI can't invite a send that won't fire).
  const atMsgCap = s.messages.length >= MAX_MESSAGES;
  const canSend = s.chatInput.trim().length > 0 && !atMsgCap;
  // Suggestion chips are an empty-state affordance — hide them once the user has
  // sent a message (the store seeds an assistant greeting, so check for a user turn).
  const hasUserMsg = s.messages.some((m) => m.role === "user");

  // Floating "scroll to latest" button — shown when the chat is scrolled up
  // away from the newest message. Scrolling fires updateScrollDown; we also
  // re-check when messages/typing change, since content added below while
  // scrolled up doesn't fire a scroll event.
  const [showScrollDown, setShowScrollDown] = useState(false);
  const updateScrollDown = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return setShowScrollDown(false);
    setShowScrollDown(el.scrollHeight - el.scrollTop - el.clientHeight > 60);
  }, [scrollRef]);
  useEffect(() => {
    if (chatTab) updateScrollDown();
  }, [chatTab, s.messages, s.typing, updateScrollDown]);
  const scrollToBottom = () => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  };

  const tabBtn = (on: boolean): CSSProperties => ({
    padding: "5px 12px", borderRadius: 7, border: "none", cursor: "pointer",
    fontFamily: "'Lato',sans-serif", fontSize: 11.5, fontWeight: 700,
    background: on ? t.accent : "transparent", color: on ? t.onAccent : t.textDim,
  });

  // Shared style for the four paper-detail action buttons (View Paper, PDF,
  // Focus in Graph, Remove): equal width, icon on the right, same background.
  const paperBtn: CSSProperties = {
    flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
    padding: 10, borderRadius: 9, textDecoration: "none", cursor: "pointer",
    fontFamily: "'Lato',sans-serif", fontSize: 12.5, fontWeight: 700, lineHeight: 1,
    border: `1px solid ${t.border}`, background: t.chipBg, color: t.text,
  };
  // Icons: nudge up ~1px so they sit on the text's optical (cap-height) center
  // rather than the em-box center, which reads a touch low.
  const paperBtnIcon: CSSProperties = { display: "block", flex: "0 0 auto", transform: "translateY(0.5px)" };

  const onChatInput = (v: string) => {
    set({ chatInput: v });
    const el = inputRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(96, el.scrollHeight) + "px";
      // Only show the textarea's scrollbar once content exceeds the 96px cap;
      // otherwise the auto-grow leaves a sub-pixel gap and a scrollbar flashes.
      el.style.overflowY = el.scrollHeight > 96 ? "auto" : "hidden";
    }
  };

  return (
    <div style={{
      position: "absolute", top: 14, right: 14, zIndex: 20,
      ...(s.rightOpen ? { bottom: 96 } : { maxHeight: "calc(100% - 28px)" }),
      display: "flex", flexDirection: "column",
      // Collapsed pill widens when a selection count is shown so the count badge
      // and caret don't overflow the box (which clips against overflow:hidden).
      width: s.rightOpen ? 400 : s.selectedIds.length > 0 ? 152 : 128,
      borderRadius: 16, background: t.panelBg, border: `1px solid ${t.border}`,
      backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)",
      boxShadow: t.panelShadow, overflow: "hidden",
    }}>
      {s.rightOpen ? (
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          {/* header */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "15px 16px 13px", flex: "0 0 auto", borderBottom: `1px solid ${t.border}` }}>
            <button
              onClick={() => set({ rightOpen: false })}
              title="Collapse"
              className="hc"
              style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, borderRadius: 7, border: "none", background: "transparent", color: t.textDim, cursor: "pointer", ["--hc" as string]: t.text }}
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: "block" }}>
                <polyline points="9 6 15 12 9 18" />
              </svg>
            </button>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Copilot</div>
            <div style={{ flex: 1 }} />
            <div style={{ display: "flex", gap: 2, padding: 3, borderRadius: 9, background: t.chipBg, border: `1px solid ${t.border}` }}>
              <button onClick={() => set({ copilotTab: "chat" })} style={tabBtn(chatTab)}>Chat</button>
              <button onClick={() => set({ copilotTab: "details" })} style={tabBtn(detailsTab)}>Paper</button>
            </div>
          </div>

          {/* selected papers */}
          <div style={{ flex: "0 0 auto", padding: "12px 16px", borderBottom: `1px solid ${t.border}` }}>
            <div
              onClick={() => setSelCollapsed((v) => !v)}
              className="hc"
              title={selCollapsed ? "Expand" : "Collapse"}
              style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", marginBottom: selCollapsed ? 0 : 9, ["--hc" as string]: t.text }}
            >
              <div style={{ fontSize: 11.5, letterSpacing: "0.01em", fontWeight: 700, color: t.textDim }}>
                Selected Papers · {s.selectedIds.length}
              </div>
              <span style={{ flex: 1 }} />
              <span style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 18, height: 18, flex: "0 0 auto", color: t.textFaint,
                transform: selCollapsed ? "rotate(-90deg)" : "none", transition: "transform .18s ease",
              }}>
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: "block" }}>
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </span>
            </div>
            {s.selectionNotice && (
              <div style={{ fontSize: 11.5, fontWeight: 600, lineHeight: 1.4, color: t.accent, marginBottom: selCollapsed ? 0 : 8, animation: "fadein .2s ease" }}>
                {s.selectionNotice}
              </div>
            )}
            {selCollapsed ? null : s.selectedIds.length > 0 ? (
              <>
                <div ref={selListRef} style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 118, overflowY: "auto", marginRight: -10, paddingRight: 10, marginTop: 4, marginBottom: 4 }}>
                  {s.selectedIds.map((id) => {
                    const n = nodes?.[id];
                    if (!n) return null;
                    const active = id === activeDetailId;
                    return (
                      <div key={id} style={{
                        display: "flex", alignItems: "center", gap: 8, padding: "7px 9px",
                        borderRadius: 9, background: t.chipBg,
                        border: `1px solid ${active ? t.accent : t.border}`,
                      }}>
                        <span style={{ width: 8, height: 8, borderRadius: "50%", flex: "0 0 auto", background: `rgb(${FIELDS[n.field].rgb.join(",")})` }} />
                        <span
                          onClick={() => actions.showPaperCard(id)}
                          title={n.title}
                          style={{ flex: 1, fontSize: 12.5, fontWeight: 700, lineHeight: 1.35, cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                        >
                          {n.title}
                        </span>
                        {n.hasGrobid && <FullTextBadge t={t} variant="icon" />}
                        <button
                          onClick={() => actions.removeSelected(id)}
                          className="hc"
                          style={{ width: 17, height: 17, flex: "0 0 auto", borderRadius: 5, border: "none", background: "transparent", color: t.textFaint, cursor: "pointer", fontSize: 13, lineHeight: 1, ["--hc" as string]: t.text }}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>
                <button
                  onClick={() => actions.clearSelection()}
                  style={{ marginTop: 8, fontSize: 11.5, fontWeight: 600, color: t.textFaint, background: "none", border: "none", cursor: "pointer", fontFamily: "'Lato',sans-serif" }}
                >
                  Clear All
                </button>
              </>
            ) : (
              <div style={{ fontSize: 13, fontWeight: 400, lineHeight: 1.55, color: t.textDim, padding: "6px 0 4px" }}>
                Click nodes in the graph to add papers here, then chat about them below.
              </div>
            )}
          </div>

          {/* chat tab */}
          {chatTab && (
            <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
             <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
              <div ref={scrollRef} onScroll={updateScrollDown} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 10px 10px 16px", marginRight: 6, marginTop: 6, marginBottom: 6 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {s.messages.map((m, i) => {
                    const user = m.role === "user";
                    return (
                      <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: user ? "flex-end" : "flex-start", animation: "fadein .3s ease" }}>
                        {!user && (
                          <div style={{ fontSize: 10.5, letterSpacing: "0.02em", fontWeight: 700, color: t.textDim, marginBottom: 5 }}>Copilot</div>
                        )}
                        {!user && m.results ? (
                          <SimilarResults results={m.results} t={t} actions={actions} />
                        ) : !user && m.paper ? (
                          <SpecificResult paper={m.paper} matchType={m.matchType} t={t} actions={actions} />
                        ) : (
                          <div style={user ? {
                            maxWidth: "88%", padding: "10px 13px", borderRadius: "14px 14px 4px 14px",
                            background: t.accent, color: t.onAccent, fontSize: 13.5, lineHeight: 1.45, fontWeight: 400,
                          } : {
                            maxWidth: "94%", padding: "11px 14px", borderRadius: "4px 14px 14px 14px",
                            background: t.botBubble, border: `1px solid ${t.border}`, color: t.text,
                            fontSize: 13.5, lineHeight: 1.55, fontWeight: 400,
                          }}>
                            {user ? m.text : (
                              <div className="md" style={{ ["--md-accent" as string]: t.accent }}>
                                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                                  {m.text}
                                </ReactMarkdown>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {s.typing && (
                    <div style={{ alignSelf: "flex-start", display: "flex", gap: 4, padding: "11px 14px", borderRadius: 13, background: t.botBubble, border: `1px solid ${t.border}` }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: t.textDim, animation: "blink 1.2s infinite" }} />
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: t.textDim, animation: "blink 1.2s .2s infinite" }} />
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: t.textDim, animation: "blink 1.2s .4s infinite" }} />
                    </div>
                  )}
                </div>
              </div>
              {showScrollDown && (
                <button
                  onClick={scrollToBottom}
                  aria-label="Scroll to latest message"
                  style={{
                    position: "absolute", bottom: 14, right: 16,
                    width: 30, height: 30, borderRadius: "50%", cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: t.cardBg, border: `1px solid ${t.border}`, color: t.text,
                    boxShadow: "0 3px 12px rgba(0,0,0,0.4)", fontSize: 16, lineHeight: 1,
                  }}
                >
                  ↓
                </button>
              )}
             </div>

              {!hasUserMsg && (
              <div style={{ flex: "0 0 auto", padding: "0 16px 8px" }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10, marginBottom: 10 }}>
                  {(s.selectedIds.length > 0 ? PROMPTS : STARTER_PROMPTS).map((p) => (
                    <button
                      key={p}
                      onClick={() => actions.send(p)}
                      className="hc"
                      style={{
                        padding: "6px 11px", borderRadius: 20, border: `1px solid ${t.border}`,
                        background: t.chipBg, color: t.textDim, fontSize: 11.5, cursor: "pointer",
                        fontFamily: "'Lato',sans-serif",
                        ["--hc" as string]: t.text,
                      }}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
              )}

              <div style={{ flex: "0 0 auto", padding: "0 16px 16px" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 8px 8px 12px", borderRadius: 13, border: `1px solid ${t.border}`, background: t.inputBg }}>
                  <textarea
                    ref={inputRef}
                    value={s.chatInput}
                    onChange={(e) => onChatInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        actions.send(s.chatInput);
                      }
                    }}
                    rows={1}
                    disabled={atMsgCap}
                    placeholder={atMsgCap ? `Message limit reached (${MAX_MESSAGES}) — reload to start over` : "Ask about the selected papers…"}
                    style={{
                      flex: 1, resize: "none", border: "none", outline: "none", background: "transparent",
                      color: t.text, fontFamily: "'Lato',sans-serif", fontSize: 14, lineHeight: 1.45,
                      maxHeight: 96, padding: "4px 0", overflowY: "hidden",
                      cursor: atMsgCap ? "not-allowed" : "text",
                    }}
                  />
                  <button
                    onClick={() => actions.send(s.chatInput)}
                    style={{
                      width: 32, height: 32, flex: "0 0 auto", borderRadius: 9, border: "none",
                      cursor: canSend ? "pointer" : "default", fontSize: 15, fontWeight: 700,
                      background: canSend ? t.accent : t.chipBg,
                      color: canSend ? t.onAccent : t.textFaint,
                      transition: "all .15s",
                    }}
                  >
                    ↑
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* paper tab */}
          {detailsTab && (
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 10px 14px 16px", marginRight: 6, marginTop: 6, marginBottom: 6 }}>
              {detailNode ? (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 11 }}>
                    <span style={{ width: 9, height: 9, borderRadius: "50%", flex: "0 0 auto", background: `rgb(${FIELDS[detailNode.field].rgb.join(",")})` }} />
                    <span style={{ fontSize: 11.5, letterSpacing: "0.02em", fontWeight: 900, color: light ? darken(FIELDS[detailNode.field].rgb) : `rgb(${FIELDS[detailNode.field].rgb.join(",")})` }}>
                      {FIELDS[detailNode.field].label}
                    </span>
                    <span style={{ flex: 1 }} />
                    <span style={{ fontSize: 11.5, fontFamily: "'Lato',sans-serif", color: t.textFaint }}>
                      #{detailNode.rank.toLocaleString()}
                    </span>
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 700, lineHeight: 1.32, textWrap: "pretty", marginBottom: 9 } as CSSProperties}>
                    {detailNode.title}
                  </div>
                  <div style={{ fontSize: 13, color: t.textDim, marginBottom: 18 }}>
                    {detail
                      ? detail.authors.map((a) => a.name).filter(Boolean).join(", ")
                      : detailNode.authors}
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "15px 16px", marginBottom: 20 }}>
                    {[
                      { label: "Published", value: detail ? fmtDate(detail.publication_date, detailNode.year) : "…" },
                      { label: "Published In", value: detail ? (detail.venue || "—") : "…" },
                      { label: "Citations", value: detailNode.citations.toLocaleString() },
                      { label: "Citation Links", value: String(actions.degree(detailNode.id)) },
                    ].map((mi) => (
                      <div key={mi.label}>
                        <div style={{ fontSize: 10.5, letterSpacing: "0.02em", color: t.textFaint, marginBottom: 4 }}>{mi.label}</div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: t.text, lineHeight: 1.3 }}>{mi.value}</div>
                      </div>
                    ))}
                  </div>

                  <div style={{ fontSize: 11.5, letterSpacing: "0.02em", fontWeight: 700, color: t.textDim, marginBottom: 8 }}>Abstract</div>
                  <div style={{ fontSize: 14, lineHeight: 1.66, color: detail ? t.text : t.textFaint, marginBottom: 16, textWrap: "pretty" } as CSSProperties}>
                    {detail ? (detail.abstract || "No abstract available.") : "Loading abstract…"}
                  </div>

                  <div style={{ fontSize: 11.5, color: t.textFaint, marginBottom: 18, wordBreak: "break-all" }}>
                    DOI: {detail ? (detail.doi ? detail.doi.replace(/^https?:\/\/doi\.org\//, "") : "—") : "…"}
                  </div>

                  {detailNode.hasGrobid && (
                    <div style={{ marginBottom: 12 }}>
                      <FullTextBadge t={t} variant="chip" />
                    </div>
                  )}

                  {detail && (detail.landing_url || detail.pdf_url) && (
                    <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                      {detail.landing_url && (
                        <a href={detail.landing_url} target="_blank" rel="noopener noreferrer" style={paperBtn}>
                          View Paper
                          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={paperBtnIcon}>
                            <path d="M7 17 17 7M9 7h8v8" />
                          </svg>
                        </a>
                      )}
                      {detail.pdf_url && (
                        <a href={detail.pdf_url} target="_blank" rel="noopener noreferrer" style={paperBtn}>
                          PDF
                          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={paperBtnIcon}>
                            <path d="M12 3v11M7 10l5 4 5-4M4 20h16" />
                          </svg>
                        </a>
                      )}
                    </div>
                  )}

                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => actions.focusNode(detailNode.id)} style={paperBtn}>
                      Focus in Graph
                      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={paperBtnIcon}>
                        <circle cx="12" cy="12" r="6" />
                        <path d="M12 1v3M12 20v3M1 12h3M20 12h3" />
                      </svg>
                    </button>
                    <button onClick={() => actions.removeSelected(detailNode.id)} style={paperBtn}>
                      Remove
                      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ ...paperBtnIcon, transform: "translateY(1.5px)" }}>
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 13, fontWeight: 400, lineHeight: 1.6, color: t.textDim, padding: "8px 0" }}>
                  Select a paper in the graph — or tap one in the list above — to read its abstract and full details here.
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <button
          onClick={() => set({ rightOpen: true })}
          title="Expand copilot"
          className="hc"
          style={{
            width: "100%", display: "flex", alignItems: "center", gap: 9, padding: "13px 14px",
            background: "none", border: "none", color: t.textDim, cursor: "pointer",
            whiteSpace: "nowrap", ["--hc" as string]: t.text,
          }}
        >
          <span style={{ fontSize: 15 }}>✧</span>
          <span style={{ fontSize: 13, letterSpacing: "0.01em", fontWeight: 700, fontFamily: "'Lato',sans-serif" }}>Copilot</span>
          <span style={{ flex: 1 }} />
          {s.selectedIds.length > 0 && (
            <span style={{ fontSize: 11, fontWeight: 700, fontFamily: "'Lato',sans-serif", color: t.accent }}>
              {s.selectedIds.length}
            </span>
          )}
          <span style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 18, height: 18, flex: "0 0 auto", color: t.textDim }}>
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: "block" }}>
              <polyline points="15 6 9 12 15 18" />
            </svg>
          </span>
        </button>
      )}
    </div>
  );
}
