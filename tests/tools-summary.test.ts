import { describe, expect, it } from "vitest";

import { summarizeToolCall } from "../src/shared/tools.js";

/**
 * Phase 12 Task C — narration summarizer `summarizeToolCall(name, input)`
 * (`src/shared/tools.ts`, ARCHITECTURE §13 `tool_activity.summary`). This pure,
 * total, deterministic function turns one tool call into a short, key-free
 * phrase for the §13 chip the webview renders.
 *
 * The pure-module contract is TOTAL: `input` arrives off the wire as `unknown`,
 * so the function NEVER throws on a malformed / non-object value — a missing or
 * malformed field falls back to that tool's generic phrasing, and an unknown
 * tool name returns the bare `name` unchanged (preserving the prior narration).
 * Present-field lists use the declared field-name keys, in declared order,
 * comma-space joined; a field counts as present when `record[key] !== undefined`,
 * except string fields, which are only used when non-empty strings.
 */

/* -------------------------------------------------------------------------- */
/* One representative "with data" phrase per tool name                        */
/* -------------------------------------------------------------------------- */

describe("summarizeToolCall — representative phrase per tool", () => {
  it("toolsSummary_liveUpdateTrack_withData", () => {
    expect(
      summarizeToolCall("live_update_track", {
        track: "track:2:Bass",
        name: "Sub Bass",
      })
    ).toBe("Update track:2:Bass (name)");
  });

  it("toolsSummary_liveUpdateClip_withData", () => {
    expect(
      summarizeToolCall("live_update_clip", {
        clip: "track:2:Bass/clip:0:Verse",
        looping: true,
      })
    ).toBe("Update track:2:Bass/clip:0:Verse (looping)");
  });

  it("toolsSummary_liveEditMidiNotes_withData", () => {
    expect(
      summarizeToolCall("live_edit_midi_notes", {
        clip: "track:0:Keys/clip:0:Verse",
        op: "transpose",
        semitones: 12,
      })
    ).toBe("Transpose notes in track:0:Keys/clip:0:Verse");
  });

  it("toolsSummary_liveSetParam_withData", () => {
    expect(
      summarizeToolCall("live_set_param", {
        target: {
          type: "device",
          device: "track:2:Bass/device:1:Reverb",
          param: "track:2:Bass/device:1:Reverb/param:7:Decay",
        },
        value: 0.5,
      })
    ).toBe("Set track:2:Bass/device:1:Reverb/param:7:Decay");
  });

  it("toolsSummary_liveCreate_withData", () => {
    expect(summarizeToolCall("live_create", { kind: "midi_track" })).toBe(
      "Create midi_track"
    );
  });

  it("toolsSummary_liveCreateClip_withData", () => {
    expect(
      summarizeToolCall("live_create_clip", {
        location: "track:1:Keys/clipSlot:0",
        type: "midi",
      })
    ).toBe("Create midi clip");
  });

  it("toolsSummary_liveInsertDevice_withData", () => {
    expect(
      summarizeToolCall("live_insert_device", {
        location: "track:2:Bass",
        deviceName: "EQ Eight",
        index: 0,
      })
    ).toBe("Insert EQ Eight");
  });

  it("toolsSummary_liveModifyDeviceChain_withData", () => {
    expect(
      summarizeToolCall("live_modify_device_chain", {
        location: "track:2:Bass/device:0:Rack",
        op: "insert_chain",
      })
    ).toBe("Modify device chain (insert_chain)");
  });

  it("toolsSummary_liveReplaceSample_constant", () => {
    expect(
      summarizeToolCall("live_replace_sample", {
        simpler: "track:3:Drums/device:0:Simpler",
        filePath: "/managed/temp/kick.wav",
      })
    ).toBe("Replace sample");
  });

  it("toolsSummary_liveDelete_withData", () => {
    expect(
      summarizeToolCall("live_delete", { target: "track:4:Old Take" })
    ).toBe("Delete track:4:Old Take");
  });

  it("toolsSummary_liveGetProject_constant", () => {
    expect(summarizeToolCall("live_get_project", {})).toBe("Read project");
  });

  it("toolsSummary_liveGetTrack_withData", () => {
    expect(summarizeToolCall("live_get_track", { track: "track:2:Bass" })).toBe(
      "Read track:2:Bass"
    );
  });

  it("toolsSummary_liveGetClip_withData", () => {
    expect(
      summarizeToolCall("live_get_clip", { clip: "track:2:Bass/clip:0:Verse" })
    ).toBe("Read track:2:Bass/clip:0:Verse");
  });

  it("toolsSummary_liveGetDeviceParams_withData", () => {
    expect(
      summarizeToolCall("live_get_device_params", {
        device: "track:2:Bass/device:1:Reverb",
      })
    ).toBe("Read track:2:Bass/device:1:Reverb");
  });

  it("toolsSummary_liveRenderAudio_constant", () => {
    expect(
      summarizeToolCall("live_render_audio", {
        track: "track:0:Drums",
        startTime: 0,
        endTime: 16,
      })
    ).toBe("Render audio");
  });

  it("toolsSummary_liveImportAudio_constant", () => {
    expect(
      summarizeToolCall("live_import_audio", {
        source: "https://example.com/loop.wav",
      })
    ).toBe("Import audio");
  });

  it("toolsSummary_reportLimitation_constant", () => {
    expect(
      summarizeToolCall("report_limitation", {
        requested: "draw automation",
        reason: "no automation API",
      })
    ).toBe("Report limitation");
  });
});

/* -------------------------------------------------------------------------- */
/* Field-listing behavior — live_update_track                                 */
/* -------------------------------------------------------------------------- */

describe("summarizeToolCall — live_update_track field listing", () => {
  it("toolsSummary_updateTrack_listsPresentFieldsInDeclaredOrder", () => {
    // Only name + mute present → "(name, mute)", in declared order, comma-space.
    expect(
      summarizeToolCall("live_update_track", {
        track: "track:2:Bass",
        name: "Sub",
        mute: true,
      })
    ).toBe("Update track:2:Bass (name, mute)");
  });

  it("toolsSummary_updateTrack_allFields_listedInDeclaredOrder", () => {
    expect(
      summarizeToolCall("live_update_track", {
        track: "track:2:Bass",
        arm: false,
        solo: true,
        mute: false,
        name: "X",
      })
    ).toBe("Update track:2:Bass (name, mute, solo, arm)");
  });

  it("toolsSummary_updateTrack_falsyBooleanStillCountsAsPresent", () => {
    // mute:false is present (record[key] !== undefined), so it is listed.
    expect(
      summarizeToolCall("live_update_track", {
        track: "track:2:Bass",
        mute: false,
      })
    ).toBe("Update track:2:Bass (mute)");
  });

  it("toolsSummary_updateTrack_noFields_fallsBackToGeneric", () => {
    // No present option fields → the generic fallback (the track ref is dropped).
    expect(
      summarizeToolCall("live_update_track", { track: "track:2:Bass" })
    ).toBe("Update track");
  });

  it("toolsSummary_updateTrack_missingTrackRef_usesPlaceholderWithFields", () => {
    // track missing → placeholder "track"; option fields still listed.
    expect(summarizeToolCall("live_update_track", { name: "X" })).toBe(
      "Update track (name)"
    );
  });
});

/* -------------------------------------------------------------------------- */
/* live_edit_midi_notes — op capitalization + fallback                        */
/* -------------------------------------------------------------------------- */

describe("summarizeToolCall — live_edit_midi_notes op phrasing", () => {
  it.each([
    ["replace", "Replace notes in track:0:Keys/clip:0:V"],
    ["transpose", "Transpose notes in track:0:Keys/clip:0:V"],
    ["quantize", "Quantize notes in track:0:Keys/clip:0:V"],
    ["humanize", "Humanize notes in track:0:Keys/clip:0:V"],
    ["filter", "Filter notes in track:0:Keys/clip:0:V"],
  ] as const)("toolsSummary_editMidiNotes_capitalizesOp_%s", (op, expected) => {
    expect(
      summarizeToolCall("live_edit_midi_notes", {
        clip: "track:0:Keys/clip:0:V",
        op,
      })
    ).toBe(expected);
  });

  it("toolsSummary_editMidiNotes_missingOp_fallsBackToEditPhrase", () => {
    expect(
      summarizeToolCall("live_edit_midi_notes", {
        clip: "track:0:Keys/clip:0:V",
      })
    ).toBe("Edit notes in track:0:Keys/clip:0:V");
  });

  it("toolsSummary_editMidiNotes_missingClip_usesClipPlaceholder", () => {
    // clip missing → placeholder "clip"; op still drives the verb.
    expect(summarizeToolCall("live_edit_midi_notes", { op: "transpose" })).toBe(
      "Transpose notes in clip"
    );
  });

  it("toolsSummary_editMidiNotes_missingClipAndOp_genericEditOnClipPlaceholder", () => {
    expect(summarizeToolCall("live_edit_midi_notes", {})).toBe(
      "Edit notes in clip"
    );
  });
});

/* -------------------------------------------------------------------------- */
/* live_set_param — target.param vs target.mixer precedence                   */
/* -------------------------------------------------------------------------- */

describe("summarizeToolCall — live_set_param target precedence", () => {
  it("toolsSummary_setParam_prefersDeviceParamRef", () => {
    expect(
      summarizeToolCall("live_set_param", {
        target: {
          type: "device",
          param: "track:2:Bass/device:1:Reverb/param:7:Decay",
        },
        value: 0.5,
      })
    ).toBe("Set track:2:Bass/device:1:Reverb/param:7:Decay");
  });

  it("toolsSummary_setParam_usesMixerWhenNoParam", () => {
    // No param; mixer is read as a (string) label fallback.
    expect(
      summarizeToolCall("live_set_param", {
        target: { type: "mixer", mixer: "volume" },
        value: 0,
      })
    ).toBe("Set volume");
  });

  it("toolsSummary_setParam_paramWinsOverMixerWhenBothPresent", () => {
    // param precedes mixer in the `??` chain, so it wins when both are strings.
    expect(
      summarizeToolCall("live_set_param", {
        target: { param: "p:ref", mixer: "volume" },
        value: 1,
      })
    ).toBe("Set p:ref");
  });

  it("toolsSummary_setParam_noTarget_fallsBackToGeneric", () => {
    expect(summarizeToolCall("live_set_param", { value: 1 })).toBe(
      "Set parameter"
    );
  });

  it("toolsSummary_setParam_emptyTarget_fallsBackToGeneric", () => {
    expect(summarizeToolCall("live_set_param", { target: {}, value: 1 })).toBe(
      "Set parameter"
    );
  });

  it("toolsSummary_setParam_nonStringParamAndMixer_fallsBackToGeneric", () => {
    // The real mixer arg is an object (`{ kind: "send", index }`), not a string,
    // so neither param nor mixer is a usable label → generic fallback.
    expect(
      summarizeToolCall("live_set_param", {
        target: {
          type: "mixer",
          track: "track:2:Bass",
          mixer: { kind: "send", index: 0 },
        },
        value: 0.25,
      })
    ).toBe("Set parameter");
  });
});

/* -------------------------------------------------------------------------- */
/* Generic fallbacks for bag tools with no usable fields                      */
/* -------------------------------------------------------------------------- */

describe("summarizeToolCall — generic fallbacks (no usable fields)", () => {
  it.each([
    ["live_update_track", "Update track"],
    ["live_update_clip", "Update clip"],
    ["live_set_param", "Set parameter"],
    ["live_create", "Create object"],
    ["live_create_clip", "Create clip"],
    ["live_insert_device", "Insert device"],
    ["live_modify_device_chain", "Modify device chain"],
    ["live_delete", "Delete object"],
    ["live_get_track", "Read track"],
    ["live_get_clip", "Read clip"],
    ["live_get_device_params", "Read device"],
  ] as const)(
    "toolsSummary_emptyInput_genericFallback_%s",
    (name, expected) => {
      expect(summarizeToolCall(name, {})).toBe(expected);
    }
  );

  it("toolsSummary_emptyStringRef_treatedAsAbsent", () => {
    // String fields are only used when NON-empty, so "" is treated as absent.
    expect(summarizeToolCall("live_get_track", { track: "" })).toBe(
      "Read track"
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Malformed / non-object input → generic fallback, NEVER throws              */
/* -------------------------------------------------------------------------- */

describe("summarizeToolCall — malformed input is total (never throws)", () => {
  const malformed: [label: string, input: unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["array", []],
    ["number", 42],
    ["string", "str"],
    ["empty object", {}],
  ];

  // A few representative mapped tools spanning ref-bearing, op-bearing,
  // nested-target, and constant phrasings.
  const mappedTools = [
    ["live_update_track", "Update track"],
    ["live_edit_midi_notes", "Edit notes in clip"],
    ["live_set_param", "Set parameter"],
    ["live_delete", "Delete object"],
    ["live_get_project", "Read project"],
    ["live_replace_sample", "Replace sample"],
  ] as const;

  for (const [toolName, expected] of mappedTools) {
    it.each(malformed)(
      `toolsSummary_${toolName}_malformedInput_%s_returnsGenericNoThrow`,
      (_label, input) => {
        expect(() => summarizeToolCall(toolName, input)).not.toThrow();
        expect(summarizeToolCall(toolName, input)).toBe(expected);
      }
    );
  }
});

/* -------------------------------------------------------------------------- */
/* Unknown tool name → bare name                                              */
/* -------------------------------------------------------------------------- */

describe("summarizeToolCall — unknown tool name", () => {
  it("toolsSummary_unknownTool_returnsBareName", () => {
    expect(summarizeToolCall("not_a_tool", {})).toBe("not_a_tool");
  });

  it("toolsSummary_unknownTool_ignoresInputAndReturnsBareName", () => {
    expect(
      summarizeToolCall("spin", { track: "track:0:X", op: "filter" })
    ).toBe("spin");
  });

  it("toolsSummary_unknownTool_malformedInput_neverThrows", () => {
    expect(() => summarizeToolCall("mystery", null)).not.toThrow();
    expect(summarizeToolCall("mystery", null)).toBe("mystery");
  });
});
