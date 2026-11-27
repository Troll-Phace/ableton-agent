import { describe, expect, it } from "vitest";

import type { ApiVersion, ExtensionContext } from "@ableton-extensions/sdk";

import { ClaudeClient } from "../src/extension/claude-client.js";
import {
  runAgentLoop,
  type AgentEvents,
  type RunLoopInput,
  type ToolCall,
} from "../src/extension/agent-loop.js";
import { ReferenceTable } from "../src/extension/references.js";
import { LiveToolRuntime } from "../src/extension/tool-registry.js";
import {
  FakeMessagesClient,
  textTurn,
  toolUseTurn,
  type ScriptedToolUse,
  type ScriptedTurn,
} from "./fixtures/fake-anthropic-client.js";
import {
  makeFakeContext,
  type FakeExtensionContext,
  type FakeNoteDescription,
  type SetSpec,
  type NodeSpec,
} from "./fixtures/fake-extension-context.js";

/**
 * Phase 12 Task B — safe-mutation END-TO-END proof + single-undo verification
 * (INSTRUCTIONS Phase 12.2; ARCHITECTURE §7 "one agent action → one undo step").
 *
 * Drives the **REAL** {@link runAgentLoop} + the **REAL** {@link LiveToolRuntime}
 * over a {@link FakeExtensionContext}, with a scripted Claude client emitting one
 * `tool_use` turn (the non-destructive mutation) followed by a terminal text
 * turn. Nothing here is built — Phases 4/5/7/9/11 already wired this path; these
 * tests PROVE the behavior holds: each non-destructive agent action (a) actually
 * mutates the fake Set AND (b) costs the documented number of undo steps.
 *
 * Undo-cost note: the fake context has no real undo *stack*. The project's
 * established proxy for "one undo step" is `committedCount` / `transactions[]`
 * observability on the fake — the same proxy Phase 9's destructive-path proof
 * uses (`tests/phase9-confirm-proof.test.ts`). A single committed transaction for
 * a whole non-destructive batch == one undo step (§7). A named `live_create`
 * legitimately commits TWO (create-then-configure, §7), which we pin explicitly.
 *
 * These proofs assert ONLY on Set state + commit counts + confirmation-bypass —
 * never on chip/narration summary text — so they are independent of the parallel
 * narration change to `summaryOf` / `summarizeToolCall` (that is Task C's job).
 */

/* -------------------------------------------------------------------------- */
/* Harness (mirrors phase9-confirm-proof.test.ts + executors.test.ts)         */
/* -------------------------------------------------------------------------- */

/** Concrete classes probed for the className tag, most-derived first. */
const CONCRETE_CLASSES = [
  "AudioClip",
  "MidiClip",
  "AudioTrack",
  "MidiTrack",
  "ClipSlot",
  "Scene",
  "CuePoint",
  "DeviceParameter",
  "Track",
  "Clip",
  "Device",
] as const;

/** A minimal abstract-ctor token carrying a `static className` the fake reads. */
function classToken(className: string): unknown {
  abstract class Token {
    static readonly className = className;
  }
  return Token;
}

/**
 * Wrap the fake's `getObjectFromHandle` so resolved objects report their concrete
 * className (matching the real SDK), so the executors' className dispatch
 * ("AudioClip" vs "MidiClip" vs "ClipSlot") branches as it would in production.
 * (Identical shim to executors.test / phase9-confirm-proof.)
 */
function tagged(fake: FakeExtensionContext): FakeExtensionContext {
  const raw = fake.getObjectFromHandle.bind(fake);
  const probeClassName = (handle: { id: bigint }): string | undefined => {
    for (const c of CONCRETE_CLASSES) {
      try {
        raw(handle, classToken(c) as never);
        return c;
      } catch {
        // not this class; keep probing
      }
    }
    return undefined;
  };
  fake.getObjectFromHandle = <T>(handle: { id: bigint }, type: unknown): T => {
    const obj: unknown = raw(handle, type as never);
    if (obj !== null && typeof obj === "object") {
      const cn = probeClassName(handle);
      if (cn !== undefined) {
        Object.defineProperty(obj, "constructor", {
          value: { className: cn },
          enumerable: false,
          configurable: true,
        });
      }
    }
    return obj as T;
  };
  return fake;
}

/** Cast the fake to the SDK context type at the documented seam. */
function ctxOf(fake: FakeExtensionContext): ExtensionContext<ApiVersion> {
  return fake as unknown as ExtensionContext<ApiVersion>;
}

/** A no-op {@link AgentEvents} sink (the proof asserts on the Set, not frames). */
function noopEvents(): AgentEvents {
  return {
    assistantDelta(): void {
      /* no-op */
    },
    toolActivity(): void {
      /* no-op */
    },
    assistantDone(): void {
      /* no-op */
    },
    error(): void {
      /* no-op */
    },
  };
}

/**
 * A {@link requestConfirmation} stub that records whether it was ever invoked. A
 * non-destructive batch must NEVER touch the Phase-9 confirm gate, so a passing
 * proof leaves `invoked === false`. If it WERE invoked it resolves `true` (so the
 * test would still run, then fail on the explicit `invoked` assertion rather than
 * deadlock).
 */
function confirmSpy(): {
  invoked: boolean;
  fn: (plan: {
    summary: string;
    actions: string[];
    calls: ToolCall[];
  }) => Promise<boolean>;
} {
  const spy = {
    invoked: false,
    fn: (): Promise<boolean> => {
      spy.invoked = true;
      return Promise.resolve(true);
    },
  };
  return spy;
}

/**
 * Assemble a real-loop run over the fake context with one scripted `tool_use`
 * turn carrying the given tool calls, followed by a terminal text turn.
 */
function buildRun(
  fake: FakeExtensionContext,
  toolUses: ScriptedToolUse[],
  opts: {
    userText?: string;
    requestConfirmation?: RunLoopInput["requestConfirmation"];
  } = {}
): RunLoopInput {
  const turns: ScriptedTurn[] = [toolUseTurn(toolUses), textTurn("done")];
  const client = new ClaudeClient(new FakeMessagesClient(turns));
  const refs = new ReferenceTable();
  const runtime = new LiveToolRuntime(ctxOf(fake), refs);

  return {
    client,
    runtime,
    events: noopEvents(),
    system: [],
    messages: [{ role: "user", content: opts.userText ?? "mutate the set" }],
    requestConfirmation: opts.requestConfirmation,
  };
}

/** A MixerDevice spec with named volume/pan and the given send names. */
function mixerSpec(sends: string[] = []): NodeSpec {
  return {
    className: "MixerDevice",
    children: {
      volume: [{ className: "DeviceParameter", name: "Volume" }],
      panning: [{ className: "DeviceParameter", name: "Pan" }],
      sends: sends.map((n) => ({ className: "DeviceParameter", name: n })),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The proofs                                                                  */
/* -------------------------------------------------------------------------- */

describe("phase12 safe-mutation proof — applied + one undo step (§7)", () => {
  // 1. live_update_track rename → one transaction; name changed.
  it("phase12Proof_updateTrackRename_appliesAndCommitsOneTransaction", async () => {
    const fake = tagged(makeFakeContext());
    // Sanity (before): the track is named "Drums", not "Beats".
    expect(fake.application.song.tracks[0].name).toBe("Drums");

    const input = buildRun(fake, [
      {
        id: "t1",
        name: "live_update_track",
        input: { track: "track:0:Drums", name: "Beats" },
      },
    ]);
    const result = await runAgentLoop(input);

    expect(result.ok).toBe(true);
    // (a) The rename actually applied to the fake Set.
    expect(fake.application.song.tracks[0].name).toBe("Beats");
    // (b) Exactly ONE committed transaction == one undo step (§7).
    expect(fake.committedCount).toBe(1);
    expect(fake.transactions).toEqual([{ committed: true, rolledBack: false }]);
  });

  // 2. live_update_clip recolor → one transaction; color applied (state read).
  it("phase12Proof_updateClipRecolor_appliesAndCommitsOneTransaction", async () => {
    const fake = tagged(makeFakeContext());
    const clipBefore = fake.application.song.tracks[0].clipSlots[0].clip;
    // Sanity (before): the seeded clip color is the default 0, target is 255.
    expect(clipBefore?.color).toBe(0);

    const input = buildRun(fake, [
      {
        id: "c1",
        name: "live_update_clip",
        input: {
          clip: "track:0:Drums/clipSlot:0/clip:0:Loop A",
          color: 255,
        },
      },
    ]);
    const result = await runAgentLoop(input);

    expect(result.ok).toBe(true);
    // (a) The recolor applied — read back the live clip state.
    expect(fake.application.song.tracks[0].clipSlots[0].clip?.color).toBe(255);
    // (b) One undo step.
    expect(fake.committedCount).toBe(1);
    expect(fake.transactions).toEqual([{ committed: true, rolledBack: false }]);
  });

  // 3. live_set_param → one transaction; value applied; clamp proven via paramValueOf.
  it("phase12Proof_setParamClampsAndCommitsOneTransaction", async () => {
    // A device param Decay in [0, 10] seeded at 1; request 999 → must clamp to 10.
    const spec: SetSpec = {
      tracks: [
        {
          className: "AudioTrack",
          name: "Bass",
          children: {
            devices: [
              {
                className: "Reverb",
                name: "Reverb",
                children: {
                  parameters: [
                    {
                      className: "DeviceParameter",
                      name: "Decay",
                      param: { min: 0, max: 10, value: 1 },
                    },
                  ],
                },
              },
            ],
          },
          mixer: mixerSpec(),
        },
      ],
    };
    const fake = tagged(makeFakeContext(spec));
    // Sanity (before): seeded value is 1, not yet clamped.
    expect(fake.paramValueOf("tracks[0]/devices[0]/parameters[0]")).toBe(1);

    const input = buildRun(fake, [
      {
        id: "p1",
        name: "live_set_param",
        input: {
          target: {
            type: "device",
            device: "track:0:Bass/device:0:Reverb",
            param: "track:0:Bass/device:0:Reverb/param:0:Decay",
          },
          value: 999,
        },
      },
    ]);
    const result = await runAgentLoop(input);

    expect(result.ok).toBe(true);
    // (a) The value applied AND was clamped to the param's max (10), not 999.
    expect(fake.paramValueOf("tracks[0]/devices[0]/parameters[0]")).toBe(10);
    // (b) One undo step.
    expect(fake.committedCount).toBe(1);
    expect(fake.transactions).toEqual([{ committed: true, rolledBack: false }]);
  });

  // 4. live_edit_midi_notes transpose (non-filter) → one transaction; pitches
  //    shifted; AND the Phase-9 confirm gate is NOT invoked (non-destructive).
  it("phase12Proof_transposeNotes_appliesOneTransactionAndBypassesConfirm", async () => {
    const notes: FakeNoteDescription[] = [
      { pitch: 60, startTime: 0, duration: 1, velocity: 100 },
      { pitch: 64, startTime: 1, duration: 1, velocity: 90 },
    ];
    const spec: SetSpec = {
      tracks: [
        {
          className: "MidiTrack",
          name: "Keys",
          children: {
            arrangementClips: [
              { className: "MidiClip", name: "Chords", notes },
            ],
          },
          mixer: mixerSpec(),
        },
      ],
    };
    const fake = tagged(makeFakeContext(spec));
    // Sanity (before): un-transposed pitches.
    expect(
      fake.notesOf("tracks[0]/arrangementClips[0]").map((n) => n.pitch)
    ).toEqual([60, 64]);

    const spy = confirmSpy();
    const input = buildRun(
      fake,
      [
        {
          id: "n1",
          name: "live_edit_midi_notes",
          input: {
            clip: "track:0:Keys/clip:0:Chords",
            op: "transpose",
            semitones: 12,
          },
        },
      ],
      { requestConfirmation: spy.fn }
    );
    const result = await runAgentLoop(input);

    expect(result.ok).toBe(true);
    // (a) Both pitches shifted up an octave (+12).
    expect(
      fake.notesOf("tracks[0]/arrangementClips[0]").map((n) => n.pitch)
    ).toEqual([72, 76]);
    // (b) One undo step.
    expect(fake.committedCount).toBe(1);
    expect(fake.transactions).toEqual([{ committed: true, rolledBack: false }]);
    // Non-destructive op NEVER hits the Phase-9 confirmation gate (§9).
    expect(spy.invoked).toBe(false);
  });

  // 5. live_create UNNAMED → one transaction (no create-then-configure split).
  it("phase12Proof_createUnnamed_commitsExactlyOneTransaction", async () => {
    const fake = tagged(makeFakeContext());
    const before = fake.application.song.tracks.length;

    const input = buildRun(fake, [
      { id: "k1", name: "live_create", input: { kind: "audio_track" } },
    ]);
    const result = await runAgentLoop(input);

    expect(result.ok).toBe(true);
    // (a) A new track is live in the song collection.
    expect(fake.application.song.tracks.length).toBe(before + 1);
    // (b) Unnamed create == ONE undo step (the rename txn is skipped entirely).
    expect(fake.committedCount).toBe(1);
    expect(fake.transactions).toEqual([{ committed: true, rolledBack: false }]);
  });

  // 6. live_create NAMED → two transactions (documented create-then-configure §7).
  it("phase12Proof_createNamed_commitsExactlyTwoTransactions", async () => {
    const fake = tagged(makeFakeContext());
    const before = fake.application.song.tracks.length;

    const input = buildRun(fake, [
      {
        id: "k2",
        name: "live_create",
        input: { kind: "audio_track", name: "Vox" },
      },
    ]);
    const result = await runAgentLoop(input);

    expect(result.ok).toBe(true);
    // (a) The new track is live AND carries the applied name (configure step ran).
    expect(fake.application.song.tracks.length).toBe(before + 1);
    expect(fake.application.song.tracks[before].name).toBe("Vox");
    // (b) Create-then-configure == exactly TWO undo steps (§7): one create txn +
    //     one rename txn.
    expect(fake.committedCount).toBe(2);
    expect(fake.transactions).toEqual([
      { committed: true, rolledBack: false },
      { committed: true, rolledBack: false },
    ]);
  });

  // 7. Multi-tool non-destructive batch in ONE turn (rename + set_param +
  //    transpose) → one transaction == one undo step for the whole batch (§7).
  it("phase12Proof_multiToolBatch_commitsExactlyOneTransaction", async () => {
    // A Set with: a track to rename, a device param to set (clamped), and a MIDI
    // clip to transpose — all reachable for one batched flush.
    const spec: SetSpec = {
      tracks: [
        {
          className: "AudioTrack",
          name: "Bass",
          children: {
            devices: [
              {
                className: "Reverb",
                name: "Reverb",
                children: {
                  parameters: [
                    {
                      className: "DeviceParameter",
                      name: "Decay",
                      param: { min: 0, max: 10, value: 1 },
                    },
                  ],
                },
              },
            ],
          },
          mixer: mixerSpec(),
        },
        {
          className: "MidiTrack",
          name: "Keys",
          children: {
            arrangementClips: [
              {
                className: "MidiClip",
                name: "Chords",
                notes: [
                  { pitch: 60, startTime: 0, duration: 1, velocity: 100 },
                ],
              },
            ],
          },
          mixer: mixerSpec(),
        },
      ],
    };
    const fake = tagged(makeFakeContext(spec));
    // Sanity (before): all three targets in their pre-mutation state.
    expect(fake.application.song.tracks[0].name).toBe("Bass");
    expect(fake.paramValueOf("tracks[0]/devices[0]/parameters[0]")).toBe(1);
    expect(fake.notesOf("tracks[1]/arrangementClips[0]")[0].pitch).toBe(60);

    const spy = confirmSpy();
    const input = buildRun(
      fake,
      [
        {
          id: "m1",
          name: "live_update_track",
          input: { track: "track:0:Bass", name: "Sub" },
        },
        {
          id: "m2",
          name: "live_set_param",
          input: {
            target: {
              type: "device",
              device: "track:0:Bass/device:0:Reverb",
              param: "track:0:Bass/device:0:Reverb/param:0:Decay",
            },
            value: 5,
          },
        },
        {
          id: "m3",
          name: "live_edit_midi_notes",
          input: {
            clip: "track:1:Keys/clip:0:Chords",
            op: "transpose",
            semitones: 7,
          },
        },
      ],
      { requestConfirmation: spy.fn }
    );
    const result = await runAgentLoop(input);

    expect(result.ok).toBe(true);
    // (a) All three mutations applied.
    expect(fake.application.song.tracks[0].name).toBe("Sub");
    expect(fake.paramValueOf("tracks[0]/devices[0]/parameters[0]")).toBe(5);
    expect(fake.notesOf("tracks[1]/arrangementClips[0]")[0].pitch).toBe(67);
    // (b) The WHOLE non-destructive batch is ONE undo step (§7 single transaction).
    expect(fake.committedCount).toBe(1);
    expect(fake.transactions).toEqual([{ committed: true, rolledBack: false }]);
    // No destructive call ⇒ the confirm gate is never invoked.
    expect(spy.invoked).toBe(false);
  });
});
