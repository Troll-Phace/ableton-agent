import { describe, expect, it } from "vitest";

import type { ApiVersion, ExtensionContext } from "@ableton-extensions/sdk";

import type Anthropic from "@anthropic-ai/sdk";

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
  type NodeSpec,
  type SetSpec,
} from "./fixtures/fake-extension-context.js";

/**
 * Phase 13 Task 3 — destructive-path END-TO-END proofs that close the §13.3 gaps
 * (INSTRUCTIONS Phase 13.3; ARCHITECTURE §7, §9, §12 outcome D). Before this file
 * only `live_delete:track` had an E2E proof (`tests/phase9-confirm-proof.test.ts`);
 * here every other destructive target type is driven through the WHOLE system.
 *
 * Drives the **REAL** {@link runAgentLoop} + the **REAL** {@link LiveToolRuntime}
 * over a {@link FakeExtensionContext}, with a scripted Claude client emitting the
 * `tool_use` blocks and a test-controlled `requestConfirmation` seam standing in
 * for the outcome-D confirm card. Only Claude and the SDK context are doubled (per
 * `.claude/rules/testing.md`); the confirmation gate, the §7 single-transaction
 * batching, the type-routed delete / note-filter, and the ref shift all run for
 * real.
 *
 * Each proof is NON-VACUOUS: it reads the fake Set state BEFORE and AFTER the run,
 * plus the transaction observability (`committedCount` / `transactions[]`).
 *
 * Invariants pinned here (per target type {scene, cuePoint, clip-session,
 * clip-arrangement, device} and the filter op):
 *  - APPROVE → target gone from the live collection, EXACTLY one committed
 *    transaction (§7), and the surviving siblings re-index (proven by re-reading
 *    the live collection AND, where siblings were pre-minted, by `affectedRefs`).
 *  - DECLINE → NO transaction (`committedCount === 0`, `transactions.length === 0`),
 *    the target survives unchanged, and an honest `user_declined` `tool_result`
 *    (`is_error: true`) is synthesized (§1.3 honesty).
 *
 * Plus a MIXED destructive batch (delete + filter in one turn) proving the whole
 * batch shares ONE confirmation + ONE transaction, and the ADDITIVE, UNGATED
 * device-chain ops (`duplicate` / `insert_chain`) proving they NEVER hit the
 * confirm gate (Task 4 — lock the "ungated" decision against regression).
 */

/* -------------------------------------------------------------------------- */
/* Harness (mirrors phase9-confirm-proof.test.ts + phase12-mutation-proof)     */
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
 * className (matching the real SDK), so the executors' type-routing dispatch
 * branches as it would in production. (Identical shim to executors.test /
 * phase9-confirm-proof / phase12-mutation-proof.)
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
 * A {@link RunLoopInput.requestConfirmation} stub recording its invocation count
 * and resolving the given decision. A destructive batch MUST invoke it exactly
 * once (the whole batch shares one card, §7/§9); an additive batch must never
 * touch it (`count === 0`).
 */
function confirmSpy(approve: boolean): {
  count: number;
  fn: (plan: {
    summary: string;
    actions: string[];
    calls: ToolCall[];
  }) => Promise<boolean>;
} {
  const spy = {
    count: 0,
    fn: (plan: {
      summary: string;
      actions: string[];
      calls: ToolCall[];
    }): Promise<boolean> => {
      spy.count++;
      // The plan is built by the REAL summarizer — sanity-check it is non-empty so
      // these proofs also exercise the loop→summarizer wiring (as phase9 does).
      expect(plan.actions.length).toBeGreaterThan(0);
      return Promise.resolve(approve);
    },
  };
  return spy;
}

/**
 * Assemble a real-loop run over the fake context with one scripted `tool_use`
 * turn carrying the given calls, followed by a terminal text turn. The supplied
 * {@link ReferenceTable} is shared with the runtime so a test can pre-mint sibling
 * refs and observe the post-delete shift via `affectedRefs`.
 */
function buildRun(
  fake: FakeExtensionContext,
  toolUses: ScriptedToolUse[],
  opts: {
    userText?: string;
    refs?: ReferenceTable;
    requestConfirmation?: RunLoopInput["requestConfirmation"];
  } = {}
): RunLoopInput {
  const turns: ScriptedTurn[] = [toolUseTurn(toolUses), textTurn("done")];
  const client = new ClaudeClient(new FakeMessagesClient(turns));
  const refs = opts.refs ?? new ReferenceTable();
  const runtime = new LiveToolRuntime(ctxOf(fake), refs);

  return {
    client,
    runtime,
    events: noopEvents(),
    system: [],
    messages: [{ role: "user", content: opts.userText ?? "edit the set" }],
    requestConfirmation: opts.requestConfirmation,
  };
}

/**
 * Read the structured-error body of the `tool_result` for `toolUseId` out of the
 * returned transcript. The loop appends the `tool_result` user message right after
 * the assistant tool_use message, so it lives at `messages[2]` for a single-turn
 * batch. Returns the parsed JSON record (the §6/§9 error contract).
 */
function toolResultBody(
  messages: Anthropic.MessageParam[],
  toolUseId: string
): { isError: boolean; body: Record<string, unknown> } {
  const toolResultMsg = messages[2];
  const content = toolResultMsg.content;
  if (!Array.isArray(content)) {
    throw new Error("expected an array tool_result content");
  }
  const block = content.find(
    (b): b is Anthropic.ToolResultBlockParam =>
      typeof b === "object" &&
      b.type === "tool_result" &&
      b.tool_use_id === toolUseId
  );
  if (!block) {
    throw new Error(`no tool_result for id ${toolUseId}`);
  }
  const text =
    typeof block.content === "string"
      ? block.content
      : JSON.stringify(block.content);
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("tool_result body was not a JSON object");
  }
  return {
    isError: block.is_error === true,
    body: parsed as Record<string, unknown>,
  };
}

/** A MidiTrack spec carrying one named arrangement MIDI clip with the given notes. */
function midiTrackSpec(
  trackName: string,
  clipName: string,
  notes: FakeNoteDescription[]
): NodeSpec {
  return {
    className: "MidiTrack",
    name: trackName,
    children: {
      arrangementClips: [{ className: "MidiClip", name: clipName, notes }],
    },
    mixer: {
      className: "MixerDevice",
      children: {
        volume: [{ className: "DeviceParameter", name: "Volume" }],
        panning: [{ className: "DeviceParameter", name: "Pan" }],
        sends: [],
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Deletion — per target type {scene, cuePoint, clip-session, clip-arrangement, */
/* device}: approve removes + one txn (+ sibling re-index); decline = untouched */
/* -------------------------------------------------------------------------- */

describe("phase13 deletion proof — scene", () => {
  it("phase13Proof_deleteScene_approve_removesShiftsSiblingsOneTransaction", async () => {
    const fake = tagged(makeFakeContext());
    // Before: two scenes "Intro" (0), "Drop" (1).
    expect(fake.application.song.scenes.map((s) => s.name)).toEqual([
      "Intro",
      "Drop",
    ]);
    // Pre-mint the surviving sibling so its post-delete shift is observable.
    const refs = new ReferenceTable();
    refs.mint("scene:0:Intro");
    refs.mint("scene:1:Drop");

    const input = buildRun(
      fake,
      [
        {
          id: "d1",
          name: "live_delete",
          input: { target: "scene:0:Intro" },
        },
      ],
      { refs, requestConfirmation: confirmSpy(true).fn }
    );
    const result = await runAgentLoop(input);

    expect(result.ok).toBe(true);
    // (a) "Intro" is gone; "Drop" shifted down to index 0 (live re-read).
    expect(fake.application.song.scenes.map((s) => s.name)).toEqual(["Drop"]);
    expect(fake.application.song.scenes[0].name).toBe("Drop");
    // (b) Exactly ONE committed transaction == one undo step (§7).
    expect(fake.committedCount).toBe(1);
    expect(fake.transactions).toEqual([{ committed: true, rolledBack: false }]);
    // (c) The ReferenceTable shifted the sibling: scene:1:Drop → scene:0:Drop.
    if (result.ok) {
      const { isError, body } = toolResultBody(result.messages, "d1");
      expect(isError).toBe(false);
      expect(body.deleted).toBe("scene");
      expect(body.destructive).toBe(true);
      expect(body.affectedRefs).toContain("scene:0:Drop");
      expect(body.affectedRefs).not.toContain("scene:0:Intro");
    }
  });

  it("phase13Proof_deleteScene_decline_leavesSetUnchangedAndReportsUserDeclined", async () => {
    const fake = tagged(makeFakeContext());
    const before = fake.application.song.scenes.map((s) => s.name);
    expect(before).toEqual(["Intro", "Drop"]);

    const input = buildRun(
      fake,
      [{ id: "d1", name: "live_delete", input: { target: "scene:0:Intro" } }],
      { requestConfirmation: confirmSpy(false).fn }
    );
    const result = await runAgentLoop(input);

    expect(result.ok).toBe(true);
    // NO transaction opened; the Set is unchanged.
    expect(fake.committedCount).toBe(0);
    expect(fake.transactions.length).toBe(0);
    expect(fake.application.song.scenes.map((s) => s.name)).toEqual(before);
    // Honest user_declined result so the model never claims the delete happened.
    if (result.ok) {
      const { isError, body } = toolResultBody(result.messages, "d1");
      expect(isError).toBe(true);
      expect(body.error).toBe("user_declined");
    }
  });
});

describe("phase13 deletion proof — cuePoint", () => {
  it("phase13Proof_deleteCuePoint_approve_removesOneTransaction", async () => {
    const fake = tagged(makeFakeContext());
    // Before: one cue point "Start".
    expect(fake.application.song.cuePoints.map((c) => c.name)).toEqual([
      "Start",
    ]);

    const input = buildRun(
      fake,
      [
        {
          id: "d1",
          name: "live_delete",
          input: { target: "cuePoint:0:Start" },
        },
      ],
      { requestConfirmation: confirmSpy(true).fn }
    );
    const result = await runAgentLoop(input);

    expect(result.ok).toBe(true);
    // (a) The cue point is gone from the live collection.
    expect(fake.application.song.cuePoints.length).toBe(0);
    // (b) One undo step.
    expect(fake.committedCount).toBe(1);
    expect(fake.transactions).toEqual([{ committed: true, rolledBack: false }]);
    if (result.ok) {
      const { isError, body } = toolResultBody(result.messages, "d1");
      expect(isError).toBe(false);
      expect(body.deleted).toBe("cuePoint");
      expect(body.destructive).toBe(true);
    }
  });

  it("phase13Proof_deleteCuePoint_decline_leavesSetUnchangedAndReportsUserDeclined", async () => {
    const fake = tagged(makeFakeContext());
    expect(fake.application.song.cuePoints.length).toBe(1);

    const input = buildRun(
      fake,
      [
        {
          id: "d1",
          name: "live_delete",
          input: { target: "cuePoint:0:Start" },
        },
      ],
      { requestConfirmation: confirmSpy(false).fn }
    );
    const result = await runAgentLoop(input);

    expect(result.ok).toBe(true);
    expect(fake.committedCount).toBe(0);
    expect(fake.transactions.length).toBe(0);
    // The cue point survives.
    expect(fake.application.song.cuePoints.map((c) => c.name)).toEqual([
      "Start",
    ]);
    if (result.ok) {
      const { isError, body } = toolResultBody(result.messages, "d1");
      expect(isError).toBe(true);
      expect(body.error).toBe("user_declined");
    }
  });
});

describe("phase13 deletion proof — session clip (clipSlot.deleteClip)", () => {
  it("phase13Proof_deleteSessionClip_approve_clearsSlotOneTransaction", async () => {
    const fake = tagged(makeFakeContext());
    // Before: slot 0 of "Drums" holds clip "Loop A".
    expect(fake.application.song.tracks[0].clipSlots[0].clip?.name).toBe(
      "Loop A"
    );

    const input = buildRun(
      fake,
      [
        {
          id: "d1",
          name: "live_delete",
          input: { target: "track:0:Drums/clipSlot:0/clip:0:Loop A" },
        },
      ],
      { requestConfirmation: confirmSpy(true).fn }
    );
    const result = await runAgentLoop(input);

    expect(result.ok).toBe(true);
    // (a) The slot is now empty (the clip pointer is null).
    expect(fake.application.song.tracks[0].clipSlots[0].clip).toBeNull();
    // (b) One undo step.
    expect(fake.committedCount).toBe(1);
    expect(fake.transactions).toEqual([{ committed: true, rolledBack: false }]);
    if (result.ok) {
      const { isError, body } = toolResultBody(result.messages, "d1");
      expect(isError).toBe(false);
      expect(body.deleted).toBe("clip");
      expect(body.destructive).toBe(true);
    }
  });

  it("phase13Proof_deleteSessionClip_decline_leavesClipInSlotAndReportsUserDeclined", async () => {
    const fake = tagged(makeFakeContext());
    expect(fake.application.song.tracks[0].clipSlots[0].clip?.name).toBe(
      "Loop A"
    );

    const input = buildRun(
      fake,
      [
        {
          id: "d1",
          name: "live_delete",
          input: { target: "track:0:Drums/clipSlot:0/clip:0:Loop A" },
        },
      ],
      { requestConfirmation: confirmSpy(false).fn }
    );
    const result = await runAgentLoop(input);

    expect(result.ok).toBe(true);
    expect(fake.committedCount).toBe(0);
    expect(fake.transactions.length).toBe(0);
    // The clip is still in the slot, unchanged.
    expect(fake.application.song.tracks[0].clipSlots[0].clip?.name).toBe(
      "Loop A"
    );
    if (result.ok) {
      const { isError, body } = toolResultBody(result.messages, "d1");
      expect(isError).toBe(true);
      expect(body.error).toBe("user_declined");
    }
  });
});

describe("phase13 deletion proof — arrangement clip (track.deleteClip)", () => {
  it("phase13Proof_deleteArrangementClip_approve_removesShiftsSiblingsOneTransaction", async () => {
    const fake = tagged(makeFakeContext());
    // Before: "Drums" arrangement holds "Verse" (0), "Chorus" (1).
    expect(
      fake.application.song.tracks[0].arrangementClips.map((c) => c.name)
    ).toEqual(["Verse", "Chorus"]);
    // Pre-mint the surviving sibling so its post-delete shift is observable.
    const refs = new ReferenceTable();
    refs.mint("track:0:Drums/clip:0:Verse");
    refs.mint("track:0:Drums/clip:1:Chorus");

    const input = buildRun(
      fake,
      [
        {
          id: "d1",
          name: "live_delete",
          input: { target: "track:0:Drums/clip:0:Verse" },
        },
      ],
      { refs, requestConfirmation: confirmSpy(true).fn }
    );
    const result = await runAgentLoop(input);

    expect(result.ok).toBe(true);
    // (a) "Verse" is gone; "Chorus" shifted down to index 0 (live re-read).
    expect(
      fake.application.song.tracks[0].arrangementClips.map((c) => c.name)
    ).toEqual(["Chorus"]);
    expect(fake.application.song.tracks[0].arrangementClips[0].name).toBe(
      "Chorus"
    );
    // (b) One undo step.
    expect(fake.committedCount).toBe(1);
    expect(fake.transactions).toEqual([{ committed: true, rolledBack: false }]);
    // (c) The ReferenceTable shifted the sibling: clip:1:Chorus → clip:0:Chorus.
    if (result.ok) {
      const { isError, body } = toolResultBody(result.messages, "d1");
      expect(isError).toBe(false);
      expect(body.deleted).toBe("clip");
      expect(body.affectedRefs).toContain("track:0:Drums/clip:0:Chorus");
      expect(body.affectedRefs).not.toContain("track:0:Drums/clip:0:Verse");
    }
  });

  it("phase13Proof_deleteArrangementClip_decline_leavesSetUnchangedAndReportsUserDeclined", async () => {
    const fake = tagged(makeFakeContext());
    const before = fake.application.song.tracks[0].arrangementClips.map(
      (c) => c.name
    );
    expect(before).toEqual(["Verse", "Chorus"]);

    const input = buildRun(
      fake,
      [
        {
          id: "d1",
          name: "live_delete",
          input: { target: "track:0:Drums/clip:0:Verse" },
        },
      ],
      { requestConfirmation: confirmSpy(false).fn }
    );
    const result = await runAgentLoop(input);

    expect(result.ok).toBe(true);
    expect(fake.committedCount).toBe(0);
    expect(fake.transactions.length).toBe(0);
    expect(
      fake.application.song.tracks[0].arrangementClips.map((c) => c.name)
    ).toEqual(before);
    if (result.ok) {
      const { isError, body } = toolResultBody(result.messages, "d1");
      expect(isError).toBe(true);
      expect(body.error).toBe("user_declined");
    }
  });
});

describe("phase13 deletion proof — device (host.deleteDevice)", () => {
  it("phase13Proof_deleteDevice_approve_removesShiftsSiblingsOneTransaction", async () => {
    const fake = tagged(makeFakeContext());
    // Before: "Bass" holds devices "Reverb" (0), "Rack" (1).
    expect(fake.application.song.tracks[1].devices.map((d) => d.name)).toEqual([
      "Reverb",
      "Rack",
    ]);
    // Pre-mint the surviving sibling so its post-delete shift is observable.
    const refs = new ReferenceTable();
    refs.mint("track:1:Bass/device:0:Reverb");
    refs.mint("track:1:Bass/device:1:Rack");

    const input = buildRun(
      fake,
      [
        {
          id: "d1",
          name: "live_delete",
          input: { target: "track:1:Bass/device:0:Reverb" },
        },
      ],
      { refs, requestConfirmation: confirmSpy(true).fn }
    );
    const result = await runAgentLoop(input);

    expect(result.ok).toBe(true);
    // (a) "Reverb" is gone; "Rack" shifted down to index 0 (live re-read).
    expect(fake.application.song.tracks[1].devices.map((d) => d.name)).toEqual([
      "Rack",
    ]);
    expect(fake.application.song.tracks[1].devices[0].name).toBe("Rack");
    // (b) One undo step.
    expect(fake.committedCount).toBe(1);
    expect(fake.transactions).toEqual([{ committed: true, rolledBack: false }]);
    // (c) The ReferenceTable shifted the sibling: device:1:Rack → device:0:Rack.
    if (result.ok) {
      const { isError, body } = toolResultBody(result.messages, "d1");
      expect(isError).toBe(false);
      expect(body.deleted).toBe("device");
      expect(body.affectedRefs).toContain("track:1:Bass/device:0:Rack");
      expect(body.affectedRefs).not.toContain("track:1:Bass/device:0:Reverb");
    }
  });

  it("phase13Proof_deleteDevice_decline_leavesSetUnchangedAndReportsUserDeclined", async () => {
    const fake = tagged(makeFakeContext());
    const before = fake.application.song.tracks[1].devices.map((d) => d.name);
    expect(before).toEqual(["Reverb", "Rack"]);

    const input = buildRun(
      fake,
      [
        {
          id: "d1",
          name: "live_delete",
          input: { target: "track:1:Bass/device:0:Reverb" },
        },
      ],
      { requestConfirmation: confirmSpy(false).fn }
    );
    const result = await runAgentLoop(input);

    expect(result.ok).toBe(true);
    expect(fake.committedCount).toBe(0);
    expect(fake.transactions.length).toBe(0);
    expect(fake.application.song.tracks[1].devices.map((d) => d.name)).toEqual(
      before
    );
    if (result.ok) {
      const { isError, body } = toolResultBody(result.messages, "d1");
      expect(isError).toBe(true);
      expect(body.error).toBe("user_declined");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Filter op E2E (live_edit_midi_notes op=filter) — destructive (§8.2)         */
/* -------------------------------------------------------------------------- */

describe("phase13 filter-op proof — live_edit_midi_notes op=filter is gated", () => {
  /** Build a Set whose only MIDI clip has notes spanning a wide pitch range. */
  const filterSpec = (): SetSpec => ({
    tracks: [
      midiTrackSpec("Keys", "Chords", [
        { pitch: 36, startTime: 0, duration: 1, velocity: 100 },
        { pitch: 60, startTime: 1, duration: 1, velocity: 100 },
        { pitch: 64, startTime: 2, duration: 1, velocity: 100 },
        { pitch: 96, startTime: 3, duration: 1, velocity: 100 },
      ]),
    ],
  });

  it("phase13Proof_filterNotes_approve_dropsOutOfRangeNotesOneTransaction", async () => {
    const fake = tagged(makeFakeContext(filterSpec()));
    // Before: all four pitches present.
    expect(
      fake.notesOf("tracks[0]/arrangementClips[0]").map((n) => n.pitch)
    ).toEqual([36, 60, 64, 96]);

    const input = buildRun(
      fake,
      [
        {
          id: "f1",
          name: "live_edit_midi_notes",
          input: {
            clip: "track:0:Keys/clip:0:Chords",
            op: "filter",
            filter: { pitchMin: 48, pitchMax: 72 },
          },
        },
      ],
      { requestConfirmation: confirmSpy(true).fn }
    );
    const result = await runAgentLoop(input);

    expect(result.ok).toBe(true);
    // (a) Only the in-range pitches (60, 64) survive; 36 and 96 were dropped.
    expect(
      fake.notesOf("tracks[0]/arrangementClips[0]").map((n) => n.pitch)
    ).toEqual([60, 64]);
    // (b) One undo step.
    expect(fake.committedCount).toBe(1);
    expect(fake.transactions).toEqual([{ committed: true, rolledBack: false }]);
    if (result.ok) {
      const { isError } = toolResultBody(result.messages, "f1");
      expect(isError).toBe(false);
    }
  });

  it("phase13Proof_filterNotes_decline_leavesNotesUntouchedAndReportsUserDeclined", async () => {
    const fake = tagged(makeFakeContext(filterSpec()));
    const before = fake
      .notesOf("tracks[0]/arrangementClips[0]")
      .map((n) => n.pitch);
    expect(before).toEqual([36, 60, 64, 96]);

    const input = buildRun(
      fake,
      [
        {
          id: "f1",
          name: "live_edit_midi_notes",
          input: {
            clip: "track:0:Keys/clip:0:Chords",
            op: "filter",
            filter: { pitchMin: 48, pitchMax: 72 },
          },
        },
      ],
      { requestConfirmation: confirmSpy(false).fn }
    );
    const result = await runAgentLoop(input);

    expect(result.ok).toBe(true);
    // NO transaction; the note buffer is byte-for-byte unchanged.
    expect(fake.committedCount).toBe(0);
    expect(fake.transactions.length).toBe(0);
    expect(
      fake.notesOf("tracks[0]/arrangementClips[0]").map((n) => n.pitch)
    ).toEqual(before);
    if (result.ok) {
      const { isError, body } = toolResultBody(result.messages, "f1");
      expect(isError).toBe(true);
      expect(body.error).toBe("user_declined");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Mixed destructive batch (live_delete + live_edit_midi_notes filter) —        */
/* one confirmation gates the WHOLE batch in ONE transaction (§7/§9)            */
/* -------------------------------------------------------------------------- */

describe("phase13 mixed-batch proof — delete + filter share one gate/transaction", () => {
  /** A Set with a deletable scene AND a filterable MIDI clip, in one turn. */
  const mixedSpec = (): SetSpec => ({
    tracks: [
      midiTrackSpec("Keys", "Chords", [
        { pitch: 36, startTime: 0, duration: 1, velocity: 100 },
        { pitch: 60, startTime: 1, duration: 1, velocity: 100 },
        { pitch: 96, startTime: 2, duration: 1, velocity: 100 },
      ]),
    ],
    scenes: [
      { className: "Scene", name: "Intro" },
      { className: "Scene", name: "Drop" },
    ],
  });

  it("phase13Proof_mixedBatch_decline_skipsBothTogetherNoTransaction", async () => {
    const fake = tagged(makeFakeContext(mixedSpec()));
    const scenesBefore = fake.application.song.scenes.map((s) => s.name);
    const notesBefore = fake
      .notesOf("tracks[0]/arrangementClips[0]")
      .map((n) => n.pitch);
    expect(scenesBefore).toEqual(["Intro", "Drop"]);
    expect(notesBefore).toEqual([36, 60, 96]);

    const spy = confirmSpy(false);
    const input = buildRun(
      fake,
      [
        { id: "d1", name: "live_delete", input: { target: "scene:0:Intro" } },
        {
          id: "f1",
          name: "live_edit_midi_notes",
          input: {
            clip: "track:0:Keys/clip:0:Chords",
            op: "filter",
            filter: { pitchMin: 48, pitchMax: 72 },
          },
        },
      ],
      { requestConfirmation: spy.fn }
    );
    const result = await runAgentLoop(input);

    expect(result.ok).toBe(true);
    // ONE confirmation gated the whole batch.
    expect(spy.count).toBe(1);
    // NO transaction; BOTH targets are untouched.
    expect(fake.committedCount).toBe(0);
    expect(fake.transactions.length).toBe(0);
    expect(fake.application.song.scenes.map((s) => s.name)).toEqual(
      scenesBefore
    );
    expect(
      fake.notesOf("tracks[0]/arrangementClips[0]").map((n) => n.pitch)
    ).toEqual(notesBefore);
    // BOTH calls report user_declined (the batch is skipped together).
    if (result.ok) {
      const del = toolResultBody(result.messages, "d1");
      const filt = toolResultBody(result.messages, "f1");
      expect(del.isError).toBe(true);
      expect(del.body.error).toBe("user_declined");
      expect(filt.isError).toBe(true);
      expect(filt.body.error).toBe("user_declined");
    }
  });

  it("phase13Proof_mixedBatch_approve_appliesBothInOneTransaction", async () => {
    const fake = tagged(makeFakeContext(mixedSpec()));
    expect(fake.application.song.scenes.map((s) => s.name)).toEqual([
      "Intro",
      "Drop",
    ]);
    expect(
      fake.notesOf("tracks[0]/arrangementClips[0]").map((n) => n.pitch)
    ).toEqual([36, 60, 96]);

    const spy = confirmSpy(true);
    const input = buildRun(
      fake,
      [
        { id: "d1", name: "live_delete", input: { target: "scene:0:Intro" } },
        {
          id: "f1",
          name: "live_edit_midi_notes",
          input: {
            clip: "track:0:Keys/clip:0:Chords",
            op: "filter",
            filter: { pitchMin: 48, pitchMax: 72 },
          },
        },
      ],
      { requestConfirmation: spy.fn }
    );
    const result = await runAgentLoop(input);

    expect(result.ok).toBe(true);
    // ONE confirmation gated the whole batch.
    expect(spy.count).toBe(1);
    // (a) The scene was deleted ("Drop" shifted to index 0).
    expect(fake.application.song.scenes.map((s) => s.name)).toEqual(["Drop"]);
    // (a) The filter dropped 36 and 96, keeping only 60.
    expect(
      fake.notesOf("tracks[0]/arrangementClips[0]").map((n) => n.pitch)
    ).toEqual([60]);
    // (b) The WHOLE destructive batch is ONE undo step (§7 single transaction).
    expect(fake.committedCount).toBe(1);
    expect(fake.transactions).toEqual([{ committed: true, rolledBack: false }]);
    if (result.ok) {
      expect(toolResultBody(result.messages, "d1").isError).toBe(false);
      expect(toolResultBody(result.messages, "f1").isError).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Device-chain (additive, UNGATED — Task 4): duplicate / insert_chain NEVER    */
/* hit the confirm gate; exactly one committed transaction; effect applied      */
/* -------------------------------------------------------------------------- */

describe("phase13 device-chain proof — additive ops are ungated (§8.2 / Task 4)", () => {
  it("phase13Proof_duplicateDevice_appliesOneTransactionAndBypassesConfirm", async () => {
    const fake = tagged(makeFakeContext());
    // Before: chain "Chain A" of the rack holds one device "AutoFilter".
    const chainRef = "track:1:Bass/device:1:Rack/chain:0:Chain A";
    const beforeChainDevices =
      fake.application.song.tracks[1].devices[1].chains![0].devices.length;
    const beforeTrackDevices = fake.application.song.tracks[1].devices.length;
    expect(beforeChainDevices).toBe(1);

    // The gate MUST never be invoked for an additive op — so it resolves false to
    // prove that even a "decline" decision cannot reach (and thus cannot block) it.
    const spy = confirmSpy(false);
    const input = buildRun(
      fake,
      [
        {
          id: "c1",
          name: "live_modify_device_chain",
          input: {
            location: chainRef,
            op: "duplicate",
            device: `${chainRef}/device:0:AutoFilter`,
          },
        },
      ],
      { requestConfirmation: spy.fn }
    );
    const result = await runAgentLoop(input);

    expect(result.ok).toBe(true);
    // (a) The chain gained a device (the duplicate landed in the chain, not the track).
    expect(
      fake.application.song.tracks[1].devices[1].chains![0].devices.length
    ).toBe(beforeChainDevices + 1);
    expect(fake.application.song.tracks[1].devices.length).toBe(
      beforeTrackDevices
    );
    // (b) One undo step.
    expect(fake.committedCount).toBe(1);
    expect(fake.transactions).toEqual([{ committed: true, rolledBack: false }]);
    // (c) The additive op NEVER touched the Phase-9 confirmation gate (§8.2 ungated).
    expect(spy.count).toBe(0);
    if (result.ok) {
      expect(toolResultBody(result.messages, "c1").isError).toBe(false);
    }
  });

  it("phase13Proof_insertChain_appliesOneTransactionAndBypassesConfirm", async () => {
    const fake = tagged(makeFakeContext());
    // Before: the rack holds two chains.
    const before =
      fake.application.song.tracks[1].devices[1].chains?.length ?? 0;
    expect(before).toBe(2);

    const spy = confirmSpy(false);
    const input = buildRun(
      fake,
      [
        {
          id: "c1",
          name: "live_modify_device_chain",
          input: {
            location: "track:1:Bass/device:1:Rack",
            op: "insert_chain",
            index: 0,
          },
        },
      ],
      { requestConfirmation: spy.fn }
    );
    const result = await runAgentLoop(input);

    expect(result.ok).toBe(true);
    // (a) The rack gained a chain.
    expect(fake.application.song.tracks[1].devices[1].chains?.length ?? 0).toBe(
      before + 1
    );
    // (b) One undo step.
    expect(fake.committedCount).toBe(1);
    expect(fake.transactions).toEqual([{ committed: true, rolledBack: false }]);
    // (c) The additive op NEVER touched the Phase-9 confirmation gate (§8.2 ungated).
    expect(spy.count).toBe(0);
    if (result.ok) {
      expect(toolResultBody(result.messages, "c1").isError).toBe(false);
    }
  });
});
