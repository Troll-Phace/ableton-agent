import { describe, expect, it } from "vitest";

import type Anthropic from "@anthropic-ai/sdk";

import { ClaudeClient } from "../src/extension/claude-client.js";
import {
  DEFAULT_MAX_ITERATIONS,
  runAgentLoop,
  type AgentEvents,
  type RunLoopInput,
  type ToolCall,
  type ToolResultPayload,
} from "../src/extension/agent-loop.js";
import {
  FakeMessagesClient,
  textTurn,
  toolUseTurn,
  type ScriptedTurn,
} from "./fixtures/fake-anthropic-client.js";
import { FakeToolRuntime } from "./fixtures/fake-tool-runtime.js";

/**
 * Phase 4 agent-loop suite — the tool-use engine in
 * `src/extension/agent-loop.ts`. Drives a real {@link ClaudeClient} over a
 * scripted {@link FakeMessagesClient} (production wiring) and a
 * {@link FakeToolRuntime} that logs read/flush ordering, so the §4 loop and §7
 * single-batch mutation boundary are asserted deterministically.
 */

/** A recording {@link AgentEvents} sink for assertions. */
interface RecordedEvents extends AgentEvents {
  deltas: string[];
  activity: { tool: string; summary: string; status: string }[];
  done: string[];
  errors: string[];
}

function makeEvents(): RecordedEvents {
  const deltas: string[] = [];
  const activity: { tool: string; summary: string; status: string }[] = [];
  const done: string[] = [];
  const errors: string[] = [];
  return {
    deltas,
    activity,
    done,
    errors,
    assistantDelta(text) {
      deltas.push(text);
    },
    toolActivity(tool, summary, status) {
      activity.push({ tool, summary, status });
    },
    assistantDone(stopReason) {
      done.push(stopReason);
    },
    error(message) {
      errors.push(message);
    },
  };
}

/** Assemble a loop input over scripted turns + a configured runtime. */
function makeLoopInput(
  turns: ScriptedTurn[],
  runtime: FakeToolRuntime,
  events: RecordedEvents,
  over: Partial<RunLoopInput> = {}
): RunLoopInput {
  const client = new ClaudeClient(new FakeMessagesClient(turns));
  return {
    client,
    runtime,
    events,
    system: [],
    messages: [{ role: "user", content: "do the thing" }],
    ...over,
  };
}

describe("runAgentLoop — single-turn terminals", () => {
  it("agentLoop_endTurn_returnsTextNoRuntimeCalls", async () => {
    const runtime = new FakeToolRuntime();
    const events = makeEvents();
    const result = await runAgentLoop(
      makeLoopInput([textTurn("Here is the answer.")], runtime, events)
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stopReason).toBe("end_turn");
      expect(result.text).toBe("Here is the answer.");
    }
    expect(events.done).toEqual(["end_turn"]);
    expect(runtime.callLog).toHaveLength(0);
  });

  it.each([
    ["max_tokens"],
    ["stop_sequence"],
    ["refusal"],
    ["end_turn"],
  ] as const)(
    "agentLoop_terminalStopReason_exitsCleanly_%s",
    async (stopReason) => {
      const runtime = new FakeToolRuntime();
      const events = makeEvents();
      const result = await runAgentLoop(
        makeLoopInput([textTurn("done", { stopReason })], runtime, events)
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.stopReason).toBe(stopReason);
      }
      expect(events.done).toEqual([stopReason]);
      expect(events.errors).toHaveLength(0);
    }
  );

  it("agentLoop_streamingDeltas_reachAssistantDelta", async () => {
    const runtime = new FakeToolRuntime();
    const events = makeEvents();
    await runAgentLoop(
      makeLoopInput(
        [textTurn("x", { deltas: ["a", "b", "c"] })],
        runtime,
        events
      )
    );
    expect(events.deltas).toEqual(["a", "b", "c"]);
  });
});

describe("runAgentLoop — multi-step tool use", () => {
  it("agentLoop_toolUseThenEndTurn_appendsResultsInOrderWithMatchingIds", async () => {
    const runtime = new FakeToolRuntime({
      classifier: { live_get_project: "read", live_get_track: "read" },
    });
    const events = makeEvents();
    const turns: ScriptedTurn[] = [
      toolUseTurn([
        { id: "tu_a", name: "live_get_project", input: {} },
        { id: "tu_b", name: "live_get_track", input: { track: "track:0:X" } },
      ]),
      textTurn("All read."),
    ];

    const result = await runAgentLoop(makeLoopInput(turns, runtime, events));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stopReason).toBe("end_turn");
    }
    // Transcript: user → assistant(tool_use) → user(tool_result) → assistant(text)
    const messages = result.messages;
    const toolResultMsg = messages[2];
    expect(toolResultMsg.role).toBe("user");
    const content = toolResultMsg.content;
    expect(Array.isArray(content)).toBe(true);
    if (Array.isArray(content)) {
      const ids = content.map(
        (b) => (b as Anthropic.ToolResultBlockParam).tool_use_id
      );
      // Same order, same ids as the requested tool_use blocks.
      expect(ids).toEqual(["tu_a", "tu_b"]);
      expect(content[0]).toMatchObject({ type: "tool_result" });
    }
  });

  it("agentLoop_readTools_executeImmediatelyInOrder", async () => {
    const runtime = new FakeToolRuntime({ defaultKind: "read" });
    const events = makeEvents();
    const turns: ScriptedTurn[] = [
      toolUseTurn([
        { id: "r1", name: "read_one", input: {} },
        { id: "r2", name: "read_two", input: {} },
      ]),
      textTurn("ok"),
    ];
    await runAgentLoop(makeLoopInput(turns, runtime, events));

    const readEntries = runtime.callLog.filter((c) => c.phase === "read");
    expect(readEntries.map((e) => e.calls[0].id)).toEqual(["r1", "r2"]);
    // No mutation flush happened.
    expect(runtime.flushCount).toBe(0);
  });
});

describe("runAgentLoop — parallel tool_use blocks + mutation batching (§7)", () => {
  it("agentLoop_parallelBlocks_readsImmediateMutationsOneBatch", async () => {
    const runtime = new FakeToolRuntime({
      classifier: {
        live_get_project: "read",
        live_get_track: "read",
        live_update_track: "mutation",
        live_set_param: "mutation",
      },
    });
    const events = makeEvents();
    const turns: ScriptedTurn[] = [
      toolUseTurn([
        { id: "read_1", name: "live_get_project", input: {} },
        { id: "mut_1", name: "live_update_track", input: {} },
        { id: "read_2", name: "live_get_track", input: {} },
        { id: "mut_2", name: "live_set_param", input: {} },
      ]),
      textTurn("Applied."),
    ];

    const result = await runAgentLoop(makeLoopInput(turns, runtime, events));
    expect(result.ok).toBe(true);

    // Exactly ONE flush call carrying BOTH mutations, in request order.
    expect(runtime.flushCount).toBe(1);
    const flushEntry = runtime.callLog.find((c) => c.phase === "flush");
    expect(flushEntry?.calls.map((c) => c.id)).toEqual(["mut_1", "mut_2"]);

    // Reads ran immediately, in order, before the flush entry in the log.
    const readEntries = runtime.callLog.filter((c) => c.phase === "read");
    expect(readEntries.map((e) => e.calls[0].id)).toEqual(["read_1", "read_2"]);
    const flushIndex = runtime.callLog.findIndex((c) => c.phase === "flush");
    const lastReadIndex = runtime.callLog
      .map((c) => c.phase)
      .lastIndexOf("read");
    expect(lastReadIndex).toBeLessThan(flushIndex);

    // tool_result order in the transcript still matches the requested order.
    if (result.ok) {
      const toolResultMsg = result.messages[2];
      const content = toolResultMsg.content;
      if (Array.isArray(content)) {
        const ids = content.map(
          (b) => (b as Anthropic.ToolResultBlockParam).tool_use_id
        );
        expect(ids).toEqual(["read_1", "mut_1", "read_2", "mut_2"]);
      }
    }
  });

  it("agentLoop_multipleMutations_collectedBeforeSingleFlush", async () => {
    const runtime = new FakeToolRuntime({ defaultKind: "mutation" });
    const events = makeEvents();
    const turns: ScriptedTurn[] = [
      toolUseTurn([
        { id: "m1", name: "live_create", input: {} },
        { id: "m2", name: "live_create", input: {} },
        { id: "m3", name: "live_create", input: {} },
      ]),
      textTurn("done"),
    ];
    await runAgentLoop(makeLoopInput(turns, runtime, events));

    expect(runtime.flushCount).toBe(1);
    const flush = runtime.callLog.find((c) => c.phase === "flush");
    expect(flush?.calls.map((c) => c.id)).toEqual(["m1", "m2", "m3"]);
  });
});

describe("runAgentLoop — report_limitation runs in the read phase (§8.3/§9)", () => {
  it("agentLoop_reportLimitation_executesImmediatelyNotInFlush", async () => {
    // The honesty tool classifies as "read" (shared TOOL_CLASS) so the loop runs
    // it immediately in the read partition and NEVER queues it into a mutation
    // flush. Mirrors the production wiring: a report_limitation tool_use followed
    // by an end_turn must execute in place, append its tool_result, and terminate.
    const runtime = new FakeToolRuntime({
      // Faithful to the shared classify: report_limitation → read.
      classifier: { report_limitation: "read" },
      readResults: {
        lim: {
          content: JSON.stringify({
            acknowledged: true,
            requested: "draw automation",
          }),
        },
      },
    });
    const events = makeEvents();
    const turns: ScriptedTurn[] = [
      toolUseTurn([
        {
          id: "lim",
          name: "report_limitation",
          input: {
            requested: "draw automation",
            reason: "live_set_param sets a static value only (§9)",
          },
        },
      ]),
      textTurn("I can't draw automation, but I can set a static value."),
    ];

    const result = await runAgentLoop(makeLoopInput(turns, runtime, events));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stopReason).toBe("end_turn");
    }
    // It ran in the READ partition, in place — never through the mutation flush.
    const readEntries = runtime.callLog.filter((c) => c.phase === "read");
    expect(readEntries.map((e) => e.calls[0].id)).toEqual(["lim"]);
    expect(runtime.flushCount).toBe(0);
    // Its tool_result is appended with the matching id (transcript: user →
    // assistant(tool_use) → user(tool_result) → assistant(text)).
    if (result.ok) {
      const toolResultMsg = result.messages[2];
      expect(toolResultMsg.role).toBe("user");
      const content = toolResultMsg.content;
      if (Array.isArray(content)) {
        const block = content[0] as Anthropic.ToolResultBlockParam;
        expect(block.tool_use_id).toBe("lim");
        // An honest acknowledgment is NOT an error.
        expect(block.is_error).toBeUndefined();
      }
    }
    // It was narrated as a successful tool activity (started → ok), not an error.
    const statuses = events.activity
      .filter((a) => a.tool === "report_limitation")
      .map((a) => a.status);
    expect(statuses).toEqual(["started", "ok"]);
  });
});

describe("runAgentLoop — is_error framing", () => {
  it("agentLoop_readError_setsIsErrorAndEmitsErrorActivity", async () => {
    const runtime = new FakeToolRuntime({
      classifier: { live_get_clip: "read" },
      readResults: {
        bad: {
          content: JSON.stringify({ error: "ref_unresolved" }),
          isError: true,
        },
      },
    });
    const events = makeEvents();
    const turns: ScriptedTurn[] = [
      toolUseTurn([{ id: "bad", name: "live_get_clip", input: {} }]),
      textTurn("noted"),
    ];

    const result = await runAgentLoop(makeLoopInput(turns, runtime, events));
    expect(result.ok).toBe(true);

    if (result.ok) {
      const content = result.messages[2].content;
      if (Array.isArray(content)) {
        const block = content[0] as Anthropic.ToolResultBlockParam;
        expect(block.is_error).toBe(true);
      }
    }
    // One started + one error activity for the failed read.
    const statuses = events.activity
      .filter((a) => a.tool === "live_get_clip")
      .map((a) => a.status);
    expect(statuses).toEqual(["started", "error"]);
  });

  it("agentLoop_mutationError_setsIsErrorAndEmitsErrorActivity", async () => {
    // Uses a NON-destructive mutation (live_update_track) so this exercises the
    // generic mutation-error framing through the normal flush path. (A destructive
    // tool like live_delete would route through the Phase-9 confirmation gate
    // instead — covered separately in the confirmation-gate suite below.)
    const runtime = new FakeToolRuntime({
      classifier: { live_update_track: "mutation" },
      mutationResults: {
        m1: {
          content: JSON.stringify({ error: "type_mismatch" }),
          isError: true,
        },
      },
    });
    const events = makeEvents();
    const turns: ScriptedTurn[] = [
      toolUseTurn([{ id: "m1", name: "live_update_track", input: {} }]),
      textTurn("ok"),
    ];
    const result = await runAgentLoop(makeLoopInput(turns, runtime, events));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const content = result.messages[2].content;
      if (Array.isArray(content)) {
        expect((content[0] as Anthropic.ToolResultBlockParam).is_error).toBe(
          true
        );
      }
    }
    const statuses = events.activity
      .filter((a) => a.tool === "live_update_track")
      .map((a) => a.status);
    expect(statuses).toEqual(["started", "error"]);
  });

  it("agentLoop_successfulTool_emitsOkActivity", async () => {
    const runtime = new FakeToolRuntime({
      classifier: { live_get_project: "read" },
    });
    const events = makeEvents();
    const turns: ScriptedTurn[] = [
      toolUseTurn([{ id: "ok1", name: "live_get_project", input: {} }]),
      textTurn("done"),
    ];
    await runAgentLoop(makeLoopInput(turns, runtime, events));
    const statuses = events.activity
      .filter((a) => a.tool === "live_get_project")
      .map((a) => a.status);
    expect(statuses).toEqual(["started", "ok"]);
  });
});

describe("runAgentLoop — iteration cap", () => {
  it("agentLoop_alwaysToolUse_stopsAtDefaultCap", async () => {
    const runtime = new FakeToolRuntime({ defaultKind: "read" });
    const events = makeEvents();
    // Every scripted turn requests a tool — the loop must never terminate
    // naturally, so the cap is what stops it.
    const turn = toolUseTurn([{ id: "loop", name: "spin", input: {} }]);
    const turns = Array.from({ length: DEFAULT_MAX_ITERATIONS + 5 }, () => ({
      ...turn,
    }));

    const result = await runAgentLoop(makeLoopInput(turns, runtime, events));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err.error).toBe("iteration_cap");
    }
    expect(events.errors).toHaveLength(1);
    // Exactly DEFAULT_MAX_ITERATIONS turns were streamed.
    const readEntries = runtime.callLog.filter((c) => c.phase === "read");
    expect(readEntries).toHaveLength(DEFAULT_MAX_ITERATIONS);
  });

  it("agentLoop_customMaxIterations_isHonored", async () => {
    const runtime = new FakeToolRuntime({ defaultKind: "read" });
    const events = makeEvents();
    const turn = toolUseTurn([{ id: "loop", name: "spin", input: {} }]);
    const turns = Array.from({ length: 10 }, () => ({ ...turn }));

    const result = await runAgentLoop(
      makeLoopInput(turns, runtime, events, { maxIterations: 3 })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err.error).toBe("iteration_cap");
    }
    const readEntries = runtime.callLog.filter((c) => c.phase === "read");
    expect(readEntries).toHaveLength(3);
  });
});

describe("runAgentLoop — AbortSignal", () => {
  it("agentLoop_preAbortedBeforeFirstTurn_returnsAbortedNoFlush", async () => {
    const runtime = new FakeToolRuntime({ defaultKind: "mutation" });
    const events = makeEvents();
    const controller = new AbortController();
    controller.abort();

    const result = await runAgentLoop(
      makeLoopInput([textTurn("never")], runtime, events, {
        signal: controller.signal,
      })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err.error).toBe("aborted");
    }
    expect(runtime.flushCount).toBe(0);
    expect(events.errors.length).toBeGreaterThan(0);
  });

  it("agentLoop_abortBeforeMutationFlush_stopsWithNoFlush", async () => {
    // The runtime aborts the controller while running the read, so by the time
    // the loop reaches the pre-flush abort check, the signal is set.
    const controller = new AbortController();
    const runtime = new (class extends FakeToolRuntime {
      override executeRead(call: ToolCall): Promise<ToolResultPayload> {
        controller.abort();
        return super.executeRead(call);
      }
    })({
      classifier: { read_first: "read", mutate_after: "mutation" },
    });
    const events = makeEvents();
    const turns: ScriptedTurn[] = [
      toolUseTurn([
        { id: "read_first", name: "read_first", input: {} },
        { id: "mutate_after", name: "mutate_after", input: {} },
      ]),
      textTurn("unreached"),
    ];

    const result = await runAgentLoop(
      makeLoopInput(turns, runtime, events, { signal: controller.signal })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err.error).toBe("aborted");
    }
    // The read ran, but the mutation flush was skipped by the abort check.
    expect(runtime.callLog.some((c) => c.phase === "read")).toBe(true);
    expect(runtime.flushCount).toBe(0);
  });
});

describe("runAgentLoop — destructive-action confirmation gate (Phase 9, §9/§13)", () => {
  /**
   * Drive a scripted destructive turn (`live_delete`) through the loop with a
   * controllable `requestConfirmation` seam, then a terminal text turn. Returns
   * the loop result, the recording events, the runtime, and the captured plan.
   */
  async function runDestructiveTurn(opts: {
    confirm?: (plan: {
      summary: string;
      actions: string[];
      calls: ToolCall[];
    }) => Promise<boolean>;
    over?: Partial<RunLoopInput>;
    extraCalls?: { id: string; name: string; input: unknown }[];
  }): Promise<{
    result: Awaited<ReturnType<typeof runAgentLoop>>;
    events: RecordedEvents;
    runtime: FakeToolRuntime;
    capturedPlan: {
      summary: string;
      actions: string[];
      calls: ToolCall[];
    } | null;
  }> {
    let capturedPlan: {
      summary: string;
      actions: string[];
      calls: ToolCall[];
    } | null = null;
    const requestConfirmation =
      opts.confirm === undefined
        ? undefined
        : (plan: { summary: string; actions: string[]; calls: ToolCall[] }) => {
            capturedPlan = plan;
            return opts.confirm!(plan);
          };

    const runtime = new FakeToolRuntime({
      classifier: {
        live_delete: "mutation",
        live_update_track: "mutation",
      },
    });
    const events = makeEvents();
    const turns: ScriptedTurn[] = [
      toolUseTurn([
        {
          id: "del1",
          name: "live_delete",
          input: { target: "track:1:Bass" },
        },
        ...(opts.extraCalls ?? []),
      ]),
      textTurn("acknowledged"),
    ];

    const result = await runAgentLoop(
      makeLoopInput(turns, runtime, events, {
        ...(requestConfirmation ? { requestConfirmation } : {}),
        ...opts.over,
      })
    );
    return { result, events, runtime, capturedPlan };
  }

  it("agentLoop_destructiveApproved_flushesOnceNoDecline", async () => {
    const { result, runtime, capturedPlan } = await runDestructiveTurn({
      confirm: () => Promise.resolve(true),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stopReason).toBe("end_turn");
    }
    // Approval ⇒ the batch flushes exactly once.
    expect(runtime.flushCount).toBe(1);
    const flush = runtime.callLog.find((c) => c.phase === "flush");
    expect(flush?.calls.map((c) => c.id)).toEqual(["del1"]);

    // No user_declined / confirmation_unavailable result was synthesized.
    if (result.ok) {
      const content = result.messages[2].content;
      if (Array.isArray(content)) {
        const wire = JSON.stringify(content);
        expect(wire).not.toMatch(/user_declined/);
        expect(wire).not.toMatch(/confirmation_unavailable/);
      }
    }

    // The plan handed to the seam carried the correct summary/actions/calls.
    expect(capturedPlan).not.toBeNull();
    expect(capturedPlan?.actions).toEqual(["Delete track:1:Bass"]);
    expect(capturedPlan?.summary).toContain("1 thing");
    expect(capturedPlan?.calls.map((c) => c.id)).toEqual(["del1"]);
  });

  it("agentLoop_destructiveDeclined_skipsFlushSynthesizesUserDeclinedEndsOkTurn", async () => {
    const { result, events, runtime } = await runDestructiveTurn({
      confirm: () => Promise.resolve(false),
    });

    // Decline is NOT a turn failure: the loop falls through to a normal end_turn.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stopReason).toBe("end_turn");
    }
    // No transaction was opened.
    expect(runtime.flushCount).toBe(0);

    // Every mutation id got a user_declined, is_error result.
    if (result.ok) {
      const content = result.messages[2].content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        const block = content[0] as Anthropic.ToolResultBlockParam;
        expect(block.tool_use_id).toBe("del1");
        expect(block.is_error).toBe(true);
        expect(JSON.stringify(block.content)).toMatch(/user_declined/);
      }
    }
    // Narrated as an error activity for the declined call.
    const statuses = events.activity
      .filter((a) => a.tool === "live_delete")
      .map((a) => a.status);
    expect(statuses).toEqual(["error"]);
  });

  it("agentLoop_destructiveDeclined_wholeMixedBatchDeclinedTogether", async () => {
    // A mixed batch (destructive + non-destructive) shares one transaction, so a
    // decline cancels the WHOLE batch — every mutation id gets user_declined.
    const { result, runtime } = await runDestructiveTurn({
      confirm: () => Promise.resolve(false),
      extraCalls: [
        {
          id: "upd1",
          name: "live_update_track",
          input: { track: "track:0:X" },
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(runtime.flushCount).toBe(0);
    if (result.ok) {
      const content = result.messages[2].content;
      if (Array.isArray(content)) {
        const ids = content.map(
          (b) => (b as Anthropic.ToolResultBlockParam).tool_use_id
        );
        expect(ids).toEqual(["del1", "upd1"]);
        for (const b of content) {
          const block = b as Anthropic.ToolResultBlockParam;
          expect(block.is_error).toBe(true);
          expect(JSON.stringify(block.content)).toMatch(/user_declined/);
        }
      }
    }
  });

  it("agentLoop_declineStillSurfacesRefsViaNormalEndTurn", async () => {
    // Decline continues the loop to end_turn (ok:true) so the turn completes
    // normally — the surrounding session emits refs_updated as usual. Here we
    // just assert the loop terminates successfully (ran), not as a failure.
    const { result, events } = await runDestructiveTurn({
      confirm: () => Promise.resolve(false),
    });
    expect(result.ok).toBe(true);
    expect(events.done).toEqual(["end_turn"]);
    expect(events.errors).toHaveLength(0);
  });

  it("agentLoop_destructiveFilterOp_isGatedByConfirmation", async () => {
    // op:"filter" on live_edit_midi_notes is destructive → gated. Approve here.
    let captured: { actions: string[] } | null = null;
    const runtime = new FakeToolRuntime({
      classifier: { live_edit_midi_notes: "mutation" },
    });
    const events = makeEvents();
    const turns: ScriptedTurn[] = [
      toolUseTurn([
        {
          id: "flt1",
          name: "live_edit_midi_notes",
          input: { clip: "track:1:Keys/clip:0:Chords", op: "filter" },
        },
      ]),
      textTurn("ok"),
    ];

    const result = await runAgentLoop(
      makeLoopInput(turns, runtime, events, {
        requestConfirmation: (plan) => {
          captured = { actions: plan.actions };
          return Promise.resolve(true);
        },
      })
    );

    expect(result.ok).toBe(true);
    expect(runtime.flushCount).toBe(1);
    expect(captured).not.toBeNull();
    expect((captured as { actions: string[] } | null)?.actions).toEqual([
      "Filter notes in track:1:Keys/clip:0:Chords (removes notes outside the kept range)",
    ]);
  });

  it("agentLoop_nonDestructiveMutation_neverCallsConfirmationSeam", async () => {
    // A non-destructive batch must never invoke the confirmation seam.
    let called = false;
    const runtime = new FakeToolRuntime({
      classifier: { live_update_track: "mutation" },
    });
    const events = makeEvents();
    const turns: ScriptedTurn[] = [
      toolUseTurn([
        { id: "u1", name: "live_update_track", input: { track: "t" } },
      ]),
      textTurn("done"),
    ];

    const result = await runAgentLoop(
      makeLoopInput(turns, runtime, events, {
        requestConfirmation: () => {
          called = true;
          return Promise.resolve(true);
        },
      })
    );

    expect(result.ok).toBe(true);
    expect(called).toBe(false);
    expect(runtime.flushCount).toBe(1);
  });

  it("agentLoop_cancelWhileAwaitingConfirmation_abortReturnsNoFlush", async () => {
    // THE critical race (decision 5): a cancel WHILE the card is open must take
    // the aborted-return path, NOT the decline path. The seam aborts the signal
    // then resolves false (mirroring the session's abort listener → settle(false)).
    const controller = new AbortController();
    const { result, runtime } = await runDestructiveTurn({
      over: { signal: controller.signal },
      confirm: () => {
        controller.abort();
        return Promise.resolve(false);
      },
    });

    // Aborted-return: ok:false with error "aborted", not a decline (which is ok:true).
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err.error).toBe("aborted");
    }
    expect(runtime.flushCount).toBe(0);
  });

  it("agentLoop_noConfirmationSeam_destructiveFailsClosedNoFlush", async () => {
    // Fail-closed (decision 4): a destructive call with NO requestConfirmation
    // wired must skip the flush and synthesize confirmation_unavailable, never
    // auto-approve.
    const { result, events, runtime } = await runDestructiveTurn({
      confirm: undefined,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stopReason).toBe("end_turn");
    }
    expect(runtime.flushCount).toBe(0);
    if (result.ok) {
      const content = result.messages[2].content;
      if (Array.isArray(content)) {
        const block = content[0] as Anthropic.ToolResultBlockParam;
        expect(block.is_error).toBe(true);
        expect(JSON.stringify(block.content)).toMatch(
          /confirmation_unavailable/
        );
      }
    }
    // The fail-closed path narrates an error (no started narration).
    const statuses = events.activity
      .filter((a) => a.tool === "live_delete")
      .map((a) => a.status);
    expect(statuses).toEqual(["error"]);
  });

  it("agentLoop_noSeam_nonDestructiveBatch_stillFlushesUnchanged", async () => {
    // Regression: the fail-closed gate must only bite destructive batches. A
    // non-destructive batch with NO seam flushes exactly as before Phase 9.
    const runtime = new FakeToolRuntime({
      classifier: { live_update_track: "mutation", live_set_param: "mutation" },
    });
    const events = makeEvents();
    const turns: ScriptedTurn[] = [
      toolUseTurn([
        { id: "m1", name: "live_update_track", input: { track: "t" } },
        { id: "m2", name: "live_set_param", input: {} },
      ]),
      textTurn("done"),
    ];

    const result = await runAgentLoop(makeLoopInput(turns, runtime, events));
    expect(result.ok).toBe(true);
    expect(runtime.flushCount).toBe(1);
    const flush = runtime.callLog.find((c) => c.phase === "flush");
    expect(flush?.calls.map((c) => c.id)).toEqual(["m1", "m2"]);
  });
});

describe("runAgentLoop — client failure propagation", () => {
  it("agentLoop_clientError_returnsErrAndEmitsError", async () => {
    const runtime = new FakeToolRuntime();
    const events = makeEvents();
    const result = await runAgentLoop(
      makeLoopInput(
        [{ rejectWith: new Error("network down") }],
        runtime,
        events
      )
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err.error).toBe("stream_error");
    }
    expect(events.errors.length).toBeGreaterThan(0);
  });
});

describe("runAgentLoop — snapshot seeding (iteration 0 only)", () => {
  it("agentLoop_snapshot_sentOnlyOnFirstIteration", async () => {
    const runtime = new FakeToolRuntime({ defaultKind: "read" });
    const events = makeEvents();
    const fake = new FakeMessagesClient([
      toolUseTurn([{ id: "t1", name: "read_x", input: {} }]),
      textTurn("done"),
    ]);
    const client = new ClaudeClient(fake);

    await runAgentLoop({
      client,
      runtime,
      events,
      system: [],
      snapshot: "SNAPSHOT BODY",
      messages: [{ role: "user", content: "hi" }],
    });

    // Iteration 0 carries the snapshot as a trailing uncached user block.
    const firstMessages = fake.capturedParams[0].messages;
    const firstLast = firstMessages[firstMessages.length - 1];
    expect(Array.isArray(firstLast.content)).toBe(true);
    if (Array.isArray(firstLast.content)) {
      expect(firstLast.content[0]).toMatchObject({
        type: "text",
        text: "SNAPSHOT BODY",
      });
    }

    // Iteration 1 carries NO snapshot block; its last message is the
    // tool_result user message, not a snapshot text block.
    const secondMessages = fake.capturedParams[1].messages;
    const secondLast = secondMessages[secondMessages.length - 1];
    if (Array.isArray(secondLast.content)) {
      expect(secondLast.content[0]).toMatchObject({ type: "tool_result" });
    }
  });
});

describe("runAgentLoop — defensive guards (malformed runtime/model)", () => {
  it("agentLoop_toolUseStopWithNoBlocks_returnsStructuredStreamError", async () => {
    // stop_reason is tool_use but the assistant message carries no tool_use
    // blocks — without the guard this would spin forever.
    const runtime = new FakeToolRuntime();
    const events = makeEvents();
    const turns: ScriptedTurn[] = [{ stopReason: "tool_use" }];
    const result = await runAgentLoop(makeLoopInput(turns, runtime, events));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err.error).toBe("stream_error");
      expect(result.err.detail).toMatch(/no tool_use blocks/);
    }
    expect(events.errors.length).toBeGreaterThan(0);
  });

  it("agentLoop_shortFlushArray_fillsMissingWithStructuredError", async () => {
    // flushMutations returns FEWER payloads than calls — the loop must backfill
    // the missing slot with a structured error rather than crash.
    class ShortFlushRuntime extends FakeToolRuntime {
      override flushMutations(calls: ToolCall[]): Promise<ToolResultPayload[]> {
        this.callLog.push({ phase: "flush", calls: [...calls] });
        // Return a result for the first call only.
        return Promise.resolve([
          { toolUseId: calls[0].id, content: "ok:first" },
        ]);
      }
    }
    const runtime = new ShortFlushRuntime({ defaultKind: "mutation" });
    const events = makeEvents();
    const turns: ScriptedTurn[] = [
      toolUseTurn([
        { id: "m1", name: "live_create", input: {} },
        { id: "m2", name: "live_create", input: {} },
      ]),
      textTurn("done"),
    ];

    const result = await runAgentLoop(makeLoopInput(turns, runtime, events));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const content = result.messages[2].content;
      if (Array.isArray(content)) {
        const second = content[1] as Anthropic.ToolResultBlockParam;
        expect(second.tool_use_id).toBe("m2");
        expect(second.is_error).toBe(true);
        expect(JSON.stringify(second.content)).toMatch(
          /mutation_missing_result/
        );
      }
    }
    // The backfilled missing result is narrated as an error.
    const m2Statuses = events.activity
      .filter((a, i) => i > 0 && a.status === "error")
      .map((a) => a.status);
    expect(m2Statuses.length).toBeGreaterThan(0);
  });

  it("agentLoop_flushResultWithWrongId_blockFallsBackToStructuredError", async () => {
    // flushMutations returns a payload whose toolUseId does NOT match the
    // requested block, so the block id is absent from resultsById and the
    // tool_result assembly falls back to a structured error.
    class WrongIdRuntime extends FakeToolRuntime {
      override flushMutations(calls: ToolCall[]): Promise<ToolResultPayload[]> {
        this.callLog.push({ phase: "flush", calls: [...calls] });
        return Promise.resolve(
          calls.map(() => ({ toolUseId: "unrelated_id", content: "stray" }))
        );
      }
    }
    const runtime = new WrongIdRuntime({ defaultKind: "mutation" });
    const events = makeEvents();
    const turns: ScriptedTurn[] = [
      toolUseTurn([{ id: "m1", name: "live_create", input: {} }]),
      textTurn("done"),
    ];

    const result = await runAgentLoop(makeLoopInput(turns, runtime, events));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const content = result.messages[2].content;
      if (Array.isArray(content)) {
        const block = content[0] as Anthropic.ToolResultBlockParam;
        // The requested block id is preserved; content is the fallback error.
        expect(block.tool_use_id).toBe("m1");
        expect(block.is_error).toBe(true);
        expect(JSON.stringify(block.content)).toMatch(/tool_result_missing/);
      }
    }
  });
});
