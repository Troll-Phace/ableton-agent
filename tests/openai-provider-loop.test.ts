import type { ApiVersion, ExtensionContext } from "@ableton-extensions/sdk";
import { describe, expect, it, vi } from "vitest";

import {
  runProviderLoop,
  type AgentEvents,
} from "../src/extension/agent-loop.js";
import { LiveToolRuntime } from "../src/extension/tool-registry.js";
import { OpenAiResponsesProvider } from "../src/companion/providers/openai-responses.js";
import type { LocalToolResultPayload } from "../src/shared/provider.js";
import { makeFakeContext } from "./fixtures/fake-extension-context.js";
import {
  callFragments,
  ACCOUNT,
  BEARER,
  completedResponse,
  CONVERSATION,
  delta,
  FINAL,
  liveCall,
  makeProvider,
  message,
  PRIVATE,
  reasoning,
  SNAPSHOT,
  stalled,
  terminal,
  unsuccessful,
  USER,
  type Reply,
} from "./fixtures/fake-openai-responses.js";

function events() {
  return {
    assistantDelta: vi.fn<AgentEvents["assistantDelta"]>(),
    toolActivity: vi.fn<AgentEvents["toolActivity"]>(),
    assistantDone: vi.fn<AgentEvents["assistantDone"]>(),
    error: vi.fn<AgentEvents["error"]>(),
  };
}

function setup(replies: Reply[], signal?: AbortSignal) {
  const f = makeProvider(...replies);
  const fake = makeFakeContext();
  const runtime = new LiveToolRuntime(
    fake as unknown as ExtensionContext<ApiVersion>,
    undefined,
    signal
  );
  const read = vi.spyOn(runtime, "executeRead");
  const flush = vi.spyOn(runtime, "flushMutations");
  const sink = events();
  const run = (
    requestConfirmation?: Parameters<
      typeof runProviderLoop
    >[0]["requestConfirmation"]
  ) =>
    runProviderLoop({
      provider: f.provider,
      runtime,
      events: sink,
      snapshot: SNAPSHOT,
      signal,
      requestConfirmation,
    });
  return { ...f, fake, runtime, read, flush, sink, run };
}

type WireResult = {
  type: "function_call_output";
  call_id: string;
  output: string;
};
function input(body: unknown): unknown[] {
  return (body as { input: unknown[] }).input;
}
function outputs(body: unknown): WireResult[] {
  return input(body).filter(
    (row): row is WireResult =>
      !!row &&
      typeof row === "object" &&
      "type" in row &&
      row.type === "function_call_output"
  );
}
function errorContent(row: WireResult): string {
  const envelope = JSON.parse(row.output) as {
    is_error: boolean;
    content: string;
  };
  expect(envelope.is_error).toBe(true);
  expect(typeof envelope.content).toBe("string");
  return envelope.content;
}

describe("15.4B2 real Responses SDK → real local music-tool loop (synthetic host)", () => {
  it("reads in order, batches all writes once and carries exact ordered results and full reasoning on the next request", async () => {
    const raw = [
      reasoning(),
      liveCall("read1", "live_get_project"),
      liveCall("mut1", "live_update_track", {
        track: "track:0:Drums",
        name: "Beats",
      }),
      message("Synthetic intermediate", "intermediate"),
      liveCall("read2", "live_get_track", { track: "track:99:Not present" }),
      liveCall("mut2", "live_update_track", {
        track: "track:1:Bass",
        mute: true,
      }),
    ];
    const f = setup([completedResponse(raw, null), completedResponse()]);
    expect(await f.run()).toEqual({
      ok: true,
      stopReason: "end_turn",
      text: FINAL,
    });
    expect(f.read.mock.calls.map(([call]) => call.id)).toEqual([
      "read1",
      "read2",
    ]);
    expect(f.flush).toHaveBeenCalledTimes(1);
    expect(f.flush.mock.calls[0][0].map((call) => call.id)).toEqual([
      "mut1",
      "mut2",
    ]);
    expect(f.read.mock.invocationCallOrder[1]).toBeLessThan(
      f.flush.mock.invocationCallOrder[0]
    );
    expect(f.fake.application.song.tracks[0].name).toBe("Beats");
    expect(f.fake.application.song.tracks[1].mute).toBe(true);
    expect(f.fake.transactions).toEqual([
      { committed: true, rolledBack: false },
    ]);
    expect(f.bodies).toHaveLength(2);
    const next = input(f.bodies[1]);
    expect(next).toEqual([
      ...input(f.bodies[0]),
      ...raw,
      ...outputs(f.bodies[1]),
    ]);
    expect(outputs(f.bodies[1]).map((row) => row.call_id)).toEqual([
      "read1",
      "mut1",
      "read2",
      "mut2",
    ]);
    const readPayloads = await Promise.all(
      f.read.mock.results.map(
        (row) => row.value as Promise<LocalToolResultPayload>
      )
    );
    const writes = await (f.flush.mock.results[0].value as Promise<
      LocalToolResultPayload[]
    >);
    expect(outputs(f.bodies[1])).toEqual([
      {
        type: "function_call_output",
        call_id: "read1",
        output: readPayloads[0].content,
      },
      {
        type: "function_call_output",
        call_id: "mut1",
        output: writes[0].content,
      },
      {
        type: "function_call_output",
        call_id: "read2",
        output: JSON.stringify({
          is_error: true,
          content: readPayloads[1].content,
        }),
      },
      {
        type: "function_call_output",
        call_id: "mut2",
        output: writes[1].content,
      },
    ]);
    expect(f.sink.assistantDone).toHaveBeenCalledExactlyOnceWith("end_turn");
    expect(f.provider.status()).toMatchObject({
      state: "ready",
      requestReady: false,
    });
  });

  it.each(["approve", "decline", "unavailable"] as const)(
    "destructive batch %s preserves the confirmation gate through the SDK adapter",
    async (decision) => {
      const raw = [
        liveCall("rename", "live_update_track", {
          track: "track:0:Drums",
          name: "Beats",
        }),
        liveCall("delete", "live_delete", { target: "track:2:Keys" }),
      ];
      const f = setup([completedResponse(raw), completedResponse()]);
      const before = f.fake.application.song.tracks.map((track) => track.name);
      const confirm = vi.fn(() => Promise.resolve(decision === "approve"));
      expect(
        (await f.run(decision === "unavailable" ? undefined : confirm)).ok
      ).toBe(true);
      expect(outputs(f.bodies[1]).map((row) => row.call_id)).toEqual([
        "rename",
        "delete",
      ]);
      expect(f.bodies).toHaveLength(2);
      if (decision === "approve") {
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(
          f.fake.application.song.tracks.map((track) => track.name)
        ).toEqual(["Beats", "Bass", "Dup", "Dup"]);
        expect(f.flush).toHaveBeenCalledTimes(1);
        expect(f.fake.transactions).toEqual([
          { committed: true, rolledBack: false },
        ]);
      } else {
        expect(confirm).toHaveBeenCalledTimes(decision === "decline" ? 1 : 0);
        expect(f.flush).not.toHaveBeenCalled();
        expect(f.fake.transactions).toEqual([]);
        expect(
          f.fake.application.song.tracks.map((track) => track.name)
        ).toEqual(before);
        for (const row of outputs(f.bodies[1]))
          expect(errorContent(row)).toContain(
            decision === "decline"
              ? "user_declined"
              : "confirmation_unavailable"
          );
      }
    }
  );

  it("cancelling at pending destructive confirmation leaves every mutation unapplied and never dispatches another request", async () => {
    const abort = new AbortController();
    const f = setup(
      [
        completedResponse([
          liveCall("delete", "live_delete", { target: "track:2:Keys" }),
        ]),
      ],
      abort.signal
    );
    const before = f.fake.application.song.tracks.map((track) => track.name);
    const entered = Promise.withResolvers<void>();
    const decision = Promise.withResolvers<boolean>();
    const task = f.run(() => {
      entered.resolve();
      return decision.promise;
    });
    await entered.promise;
    abort.abort();
    decision.resolve(false);
    expect(await task).toMatchObject({ ok: false, err: { error: "aborted" } });
    expect(f.flush).not.toHaveBeenCalled();
    expect(f.fake.transactions).toEqual([]);
    expect(f.fake.application.song.tracks.map((track) => track.name)).toEqual(
      before
    );
    expect(f.requests).toHaveLength(1);
    expect(f.sink.assistantDone).not.toHaveBeenCalled();
  });

  it("preserves atomic rollback and matched error envelopes on a failed fake SDK setter", async () => {
    const f = setup([
      completedResponse([
        liveCall("mute", "live_update_track", {
          track: "track:0:Drums",
          mute: true,
        }),
        liveCall("rename", "live_update_track", {
          track: "track:1:Bass",
          name: "Should not land",
        }),
      ]),
      completedResponse(),
    ]);
    const beforeMute = f.fake.application.song.tracks[0].mute;
    f.fake.failNameSets("synthetic setter failure");
    expect((await f.run()).ok).toBe(true);
    expect(f.fake.application.song.tracks[0].mute).toBe(beforeMute);
    expect(f.fake.application.song.tracks[1].name).toBe("Bass");
    expect(f.fake.transactions).toEqual([
      { committed: false, rolledBack: true },
    ]);
    const rows = outputs(f.bodies[1]);
    expect(rows.map((row) => row.call_id)).toEqual(["mute", "rename"]);
    for (const row of rows)
      expect(errorContent(row)).toContain("transaction rolled back");
  });

  it("re-resolves the named reference after a fresh reorder between provider turns", async () => {
    const f = setup([
      completedResponse([
        liveCall("read", "live_get_track", { track: "track:1:Bass" }),
      ]),
      () => {
        f.fake.reorder("", "tracks", 1, 0);
        return completedResponse([
          liveCall("rename", "live_update_track", {
            track: "track:1:Bass",
            name: "Sub",
          }),
        ]);
      },
      completedResponse(),
    ]);
    expect((await f.run()).ok).toBe(true);
    expect(
      f.fake.application.song.tracks.slice(0, 2).map((track) => track.name)
    ).toEqual(["Sub", "Drums"]);
    const rows = outputs(f.bodies[2]);
    expect(rows.map((row) => row.call_id)).toEqual(["read", "rename"]);
    expect(rows[1].output).toContain("track:0:Bass");
    expect(f.fake.committedCount).toBe(1);
  });

  it("named creation remains two transactions with the real final named reference", async () => {
    const f = setup([
      completedResponse([
        liveCall("create", "live_create", {
          kind: "audio_track",
          name: "Synthetic Vox",
        }),
      ]),
      completedResponse(),
    ]);
    const before = f.fake.application.song.tracks.length;
    expect((await f.run()).ok).toBe(true);
    expect(f.fake.application.song.tracks.length).toBe(before + 1);
    expect(f.fake.application.song.tracks[before].name).toBe("Synthetic Vox");
    expect(f.fake.transactions).toEqual([
      { committed: true, rolledBack: false },
      { committed: true, rolledBack: false },
    ]);
    expect(outputs(f.bodies[1])[0].output).toContain(
      `track:${before}:Synthetic Vox`
    );
  });

  it("wire non-strict schema does not relax executor argument validation", async () => {
    const f = setup([
      completedResponse([
        liveCall("malformed", "live_update_track", {
          track: "track:0:Drums",
          mute: "yes",
        }),
      ]),
      completedResponse(),
    ]);
    const before = f.fake.application.song.tracks[0].mute;
    expect((await f.run()).ok).toBe(true);
    expect(f.fake.application.song.tracks[0].mute).toBe(before);
    expect(f.fake.transactions).toEqual([]);
    expect(outputs(f.bodies[1])[0].call_id).toBe("malformed");
    expect(errorContent(outputs(f.bodies[1])[0])).toContain("mute");
  });

  it("even completed item fragments and displayed text cannot execute before a completed terminal; failed stream executes nothing", async () => {
    const call = liveCall("candidate", "live_update_track", {
      track: "track:0:Drums",
      mute: true,
    });
    const waiting = stalled(delta("Synthetic streaming") + callFragments(call));
    const f = setup([waiting.response]);
    const before = f.fake.application.song.tracks[0].mute;
    const task = f.run();
    await waiting.readStarted;
    expect(f.read).not.toHaveBeenCalled();
    expect(f.flush).not.toHaveBeenCalled();
    expect(f.fake.transactions).toEqual([]);
    expect(waiting.completeLate(unsuccessful("response.failed"))).toBe(true);
    expect(await task).toMatchObject({ ok: false });
    expect(f.fake.application.song.tracks[0].mute).toBe(before);
    expect(f.read).not.toHaveBeenCalled();
    expect(f.flush).not.toHaveBeenCalled();
    expect(f.requests).toHaveLength(1);
    expect(f.sink.assistantDone).not.toHaveBeenCalled();
  });

  it("never executes any call if the terminal contains one valid call and another unknown or duplicate call", async () => {
    for (const invalid of [
      liveCall("bad", "not_a_registered_live_tool"),
      liveCall("valid", "live_get_project"),
    ]) {
      const f = setup([
        completedResponse([
          liveCall("valid", "live_update_track", {
            track: "track:0:Drums",
            mute: true,
          }),
          invalid,
        ]),
      ]);
      expect(await f.run()).toMatchObject({ ok: false });
      expect(f.read).not.toHaveBeenCalled();
      expect(f.flush).not.toHaveBeenCalled();
      expect(f.fake.transactions).toEqual([]);
      expect(f.requests).toHaveLength(1);
    }
  });

  it("a delayed valid terminal is the first point at which a mutation becomes executable", async () => {
    const call = liveCall("rename", "live_update_track", {
      track: "track:0:Drums",
      name: "After terminal",
    });
    const waiting = stalled(callFragments(call));
    const f = setup([waiting.response, completedResponse()]);
    const task = f.run();
    await waiting.readStarted;
    expect(f.fake.application.song.tracks[0].name).toBe("Drums");
    expect(f.flush).not.toHaveBeenCalled();
    expect(waiting.completeLate(terminal([call]))).toBe(true);
    expect(await task).toMatchObject({ ok: true, text: FINAL });
    expect(f.flush).toHaveBeenCalledTimes(1);
    expect(f.fake.application.song.tracks[0].name).toBe("After terminal");
    expect(f.requests).toHaveLength(2);
  });

  it("credential loss between terminal validation and canonical append does not execute tools or escape the loop's structured failure contract", async () => {
    const f = setup([
      completedResponse([
        liveCall("rename", "live_update_track", {
          track: "track:0:Drums",
          name: "Must not apply",
        }),
      ]),
    ]);
    // The selected-account accessor changes precisely at the completed-but-
    // uncommitted boundary, before appendAssistant and any local dispatch.
    f.credential.mockImplementation(() =>
      f.provider.status().state === "completed_pending_append"
        ? undefined
        : f.selected
    );
    const outcome = await f
      .run()
      .catch((error: unknown) => ({ rejected: String(error) }));
    expect(f.read).not.toHaveBeenCalled();
    expect(f.flush).not.toHaveBeenCalled();
    expect(f.fake.transactions).toEqual([]);
    expect(f.fake.application.song.tracks[0].name).toBe("Drums");
    expect(f.requests).toHaveLength(1);
    expect(outcome).toHaveProperty("ok", false);
    expect(outcome).toHaveProperty("err.error");
  });

  it("a bounded history rejection after a committed mutation returns a sanitized failure without repeating the local action", async () => {
    const changedName = `${PRIVATE}-completed-name`;
    const call = liveCall(`${PRIVATE}-call`, "live_update_track", {
      track: "track:0:Drums",
      name: changedName,
    });
    const f = setup([completedResponse([call])]);
    // The real B1 history can hold the user, snapshot, and terminal call, but
    // has no remaining item slot for the real executor's result.
    const provider = new OpenAiResponsesProvider(
      { ...f.options, historyLimits: { maxItems: 3 } },
      {
        fetch: f.fetch,
        AbortController,
        clock: f.clock,
        loadCredential: f.credential,
      }
    );
    provider.appendUserText(USER);
    const run = () =>
      runProviderLoop({
        provider,
        runtime: f.runtime,
        events: f.sink,
        snapshot: SNAPSHOT,
      });

    const outcome = await run();
    expect(outcome).toMatchObject({
      ok: false,
      err: { error: "stream_error" },
    });
    if (outcome.ok)
      throw new Error("Expected the bounded result append to fail");
    expect(outcome.err.detail).toContain(
      "local actions may already have completed"
    );
    expect(outcome.err.hint).toContain("do not replay");
    expect(f.sink.error).toHaveBeenCalledExactlyOnceWith(outcome.err.detail);
    for (const secret of [
      PRIVATE,
      BEARER,
      ACCOUNT,
      CONVERSATION,
      USER,
      SNAPSHOT,
      "history_limit",
    ])
      expect(JSON.stringify(outcome)).not.toContain(secret);
    expect(f.sink.assistantDone).not.toHaveBeenCalled();
    expect(
      f.sink.toolActivity.mock.calls.map(([tool, , status]) => [tool, status])
    ).toEqual([
      ["live_update_track", "started"],
      ["live_update_track", "ok"],
    ]);
    expect(f.fake.application.song.tracks[0].name).toBe(changedName);
    expect(f.fake.transactions).toEqual([
      { committed: true, rolledBack: false },
    ]);
    expect(f.flush).toHaveBeenCalledTimes(1);
    expect(f.read).not.toHaveBeenCalled();
    expect(f.requests).toHaveLength(1);
    expect(provider.status()).toMatchObject({
      state: "awaiting_results",
      items: 3,
      expectedResults: 1,
      requestReady: false,
    });

    // Even a subsequent loop invocation against this unresolved history cannot
    // dispatch or re-run the already committed action.
    expect(await run()).toMatchObject({ ok: false });
    expect(f.requests).toHaveLength(1);
    expect(f.flush).toHaveBeenCalledTimes(1);
    expect(f.fake.transactions).toEqual([
      { committed: true, rolledBack: false },
    ]);
    expect(f.fake.application.song.tracks[0].name).toBe(changedName);
    expect(provider.status()).toMatchObject({
      state: "awaiting_results",
      items: 3,
      expectedResults: 1,
      requestReady: false,
    });
  });
});
