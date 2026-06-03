import { describe, expect, it } from "vitest";

import {
  parseRef,
  RefParseError,
  serializeRef,
  shiftSiblingIndices,
  validateRef,
  type ParsedRef,
  type RefSegment,
} from "../src/shared/refs.js";

/**
 * Phase 3 grammar suite — the pure ref grammar in `src/shared/refs.ts`.
 *
 * Two layers are exercised separately, mirroring the module's contract:
 *  - `parseRef` is LEXICAL-only (throws {@link RefParseError} on malformed
 *    strings); `serializeRef` is its inverse.
 *  - `validateRef` is STRUCTURAL (returns `{ ok, issues }`) for lexically-valid
 *    but structurally-illegal paths.
 *  - `shiftSiblingIndices` is the pure subtree-rebuild used after a delete.
 */

/** Re-parse a canonical string and assert the round-trip is lossless both ways. */
function expectRoundTrip(canonical: string, expected: RefSegment[]): void {
  const parsed = parseRef(canonical);
  expect(parsed.segments).toEqual(expected);
  expect(serializeRef(parsed.segments)).toBe(canonical);
  // serialize ∘ parse identity on the supplied segments too.
  expect(serializeRef(expected)).toBe(canonical);
}

describe("refs grammar — round-trip every kind", () => {
  it("refs_roundTrip_track", () => {
    expectRoundTrip("track:2:Bass", [
      { kind: "track", index: 2, name: "Bass" },
    ]);
  });

  it("refs_roundTrip_sceneAndCuePoint", () => {
    expectRoundTrip("scene:4:Chorus", [
      { kind: "scene", index: 4, name: "Chorus" },
    ]);
    expectRoundTrip("cuePoint:0:Intro", [
      { kind: "cuePoint", index: 0, name: "Intro" },
    ]);
  });

  it("refs_roundTrip_arrangementClip", () => {
    expectRoundTrip("track:2:Bass/clip:0:Verse", [
      { kind: "track", index: 2, name: "Bass" },
      { kind: "clip", index: 0, name: "Verse" },
    ]);
  });

  it("refs_roundTrip_clipSlotIndexOnly", () => {
    expectRoundTrip("track:2:Bass/clipSlot:5", [
      { kind: "track", index: 2, name: "Bass" },
      { kind: "clipSlot", index: 5, name: "" },
    ]);
  });

  it("refs_roundTrip_clipSlotWithClip", () => {
    expectRoundTrip("track:2:Bass/clipSlot:5/clip:0:Verse", [
      { kind: "track", index: 2, name: "Bass" },
      { kind: "clipSlot", index: 5, name: "" },
      { kind: "clip", index: 0, name: "Verse" },
    ]);
  });

  it("refs_roundTrip_takeLaneClip", () => {
    expectRoundTrip("track:2:Bass/takeLane:1:Comp/clip:0:Verse", [
      { kind: "track", index: 2, name: "Bass" },
      { kind: "takeLane", index: 1, name: "Comp" },
      { kind: "clip", index: 0, name: "Verse" },
    ]);
  });

  it("refs_roundTrip_device", () => {
    expectRoundTrip("track:2:Bass/device:1:Reverb", [
      { kind: "track", index: 2, name: "Bass" },
      { kind: "device", index: 1, name: "Reverb" },
    ]);
  });

  it("refs_roundTrip_deviceParam", () => {
    expectRoundTrip("track:2:Bass/device:1:Reverb/param:7:Decay", [
      { kind: "track", index: 2, name: "Bass" },
      { kind: "device", index: 1, name: "Reverb" },
      { kind: "param", under: "device", index: 7, name: "Decay" },
    ]);
  });

  it("refs_roundTrip_nestedTrackDeviceChainDeviceParam", () => {
    expectRoundTrip(
      "track:2:Bass/device:0:Rack/chain:1:B/device:0:Reverb/param:7:Decay",
      [
        { kind: "track", index: 2, name: "Bass" },
        { kind: "device", index: 0, name: "Rack" },
        { kind: "chain", index: 1, name: "B" },
        { kind: "device", index: 0, name: "Reverb" },
        { kind: "param", under: "device", index: 7, name: "Decay" },
      ]
    );
  });

  it("refs_roundTrip_bareMixer", () => {
    expectRoundTrip("track:2:Bass/mixer", [
      { kind: "track", index: 2, name: "Bass" },
      { kind: "mixer" },
    ]);
  });

  it("refs_roundTrip_mixerParamVolume", () => {
    expectRoundTrip("track:2:Bass/mixer/param:volume", [
      { kind: "track", index: 2, name: "Bass" },
      { kind: "mixer" },
      { kind: "param", under: "mixer", ref: { selector: "volume" } },
    ]);
  });

  it("refs_roundTrip_mixerParamPan", () => {
    expectRoundTrip("track:2:Bass/mixer/param:pan", [
      { kind: "track", index: 2, name: "Bass" },
      { kind: "mixer" },
      { kind: "param", under: "mixer", ref: { selector: "pan" } },
    ]);
  });

  it("refs_roundTrip_mixerParamSend", () => {
    expectRoundTrip("track:2:Bass/mixer/param:send:1", [
      { kind: "track", index: 2, name: "Bass" },
      { kind: "mixer" },
      {
        kind: "param",
        under: "mixer",
        ref: { selector: "send", sendIndex: 1 },
      },
    ]);
  });

  it("refs_roundTrip_chainMixerParam", () => {
    expectRoundTrip("track:2:Bass/device:0:Rack/chain:0:A/mixer/param:send:0", [
      { kind: "track", index: 2, name: "Bass" },
      { kind: "device", index: 0, name: "Rack" },
      { kind: "chain", index: 0, name: "A" },
      { kind: "mixer" },
      {
        kind: "param",
        under: "mixer",
        ref: { selector: "send", sendIndex: 0 },
      },
    ]);
  });
});

describe("refs grammar — name escaping (lossless)", () => {
  it("refs_escaping_colonSlashPercent", () => {
    // Name with all three boundary-breaking characters.
    const segments: RefSegment[] = [
      { kind: "track", index: 0, name: "A:B/C%D" },
    ];
    const canonical = serializeRef(segments);
    expect(canonical).toBe("track:0:A%3AB%2FC%25D");
    expect(parseRef(canonical).segments).toEqual(segments);
  });

  it("refs_escaping_spacesAndUnicodeLeftIntact", () => {
    const segments: RefSegment[] = [
      { kind: "track", index: 3, name: "Lead Synth ✨ café" },
    ];
    const canonical = serializeRef(segments);
    // Spaces and unicode are NOT encoded — only %/:/ are.
    expect(canonical).toBe("track:3:Lead Synth ✨ café");
    expect(parseRef(canonical).segments).toEqual(segments);
  });

  it("refs_escaping_percentFirstKeepsReversible", () => {
    // A literal "%3A" in a name must survive — the % is encoded first.
    const segments: RefSegment[] = [
      { kind: "device", index: 1, name: "lit %3A here" },
    ];
    const canonical = serializeRef(segments);
    expect(canonical).toBe("device:1:lit %253A here");
    expect(parseRef(canonical).segments).toEqual(segments);
  });

  it("refs_escaping_deviceParamNameEscaped", () => {
    const segments: RefSegment[] = [
      { kind: "track", index: 0, name: "T" },
      { kind: "device", index: 0, name: "D" },
      { kind: "param", under: "device", index: 0, name: "A:B" },
    ];
    const canonical = serializeRef(segments);
    expect(canonical).toBe("track:0:T/device:0:D/param:0:A%3AB");
    expect(parseRef(canonical).segments).toEqual(segments);
  });

  it("refs_escaping_decodesLowercaseHex", () => {
    // decodeName accepts case-insensitive hex.
    expect(parseRef("track:0:a%3ab").segments).toEqual([
      { kind: "track", index: 0, name: "a:b" },
    ]);
  });
});

describe("refs grammar — malformed input throws RefParseError", () => {
  const cases: { name: string; input: string }[] = [
    { name: "emptyString", input: "" },
    { name: "leadingSlash", input: "/track:0:A" },
    { name: "trailingSlash", input: "track:0:A/" },
    { name: "emptySegmentDoubleSlash", input: "track:0:A//device:0:B" },
    { name: "unknownKind", input: "widget:0:A" },
    { name: "nonNumericIndex", input: "track:x:A" },
    { name: "negativeLooksNonNumeric", input: "track:-1:A" },
    { name: "badPercentZZ", input: "track:0:a%ZZb" },
    { name: "barePercent", input: "track:0:a%" },
    { name: "trackMissingName", input: "track:0" },
    { name: "deviceMissingName", input: "track:0:T/device:0" },
  ];

  for (const c of cases) {
    it(`refs_malformed_${c.name}_throws`, () => {
      expect(() => parseRef(c.input)).toThrow(RefParseError);
    });
  }

  it("refs_malformed_mixerParamSendMissingIndex_throws", () => {
    expect(() => parseRef("track:0:T/mixer/param:send")).toThrow(RefParseError);
  });

  it("refs_malformed_mixerTakesNoFields_throws", () => {
    expect(() => parseRef("track:0:T/mixer:0")).toThrow(RefParseError);
  });

  it("refs_malformed_mixerParamUnknownKeyword_throws", () => {
    expect(() => parseRef("track:0:T/mixer/param:bogus")).toThrow(
      RefParseError
    );
  });

  it("refs_malformed_mixerParamSendExtraField_throws", () => {
    expect(() => parseRef("track:0:T/mixer/param:send:1:2")).toThrow(
      RefParseError
    );
  });

  it("refs_malformed_mixerParamVolumeExtraField_throws", () => {
    expect(() => parseRef("track:0:T/mixer/param:volume:1")).toThrow(
      RefParseError
    );
  });

  it("refs_malformed_paramMissingSelector_throws", () => {
    expect(() => parseRef("track:0:T/mixer/param")).toThrow(RefParseError);
  });

  it("refs_malformed_paramFirstSegment_throws", () => {
    expect(() => parseRef("param:0:X")).toThrow(RefParseError);
  });

  it("refs_malformed_paramAfterTrack_throws", () => {
    // param must follow mixer or device, not track.
    expect(() => parseRef("track:0:T/param:0:X")).toThrow(RefParseError);
  });

  it("refs_malformed_clipSlotWithName_throws", () => {
    expect(() => parseRef("track:0:T/clipSlot:0:Name")).toThrow(RefParseError);
  });

  it("refs_malformed_deviceParamExtraField_throws", () => {
    expect(() => parseRef("track:0:T/device:0:D/param:0:N:extra")).toThrow(
      RefParseError
    );
  });

  it("refs_malformed_deviceParamMissingName_throws", () => {
    expect(() => parseRef("track:0:T/device:0:D/param:0")).toThrow(
      RefParseError
    );
  });

  it("refs_malformed_messageMentionsKind", () => {
    // Spot-check the error message is informative (covers the message branch).
    expect(() => parseRef("widget:0:A")).toThrow(/Unknown kind "widget"/);
  });
});

describe("refs grammar — structural validation (validateRef)", () => {
  /** Parse a string that is lexically valid; assert it then fails validation. */
  function parsedOf(s: string): ParsedRef {
    return parseRef(s);
  }

  it("refs_validate_fullyLegalPath_ok", () => {
    const parsed = parsedOf(
      "track:0:T/device:0:Rack/chain:0:A/device:0:F/param:0:Freq"
    );
    expect(validateRef(parsed)).toEqual({ ok: true });
  });

  it("refs_validate_legalMixerParamSend_ok", () => {
    expect(validateRef(parsedOf("track:0:T/mixer/param:send:0"))).toEqual({
      ok: true,
    });
  });

  it("refs_validate_chainNotUnderDevice_issue", () => {
    // A `chain` whose parent is a track (not a device) is structurally illegal,
    // but lexically parses fine.
    const result = validateRef(parsedOf("track:0:T/chain:0:A"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.join(" ")).toMatch(/chain.*parent must be a device/);
    }
  });

  it("refs_validate_clipSlotNotUnderTrack_issue", () => {
    // clipSlot under a device is illegal.
    const result = validateRef(parsedOf("track:0:T/device:0:D/clipSlot:0"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join(" ")).toMatch(
        /clipSlot.*parent must be a track/
      );
    }
  });

  it("refs_validate_takeLaneNotUnderTrack_issue", () => {
    const result = validateRef(parsedOf("track:0:T/device:0:D/takeLane:0:L"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join(" ")).toMatch(
        /takeLane.*parent must be a track/
      );
    }
  });

  it("refs_validate_clipUnderIllegalParent_issue", () => {
    // clip under a device is not track/clipSlot/takeLane.
    const result = validateRef(parsedOf("track:0:T/device:0:D/clip:0:C"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join(" ")).toMatch(/clip.*parent must be/);
    }
  });

  it("refs_validate_mixerUnderIllegalParent_issue", () => {
    // mixer under a scene is not track/chain.
    const result = validateRef(parsedOf("scene:0:S/mixer"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join(" ")).toMatch(/mixer.*parent must be/);
    }
  });

  it("refs_validate_deviceAtSongLevel_issue", () => {
    // A top-level device has no legal parent.
    const result = validateRef(parsedOf("device:0:D"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join(" ")).toMatch(/device.*parent must be/);
    }
  });

  it("refs_validate_trackNotTopLevel_issue", () => {
    // track must be song-anchored, not under another track.
    const result = validateRef(parsedOf("track:0:A/track:0:B"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join(" ")).toMatch(/track.*must be top-level/);
    }
  });

  it("refs_validate_sceneNotTopLevel_issue", () => {
    const result = validateRef(parsedOf("track:0:A/scene:0:S"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join(" ")).toMatch(/scene.*must be top-level/);
    }
  });

  it("refs_validate_mixerParamWithoutMixerParent_issue", () => {
    // A mixer-param segment must follow a `mixer` segment. Construct one directly
    // (parseRef would reject `param:volume` after a track), so we hand-build it.
    const parsed: ParsedRef = {
      segments: [
        { kind: "track", index: 0, name: "T" },
        { kind: "param", under: "mixer", ref: { selector: "volume" } },
      ],
      source: "(synthetic)",
    };
    const result = validateRef(parsed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join(" ")).toMatch(/mixer "param" must follow/);
    }
  });

  it("refs_validate_deviceParamWithoutDeviceParent_issue", () => {
    const parsed: ParsedRef = {
      segments: [
        { kind: "track", index: 0, name: "T" },
        { kind: "param", under: "device", index: 0, name: "X" },
      ],
      source: "(synthetic)",
    };
    const result = validateRef(parsed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join(" ")).toMatch(/device "param" must follow/);
    }
  });

  it("refs_validate_negativeIndex_issue", () => {
    // parseRef won't yield a negative index, so hand-build one.
    const parsed: ParsedRef = {
      segments: [{ kind: "track", index: -1, name: "T" }],
      source: "(synthetic)",
    };
    const result = validateRef(parsed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join(" ")).toMatch(/index must be >= 0/);
    }
  });

  it("refs_validate_negativeSendIndex_issue", () => {
    const parsed: ParsedRef = {
      segments: [
        { kind: "track", index: 0, name: "T" },
        { kind: "mixer" },
        {
          kind: "param",
          under: "mixer",
          ref: { selector: "send", sendIndex: -1 },
        },
      ],
      source: "(synthetic)",
    };
    const result = validateRef(parsed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join(" ")).toMatch(/sendIndex must be >= 0/);
    }
  });

  it("refs_validate_negativeDeviceParamIndex_issue", () => {
    const parsed: ParsedRef = {
      segments: [
        { kind: "track", index: 0, name: "T" },
        { kind: "device", index: 0, name: "D" },
        { kind: "param", under: "device", index: -1, name: "X" },
      ],
      source: "(synthetic)",
    };
    const result = validateRef(parsed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join(" ")).toMatch(
        /device "param" index must be >= 0/
      );
    }
  });

  it("refs_validate_emptySegments_issue", () => {
    const result = validateRef({ segments: [], source: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContain("Ref has no segments");
    }
  });

  it("refs_validate_collectsAllIssues_notJustFirst", () => {
    // Two independent violations in one path → both reported.
    const result = validateRef(parsedOf("device:0:D/track:0:T"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("refs grammar — shiftSiblingIndices", () => {
  it("refs_shift_topLevelDecrementsAfterDeleted", () => {
    const refs = ["track:0:A", "track:1:B", "track:2:C", "track:3:D"];
    // Delete track index 1 at song-level.
    const out = shiftSiblingIndices(refs, "", "track", 1);
    expect(out).toEqual([
      "track:0:A", // < deleted — untouched
      // track:1:B dropped (== deleted)
      "track:1:C", // was 2 → decremented
      "track:2:D", // was 3 → decremented
    ]);
  });

  it("refs_shift_dropsDeletedAndItsDescendants", () => {
    const refs = [
      "track:1:B", // the deleted track itself
      "track:1:B/device:0:Reverb", // descendant of deleted track
      "track:2:C", // later sibling
    ];
    const out = shiftSiblingIndices(refs, "", "track", 1);
    // The deleted track and its descendant subtree are dropped; later sibling shifts.
    expect(out).toEqual(["track:1:C"]);
  });

  it("refs_shift_earlierSiblingUntouched", () => {
    const out = shiftSiblingIndices(["track:0:A", "track:5:E"], "", "track", 5);
    // index 0 < 5 untouched; index 5 == deleted dropped.
    expect(out).toEqual(["track:0:A"]);
  });

  it("refs_shift_otherBranchesUntouched", () => {
    const refs = ["track:0:A", "scene:2:S", "cuePoint:3:C"];
    const out = shiftSiblingIndices(refs, "", "track", 0);
    // Only the track collection is affected; scene/cuePoint untouched.
    expect(out).toEqual(["scene:2:S", "cuePoint:3:C"]);
  });

  it("refs_shift_nestedParentScopesToSubtree", () => {
    const refs = [
      "track:0:T/device:0:A",
      "track:0:T/device:1:B", // deleted
      "track:0:T/device:2:C",
      "track:1:Other/device:1:X", // different parent — untouched
    ];
    const out = shiftSiblingIndices(refs, "track:0:T", "device", 1);
    expect(out).toEqual([
      "track:0:T/device:0:A",
      "track:0:T/device:1:C", // was 2 → decremented
      "track:1:Other/device:1:X", // untouched (different parent prefix)
    ]);
  });

  it("refs_shift_sameLevelDifferentKindUntouched", () => {
    // A clipSlot at the same depth as a deleted device is a different kind.
    const refs = ["track:0:T/device:1:D", "track:0:T/clipSlot:2"];
    const out = shiftSiblingIndices(refs, "track:0:T", "device", 0);
    // device:1 decremented to device:0; clipSlot untouched (different kind).
    expect(out).toEqual(["track:0:T/device:0:D", "track:0:T/clipSlot:2"]);
  });

  it("refs_shift_refTooShallowUntouched", () => {
    // A ref shorter than parentDepth+1 cannot contain the affected segment.
    const refs = ["track:0:T"];
    const out = shiftSiblingIndices(refs, "track:0:T", "device", 0);
    expect(out).toEqual(["track:0:T"]);
  });

  it("refs_shift_prefixMismatchUntouched", () => {
    const refs = ["track:1:Other/device:2:X"];
    const out = shiftSiblingIndices(refs, "track:0:T", "device", 0);
    expect(out).toEqual(["track:1:Other/device:2:X"]);
  });

  it("refs_shift_unparseableRefPassedThrough", () => {
    const refs = ["not a valid ref", "track:2:C"];
    const out = shiftSiblingIndices(refs, "", "track", 0);
    // Garbage passes through; valid track:2 decrements to track:1.
    expect(out).toEqual(["not a valid ref", "track:1:C"]);
  });

  it("refs_shift_deviceParamIndexShifts", () => {
    const refs = [
      "track:0:T/device:0:D/param:0:A",
      "track:0:T/device:0:D/param:2:C",
    ];
    const out = shiftSiblingIndices(refs, "track:0:T/device:0:D", "param", 1);
    // param:0 < 1 untouched; param:2 → param:1.
    expect(out).toEqual([
      "track:0:T/device:0:D/param:0:A",
      "track:0:T/device:0:D/param:1:C",
    ]);
  });
});
