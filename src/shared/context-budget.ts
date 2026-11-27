/**
 * Token-budget estimation + transcript compaction (Phase 15 Task 1,
 * ARCHITECTURE §15 "Performance Budgets", §4 data flow / agent loop).
 *
 * Long agent sessions accumulate transcript: each turn re-feeds the whole
 * `messages` array (we have **no background mode**, §5), so without pruning the
 * per-turn input grows past the §15 budget (≤ 25k input tokens, "evict/cache
 * beyond"). This module supplies the **pure**, deterministic pieces of that
 * defence:
 *
 * - {@link estimateTokens} / {@link estimateMessageTokens} /
 *   {@link estimateRequestTokens} — a cheap char-based heuristic used **only**
 *   as a budget gate (the real `usage` from the API is logged elsewhere for
 *   calibration; this never claims to be the real tokenizer).
 * - {@link compactTranscript} — shrinks an over-budget transcript by first
 *   stubbing stale `tool_result` payloads in place, then (only if still over)
 *   dropping whole oldest turn-pairs at clean boundaries.
 *
 * ## The pairing invariant (single most important constraint)
 * The Messages API **rejects** a `messages` array where an assistant `tool_use`
 * block has no matching `tool_result` in the following user message, or a
 * `tool_result` references a missing `tool_use`. {@link compactTranscript} is
 * built so this pairing is **never** broken on any path: PASS 1 mutates only the
 * `.content` of a `tool_result` (keeping its `tool_use_id`, so the block — and
 * thus the pairing — survives); PASS 2 only ever removes whole turn-pairs (the
 * leading user-text message + assistant `tool_use` message(s) + the matching
 * `tool_result` user message(s)) together. {@link transcriptPairingHolds} is the
 * predicate that encodes the invariant.
 *
 * ## Purity
 * Like its `src/shared/**` siblings this module imports ONLY the `Anthropic`
 * *type* (mirroring `./tools.ts`), touches no Extensions SDK, no DOM, and no Node
 * APIs, and is fully deterministic — **no `Date.now`, no `Math.random`** — so it
 * compiles under the strict shared tsconfig and is trivially testable.
 */

import type Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Heuristic constants
// ---------------------------------------------------------------------------

/**
 * Characters-per-token divisor for the {@link estimateTokens} heuristic. ~4
 * chars/token is the standard rough approximation for English + JSON; we round
 * up so the estimate over-counts slightly, giving the budget gate headroom over
 * the real tokenizer.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Fixed per-block character surcharge added in {@link estimateMessageTokens}.
 * Approximates the structural framing the real tokenizer charges for each
 * content block (type tag, delimiters, JSON braces) that the raw payload length
 * does not capture. A budget-gate fudge factor, not an exact figure.
 */
const PER_BLOCK_OVERHEAD_CHARS = 8;

/**
 * Fixed per-message character surcharge added in {@link estimateMessageTokens}.
 * Approximates the role marker and message envelope framing. A budget-gate fudge
 * factor, not an exact figure.
 */
const PER_MESSAGE_OVERHEAD_CHARS = 12;

/** Default total per-turn input budget (tokens) — the §15 ≤ 25k figure. */
const DEFAULT_MAX_TOKENS = 25_000;

/** Default number of most-recent turns kept verbatim by {@link compactTranscript}. */
const DEFAULT_KEEP_RECENT_TURNS = 3;

/** Default replacement payload for a stubbed-out stale `tool_result` (PASS 1). */
const DEFAULT_STUB_TEXT =
  "[evicted stale result — re-read with live_get_* if needed]";

/** Note prepended exactly once when PASS 2 drops any earlier history. */
const TRIMMED_NOTE_TEXT =
  "[earlier conversation trimmed to stay within context budget]";

// ---------------------------------------------------------------------------
// Public option / result types
// ---------------------------------------------------------------------------

/** Options controlling {@link compactTranscript}. All fields are optional. */
export interface CompactOptions {
  /**
   * Total per-turn input budget in tokens. The transcript target is
   * `maxTokens - reserve`. Defaults to {@link DEFAULT_MAX_TOKENS} (25 000).
   */
  maxTokens?: number;
  /**
   * Number of most-recent turns kept verbatim (never stubbed or dropped).
   * Defaults to {@link DEFAULT_KEEP_RECENT_TURNS} (3).
   */
  keepRecentTurns?: number;
  /**
   * Estimated tokens consumed by the non-transcript parts of the request
   * (system + tools + snapshot), subtracted from `maxTokens` to derive the
   * transcript target. Defaults to `0`.
   */
  reserve?: number;
  /**
   * Replacement text for a stubbed-out stale `tool_result`'s content. Defaults
   * to {@link DEFAULT_STUB_TEXT}.
   */
  stubText?: string;
}

/** Count of what {@link compactTranscript} removed/shrank. */
export interface CompactionEvicted {
  /** Number of stale `tool_result` blocks whose content was stubbed (PASS 1). */
  compactedResults: number;
  /** Number of whole messages dropped at turn boundaries (PASS 2). */
  droppedMessages: number;
}

/** Result of {@link compactTranscript}: a NEW messages array + eviction counts. */
export interface CompactionResult {
  /** The compacted transcript (a fresh array; input is never mutated). */
  messages: Anthropic.MessageParam[];
  /** What was shrunk/removed. */
  evicted: CompactionEvicted;
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the token count of a raw string via the `ceil(length / 4)` heuristic.
 *
 * This is a deliberately cheap **approximation** of the real BPE tokenizer,
 * used only as a budget gate with built-in headroom (it tends to over-count).
 * The authoritative token count comes from the API `usage` field, which is
 * logged elsewhere for calibration — this function is never presented as exact.
 *
 * @param text - The string to estimate.
 * @returns A non-negative integer token estimate.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Sum the character length of a `tool_result` block's `content`, which may be a
 * plain string or an array of nested blocks (text / image / etc.). Only text is
 * counted by its payload; non-text nested blocks contribute the per-block
 * overhead only (their byte payload is not in the transcript JSON we send).
 */
function toolResultContentChars(
  content: Anthropic.ToolResultBlockParam["content"]
): number {
  if (content === undefined) {
    return 0;
  }
  if (typeof content === "string") {
    return content.length + PER_BLOCK_OVERHEAD_CHARS;
  }
  let chars = 0;
  for (const block of content) {
    chars += PER_BLOCK_OVERHEAD_CHARS;
    if (block.type === "text") {
      chars += block.text.length;
    }
  }
  return chars;
}

/**
 * Estimate the token count of a single {@link Anthropic.MessageParam}.
 *
 * Walks `msg.content` (which may be a `string` or a block array). For each block
 * it sums: `text` blocks' `.text`; `tool_use` blocks' name + `JSON.stringify`'d
 * `input`; `tool_result` blocks' `.content` (string OR nested block array). A
 * fixed {@link PER_BLOCK_OVERHEAD_CHARS} is added per block and one
 * {@link PER_MESSAGE_OVERHEAD_CHARS} per message to approximate role/structure
 * framing, then the char total is converted via {@link estimateTokens}.
 *
 * @param msg - The message to estimate.
 * @returns A non-negative integer token estimate.
 */
export function estimateMessageTokens(msg: Anthropic.MessageParam): number {
  let chars = PER_MESSAGE_OVERHEAD_CHARS;

  if (typeof msg.content === "string") {
    chars += msg.content.length;
    return charsToTokens(chars);
  }

  for (const block of msg.content) {
    chars += PER_BLOCK_OVERHEAD_CHARS;
    switch (block.type) {
      case "text":
        chars += block.text.length;
        break;
      case "tool_use":
        chars += block.name.length + JSON.stringify(block.input).length;
        break;
      case "tool_result":
        chars += toolResultContentChars(block.content);
        break;
      default:
        // Other block kinds (image, document, thinking, …) contribute only the
        // per-block overhead — their payloads are not part of the text budget
        // this heuristic gates on.
        break;
    }
  }

  return charsToTokens(chars);
}

/** Convert an accumulated character count to a token estimate. */
function charsToTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Estimate the total input tokens of a full request: system blocks + tools +
 * every message + the optional snapshot string.
 *
 * Used both for the {@link compactTranscript} budget decision and for logging
 * the heuristic next to the real API `usage` for calibration.
 *
 * @param input.system - The system prompt as text blocks.
 * @param input.tools - The tool definitions (each `JSON.stringify`'d).
 * @param input.messages - The transcript.
 * @param input.snapshot - Optional serialized Set snapshot block.
 * @returns A non-negative integer token estimate.
 */
export function estimateRequestTokens(input: {
  system: Anthropic.TextBlockParam[];
  tools: Anthropic.ToolUnion[];
  messages: Anthropic.MessageParam[];
  snapshot?: string;
}): number {
  let total = 0;

  for (const block of input.system) {
    total += estimateTokens(block.text);
  }
  for (const tool of input.tools) {
    total += estimateTokens(JSON.stringify(tool));
  }
  for (const msg of input.messages) {
    total += estimateMessageTokens(msg);
  }
  if (input.snapshot !== undefined) {
    total += estimateTokens(input.snapshot);
  }

  return total;
}

// ---------------------------------------------------------------------------
// Transcript compaction
// ---------------------------------------------------------------------------

/** Sum {@link estimateMessageTokens} across a transcript. */
function transcriptTokens(messages: Anthropic.MessageParam[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

/** True if `msg` has at least one block of `type`. (Non-array content has none.) */
function hasBlockType(
  msg: Anthropic.MessageParam,
  type: "text" | "tool_use" | "tool_result"
): boolean {
  if (typeof msg.content === "string") {
    return type === "text" && msg.content.length > 0;
  }
  return msg.content.some((block) => block.type === type);
}

/**
 * Is this message a **turn-leading** user-text message?
 *
 * A turn boundary is defined by user messages that carry actual user **text**.
 * A user message that is *purely* `tool_result` blocks is NOT a boundary — it
 * belongs to the preceding assistant turn (it answers that turn's `tool_use`).
 * So a message starts a new turn iff it is `role: "user"` and contains a text
 * block. (String content is treated as a text block.)
 */
function isTurnStart(msg: Anthropic.MessageParam): boolean {
  return msg.role === "user" && hasBlockType(msg, "text");
}

/**
 * Index of the first message belonging to the "recent window" — the last
 * `keepRecentTurns` turns plus everything after the last turn start. Messages at
 * or after this index are kept verbatim. Returns `0` when the whole transcript
 * fits inside the window.
 */
function recentWindowStart(
  messages: Anthropic.MessageParam[],
  keepRecentTurns: number
): number {
  if (keepRecentTurns <= 0) {
    // Still always protect the trailing user message (see compactTranscript).
    return messages.length;
  }
  // Collect indices of turn-start messages, oldest → newest.
  const starts: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (isTurnStart(messages[i])) {
      starts.push(i);
    }
  }
  if (starts.length <= keepRecentTurns) {
    return 0;
  }
  // Keep the last `keepRecentTurns` turns: window begins at the start of the
  // (starts.length - keepRecentTurns)-th turn.
  return starts[starts.length - keepRecentTurns];
}

/**
 * Shallow-clone a message with a fresh content array. Nested blocks are shared
 * by reference, which is safe because this module **never mutates** an existing
 * block — every changed block (a stubbed `tool_result`, the trim note) is a
 * freshly constructed object. The fresh outer object + array guarantee the
 * caller's input array and message objects are never aliased into the output.
 */
function cloneMessageShallow(
  msg: Anthropic.MessageParam
): Anthropic.MessageParam {
  if (typeof msg.content === "string") {
    return { role: msg.role, content: msg.content };
  }
  return { role: msg.role, content: [...msg.content] };
}

/**
 * Verify the tool_use ↔ tool_result pairing invariant for a transcript:
 * every assistant `tool_use` id has a matching `tool_result` somewhere later,
 * and every `tool_result` references a `tool_use` id that exists. This is the
 * predicate the API enforces; {@link compactTranscript} preserves it on every
 * path. Exported for use by tests asserting the invariant.
 *
 * @param messages - The transcript to check.
 * @returns `true` iff the pairing holds.
 */
export function transcriptPairingHolds(
  messages: Anthropic.MessageParam[]
): boolean {
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      continue;
    }
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        toolUseIds.add(block.id);
      } else if (block.type === "tool_result") {
        toolResultIds.add(block.tool_use_id);
      }
    }
  }

  for (const id of toolUseIds) {
    if (!toolResultIds.has(id)) {
      return false;
    }
  }
  for (const id of toolResultIds) {
    if (!toolUseIds.has(id)) {
      return false;
    }
  }
  return true;
}

/**
 * PASS 1 — shrink stale `tool_result` payloads in place.
 *
 * For every `tool_result` block strictly older than `windowStart`, replace ONLY
 * its `.content` with `stubText`, preserving `tool_use_id` and `is_error`. The
 * block, the message, and the id all survive, so the pairing is untouched. A
 * result is only stubbed if its content is not already exactly the stub (keeps
 * the op idempotent). Returns a NEW array; never mutates the input.
 */
function stubStaleResults(
  messages: Anthropic.MessageParam[],
  windowStart: number,
  stubText: string
): { messages: Anthropic.MessageParam[]; compacted: number } {
  let compacted = 0;
  const out = messages.map((msg, i) => {
    if (i >= windowStart || typeof msg.content === "string") {
      return msg;
    }
    let changed = false;
    const newContent = msg.content.map((block) => {
      if (block.type !== "tool_result") {
        return block;
      }
      if (block.content === stubText) {
        return block; // already stubbed — idempotent
      }
      changed = true;
      compacted++;
      const stubbed: Anthropic.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: stubText,
      };
      if (block.is_error !== undefined) {
        stubbed.is_error = block.is_error;
      }
      return stubbed;
    });
    return changed ? { role: msg.role, content: newContent } : msg;
  });
  return { messages: out, compacted };
}

/**
 * Compute, for each turn-start index, the half-open `[start, end)` message range
 * that constitutes that whole turn (leading user-text message + following
 * assistant/tool messages up to the next turn start). The final turn ends at
 * `messages.length`.
 */
function turnRanges(
  messages: Anthropic.MessageParam[]
): Array<{ start: number; end: number }> {
  const starts: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (isTurnStart(messages[i])) {
      starts.push(i);
    }
  }
  const ranges: Array<{ start: number; end: number }> = [];
  for (let s = 0; s < starts.length; s++) {
    const start = starts[s];
    const end = s + 1 < starts.length ? starts[s + 1] : messages.length;
    ranges.push({ start, end });
  }
  return ranges;
}

/**
 * Compact an over-budget transcript while **always** preserving the tool_use ↔
 * tool_result pairing the Messages API enforces.
 *
 * Policy (ARCHITECTURE §15):
 * 1. Target = `maxTokens - reserve`. If the transcript already estimates under
 *    target, return a COPY unchanged (idempotent no-op).
 * 2. The last `keepRecentTurns` turns (and the trailing user message) are kept
 *    **verbatim** — never stubbed, never dropped. A turn boundary is a user
 *    message carrying actual text (a pure-`tool_result` user message belongs to
 *    the preceding assistant turn).
 * 3. PASS 1 (primary): stub the `.content` of every `tool_result` older than the
 *    recent window, keeping `tool_use_id` + `is_error` so the pairing holds.
 * 4. PASS 2 (only if still over target): drop whole oldest **turn-pairs** at
 *    clean boundaries — never splitting a `tool_use` from its `tool_result`,
 *    never touching the recent window or trailing user message. When anything is
 *    dropped, prepend exactly ONE "[earlier conversation trimmed…]" note.
 *
 * Returns a NEW array; the input and its nested blocks are never mutated.
 * Idempotent: re-running on its own output, when already under target, is a
 * no-op (no extra stubbing, no second note).
 *
 * @param messages - The transcript to compact.
 * @param opts - {@link CompactOptions}.
 * @returns {@link CompactionResult} — compacted messages + eviction counts.
 */
export function compactTranscript(
  messages: Anthropic.MessageParam[],
  opts?: CompactOptions
): CompactionResult {
  const maxTokens = opts?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const keepRecentTurns = opts?.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS;
  const reserve = opts?.reserve ?? 0;
  const stubText = opts?.stubText ?? DEFAULT_STUB_TEXT;
  const target = maxTokens - reserve;

  const evicted: CompactionEvicted = {
    compactedResults: 0,
    droppedMessages: 0,
  };

  // Fast path: already under target → return an unchanged copy.
  if (transcriptTokens(messages) <= target) {
    return { messages: messages.map(cloneMessageShallow), evicted };
  }

  // The recent window is protected from both passes. We also always protect the
  // trailing message even if keepRecentTurns is 0.
  let windowStart = recentWindowStart(messages, keepRecentTurns);
  if (windowStart >= messages.length && messages.length > 0) {
    windowStart = messages.length - 1;
  }

  // --- PASS 1: stub stale tool_result payloads ---------------------------
  const pass1 = stubStaleResults(messages, windowStart, stubText);
  evicted.compactedResults = pass1.compacted;
  let working = pass1.messages;

  if (transcriptTokens(working) <= target) {
    return { messages: working, evicted };
  }

  // --- PASS 2: drop whole oldest turn-pairs ------------------------------
  // Candidate turns are those that lie entirely before the recent window.
  const ranges = turnRanges(working).filter((r) => r.end <= windowStart);

  let droppedUntil = 0; // exclusive index: messages[0, droppedUntil) removed
  for (const range of ranges) {
    if (transcriptTokens(working.slice(droppedUntil)) <= target) {
      break;
    }
    // Dropping this whole turn removes its user-text msg + assistant tool_use
    // msg(s) + matching tool_result msg(s) together — pairing preserved.
    droppedUntil = range.end;
  }

  if (droppedUntil > 0) {
    const kept = working.slice(droppedUntil).map(cloneMessageShallow);
    evicted.droppedMessages = droppedUntil;
    const note: Anthropic.MessageParam = {
      role: "user",
      content: [{ type: "text", text: TRIMMED_NOTE_TEXT }],
    };
    working = [note, ...kept];
  } else {
    working = working.map(cloneMessageShallow);
  }

  return { messages: working, evicted };
}
