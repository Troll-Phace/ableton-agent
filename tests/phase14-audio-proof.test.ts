import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiVersion, ExtensionContext } from "@ableton-extensions/sdk";

import type Anthropic from "@anthropic-ai/sdk";

import { ClaudeClient } from "../src/extension/claude-client.js";
import {
  runAgentLoop,
  type AgentEvents,
  type RunLoopInput,
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
  type SetSpec,
} from "./fixtures/fake-extension-context.js";

/**
 * Phase 14 Task 8 — audio-tools END-TO-END proofs (INSTRUCTIONS Phase 14; ARCH §7,
 * §8, §14). Drives the **REAL** {@link runAgentLoop} + the **REAL**
 * {@link LiveToolRuntime} over a {@link FakeExtensionContext}, with a scripted
 * Claude client emitting the `tool_use` blocks. Only Claude and the SDK context are
 * doubled (per `.claude/rules/testing.md`); the loop's read/mutation partitioning,
 * the §7 single-transaction batching, the ref resolution, and the audio executors
 * all run for real. The webview/transport/confirm layers are not involved (audio
 * tools are non-destructive → no confirm gate).
 *
 * Each proof is NON-VACUOUS: it reads the fake Set state (and transaction
 * observability) BEFORE and AFTER the run and asserts the change.
 *
 * Headline criterion (INSTRUCTIONS Phase 14): "a URL sample imports and lands in a
 * clip" — proven as a TWO-turn flow (import → create) sharing one fake Set, with
 * the managed path captured from turn 1's tool_result and fed into turn 2. Plus a
 * render proof (a read tool that surfaces a path and mutates nothing).
 */

/* -------------------------------------------------------------------------- */
/* Harness (mirrors tests/phase13-destructive-proof.test.ts)                   */
/* -------------------------------------------------------------------------- */

/** Concrete classes probed for the className tag, most-derived first. */
const CONCRETE_CLASSES = [
  "Simpler",
  "AudioClip",
  "MidiClip",
  "AudioTrack",
  "MidiTrack",
  "ClipSlot",
  "TakeLane",
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
 * branches as it would in production (identical shim to the other proof files).
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
 * Assemble a real-loop run over the fake context with one scripted `tool_use` turn
 * carrying the given calls, followed by a terminal text turn. The supplied
 * {@link LiveToolRuntime} (and thus its {@link ReferenceTable}) is shared across the
 * two turns of the headline flow so the second turn re-resolves against the Set
 * mutated by the first.
 */
function buildRun(
  runtime: LiveToolRuntime<ApiVersion>,
  toolUses: ScriptedToolUse[],
  userText: string
): RunLoopInput {
  const turns: ScriptedTurn[] = [toolUseTurn(toolUses), textTurn("done")];
  const client = new ClaudeClient(new FakeMessagesClient(turns));
  return {
    client,
    runtime,
    events: noopEvents(),
    system: [],
    messages: [{ role: "user", content: userText }],
  };
}

/**
 * Read the `tool_result` body for `toolUseId` from a single-turn transcript. The
 * loop appends the tool_result user message right after the assistant tool_use
 * message, so it lives at `messages[2]`.
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

/** An AudioTrack with one empty clip slot, the landing spot for the imported audio. */
function audioTrackWithEmptySlotSpec(): SetSpec {
  return {
    tracks: [
      {
        className: "AudioTrack",
        name: "Audio",
        children: { clipSlots: [{ className: "ClipSlot", clip: null }] },
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
}

/**
 * The leading bytes of a real WAV file ("RIFF"…"WAVE"). Used so the import's
 * non-audio guard (`looksLikeNonAudio`) passes — the first byte is `R`, not `<`/`{`.
 */
const RIFF_WAVE_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
]);

/**
 * Stub the GLOBAL `fetch` with a 200 audio response carrying the given bytes. The
 * Response exposes `headers.get("content-type")` (the import's non-audio guard reads
 * it) returning `audio/wav`, plus `arrayBuffer()`.
 */
function stubOkFetch(bytes: Uint8Array): ReturnType<typeof vi.fn> {
  const spy = vi.fn(
    (): Promise<{
      ok: boolean;
      status: number;
      statusText: string;
      headers: { get(name: string): string | null };
      arrayBuffer: () => Promise<ArrayBuffer>;
    }> =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {
          get(name: string): string | null {
            return name.toLowerCase() === "content-type" ? "audio/wav" : null;
          },
        },
        arrayBuffer: (): Promise<ArrayBuffer> =>
          Promise.resolve(
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength
            ) as ArrayBuffer
          ),
      })
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

/* -------------------------------------------------------------------------- */
/* Headline: a URL sample imports and lands in a clip (two-turn flow)          */
/* -------------------------------------------------------------------------- */

describe("phase14 audio proof — URL sample imports and lands in a clip", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir !== undefined) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
    vi.unstubAllGlobals();
  });

  it("phase14Proof_importThenCreate_audioClipHoldsManagedPathOneTransaction", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "p14-proof-"));
    stubOkFetch(RIFF_WAVE_BYTES);
    const fake = tagged(
      makeFakeContext(audioTrackWithEmptySlotSpec(), { tempDirectory: tempDir })
    );
    // Share ONE runtime (and its ReferenceTable) across both turns.
    const runtime = new LiveToolRuntime(ctxOf(fake), new ReferenceTable());

    // BEFORE: the slot is empty and nothing has been imported.
    expect(fake.application.song.tracks[0].clipSlots[0].clip).toBeNull();
    expect(fake.resourceCalls).toEqual([]);

    // --- Turn 1: import the URL sample → capture the managed path -----------
    const importRun = buildRun(
      runtime,
      [
        {
          id: "imp1",
          name: "live_import_audio",
          input: { source: "https://example.com/loop.wav" },
        },
      ],
      "import https://example.com/loop.wav"
    );
    const importResult = await runAgentLoop(importRun);
    expect(importResult.ok).toBe(true);
    if (!importResult.ok) {
      return;
    }
    const imp = toolResultBody(importResult.messages, "imp1");
    expect(imp.isError).toBe(false);
    const managedPath = imp.body.managedPath;
    expect(managedPath).toBe("managed:loop.wav");
    // The URL was fetched and imported (one importIntoProject call).
    expect(
      fake.resourceCalls.filter((c) => c.kind === "importIntoProject")
    ).toHaveLength(1);
    // Import is a file-copy side effect, not a model edit: its asyncPlan batches no
    // model change but still runs as one transaction (expected/honest, §14).
    const txnsAfterImport = fake.committedCount;

    // --- Turn 2: create an audio clip from the managed path -----------------
    const createRun = buildRun(
      runtime,
      [
        {
          id: "crt1",
          name: "live_create_clip",
          input: {
            location: "track:0:Audio/clipSlot:0",
            type: "audio",
            filePath: managedPath,
          },
        },
      ],
      "drop it into the slot"
    );
    const createResult = await runAgentLoop(createRun);
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) {
      return;
    }
    const crt = toolResultBody(createResult.messages, "crt1");
    expect(crt.isError).toBe(false);
    expect(crt.body.created).toBe("audio clip");

    // AFTER: the slot now holds an AudioClip whose filePath === the managed path.
    const clip = fake.application.song.tracks[0].clipSlots[0].clip;
    expect(clip).not.toBeNull();
    expect(clip?.filePath).toBe("managed:loop.wav");
    // The create added exactly one more committed transaction (§7 one undo step).
    expect(fake.committedCount).toBe(txnsAfterImport + 1);
  });
});

/* -------------------------------------------------------------------------- */
/* Render: a read tool surfaces a WAV path and mutates nothing                  */
/* -------------------------------------------------------------------------- */

describe("phase14 audio proof — render surfaces a path with zero mutations", () => {
  it("phase14Proof_renderAudioTrack_pathSurfacedNoMutations", async () => {
    const fake = tagged(makeFakeContext());
    const runtime = new LiveToolRuntime(ctxOf(fake), new ReferenceTable());

    const input = buildRun(
      runtime,
      [
        {
          id: "rnd1",
          name: "live_render_audio",
          input: { track: "track:0:Drums", startTime: 0, endTime: 4 },
        },
      ],
      "render the drums 0 to 4 beats"
    );
    const result = await runAgentLoop(input);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const rnd = toolResultBody(result.messages, "rnd1");
    expect(rnd.isError).toBe(false);
    // The rendered WAV path is surfaced to the agent.
    expect(rnd.body.path).toBe("/tmp/render-0-4.wav");
    expect(rnd.body.track).toBe("track:0:Drums");
    // tempo 120 ⇒ 4 beats = 2.0 s.
    expect(rnd.body.durationSeconds).toBeCloseTo(2.0, 10);
    // ZERO mutations: render is a side-effecting read, no transaction opened.
    expect(fake.committedCount).toBe(0);
    expect(fake.transactions).toEqual([]);
    // Exactly one render call was made (beats passed through).
    expect(fake.resourceCalls).toEqual([
      {
        kind: "renderPreFxAudio",
        trackHandleId: fake.application.song.tracks[0].handle.id,
        startTime: 0,
        endTime: 4,
      },
    ]);
  });
});
