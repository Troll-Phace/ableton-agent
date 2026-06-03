import { describe, expect, it } from "vitest";

import { buildSystemPrompt } from "../src/extension/system-prompt.js";
import { ClaudeClient } from "../src/extension/claude-client.js";
import {
  FakeMessagesClient,
  textTurn,
} from "./fixtures/fake-anthropic-client.js";

/**
 * Phase 6 Task 5 — system-prompt content + caching suite
 * (`src/extension/system-prompt.ts`, ARCHITECTURE §9 cannot-list, §15.1 caching,
 * §16 units). Two guarantees:
 *
 *  1. **Content** — the prompt is a SINGLE non-empty text block carrying the
 *     verbatim §9 "You cannot…" contract (so the model is genuinely *told* its
 *     limits), the honesty instruction (`report_limitation`), and the §16 units.
 *     This is the half of the Phase 6 guardrail that lives in the prompt: three
 *     of the four cannot-categories (automation, routing, plugins) are not even
 *     expressible as tool calls, so the prompt is what prevents the model from
 *     *attempting* them.
 *  2. **Caching** — run through {@link ClaudeClient}, the prompt's (single, last)
 *     system block carries `cache_control: { type: "ephemeral" }`, so the whole
 *     stable prefix caches across turns (§15.1). Asserted via the same captured
 *     params seam `claude-client.test.ts` uses — no new client internals exported.
 */

/** The single system block returned by {@link buildSystemPrompt}. */
function promptText(): string {
  const blocks = buildSystemPrompt();
  return blocks[0].text;
}

describe("system-prompt — single-block shape (§15.1)", () => {
  it("systemPrompt_buildSystemPrompt_returnsSingleNonEmptyTextBlock", () => {
    const blocks = buildSystemPrompt();
    // Exactly one block so the whole prompt caches as a unit — the client stamps
    // cache_control on the LAST system block only (§15.1).
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
    expect(typeof blocks[0].text).toBe("string");
    expect(blocks[0].text.trim().length).toBeGreaterThan(0);
  });

  it("systemPrompt_buildSystemPrompt_carriesNoCacheControlItself", () => {
    // The prompt module supplies CONTENT only; the cache breakpoint is the
    // client's to stamp (§15.1). The raw block must not pre-stamp cache_control.
    const block = buildSystemPrompt()[0];
    expect(block.cache_control).toBeUndefined();
  });
});

describe("system-prompt — verbatim §9 cannot-list", () => {
  // Each substring is lifted from the §9 "You cannot…" contract. If any drifts,
  // the model is no longer told that limit and an unsupported request could
  // fake-succeed — so every cannot-line is pinned.
  const CANNOT_LINES: [label: string, substring: string][] = [
    [
      "automation/DSP",
      `Process real-time audio or apply DSP ("make it warmer/louder/punchier").`,
    ],
    [
      "automation/envelopes (static-only)",
      "Draw automation / envelopes — live_set_param sets a STATIC value only.",
    ],
    [
      "routing / sidechain / MIDI routing",
      "Route signals or create sidechains; route MIDI.",
    ],
    [
      "groove / quantize-to-groove",
      "Apply groove / quantize-to-groove (only quantize note start times to a grid).",
    ],
    [
      "move markers after a clip exists",
      "Move loop/start/end markers after a clip exists (set only at creation).",
    ],
    [
      "third-party plugins (built-in only)",
      "Load third-party plugins (built-in Live devices only).",
    ],
    [
      "control surface / background / native UI",
      "Act as a control surface, run in the background, or draw in Live's native UI.",
    ],
    [
      "global selection",
      "See the global selection — only the object/selection that launched the agent, plus what tools read.",
    ],
  ];

  it.each(CANNOT_LINES)(
    "systemPrompt_text_containsCannotLine_%s",
    (_label, substring) => {
      expect(promptText()).toContain(substring);
    }
  );

  it("systemPrompt_text_headsTheCannotSection", () => {
    // The list is introduced as a contract the model must read as "you cannot".
    expect(promptText()).toContain("You cannot");
  });
});

describe("system-prompt — confirmation section (Phase 9 reconciliation, §9/§13)", () => {
  it("systemPrompt_text_confirmationNamesDeleteAndFilterOnly", () => {
    // The reconciled confirmation section gates exactly the §8.2 D-marked set:
    // live_delete + MIDI 'filter'. It must NOT name device-chain ops (those are
    // additive — the predicate isDestructiveCall agrees), or the prompt, the
    // predicate, and the executors would drift (plan §8.2 / risk areas).
    const text = promptText();
    expect(text).toContain("live_delete");
    expect(text).toContain("filter");
    expect(text).toContain("live_edit_midi_notes");
    // The pre-Phase-9 "destructive device-chain operations" claim was removed.
    expect(text).not.toContain("device-chain");
    expect(text).not.toContain("device chain");
  });

  it("systemPrompt_text_warnsAgainstBatchingDestructiveWithNonDestructive", () => {
    // A decline cancels the whole batch (one transaction, §7), so the prompt
    // steers the model away from mixing destructive + non-destructive in a turn.
    const text = promptText().toLowerCase();
    expect(text).toContain("do not batch destructive");
  });
});

describe("system-prompt — honesty + units", () => {
  it("systemPrompt_text_instructsReportLimitationForUnsupportedAsks", () => {
    // The honesty rule pairs the cannot-list with the report_limitation tool so an
    // unsupported request becomes an explicit limitation, never a fake success (§9).
    const text = promptText();
    expect(text).toContain("report_limitation");
    expect(text.toLowerCase()).toContain("alternative");
  });

  it("systemPrompt_text_statesTheUnitsContract", () => {
    // §16 units: beats (arrangement time), BPM (tempo), seconds (render analysis),
    // and raw min…max (device params). The agent must speak the right units.
    const text = promptText();
    expect(text).toContain("beats");
    expect(text).toContain("BPM");
    expect(text).toContain("seconds");
    expect(text).toContain("min…max");
  });

  it("systemPrompt_text_namesTheReadToolsForGrounding", () => {
    // The model is told to ground itself in the live model before acting (§6/§1.4).
    expect(promptText()).toContain("live_get_project");
  });
});

describe("system-prompt — caching (§15.1, via ClaudeClient)", () => {
  it("systemPrompt_runTurn_lastSystemBlockIsEphemeralCached", async () => {
    // Drive a turn through the real client with the real prompt and assert the
    // (single, last) system block is stamped ephemeral — mirrors
    // claude-client.test.ts's captured-params cache assertions, reusing the same
    // FakeMessagesClient seam (no new internals exported from claude-client).
    const fake = new FakeMessagesClient([textTurn("ok")]);
    const client = new ClaudeClient(fake);
    await client.runTurn({
      system: buildSystemPrompt(),
      tools: [],
      messages: [{ role: "user", content: "hi" }],
    });

    const system = fake.capturedParams[0].system;
    expect(Array.isArray(system)).toBe(true);
    if (Array.isArray(system)) {
      // One block (§15.1) and it carries the cache breakpoint, so the WHOLE
      // prompt caches across turns.
      expect(system).toHaveLength(1);
      const last = system[system.length - 1];
      expect(last.cache_control).toEqual({ type: "ephemeral" });
    }
  });
});
