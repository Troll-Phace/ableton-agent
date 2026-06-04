import { describe, expect, it } from "vitest";

import type { ApiVersion, ExtensionContext } from "@ableton-extensions/sdk";

import type { ToolResultPayload } from "../src/extension/agent-loop.js";
import { ReferenceTable } from "../src/extension/references.js";
import { buildSnapshot } from "../src/extension/snapshot.js";
import { LiveToolRuntime } from "../src/extension/tool-registry.js";
import {
  makeFakeContext,
  type FakeExtensionContext,
  type SetSpec,
} from "./fixtures/fake-extension-context.js";

/**
 * Phase 11 Task 3b — unit suite for the per-turn scoped snapshot serializer
 * `src/extension/snapshot.ts` (`buildSnapshot`), driven against the
 * {@link FakeExtensionContext} (ARCHITECTURE §4 data flow, §6 refs, §15 budgets,
 * §9 honesty).
 *
 * What is asserted:
 *  - **Header-only** (no scope): the `header` is the `live_get_project` shape,
 *    including the now-seedable scale/grid fields; no `scopedTrack`/`scopeNote`.
 *  - **Track-scoped**: a resolvable track ref expands to the SHALLOW
 *    `live_get_track` shape — and the snapshot carries NO device-parameter
 *    `value`/`min`/`max` and NO MIDI `notes` anywhere (§15 shallow discipline).
 *  - **Honest fallback** (§9): an unresolved (deleted / renamed-away / ambiguous)
 *    or non-track scope ref omits `scopedTrack`, sets an honest `scopeNote`, keeps
 *    the header, and NEVER throws.
 *  - **§15 read-only guards (CRITICAL)**: a full snapshot build calls
 *    `DeviceParameter.getValue()` ZERO times and opens ZERO transactions — proven
 *    by instrumenting the fake (see {@link withGetValueCounter}) and reading the
 *    fixture's `committedCount` / `transactions` observability.
 *  - **Single source of truth**: the snapshot `header` deep-equals the body of
 *    `executeGetProject` and `scopedTrack` deep-equals the body of
 *    `executeGetTrack` over the same context — so the snapshot and the read tools
 *    cannot drift.
 *  - **Valid JSON**: `JSON.parse(buildSnapshot(...))` never throws.
 *
 * ## No `tagged` shim needed here
 * Unlike the clip-focused executor suite, the snapshot's resolution path only
 * needs to distinguish "track vs not-track". `buildSnapshot` calls `resolveRef`
 * with the real SDK class tokens, whose `Track` token is tagged `className:
 * "Track"` — which the fake recognizes — and the resolver reports the base
 * `"Track"` className, satisfying the serializer's `isTrackClassName` check. So a
 * PLAIN `makeFakeContext()` resolves a track scope faithfully, and the read
 * executors (`live_get_project`/`live_get_track`) report the SAME base className,
 * keeping the shape-consistency comparison exact.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Cast the fake to the SDK context type at the documented seam (no `any`). */
function ctxOf(fake: FakeExtensionContext): ExtensionContext<ApiVersion> {
  return fake as unknown as ExtensionContext<ApiVersion>;
}

/** Parse a snapshot string into a typed-enough record (never throws on valid JSON). */
function parseSnapshot(json: string): Record<string, unknown> {
  return JSON.parse(json) as Record<string, unknown>;
}

/** Parse a tool-result payload's JSON content. */
function body(p: ToolResultPayload): Record<string, unknown> {
  return JSON.parse(p.content as string) as Record<string, unknown>;
}

/** Build a read runtime over a fake Set with a fresh turn-scoped table. */
function readRuntime(fake: FakeExtensionContext): LiveToolRuntime<ApiVersion> {
  return new LiveToolRuntime(ctxOf(fake), new ReferenceTable());
}

/**
 * Wrap the fake's `getObjectFromHandle` so every materialized object that exposes
 * an async `getValue()` (i.e. a `DeviceParameter`) has it counted. This is the
 * §15 read-only guard's instrument: a correct snapshot build NEVER fans out
 * `getValue()`, so `count()` must stay `0`. Mirrors the `tagged` wrapping pattern
 * in `executors.test.ts` (re-wrap the handle factory, delegate to the original).
 * The wrapped value still resolves to the real number, so behavior is unchanged —
 * we only observe.
 */
function withGetValueCounter(fake: FakeExtensionContext): {
  fake: FakeExtensionContext;
  count: () => number;
} {
  let calls = 0;
  const raw = fake.getObjectFromHandle.bind(fake);
  fake.getObjectFromHandle = <T>(handle: { id: bigint }, type: unknown): T => {
    const obj: unknown = raw(handle, type as never);
    if (
      obj !== null &&
      typeof obj === "object" &&
      typeof (obj as { getValue?: unknown }).getValue === "function"
    ) {
      const o = obj as { getValue: () => Promise<number> };
      const orig = o.getValue.bind(o);
      o.getValue = (): Promise<number> => {
        calls += 1;
        return orig();
      };
    }
    return obj as T;
  };
  return { fake, count: (): number => calls };
}

/**
 * Recursively collect every property key appearing anywhere in a parsed snapshot.
 * Used to prove the §15 shallow discipline negatively: no device-parameter
 * `value` and no MIDI `notes` key exists ANYWHERE in the serialized tree.
 */
function allKeys(value: unknown): Set<string> {
  const keys = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) {
        walk(item);
      }
      return;
    }
    if (v !== null && typeof v === "object") {
      for (const [k, child] of Object.entries(v)) {
        keys.add(k);
        walk(child);
      }
    }
  };
  walk(value);
  return keys;
}

// ---------------------------------------------------------------------------
// 1. Header-only (no scopeRef)
// ---------------------------------------------------------------------------

describe("buildSnapshot — header-only (no scopeRef)", () => {
  it("snapshot_headerOnly_returnsProjectHeaderShapeNoScope", () => {
    const fake = makeFakeContext();
    const snap = parseSnapshot(buildSnapshot(ctxOf(fake)));

    expect(snap.kind).toBe("project_snapshot");
    expect(snap.scopedTrack).toBeUndefined();
    expect(snap.scopeNote).toBeUndefined();

    const header = snap.header as Record<string, unknown>;
    expect(header.tempo).toBe(120);
    // Default Set seeds no scale/grid → null (the executor's unseeded contract).
    expect(header.scaleName).toBeNull();
    expect(header.scaleMode).toBeNull();
    expect(header.rootNote).toBeNull();
    expect(header.gridQuantization).toBeNull();
    expect(header.gridIsTriplet).toBeNull();
    expect(header.tracks).toEqual([
      { index: 0, name: "Drums" },
      { index: 1, name: "Bass" },
      { index: 2, name: "Keys" },
      { index: 3, name: "Dup" },
      { index: 4, name: "Dup" },
    ]);
    expect(header.returnTracks).toEqual([{ index: 0, name: "Return A" }]);
    expect((header.mainTrack as { name: string }).name).toBe("Main");
    expect(header.scenes).toEqual([
      { index: 0, name: "Intro" },
      { index: 1, name: "Drop" },
    ]);
    expect(header.cuePoints).toEqual([{ index: 0, name: "Start" }]);
  });

  it("snapshot_headerOnly_seededScaleGridFieldsAppear", () => {
    // Seed the new SetSpec scale/grid fields (Task 3a) and assert they surface.
    const spec: SetSpec = {
      scaleName: "Dorian",
      scaleMode: true,
      rootNote: 2,
      gridQuantization: 5,
      gridIsTriplet: false,
    };
    const fake = makeFakeContext(spec);
    const header = parseSnapshot(buildSnapshot(ctxOf(fake))).header as Record<
      string,
      unknown
    >;
    expect(header.scaleName).toBe("Dorian");
    expect(header.scaleMode).toBe(true);
    expect(header.rootNote).toBe(2);
    expect(header.gridQuantization).toBe(5);
    expect(header.gridIsTriplet).toBe(false);
  });

  it("snapshot_headerOnly_blankScopeRefTreatedAsNoScope", () => {
    // A whitespace-only scope ref is treated as "no scope" (header only).
    const fake = makeFakeContext();
    const snap = parseSnapshot(buildSnapshot(ctxOf(fake), "   "));
    expect(snap.scopedTrack).toBeUndefined();
    expect(snap.scopeNote).toBeUndefined();
    expect((snap.header as { tempo: number }).tempo).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// 2. Track-scoped expansion
// ---------------------------------------------------------------------------

describe("buildSnapshot — track-scoped expansion", () => {
  it("snapshot_trackScope_expandsShallowTrackDetail", () => {
    const fake = makeFakeContext();
    const snap = parseSnapshot(buildSnapshot(ctxOf(fake), "track:0:Drums"));

    expect(snap.scopeNote).toBeUndefined();
    const track = snap.scopedTrack as Record<string, unknown>;
    expect(track.ref).toBe("track:0:Drums");
    expect(track.className).toBe("Track");
    expect(track.name).toBe("Drums");
    expect(track.mute).toBe(false);
    expect(track.solo).toBe(false);
    expect(track.arm).toBe(false);
    expect(track.groupTrack).toBeNull();
    expect(track.devices).toEqual([{ index: 0, name: "Kit" }]);
    expect(track.arrangementClips).toEqual([
      { index: 0, name: "Verse" },
      { index: 1, name: "Chorus" },
    ]);
    expect(track.clipSlots).toEqual([
      { index: 0, hasClip: true, clipName: "Loop A" },
      { index: 1, hasClip: false, clipName: null },
    ]);
    expect(track.takeLanes).toEqual([{ index: 0, name: "Take 1" }]);
    expect(track.hasMixer).toBe(true);
  });

  it("snapshot_trackScope_isShallowNoParamValuesNoNotes", () => {
    // §15: the snapshot must be shallow — no device-parameter value/min/max and
    // no MIDI note arrays anywhere in the serialized tree (those are on-demand).
    const fake = makeFakeContext();
    const snap = parseSnapshot(buildSnapshot(ctxOf(fake), "track:0:Drums"));
    const keys = allKeys(snap);
    expect(keys.has("value")).toBe(false);
    expect(keys.has("min")).toBe(false);
    expect(keys.has("max")).toBe(false);
    expect(keys.has("notes")).toBe(false);
    expect(keys.has("parameters")).toBe(false);
    // Devices/clips are present, but only as `{index,name}` identity rows.
    const track = snap.scopedTrack as { devices: unknown[] };
    expect(track.devices).toEqual([{ index: 0, name: "Kit" }]);
  });
});

// ---------------------------------------------------------------------------
// 3. Honest fallback (§9) — never throws, header still present
// ---------------------------------------------------------------------------

describe("buildSnapshot — honest fallback for unresolvable / non-track scopes", () => {
  it("snapshot_scopeDeleted_omitsScopedTrackKeepsHeaderWithNote", () => {
    const fake = makeFakeContext();
    fake.remove("tracks[0]"); // Drums is gone; the launch ref is now stale.
    let snap: Record<string, unknown> = {};
    expect(() => {
      snap = parseSnapshot(buildSnapshot(ctxOf(fake), "track:0:Drums"));
    }).not.toThrow();
    expect(snap.scopedTrack).toBeUndefined();
    expect(typeof snap.scopeNote).toBe("string");
    expect(snap.scopeNote).toContain("ref_unresolved");
    // Header is still fully present and re-resolved against the live model.
    expect((snap.header as { tracks: unknown[] }).tracks).toHaveLength(4);
  });

  it("snapshot_scopeRenamedAway_omitsScopedTrackWithUnresolvedNote", () => {
    const fake = makeFakeContext();
    fake.rename("tracks[1]", "Renamed"); // "Bass" no longer exists by that name.
    const snap = parseSnapshot(buildSnapshot(ctxOf(fake), "track:1:Bass"));
    expect(snap.scopedTrack).toBeUndefined();
    expect(snap.scopeNote).toContain("ref_unresolved");
  });

  it("snapshot_scopeAmbiguous_omitsScopedTrackWithAmbiguousNote", () => {
    // The default Set has two tracks named "Dup"; a bad index forces a name
    // search that finds two → ref_ambiguous.
    const fake = makeFakeContext();
    const snap = parseSnapshot(buildSnapshot(ctxOf(fake), "track:9:Dup"));
    expect(snap.scopedTrack).toBeUndefined();
    expect(snap.scopeNote).toContain("ref_ambiguous");
  });

  it("snapshot_scopeNonTrack_scene_omitsScopedTrackWithNotATrackNote", () => {
    // A scene resolves fine but is NOT a track → honest "not a track" note.
    const fake = makeFakeContext();
    const snap = parseSnapshot(buildSnapshot(ctxOf(fake), "scene:0:Intro"));
    expect(snap.scopedTrack).toBeUndefined();
    expect(snap.scopeNote).toContain("not a track");
    expect((snap.header as { scenes: unknown[] }).scenes).toHaveLength(2);
  });

  it("snapshot_scopeNonTrack_cuePoint_omitsScopedTrackWithNote", () => {
    const fake = makeFakeContext();
    const snap = parseSnapshot(buildSnapshot(ctxOf(fake), "cuePoint:0:Start"));
    expect(snap.scopedTrack).toBeUndefined();
    expect(snap.scopeNote).toContain("not a track");
  });
});

// ---------------------------------------------------------------------------
// 4. §15 read-only / perf guards (CRITICAL): zero getValue, zero transactions
// ---------------------------------------------------------------------------

describe("buildSnapshot — §15 read-only guards (no getValue, no transaction)", () => {
  it("snapshot_headerOnly_callsGetValueZeroTimesAndOpensNoTransaction", () => {
    const { fake, count } = withGetValueCounter(makeFakeContext());
    parseSnapshot(buildSnapshot(ctxOf(fake)));
    expect(count()).toBe(0);
    expect(fake.committedCount).toBe(0);
    expect(fake.transactions).toHaveLength(0);
  });

  it("snapshot_trackScope_callsGetValueZeroTimesAndOpensNoTransaction", () => {
    const { fake, count } = withGetValueCounter(makeFakeContext());
    const snap = parseSnapshot(buildSnapshot(ctxOf(fake), "track:0:Drums"));
    // Sanity: the track really did expand (so the zero-count is meaningful).
    expect(snap.scopedTrack).toBeDefined();
    expect(count()).toBe(0);
    expect(fake.committedCount).toBe(0);
    expect(fake.transactions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Shape consistency — snapshot ≡ the read tools (single source of truth)
// ---------------------------------------------------------------------------

describe("buildSnapshot — shape consistency with the read executors", () => {
  it("snapshot_header_deepEqualsExecuteGetProjectBody", async () => {
    const fake = makeFakeContext({
      // Seed scale/grid so the comparison exercises those fields too.
      scaleName: "Phrygian",
      scaleMode: false,
      rootNote: 4,
      gridQuantization: 3,
      gridIsTriplet: true,
    });
    const header = parseSnapshot(buildSnapshot(ctxOf(fake))).header;
    const projectBody = body(
      await readRuntime(fake).executeRead({
        id: "p",
        name: "live_get_project",
        input: {},
      })
    );
    expect(header).toEqual(projectBody);
  });

  it("snapshot_scopedTrack_deepEqualsExecuteGetTrackBody", async () => {
    const fake = makeFakeContext();
    const scoped = parseSnapshot(
      buildSnapshot(ctxOf(fake), "track:0:Drums")
    ).scopedTrack;
    const trackBody = body(
      await readRuntime(fake).executeRead({
        id: "t",
        name: "live_get_track",
        input: { track: "track:0:Drums" },
      })
    );
    expect(scoped).toEqual(trackBody);
  });
});

// ---------------------------------------------------------------------------
// 6. Valid JSON across every path
// ---------------------------------------------------------------------------

describe("buildSnapshot — always returns valid JSON", () => {
  it("snapshot_validJson_forHeaderTrackAndFallbackScopes", () => {
    const fake = makeFakeContext();
    const cases: (string | undefined)[] = [
      undefined, // header only
      "track:0:Drums", // resolvable track
      "scene:0:Intro", // non-track fallback
      "track:9:Ghost", // unresolved fallback
      "track:9:Dup", // ambiguous fallback
    ];
    for (const scope of cases) {
      expect(() => {
        parseSnapshot(buildSnapshot(ctxOf(fake), scope));
      }).not.toThrow();
    }
  });
});
