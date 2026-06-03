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
  type ScriptedTurn,
} from "./fixtures/fake-anthropic-client.js";
import {
  makeFakeContext,
  type FakeExtensionContext,
} from "./fixtures/fake-extension-context.js";

/**
 * Phase 9 Task 5 (5) — destructive-path PROOF (the §criteria spine,
 * ARCHITECTURE §7, §9, §13; INSTRUCTIONS Phase 9 success criteria).
 *
 * Drives the **REAL** {@link runAgentLoop} + the **REAL** {@link LiveToolRuntime}
 * over a {@link FakeExtensionContext}, with a scripted Claude client emitting a
 * `live_delete` tool_use and a `requestConfirmation` stub standing in for the
 * confirm card. This proves the whole-system invariant Phase 9 exists to
 * guarantee:
 *
 *  - APPROVE → the destructive batch executes in EXACTLY ONE transaction
 *    (`committedCount === 1`) and the target is gone from the Set.
 *  - DECLINE → NO transaction opens (`committedCount === 0`,
 *    `transactions.length === 0`) and the Set is unchanged (the target survives).
 *
 * No fakes for the loop or the executors here (unlike the loop-gate unit tests):
 * the confirmation gate, the §7 single-`withinTransaction` batching, the
 * type-routed delete, and the ref invalidation all run for real — only Claude
 * and the SDK context are doubled (per testing rules).
 */

/* -------------------------------------------------------------------------- */
/* Harness (mirrors executors.test.ts className-tagging + ctx cast)            */
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
 * Wrap the fake's `getObjectFromHandle` so resolved objects report their
 * concrete className (matching the real SDK), so the delete executor's
 * type-routing branches as it would in production. (Same shim as executors.test.)
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
 * Assemble a real-loop run over the fake context with a scripted `live_delete`
 * tool_use turn followed by a terminal text turn, and the given confirmation
 * decision.
 */
function buildRun(
  fake: FakeExtensionContext,
  approve: boolean,
  target = "track:1:Bass"
): RunLoopInput {
  const turns: ScriptedTurn[] = [
    toolUseTurn([{ id: "del1", name: "live_delete", input: { target } }]),
    textTurn("done"),
  ];
  const client = new ClaudeClient(new FakeMessagesClient(turns));
  const refs = new ReferenceTable();
  const runtime = new LiveToolRuntime(ctxOf(fake), refs);

  const requestConfirmation = (plan: {
    summary: string;
    actions: string[];
    calls: ToolCall[];
  }): Promise<boolean> => {
    // The plan is produced by the REAL summarizer here — sanity-check it carries
    // the delete action so this proof also exercises the loop→summarizer wiring.
    expect(plan.actions.length).toBeGreaterThan(0);
    return Promise.resolve(approve);
  };

  return {
    client,
    runtime,
    events: noopEvents(),
    system: [],
    messages: [{ role: "user", content: `delete ${target}` }],
    requestConfirmation,
  };
}

/* -------------------------------------------------------------------------- */
/* The proof                                                                  */
/* -------------------------------------------------------------------------- */

describe("phase9 destructive-path proof — approval gates the single transaction", () => {
  it("phase9Proof_approve_commitsOneTransactionAndRemovesTarget", async () => {
    const fake = tagged(makeFakeContext());
    // The default Set has track:1:Bass present before the run.
    expect(fake.application.song.tracks.map((t) => t.name)).toContain("Bass");

    const input = buildRun(fake, true);
    const result = await runAgentLoop(input);

    expect(result.ok).toBe(true);
    // EXACTLY ONE transaction committed for the approved destructive batch (§7).
    expect(fake.committedCount).toBe(1);
    // The target track is gone from the live Set.
    expect(fake.application.song.tracks.map((t) => t.name)).not.toContain(
      "Bass"
    );
  });

  it("phase9Proof_decline_opensNoTransactionAndLeavesSetUnchanged", async () => {
    const fake = tagged(makeFakeContext());
    const before = fake.application.song.tracks.map((t) => t.name);
    expect(before).toContain("Bass");

    const input = buildRun(fake, false);
    const result = await runAgentLoop(input);

    // Decline is not a turn failure — the loop ends normally.
    expect(result.ok).toBe(true);
    // NO transaction was opened: nothing committed, nothing logged.
    expect(fake.committedCount).toBe(0);
    expect(fake.transactions.length).toBe(0);
    // The Set is byte-for-byte unchanged — the target track survives.
    expect(fake.application.song.tracks.map((t) => t.name)).toEqual(before);
  });

  it("phase9Proof_decline_synthesizesUserDeclinedResultForTheDelete", async () => {
    // Belt-and-braces: the model also sees an honest user_declined result so it
    // never claims the deletion happened (§1.3 honesty).
    const fake = tagged(makeFakeContext());
    const input = buildRun(fake, false);
    const result = await runAgentLoop(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Transcript: user → assistant(tool_use) → user(tool_result) → assistant(text).
      const toolResultMsg = result.messages[2];
      const content = toolResultMsg.content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        const block = content[0] as Anthropic.ToolResultBlockParam;
        expect(block.tool_use_id).toBe("del1");
        expect(block.is_error).toBe(true);
        expect(JSON.stringify(block.content)).toMatch(/user_declined/);
      }
    }
  });
});
