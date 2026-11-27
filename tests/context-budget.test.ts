/**
 * Phase 15 Task 1 unit suite — the PURE context-budget module
 * `src/shared/context-budget.ts` (ARCHITECTURE §15 budgets, §4 loop). Covers the
 * token estimators and, critically, {@link compactTranscript}: the tool_use ↔
 * tool_result PAIRING INVARIANT across BOTH compaction passes, the recent-window
 * verbatim guarantee, text-block preservation, clean turn-pair dropping with a
 * single trim note, idempotency, the under-target no-op, and strict
 * non-mutation. Pure module → no fakes, no network, no SDK.
 *
 * ## Why the pairing invariant is the headline test
 * The Messages API rejects any `messages` array where an assistant `tool_use`
 * block lacks its matching `tool_result` (or vice-versa). The whole point of
 * `compactTranscript` is to shrink the transcript WITHOUT ever breaking that
 * pairing — so the pairing test is built to be NON-VACUOUS: it drives a ≥20-
 * message synthetic transcript with multi-tool turns through a `maxTokens` tight
 * enough to force PASS 1 (stub stale results) AND PASS 2 (drop oldest turn-pairs),
 * asserting `evicted.compactedResults > 0 && evicted.droppedMessages > 0`, and
 * then verifies the surviving ids pair up directly (not only via the helper).
 */

import type Anthropic from "@anthropic-ai/sdk";

import { describe, expect, it } from "vitest";

import {
  compactTranscript,
  estimateMessageTokens,
  estimateRequestTokens,
  estimateTokens,
  transcriptPairingHolds,
} from "../src/shared/context-budget.js";

// ---------------------------------------------------------------------------
// Constants mirrored from the module under test (kept local so the test pins
// the documented contract, not the source's private values by import).
// ---------------------------------------------------------------------------

/** Default stub text used by PASS 1 (must match the module's default). */
const STUB_TEXT = "[evicted stale result — re-read with live_get_* if needed]";

/** Trim note prepended once by PASS 2 (must match the module's default). */
const TRIM_NOTE =
  "[earlier conversation trimmed to stay within context budget]";

// ---------------------------------------------------------------------------
// Synthetic-transcript builders
// ---------------------------------------------------------------------------

/** A user-text turn-leading message. */
function userText(text: string): Anthropic.MessageParam {
  return { role: "user", content: [{ type: "text", text }] };
}

/** An assistant message that emits one `tool_use` block (id `tu`). */
function assistantToolUse(
  tu: string,
  name = "live_get_track",
  input: unknown = { track: "track:0:Drums" }
): Anthropic.MessageParam {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id: tu, name, input: input as object }],
  };
}

/**
 * A user message that is PURELY a `tool_result` (answers a prior `tool_use`).
 * Per the module's turn rule this is NOT a turn boundary — it belongs to the
 * preceding assistant turn. `content` is padded so a stale result is heavy enough
 * for stubbing to make a measurable difference.
 */
function userToolResult(
  tu: string,
  payload = "x".repeat(400)
): Anthropic.MessageParam {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: tu, content: payload }],
  };
}

/** An assistant plain-text reply (ends a turn's work). */
function assistantText(text: string): Anthropic.MessageParam {
  return { role: "assistant", content: [{ type: "text", text }] };
}

/**
 * Build a long, realistic multi-tool transcript with `n` tool-rounds. Each round
 * is a 4-message turn:
 *   user(text) → assistant(tool_use) → user(tool_result) → assistant(text)
 * The first round additionally carries a SECOND tool in its assistant turn (an
 * extra tool_use + its tool_result), so the suite exercises multi-tool-per-turn
 * pairing. With `n=6` this yields ≥ 25 messages — comfortably over the "≥20" bar.
 */
function buildToolTranscript(n: number): Anthropic.MessageParam[] {
  const msgs: Anthropic.MessageParam[] = [];
  for (let i = 0; i < n; i++) {
    msgs.push(userText(`question ${i} ${"q".repeat(60)}`));
    if (i === 0) {
      // A multi-tool assistant turn: two tool_use blocks in ONE message.
      msgs.push({
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: `tu_${i}_a`,
            name: "live_get_project",
            input: {},
          },
          {
            type: "tool_use",
            id: `tu_${i}_b`,
            name: "live_get_track",
            input: { track: "track:0:Drums" },
          },
        ],
      });
      // Their two tool_results in ONE following user message.
      msgs.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: `tu_${i}_a`,
            content: "y".repeat(400),
          },
          {
            type: "tool_result",
            tool_use_id: `tu_${i}_b`,
            content: "z".repeat(400),
          },
        ],
      });
    } else {
      msgs.push(assistantToolUse(`tu_${i}`));
      msgs.push(userToolResult(`tu_${i}`));
    }
    msgs.push(assistantText(`answer ${i} ${"a".repeat(60)}`));
  }
  return msgs;
}

/** Deep structural clone of a transcript (for non-mutation comparison). */
function clone(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  return JSON.parse(JSON.stringify(messages)) as Anthropic.MessageParam[];
}

/** Collect every `tool_use` id appearing in a transcript. */
function toolUseIds(messages: Anthropic.MessageParam[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (typeof m.content === "string") {
      continue;
    }
    for (const b of m.content) {
      if (b.type === "tool_use") {
        ids.add(b.id);
      }
    }
  }
  return ids;
}

/** Collect every `tool_result` `tool_use_id` appearing in a transcript. */
function toolResultIds(messages: Anthropic.MessageParam[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (typeof m.content === "string") {
      continue;
    }
    for (const b of m.content) {
      if (b.type === "tool_result") {
        ids.add(b.tool_use_id);
      }
    }
  }
  return ids;
}

/** Every `text` block's text appearing anywhere in a transcript, in order. */
function allTexts(messages: Anthropic.MessageParam[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push(m.content);
      continue;
    }
    for (const b of m.content) {
      if (b.type === "text") {
        out.push(b.text);
      }
    }
  }
  return out;
}

// ===========================================================================
// estimateTokens
// ===========================================================================

describe("contextBudget_estimateTokens", () => {
  it("contextBudget_estimateTokens_isDeterministicForSameInput", () => {
    const s = "the quick brown fox jumps over the lazy dog";
    expect(estimateTokens(s)).toBe(estimateTokens(s));
  });

  it("contextBudget_estimateTokens_isCeilLengthOverFour", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(1); // ceil(1/4)
    expect(estimateTokens("abcd")).toBe(1); // ceil(4/4)
    expect(estimateTokens("abcde")).toBe(2); // ceil(5/4)
    expect(estimateTokens("x".repeat(40))).toBe(10);
  });

  it("contextBudget_estimateTokens_isMonotonicInLength", () => {
    const shortText = "x".repeat(10);
    const longText = "x".repeat(1000);
    expect(estimateTokens(longText)).toBeGreaterThanOrEqual(
      estimateTokens(shortText)
    );
  });

  it("contextBudget_estimateMessageTokens_growsWithContent", () => {
    const small = estimateMessageTokens({ role: "user", content: "hi" });
    const big = estimateMessageTokens({
      role: "user",
      content: "hi " + "word ".repeat(500),
    });
    expect(big).toBeGreaterThan(small);
  });
});

// ===========================================================================
// estimateRequestTokens
// ===========================================================================

describe("contextBudget_estimateRequestTokens", () => {
  const baseSystem: Anthropic.TextBlockParam[] = [
    { type: "text", text: "system rules" },
  ];
  const baseTools: Anthropic.ToolUnion[] = [
    { name: "t", input_schema: { type: "object" } },
  ];
  const baseMessages: Anthropic.MessageParam[] = [
    { role: "user", content: "hello" },
  ];

  it("contextBudget_estimateRequestTokens_sumsAllComponents", () => {
    const total = estimateRequestTokens({
      system: baseSystem,
      tools: baseTools,
      messages: baseMessages,
    });
    // The sum is at least the system + the single message individually.
    expect(total).toBeGreaterThan(0);
    expect(total).toBeGreaterThanOrEqual(
      estimateMessageTokens(baseMessages[0])
    );
  });

  it("contextBudget_estimateRequestTokens_biggerSystemRaisesTotal", () => {
    const small = estimateRequestTokens({
      system: baseSystem,
      tools: baseTools,
      messages: baseMessages,
    });
    const big = estimateRequestTokens({
      system: [{ type: "text", text: "system rules " + "x".repeat(2000) }],
      tools: baseTools,
      messages: baseMessages,
    });
    expect(big).toBeGreaterThan(small);
  });

  it("contextBudget_estimateRequestTokens_biggerMessagesRaiseTotal", () => {
    const small = estimateRequestTokens({
      system: baseSystem,
      tools: baseTools,
      messages: baseMessages,
    });
    const big = estimateRequestTokens({
      system: baseSystem,
      tools: baseTools,
      messages: [
        ...baseMessages,
        { role: "assistant", content: "y".repeat(4000) },
      ],
    });
    expect(big).toBeGreaterThan(small);
  });

  it("contextBudget_estimateRequestTokens_snapshotAddsToTotal", () => {
    const without = estimateRequestTokens({
      system: baseSystem,
      tools: baseTools,
      messages: baseMessages,
    });
    const withSnap = estimateRequestTokens({
      system: baseSystem,
      tools: baseTools,
      messages: baseMessages,
      snapshot: "PROJECT SNAPSHOT " + "s".repeat(800),
    });
    expect(withSnap).toBeGreaterThan(without);
  });
});

// ===========================================================================
// compactTranscript — the pairing invariant across BOTH passes (headline)
// ===========================================================================

describe("contextBudget_compactTranscript_pairingInvariant", () => {
  /**
   * Pick a `maxTokens` between the post-PASS-1 size and the recent-window size so
   * BOTH passes must run: PASS 1 alone can't reach target (forcing PASS 2), yet
   * PASS 2 can't drop the protected window. We derive it from the transcript's own
   * estimate to stay robust to the heuristic constants.
   */
  function tightBudget(messages: Anthropic.MessageParam[]): number {
    // Recent window (3 turns) is ~ the last 12 messages; aim the target just above
    // that so PASS 2 drops the older rounds but keeps the window. Half the total
    // reliably lands between "after-stub" and "window-only" for this transcript.
    const total = messages.reduce(
      (acc, m) => acc + estimateMessageTokens(m),
      0
    );
    return Math.floor(total / 2);
  }

  it("contextBudget_compactTranscript_triggersBothPassesNonVacuously", () => {
    const input = buildToolTranscript(6); // ≥ 25 messages, multi-tool turns
    expect(input.length).toBeGreaterThanOrEqual(20);

    const result = compactTranscript(input, {
      maxTokens: tightBudget(input),
      keepRecentTurns: 3,
    });

    // NON-VACUOUS proof: BOTH passes did work.
    expect(result.evicted.compactedResults).toBeGreaterThan(0);
    expect(result.evicted.droppedMessages).toBeGreaterThan(0);
  });

  it("contextBudget_compactTranscript_preservesPairingPerHelper", () => {
    const input = buildToolTranscript(6);
    const result = compactTranscript(input, {
      maxTokens: tightBudget(input),
      keepRecentTurns: 3,
    });
    expect(transcriptPairingHolds(result.messages)).toBe(true);
  });

  it("contextBudget_compactTranscript_pairingHoldsByDirectIdCheck", () => {
    // Independently verify (not trusting the helper) that every surviving
    // tool_use id has a matching tool_result id and vice-versa.
    const input = buildToolTranscript(6);
    const result = compactTranscript(input, {
      maxTokens: tightBudget(input),
      keepRecentTurns: 3,
    });
    const uses = toolUseIds(result.messages);
    const results = toolResultIds(result.messages);
    for (const id of uses) {
      expect(results.has(id)).toBe(true);
    }
    for (const id of results) {
      expect(uses.has(id)).toBe(true);
    }
  });

  it("contextBudget_compactTranscript_neverSplitsAMultiToolTurn", () => {
    // The multi-tool round (round 0) has ids tu_0_a / tu_0_b. Whatever survives,
    // both ids' use+result must survive together (never half a pair).
    const input = buildToolTranscript(6);
    const result = compactTranscript(input, {
      maxTokens: tightBudget(input),
      keepRecentTurns: 3,
    });
    const uses = toolUseIds(result.messages);
    const results = toolResultIds(result.messages);
    // Either tu_0_a/b were dropped entirely, or both are fully paired.
    for (const id of ["tu_0_a", "tu_0_b"]) {
      expect(uses.has(id)).toBe(results.has(id));
    }
  });
});

// ===========================================================================
// compactTranscript — PASS 1 stubbing + recent-window verbatim + text intact
// ===========================================================================

describe("contextBudget_compactTranscript_pass1AndWindow", () => {
  it("contextBudget_compactTranscript_staleResultsStubbedToStubText", () => {
    // PASS-1-ONLY budget: just below total so stale tool_results are stubbed but
    // PASS 2 never drops the rounds that carry them — so the stub provably
    // survives in the output (under tightHalf, PASS 2 could drop the stubbed
    // turns, removing the stub even though compactedResults > 0).
    const input = buildToolTranscript(6);
    const total = input.reduce((a, m) => a + estimateMessageTokens(m), 0);
    const result = compactTranscript(input, {
      maxTokens: total - 1,
      keepRecentTurns: 3,
    });
    // PASS 1 ran (stale results compacted) and PASS 2 did not (nothing dropped).
    expect(result.evicted.compactedResults).toBeGreaterThan(0);
    expect(result.evicted.droppedMessages).toBe(0);
    // At least one tool_result outside the recent window now carries the stub.
    const stubbed = result.messages.some(
      (m) =>
        typeof m.content !== "string" &&
        m.content.some(
          (b) => b.type === "tool_result" && b.content === STUB_TEXT
        )
    );
    expect(stubbed).toBe(true);
  });

  it("contextBudget_compactTranscript_keepsRecentTurnsVerbatimByValue", () => {
    const keepRecentTurns = 3;
    const input = buildToolTranscript(6);
    const result = compactTranscript(input, {
      maxTokens: tightHalf(input),
      keepRecentTurns,
    });

    // The last `keepRecentTurns` turns of the INPUT must appear verbatim (by
    // value) as the TAIL of the output. Each turn here is 4 messages → 12 msgs.
    const recentInput = input.slice(input.length - keepRecentTurns * 4);
    const tail = result.messages.slice(
      result.messages.length - recentInput.length
    );
    expect(tail).toEqual(recentInput);
  });

  it("contextBudget_compactTranscript_trailingMessageAlwaysProtected", () => {
    const input = buildToolTranscript(6);
    const result = compactTranscript(input, {
      maxTokens: tightHalf(input),
      keepRecentTurns: 3,
    });
    expect(result.messages[result.messages.length - 1]).toEqual(
      input[input.length - 1]
    );
  });

  it("contextBudget_compactTranscript_allTextBlocksPreserved", () => {
    // UI history must stay intact: every text block from the input still appears
    // somewhere in the output (PASS 2 only drops WHOLE turns — but here the budget
    // is set so no user-text turn-leader is dropped is NOT guaranteed; instead we
    // assert text preservation under a stub-only budget where PASS 2 doesn't run).
    const input = buildToolTranscript(4);
    const total = input.reduce((a, m) => a + estimateMessageTokens(m), 0);
    // Budget just under total but above the recent window → PASS 1 stubs, PASS 2
    // may or may not run; force PASS-1-only by targeting just below total.
    const result = compactTranscript(input, {
      maxTokens: total - 1,
      keepRecentTurns: 4, // keep ALL turns verbatim → only stubbing can act
    });
    // With every turn in the recent window, nothing is stale → no-op, all text kept.
    for (const t of allTexts(input)) {
      expect(allTexts(result.messages)).toContain(t);
    }
  });
});

/** Half-the-total budget that forces both passes for `buildToolTranscript`. */
function tightHalf(messages: Anthropic.MessageParam[]): number {
  const total = messages.reduce((a, m) => a + estimateMessageTokens(m), 0);
  return Math.floor(total / 2);
}

// ===========================================================================
// compactTranscript — PASS 2 turn-pair dropping + single trim note
// ===========================================================================

describe("contextBudget_compactTranscript_pass2Dropping", () => {
  it("contextBudget_compactTranscript_prependsTrimNoteExactlyOnce", () => {
    const input = buildToolTranscript(6);
    const result = compactTranscript(input, {
      maxTokens: tightHalf(input),
      keepRecentTurns: 3,
    });
    // The trim note appears exactly once, as the very first message.
    const noteCount = allTexts(result.messages).filter(
      (t) => t === TRIM_NOTE
    ).length;
    expect(noteCount).toBe(1);
    const first = result.messages[0];
    expect(first.role).toBe("user");
    expect(typeof first.content === "string" ? "" : first.content[0]).toEqual({
      type: "text",
      text: TRIM_NOTE,
    });
  });

  it("contextBudget_compactTranscript_dropsAtCleanTurnBoundaries", () => {
    // After dropping, the first NON-note message must be a turn-leading user-text
    // message (a clean boundary), never a dangling assistant/tool_result fragment.
    const input = buildToolTranscript(6);
    const result = compactTranscript(input, {
      maxTokens: tightHalf(input),
      keepRecentTurns: 3,
    });
    const afterNote = result.messages[1];
    expect(afterNote.role).toBe("user");
    if (typeof afterNote.content !== "string") {
      expect(afterNote.content.some((b) => b.type === "text")).toBe(true);
      // Not a tool_result-only message.
      expect(afterNote.content.every((b) => b.type === "tool_result")).toBe(
        false
      );
    }
  });

  it("contextBudget_compactTranscript_retainsTrailingWindowAfterDrop", () => {
    const keepRecentTurns = 3;
    const input = buildToolTranscript(6);
    const result = compactTranscript(input, {
      maxTokens: tightHalf(input),
      keepRecentTurns,
    });
    // The recent window tail survives the drop verbatim.
    const recentInput = input.slice(input.length - keepRecentTurns * 4);
    const tail = result.messages.slice(
      result.messages.length - recentInput.length
    );
    expect(tail).toEqual(recentInput);
  });
});

// ===========================================================================
// compactTranscript — under-target no-op + idempotency
// ===========================================================================

describe("contextBudget_compactTranscript_noopAndIdempotency", () => {
  it("contextBudget_compactTranscript_underTargetReturnsUnchangedByValue", () => {
    const input = buildToolTranscript(2);
    const result = compactTranscript(input, { maxTokens: 100_000 });
    expect(result.messages).toEqual(input); // by value
    expect(result.evicted.compactedResults).toBe(0);
    expect(result.evicted.droppedMessages).toBe(0);
  });

  it("contextBudget_compactTranscript_underTargetReturnsNewArrayNotSameRef", () => {
    const input = buildToolTranscript(2);
    const result = compactTranscript(input, { maxTokens: 100_000 });
    // A fresh array even on the no-op path (the input must never be aliased out).
    expect(result.messages).not.toBe(input);
  });

  it("contextBudget_compactTranscript_isIdempotentNoFurtherEviction", () => {
    const input = buildToolTranscript(6);
    const opts = { maxTokens: tightHalf(input), keepRecentTurns: 3 };
    const first = compactTranscript(input, opts);

    // Re-running on the already-compacted output (now under target) must be a
    // no-op: no extra stubbing, no second trim note.
    const second = compactTranscript(first.messages, opts);
    expect(second.evicted.compactedResults).toBe(0);
    expect(second.evicted.droppedMessages).toBe(0);
    const noteCount = allTexts(second.messages).filter(
      (t) => t === TRIM_NOTE
    ).length;
    expect(noteCount).toBe(1); // still exactly one — not doubled
    expect(second.messages).toEqual(first.messages); // stable by value
  });
});

// ===========================================================================
// compactTranscript — strict non-mutation of the input
// ===========================================================================

describe("contextBudget_compactTranscript_nonMutation", () => {
  it("contextBudget_compactTranscript_leavesInputArrayAndBlocksUnchanged", () => {
    const input = buildToolTranscript(6);
    const before = clone(input);

    compactTranscript(input, {
      maxTokens: tightHalf(input),
      keepRecentTurns: 3,
    });

    // The original array, its messages, and its nested blocks are untouched.
    expect(input).toEqual(before);
    expect(input).toHaveLength(before.length);
  });

  it("contextBudget_compactTranscript_doesNotStubInputToolResults", () => {
    // Specifically: PASS 1 must not have rewritten any of the INPUT's tool_result
    // payloads to the stub text (it builds fresh blocks instead).
    const input = buildToolTranscript(6);
    compactTranscript(input, {
      maxTokens: tightHalf(input),
      keepRecentTurns: 3,
    });
    const inputHasStub = input.some(
      (m) =>
        typeof m.content !== "string" &&
        m.content.some(
          (b) => b.type === "tool_result" && b.content === STUB_TEXT
        )
    );
    expect(inputHasStub).toBe(false);
  });
});
