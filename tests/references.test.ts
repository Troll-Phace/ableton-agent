import { describe, expect, it } from "vitest";

import {
  ReferenceTable,
  refFromHandle,
  resolveRef,
  type ClassTokens,
} from "../src/extension/references.js";
import {
  FakeClass,
  makeFakeContext,
  type FakeExtensionContext,
  type SetSpec,
} from "./fixtures/fake-extension-context.js";

/**
 * Phase 3 resolver suite — the re-resolve-every-call identity layer in
 * `src/extension/references.ts`, driven against the {@link FakeExtensionContext}.
 *
 * The resolver's class tokens default to the real SDK constructors; the fake's
 * class identities are NOT the SDK's, so every `resolveRef`/`refFromHandle` call
 * passes {@link TOKENS} (built from `FakeClass`) as the third argument so the
 * resolver runs UNMODIFIED against the fake (per the resolver author's contract).
 */
const TOKENS = {
  probe: FakeClass.DataModelObject,
  track: FakeClass.Track,
  clip: FakeClass.Clip,
  clipSlot: FakeClass.ClipSlot,
  takeLane: FakeClass.TakeLane,
  scene: FakeClass.Scene,
  cuePoint: FakeClass.CuePoint,
  device: FakeClass.Device,
  chain: FakeClass.Chain,
  trackMixer: FakeClass.TrackMixer,
  chainMixer: FakeClass.ChainMixer,
  param: FakeClass.DeviceParameter,
} as unknown as ClassTokens;

/**
 * The resolver is typed against the SDK `ExtensionContext`; the fake is
 * structurally compatible for the surface the resolver touches
 * (`application.song`, `getObjectFromHandle`). One documented cast at the seam.
 */
function ctxOf(fake: FakeExtensionContext): Parameters<typeof resolveRef>[0] {
  return fake as unknown as Parameters<typeof resolveRef>[0];
}

/** Resolve against a fake, always threading the fake TOKENS. */
function resolve(fake: FakeExtensionContext, ref: string) {
  return resolveRef(ctxOf(fake), ref, TOKENS);
}

describe("resolver — happy path for every kind", () => {
  it("references_resolve_topLevelTrack", () => {
    const fake = makeFakeContext();
    const r = resolve(fake, "track:0:Drums");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.className).toBe("Track");
      expect(r.canonicalRef).toBe("track:0:Drums");
    }
  });

  it("references_resolve_scene", () => {
    const fake = makeFakeContext();
    const r = resolve(fake, "scene:0:Intro");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.canonicalRef).toBe("scene:0:Intro");
    }
  });

  it("references_resolve_cuePoint", () => {
    const fake = makeFakeContext();
    const r = resolve(fake, "cuePoint:0:Start");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.canonicalRef).toBe("cuePoint:0:Start");
    }
  });

  it("references_resolve_device", () => {
    const fake = makeFakeContext();
    const r = resolve(fake, "track:0:Drums/device:0:Kit");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.className).toBe("Device");
      expect(r.canonicalRef).toBe("track:0:Drums/device:0:Kit");
    }
  });

  it("references_resolve_deviceParam", () => {
    const fake = makeFakeContext();
    const r = resolve(fake, "track:0:Drums/device:0:Kit/param:0:Volume");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.className).toBe("DeviceParameter");
      expect(r.canonicalRef).toBe("track:0:Drums/device:0:Kit/param:0:Volume");
    }
  });

  it("references_resolve_deepNestedRackChainDeviceParam", () => {
    const fake = makeFakeContext();
    const ref =
      "track:1:Bass/device:1:Rack/chain:0:Chain A/device:0:AutoFilter/param:0:Freq";
    const r = resolve(fake, ref);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.className).toBe("DeviceParameter");
      expect(r.canonicalRef).toBe(ref);
    }
  });

  it("references_resolve_arrangementClip", () => {
    const fake = makeFakeContext();
    const r = resolve(fake, "track:0:Drums/clip:0:Verse");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.className).toBe("Clip");
      expect(r.canonicalRef).toBe("track:0:Drums/clip:0:Verse");
    }
  });

  it("references_resolve_clipSlotClip", () => {
    const fake = makeFakeContext();
    const r = resolve(fake, "track:0:Drums/clipSlot:0/clip:0:Loop A");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.className).toBe("Clip");
      expect(r.canonicalRef).toBe("track:0:Drums/clipSlot:0/clip:0:Loop A");
    }
  });

  it("references_resolve_takeLaneClip", () => {
    const fake = makeFakeContext();
    const r = resolve(fake, "track:0:Drums/takeLane:0:Take 1/clip:0:Comp");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.className).toBe("Clip");
      expect(r.canonicalRef).toBe(
        "track:0:Drums/takeLane:0:Take 1/clip:0:Comp"
      );
    }
  });

  it("references_resolve_mixerVolume", () => {
    const fake = makeFakeContext();
    const r = resolve(fake, "track:0:Drums/mixer/param:volume");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.className).toBe("DeviceParameter");
      expect(r.canonicalRef).toBe("track:0:Drums/mixer/param:volume");
    }
  });

  it("references_resolve_mixerPan", () => {
    const fake = makeFakeContext();
    const r = resolve(fake, "track:0:Drums/mixer/param:pan");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.canonicalRef).toBe("track:0:Drums/mixer/param:pan");
    }
  });

  it("references_resolve_mixerSend", () => {
    const fake = makeFakeContext();
    const r = resolve(fake, "track:0:Drums/mixer/param:send:1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.className).toBe("DeviceParameter");
      expect(r.canonicalRef).toBe("track:0:Drums/mixer/param:send:1");
    }
  });

  it("references_resolve_takeLaneLeaf", () => {
    const fake = makeFakeContext();
    const r = resolve(fake, "track:0:Drums/takeLane:0:Take 1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.className).toBe("TakeLane");
      expect(r.canonicalRef).toBe("track:0:Drums/takeLane:0:Take 1");
    }
  });

  it("references_resolve_chainLeaf", () => {
    const fake = makeFakeContext();
    const r = resolve(fake, "track:1:Bass/device:1:Rack/chain:0:Chain A");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.className).toBe("Chain");
      expect(r.canonicalRef).toBe("track:1:Bass/device:1:Rack/chain:0:Chain A");
    }
  });

  it("references_resolve_clipSlotLeaf", () => {
    const fake = makeFakeContext();
    const r = resolve(fake, "track:0:Drums/clipSlot:0");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.className).toBe("ClipSlot");
    }
  });

  it("references_resolve_bareMixerLeaf", () => {
    const fake = makeFakeContext();
    const r = resolve(fake, "track:0:Drums/mixer");
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Bare mixer leaf reports the base mixer className fallback.
      expect(r.className).toBe("MixerDevice");
      expect(r.canonicalRef).toBe("track:0:Drums/mixer");
    }
  });
});

describe("resolver — index drift / reorder re-anchors by name", () => {
  it("references_reorder_reanchorsToNewIndex", () => {
    const fake = makeFakeContext();
    // Move "Bass" (index 1) to index 0; "Drums" shifts to 1.
    fake.reorder("", "tracks", 1, 0);
    // The ref still says track:1:Bass, but Bass now lives at index 0.
    const r = resolve(fake, "track:1:Bass");
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Re-anchored: canonicalRef reflects the NEW index 0.
      expect(r.canonicalRef).toBe("track:0:Bass");
    }
  });

  it("references_reorder_deviceReanchorsToNewIndex", () => {
    const fake = makeFakeContext();
    // tracks[1] Bass has devices [0] Reverb, [1] Rack. Swap them.
    fake.reorder("tracks[1]", "devices", 0, 1);
    const r = resolve(fake, "track:1:Bass/device:0:Reverb");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.canonicalRef).toBe("track:1:Bass/device:1:Reverb");
    }
  });
});

describe("resolver — rename drift", () => {
  it("references_rename_targetUnresolvedWhenNoUniqueMatch", () => {
    const fake = makeFakeContext();
    fake.rename("tracks[0]", "Renamed");
    // The ref still says track:0:Drums; no track named "Drums" exists anymore.
    const r = resolve(fake, "track:0:Drums");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.err.error).toBe("ref_unresolved");
    }
  });

  it("references_rename_siblingAwayStillResolvesByIndexName", () => {
    const fake = makeFakeContext();
    // tracks[3] and [4] are both "Dup". Rename [4] away so "Dup" is unique.
    fake.rename("tracks[4]", "Solo");
    const r = resolve(fake, "track:3:Dup");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.canonicalRef).toBe("track:3:Dup");
    }
  });

  it("references_rename_reanchorsWhenIndexMovedButNameUnique", () => {
    const fake = makeFakeContext();
    // Rename the track currently at index 0 so the ref's recorded index no
    // longer name-matches, then resolve by a still-unique name elsewhere.
    fake.rename("tracks[0]", "Percussion");
    // "Keys" is at index 2; ask for it at a wrong index — unique-name re-anchor.
    const r = resolve(fake, "track:0:Keys");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.canonicalRef).toBe("track:2:Keys");
    }
  });
});

describe("resolver — deletion", () => {
  it("references_delete_targetUnresolved", () => {
    const fake = makeFakeContext();
    fake.remove("tracks[1]"); // delete "Bass"
    const r = resolve(fake, "track:1:Bass");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.err.error).toBe("ref_unresolved");
    }
  });

  it("references_delete_deviceUnresolved", () => {
    const fake = makeFakeContext();
    fake.remove("tracks[0]/devices[0]"); // delete Simpler "Kit"
    const r = resolve(fake, "track:0:Drums/device:0:Kit");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.err.error).toBe("ref_unresolved");
    }
  });

  it("references_referenceTable_invalidateAndShiftDropsAndReindexes", () => {
    const fake = makeFakeContext();
    const table = new ReferenceTable();
    // Seed several sibling refs at the track level.
    table.mint("track:0:Drums");
    table.mint("track:1:Bass");
    table.mint("track:2:Keys");
    table.mint("track:1:Bass/device:0:Reverb");

    // Delete "Bass" (index 1) from the live tree, then shift the table.
    fake.remove("tracks[1]");
    const updated = table.invalidateAndShift("track:1:Bass");

    // Bass and its descendant are dropped; Keys decremented 2 → 1.
    expect(updated).toContain("track:0:Drums");
    expect(updated).toContain("track:1:Keys");
    expect(updated).not.toContain("track:1:Bass");
    expect(updated).not.toContain("track:2:Keys");
    expect(updated).not.toContain("track:1:Bass/device:0:Reverb");

    // The shifted ref now resolves against the correspondingly-mutated fake:
    // "Keys" is at live index 1 after the removal.
    const r = resolve(fake, "track:1:Keys");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.canonicalRef).toBe("track:1:Keys");
    }
  });

  it("references_referenceTable_resetClears", () => {
    const table = new ReferenceTable();
    table.mint("track:0:A");
    expect(table.all()).toHaveLength(1);
    table.reset();
    expect(table.all()).toHaveLength(0);
  });

  it("references_referenceTable_invalidateUnparseableLeavesTableUntouched", () => {
    const table = new ReferenceTable();
    table.mint("track:0:A");
    const out = table.invalidateAndShift("not a ref");
    expect(out).toEqual(["track:0:A"]);
  });

  it("references_referenceTable_invalidateMixerLeafJustDrops", () => {
    const table = new ReferenceTable();
    table.mint("track:0:A/mixer/param:volume");
    table.mint("track:0:A");
    const out = table.invalidateAndShift("track:0:A/mixer/param:volume");
    expect(out).not.toContain("track:0:A/mixer/param:volume");
    expect(out).toContain("track:0:A");
  });
});

describe("resolver — ambiguity", () => {
  it("references_ambiguity_duplicateSiblingNames", () => {
    const fake = makeFakeContext();
    // tracks[3] and [4] are both "Dup". A stale/out-of-range index forces the
    // unique-name search, which finds two matches → ref_ambiguous.
    const r = resolve(fake, "track:9:Dup");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.err.error).toBe("ref_ambiguous");
      expect(r.err.detail).toMatch(/2 objects named "Dup"/);
    }
  });
});

describe("resolver — type mismatch", () => {
  it("references_typeMismatch_deviceRefLandsOnNonDevice", () => {
    // Custom Set: a track whose `devices` collection holds a node that is NOT a
    // device class (a Scene), so the leaf assertion (Device) throws while the
    // base probe (DataModelObject) succeeds → type_mismatch.
    const spec: SetSpec = {
      tracks: [
        {
          className: "AudioTrack",
          name: "T",
          children: {
            devices: [{ className: "Scene", name: "NotADevice" }],
          },
          mixer: {
            className: "MixerDevice",
            children: {
              volume: [{ className: "DeviceParameter", name: "Volume" }],
              panning: [{ className: "DeviceParameter", name: "Pan" }],
              sends: [],
            },
          },
        },
      ],
    };
    const fake = makeFakeContext(spec);
    const r = resolve(fake, "track:0:T/device:0:NotADevice");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.err.error).toBe("type_mismatch");
      // The fake's materialized proxies carry no `static className`, so the
      // resolver's classNameOf falls back to "unknown" in the detail. The
      // discriminating fact under test is the type_mismatch class itself
      // (object present via base probe, leaf assertion rejected).
      expect(r.err.detail).toMatch(/not the expected type/);
    }
  });
});

describe("resolver — refFromHandle (raw launch-scope anchoring)", () => {
  it("references_refFromHandle_topLevelTrack", () => {
    const fake = makeFakeContext();
    const handle = fake.handleOf("tracks[1]"); // Bass
    const r = refFromHandle(ctxOf(fake), handle, TOKENS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ref).toBe("track:1:Bass");
    }
  });

  it("references_refFromHandle_scene", () => {
    const fake = makeFakeContext();
    const handle = fake.handleOf("scenes[1]"); // Drop
    const r = refFromHandle(ctxOf(fake), handle, TOKENS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ref).toBe("scene:1:Drop");
    }
  });

  it("references_refFromHandle_cuePoint", () => {
    const fake = makeFakeContext();
    const handle = fake.handleOf("cuePoints[0]"); // Start
    const r = refFromHandle(ctxOf(fake), handle, TOKENS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ref).toBe("cuePoint:0:Start");
    }
  });

  it("references_refFromHandle_deadHandleUnresolved", () => {
    const fake = makeFakeContext();
    const handle = fake.handleOf("tracks[0]");
    fake.remove("tracks[0]");
    const r = refFromHandle(ctxOf(fake), handle, TOKENS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.err.error).toBe("ref_unresolved");
    }
  });

  it("references_refFromHandle_nonTopLevelTypeMismatch", () => {
    const fake = makeFakeContext();
    // A device handle is not a top-level track/scene/cuePoint anchorable in Ph3.
    const handle = fake.handleOf("tracks[0]/devices[0]");
    const r = refFromHandle(ctxOf(fake), handle, TOKENS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.err.error).toBe("type_mismatch");
    }
  });
});

describe("resolver — no-caching invariant (re-resolve reflects live mutation)", () => {
  it("references_noCaching_renameBetweenResolvesIsObserved", () => {
    const fake = makeFakeContext();
    const first = resolve(fake, "track:1:Bass");
    expect(first.ok).toBe(true);

    // Mutate the tree, then resolve the SAME ref again.
    fake.rename("tracks[1]", "Bassline");
    const second = resolve(fake, "track:1:Bass");
    // The recorded name no longer matches and is not unique elsewhere → unresolved.
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.err.error).toBe("ref_unresolved");
    }
  });

  it("references_noCaching_reorderBetweenResolvesIsObserved", () => {
    const fake = makeFakeContext();
    const first = resolve(fake, "track:0:Drums");
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.canonicalRef).toBe("track:0:Drums");
    }

    fake.reorder("", "tracks", 0, 1); // Drums → index 1
    const second = resolve(fake, "track:0:Drums");
    expect(second.ok).toBe(true);
    if (second.ok) {
      // Re-walked live: Drums re-anchored to its new index.
      expect(second.canonicalRef).toBe("track:1:Drums");
    }
  });

  it("references_noCaching_deleteBetweenResolvesIsObserved", () => {
    const fake = makeFakeContext();
    const first = resolve(fake, "track:0:Drums/device:0:Kit");
    expect(first.ok).toBe(true);

    fake.remove("tracks[0]/devices[0]");
    const second = resolve(fake, "track:0:Drums/device:0:Kit");
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.err.error).toBe("ref_unresolved");
    }
  });
});

describe("resolver — clipSlot index-only", () => {
  it("references_clipSlot_resolvesByIndexNoName", () => {
    const fake = makeFakeContext();
    const r = resolve(fake, "track:0:Drums/clipSlot:0");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.className).toBe("ClipSlot");
      expect(r.canonicalRef).toBe("track:0:Drums/clipSlot:0");
    }
  });

  it("references_clipSlot_outOfRangeUnresolved", () => {
    const fake = makeFakeContext();
    // Drums has 2 clipSlots; index 9 is out of range.
    const r = resolve(fake, "track:0:Drums/clipSlot:9");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.err.error).toBe("ref_unresolved");
      expect(r.err.detail).toMatch(/out of range/);
    }
  });

  it("references_clipSlot_emptySlotClipUnresolved", () => {
    const fake = makeFakeContext();
    // clipSlots[1] is empty (clip: null).
    const r = resolve(fake, "track:0:Drums/clipSlot:1/clip:0:Anything");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.err.error).toBe("ref_unresolved");
      expect(r.err.detail).toMatch(/empty/);
    }
  });
});

describe("resolver — subtype acceptance under base tokens", () => {
  it("references_subtype_midiTrackResolvesUnderTrackToken", () => {
    const fake = makeFakeContext();
    const r = resolve(fake, "track:2:Keys"); // MidiTrack
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.canonicalRef).toBe("track:2:Keys");
    }
  });

  it("references_subtype_audioTrackResolvesUnderTrackToken", () => {
    const fake = makeFakeContext();
    const r = resolve(fake, "track:0:Drums"); // AudioTrack
    expect(r.ok).toBe(true);
  });

  it("references_subtype_simplerResolvesUnderDeviceToken", () => {
    const fake = makeFakeContext();
    const r = resolve(fake, "track:0:Drums/device:0:Kit"); // Simpler is-a Device
    expect(r.ok).toBe(true);
  });

  it("references_subtype_rackDeviceResolvesUnderDeviceToken", () => {
    const fake = makeFakeContext();
    const r = resolve(fake, "track:1:Bass/device:1:Rack"); // RackDevice is-a Device
    expect(r.ok).toBe(true);
  });
});

describe("resolver — additional error paths", () => {
  it("references_error_lexicallyMalformedRef", () => {
    const fake = makeFakeContext();
    const r = resolve(fake, "track:0"); // missing name → parse error
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.err.error).toBe("ref_unresolved");
    }
  });

  it("references_error_structurallyInvalidRef", () => {
    const fake = makeFakeContext();
    // chain under a track is structurally invalid.
    const r = resolve(fake, "track:0:Drums/chain:0:X");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.err.error).toBe("ref_unresolved");
      expect(r.err.detail).toMatch(/structurally invalid/);
    }
  });

  it("references_error_emptyRef", () => {
    const fake = makeFakeContext();
    const r = resolve(fake, "");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.err.error).toBe("ref_unresolved");
    }
  });

  it("references_error_chainOnNonRackDevice", () => {
    const fake = makeFakeContext();
    // Reverb (tracks[1]/devices[0]) is not a rack — exposes no chains.
    const r = resolve(fake, "track:1:Bass/device:0:Reverb/chain:0:X");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.err.error).toBe("ref_unresolved");
      expect(r.err.detail).toMatch(/no chains|chains/);
    }
  });

  it("references_error_sendIndexOutOfRange", () => {
    const fake = makeFakeContext();
    // Keys (tracks[2]) mixer has NO sends.
    const r = resolve(fake, "track:2:Keys/mixer/param:send:0");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.err.error).toBe("ref_unresolved");
      expect(r.err.detail).toMatch(/out of range/);
    }
  });

  it("references_error_deviceParamNotFound", () => {
    const fake = makeFakeContext();
    const r = resolve(fake, "track:0:Drums/device:0:Kit/param:9:Nope");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.err.error).toBe("ref_unresolved");
    }
  });

  it("references_error_clipSlotClipNameMismatch", () => {
    const fake = makeFakeContext();
    // clipSlots[0] holds "Loop A"; ask for a wrong name in that single slot.
    const r = resolve(fake, "track:0:Drums/clipSlot:0/clip:0:WrongName");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.err.error).toBe("ref_unresolved");
    }
  });

  it("references_error_clipSlotClipNonZeroIndex", () => {
    const fake = makeFakeContext();
    // A clipSlot holds a single clip; index must be 0.
    const r = resolve(fake, "track:0:Drums/clipSlot:0/clip:1:Loop A");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.err.error).toBe("ref_unresolved");
      expect(r.err.detail).toMatch(/single clip|index 0/);
    }
  });

  it("references_error_arrangementClipUnresolvedWhenRenamedAway", () => {
    const fake = makeFakeContext();
    fake.rename("tracks[0]/arrangementClips[0]", "Gone");
    const r = resolve(fake, "track:0:Drums/clip:0:Verse");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.err.error).toBe("ref_unresolved");
    }
  });

  it("references_error_walkThrowBecomesStructuredError", () => {
    // A track with NO mixer node: reading `track.mixer` throws inside the fake's
    // getter, which the resolver's outer try/catch converts to a structured
    // ref_unresolved rather than letting it escape.
    const spec: SetSpec = {
      tracks: [{ className: "AudioTrack", name: "NoMix" }],
    };
    const fake = makeFakeContext(spec);
    const r = resolve(fake, "track:0:NoMix/mixer");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.err.error).toBe("ref_unresolved");
    }
  });
});

describe("resolver — chain mixer + reindex coverage", () => {
  it("references_chainMixer_resolvesVolumeUnderChain", () => {
    const fake = makeFakeContext();
    const r = resolve(
      fake,
      "track:1:Bass/device:1:Rack/chain:0:Chain A/mixer/param:volume"
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.className).toBe("DeviceParameter");
    }
  });

  it("references_chainMixer_bareChainMixerLeaf", () => {
    const fake = makeFakeContext();
    const r = resolve(fake, "track:1:Bass/device:1:Rack/chain:1:Chain B/mixer");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.className).toBe("MixerDevice");
    }
  });

  it("references_chainMixer_sendUnderChain", () => {
    const fake = makeFakeContext();
    const r = resolve(
      fake,
      "track:1:Bass/device:1:Rack/chain:0:Chain A/mixer/param:send:0"
    );
    expect(r.ok).toBe(true);
  });

  it("references_reindex_clipSlotAdoptsReorderedIndex", () => {
    const fake = makeFakeContext();
    // Drums has clipSlots [0] (with clip) and [1] (empty). Reorder them so the
    // clipSlot that was at 1 is now at 0 — index-only re-anchor still works by
    // position (clipSlot has no name to verify).
    fake.reorder("tracks[0]", "clipSlots", 0, 1);
    const r = resolve(fake, "track:0:Drums/clipSlot:1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.canonicalRef).toBe("track:0:Drums/clipSlot:1");
    }
  });

  it("references_reindex_deviceParamAdoptsReorderedIndex", () => {
    const fake = makeFakeContext();
    // Kit params: [0] Volume, [1] Filter. Swap them.
    fake.reorder("tracks[0]/devices[0]", "parameters", 0, 1);
    const r = resolve(fake, "track:0:Drums/device:0:Kit/param:0:Volume");
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Re-anchored: Volume now at index 1.
      expect(r.canonicalRef).toBe("track:0:Drums/device:0:Kit/param:1:Volume");
    }
  });
});

describe("resolver — ReferenceTable bare-mixer & nested invalidation", () => {
  it("references_referenceTable_invalidateBareMixerLeafDrops", () => {
    const table = new ReferenceTable();
    table.mint("track:0:A/mixer");
    table.mint("track:0:A");
    const out = table.invalidateAndShift("track:0:A/mixer");
    expect(out).not.toContain("track:0:A/mixer");
    expect(out).toContain("track:0:A");
  });

  it("references_referenceTable_invalidateNestedDeviceShiftsSiblings", () => {
    const table = new ReferenceTable();
    table.mint("track:0:T/device:0:A");
    table.mint("track:0:T/device:1:B");
    table.mint("track:0:T/device:2:C");
    const out = table.invalidateAndShift("track:0:T/device:1:B");
    expect(out).toContain("track:0:T/device:0:A");
    expect(out).toContain("track:0:T/device:1:C"); // 2 → 1
    expect(out).not.toContain("track:0:T/device:1:B");
    expect(out).not.toContain("track:0:T/device:2:C");
  });
});

describe("resolver — missing-collection error paths (custom Set)", () => {
  it("references_missing_mixerVolumeParamThrowsToUnresolved", () => {
    // A mixer node with NO volume param: the fake's `volume` getter throws,
    // which the resolver converts to a structured ref_unresolved.
    const spec: SetSpec = {
      tracks: [
        {
          className: "AudioTrack",
          name: "T",
          mixer: {
            className: "MixerDevice",
            children: {
              // no `volume` child
              panning: [{ className: "DeviceParameter", name: "Pan" }],
              sends: [],
            },
          },
        },
      ],
    };
    const fake = makeFakeContext(spec);
    const r = resolve(fake, "track:0:T/mixer/param:volume");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.err.error).toBe("ref_unresolved");
    }
  });
});

describe("resolver — refFromHandle returnTrack falls through", () => {
  it("references_refFromHandle_returnTrackNotInMainTracksTypeMismatch", () => {
    // A returnTrack IS a Track by token, but findInCollection only searches the
    // `tracks` collection, so it is not found there and the function falls
    // through to the type_mismatch tail.
    const fake = makeFakeContext();
    const handle = fake.handleOf("returnTracks[0]"); // "Return A"
    const r = refFromHandle(ctxOf(fake), handle, TOKENS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.err.error).toBe("type_mismatch");
    }
  });
});
