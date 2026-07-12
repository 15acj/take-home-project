// Copilot guardrails — shared caps to prevent abuse and runaway API charges.
// Kept dependency-free (no client/server imports) so both the browser bundle
// and the API route can import it without pulling in each other's deps.
//
// Character budgets use a ~4-chars-per-token approximation; they bound the
// paper context we send to the model per turn (the dominant, uncapped cost
// driver, since full paper bodies may be included for multiple papers).

// Max papers a user can add to the chat selection at once.
export const MAX_SELECTED_PAPERS = 10;

// Max total chat messages per session (includes the seeded greeting). Hitting
// this hard-stops the conversation — the user must start a new session.
export const MAX_MESSAGES = 50;

// Per-paper cap on the context text (abstract / full body) — ~15K tokens, big
// enough for a large full paper.
export const PER_PAPER_CONTEXT_CHARS = 60_000;

// Total budget across all selected papers' context — ~80K tokens.
export const TOTAL_CONTEXT_CHARS = 320_000;

// Max model round-trips per copilot request. One initial turn plus follow-ups
// after a tool returns a result (fetch_full_text). Bounds worst-case per-request
// cost when the model chains tool calls. Fire-and-forget tools (filters, search)
// don't consume extra turns — the loop only continues when full text was fetched.
export const MAX_TOOL_TURNS = 3;
