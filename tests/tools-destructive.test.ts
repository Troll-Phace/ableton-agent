import { describe, expect, it } from "vitest";

import {
  isDestructiveCall,
  summarizeDestructivePlan,
} from "../src/shared/tools.js";

/**
 * Phase 9 Task 5 (1) — destructive-action predicate + plan summarizer
 * (`src/shared/tools.ts`, ARCHITECTURE §8.2 `D`, §9). Both functions are the
 * SINGLE source of truth shared by the agent loop, the confirm card, and the
 * system prompt, so the truth table + the user-facing strings are pinned here.
 *
 * The pure-module contract is TOTAL: `input` arrives off the wire as `unknown`,
 * so neither function may throw on a malformed / non-object value — a malformed
 * call is not provably destructive (predicate → `false`) and falls back to a
 * generic phrasing (summarizer), while the executor rejects bad input later (§9).
 */

/* -------------------------------------------------------------------------- */
/* isDestructiveCall — truth table                                            */
/* -------------------------------------------------------------------------- */

describe("isDestructiveCall — destructive set (§8.2 D)", () => {
  it("toolsDestructive_liveDelete_alwaysDestructive", () => {
    expect(isDestructiveCall("live_delete", { target: "track:1:Bass" })).toBe(
      true
    );
    // Destructive regardless of input shape — delete is always gated.
    expect(isDestructiveCall("live_delete", {})).toBe(true);
    expect(isDestructiveCall("live_delete", undefined)).toBe(true);
    expect(isDestructiveCall("live_delete", null)).toBe(true);
  });

  it("toolsDestructive_editMidiNotesFilter_isDestructive", () => {
    expect(
      isDestructiveCall("live_edit_midi_notes", {
        clip: "track:1:Keys/clip:0:Chords",
        op: "filter",
        filter: { pitchMin: 48 },
      })
    ).toBe(true);
  });

  it.each([["replace"], ["transpose"], ["quantize"], ["humanize"]] as const)(
    "toolsDestructive_editMidiNotesNonFilterOp_notDestructive_%s",
    (op) => {
      // Only op:"filter" removes notes; every other MIDI op is non-destructive.
      expect(isDestructiveCall("live_edit_midi_notes", { clip: "c", op })).toBe(
        false
      );
    }
  );

  it("toolsDestructive_editMidiNotesMissingOp_notDestructive", () => {
    // No op at all is not provably the destructive filter op.
    expect(isDestructiveCall("live_edit_midi_notes", { clip: "c" })).toBe(
      false
    );
  });

  it.each([
    ["live_update_track"],
    ["live_update_clip"],
    ["live_set_param"],
    ["live_create"],
    ["live_create_clip"],
    ["live_insert_device"],
    ["live_modify_device_chain"], // additive — explicitly NOT gated (plan §8.2)
    ["live_replace_sample"],
    ["live_import_audio"],
    ["live_get_project"],
    ["report_limitation"],
    ["some_unknown_tool"],
  ] as const)("toolsDestructive_nonDestructiveTool_false_%s", (name) => {
    expect(isDestructiveCall(name, { target: "x", op: "filter" })).toBe(false);
  });

  it("toolsDestructive_malformedInput_neverThrows", () => {
    // TOTAL: must narrow defensively and return false (not throw) for any
    // non-object / array / primitive input on a filter-capable tool name.
    const malformed: unknown[] = [
      undefined,
      null,
      42,
      "filter",
      true,
      ["op", "filter"],
      Symbol("x"),
    ];
    for (const input of malformed) {
      expect(() =>
        isDestructiveCall("live_edit_midi_notes", input)
      ).not.toThrow();
      expect(isDestructiveCall("live_edit_midi_notes", input)).toBe(false);
    }
  });

  it("toolsDestructive_filterOpAsNonString_notDestructive", () => {
    // `op` present but not the string "filter" → not destructive (no throw).
    expect(isDestructiveCall("live_edit_midi_notes", { op: 123 })).toBe(false);
    expect(isDestructiveCall("live_edit_midi_notes", { op: null })).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* summarizeDestructivePlan — action strings + total-count summary            */
/* -------------------------------------------------------------------------- */

describe("summarizeDestructivePlan — action lines (§13 confirm_request)", () => {
  it("toolsSummary_delete_actionNamesTheTarget", () => {
    const plan = summarizeDestructivePlan([
      { name: "live_delete", input: { target: "track:1:Bass" } },
    ]);
    expect(plan.actions).toEqual(["Delete track:1:Bass"]);
  });

  it("toolsSummary_deleteMissingTarget_fallsBackToGeneric", () => {
    const plan = summarizeDestructivePlan([{ name: "live_delete", input: {} }]);
    expect(plan.actions).toEqual(["Delete an object"]);
  });

  it("toolsSummary_deleteMalformedInput_fallsBackToGeneric", () => {
    const plan = summarizeDestructivePlan([
      { name: "live_delete", input: undefined },
    ]);
    expect(plan.actions).toEqual(["Delete an object"]);
  });

  it("toolsSummary_deleteNonStringTarget_fallsBackToGeneric", () => {
    const plan = summarizeDestructivePlan([
      { name: "live_delete", input: { target: 7 } },
    ]);
    expect(plan.actions).toEqual(["Delete an object"]);
  });

  it("toolsSummary_filter_actionNamesTheClip", () => {
    const plan = summarizeDestructivePlan([
      {
        name: "live_edit_midi_notes",
        input: { clip: "track:1:Keys/clip:0:Chords", op: "filter" },
      },
    ]);
    expect(plan.actions).toEqual([
      "Filter notes in track:1:Keys/clip:0:Chords (removes notes outside the kept range)",
    ]);
  });

  it("toolsSummary_filterMissingClip_fallsBackToGeneric", () => {
    const plan = summarizeDestructivePlan([
      { name: "live_edit_midi_notes", input: { op: "filter" } },
    ]);
    expect(plan.actions).toEqual([
      "Filter notes in a clip (removes notes outside the kept range)",
    ]);
  });

  it("toolsSummary_filterMalformedInput_neverThrowsAndFallsBack", () => {
    expect(() =>
      summarizeDestructivePlan([{ name: "live_edit_midi_notes", input: null }])
    ).not.toThrow();
    const plan = summarizeDestructivePlan([
      { name: "live_edit_midi_notes", input: null },
    ]);
    expect(plan.actions).toEqual([
      "Filter notes in a clip (removes notes outside the kept range)",
    ]);
  });
});

describe("summarizeDestructivePlan — summary headline (total count)", () => {
  it("toolsSummary_singleAction_summaryUsesSingularThing", () => {
    const plan = summarizeDestructivePlan([
      { name: "live_delete", input: { target: "track:1:Bass" } },
    ]);
    expect(plan.summary).toBe(
      "This will permanently change 1 thing and cannot be undone automatically by the agent."
    );
  });

  it("toolsSummary_multipleActions_summaryUsesPluralThings", () => {
    const plan = summarizeDestructivePlan([
      { name: "live_delete", input: { target: "track:1:Bass" } },
      { name: "live_delete", input: { target: "scene:0:Intro" } },
    ]);
    expect(plan.summary).toBe(
      "This will permanently change 2 things and cannot be undone automatically by the agent."
    );
  });

  it("toolsSummary_emptyPlan_summaryUsesZeroPlural", () => {
    const plan = summarizeDestructivePlan([]);
    expect(plan.actions).toEqual([]);
    expect(plan.summary).toBe(
      "This will permanently change 0 things and cannot be undone automatically by the agent."
    );
  });

  it("toolsSummary_mixedDeleteAndFilter_actionsAndCountCoverWholeSubset", () => {
    // A mixed destructive subset: the summary count is the TOTAL of the subset
    // and each action line reflects its own tool, in call order.
    const plan = summarizeDestructivePlan([
      { name: "live_delete", input: { target: "track:4:Old" } },
      {
        name: "live_edit_midi_notes",
        input: { clip: "track:1:Keys/clip:0:Chords", op: "filter" },
      },
      { name: "live_delete", input: { target: "device:0:Reverb" } },
    ]);
    expect(plan.actions).toEqual([
      "Delete track:4:Old",
      "Filter notes in track:1:Keys/clip:0:Chords (removes notes outside the kept range)",
      "Delete device:0:Reverb",
    ]);
    expect(plan.summary).toContain("3 things");
  });
});
