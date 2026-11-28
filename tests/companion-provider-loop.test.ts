import type { ApiVersion, ExtensionContext } from "@ableton-extensions/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runProviderLoop,
  type AgentEvents,
} from "../src/extension/agent-loop.js";
import { LiveToolRuntime } from "../src/extension/tool-registry.js";
import type { ChannelAckOperation } from "../src/shared/companion-channel.js";
import type { LocalToolResultPayload } from "../src/shared/provider.js";
import { makeFakeContext } from "./fixtures/fake-extension-context.js";
import {
  call,
  completion,
  FINAL,
  makeScript,
  openFixture,
  SNAPSHOT,
  startFixture,
} from "./fixtures/companion-channel.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup(
  replies: Parameters<typeof makeScript>,
  signal?: AbortSignal,
  loseAck?: ChannelAckOperation,
) {
  const script = makeScript(...replies);
  const server = await startFixture(script, cleanup);
  const pair = await openFixture(server, cleanup, loseAck);
  const fake = makeFakeContext();
  const runtime = new LiveToolRuntime(
    fake as unknown as ExtensionContext<ApiVersion>,
    undefined,
    signal,
  );
  const read = vi.spyOn(runtime, "executeRead");
  const flush = vi.spyOn(runtime, "flushMutations");
  const events = {
    assistantDelta: vi.fn<AgentEvents["assistantDelta"]>(),
    toolActivity: vi.fn<AgentEvents["toolActivity"]>(),
    assistantDone: vi.fn<AgentEvents["assistantDone"]>(),
    error: vi.fn<AgentEvents["error"]>(),
  };
  pair.proxy.appendUserText("Synthetic music request");
  const run = (
    requestConfirmation?: Parameters<
      typeof runProviderLoop
    >[0]["requestConfirmation"],
  ) =>
    runProviderLoop({
      provider: pair.proxy,
      runtime,
      events,
      snapshot: SNAPSHOT,
      signal,
      requestConfirmation,
    });
  return { ...script, ...pair, fake, runtime, read, flush, events, run };
}

describe("C2 paired channel through canonical fake-Live tool loop", () => {
  it("orders reads, batches writes, and delivers exact ordered results before next turn", async () => {
    const initial = completion(
      call("read1", "live_get_project"),
      call("mut1", "live_update_track", {
        track: "track:0:Drums",
        name: "Beats",
      }),
      call("read2", "live_get_track", { track: "track:99:Absent" }),
      call("mut2", "live_update_track", { track: "track:1:Bass", mute: true }),
    );
    const final = completion();
    const f = await setup([initial, final]);
    expect(await f.run()).toEqual({
      ok: true,
      stopReason: "end_turn",
      text: FINAL,
    });
    await f.proxy.flush();
    expect(f.read.mock.calls.map(([c]) => c.id)).toEqual(["read1", "read2"]);
    expect(f.flush).toHaveBeenCalledTimes(1);
    expect(f.flush.mock.calls[0][0].map((c) => c.id)).toEqual(["mut1", "mut2"]);
    expect(f.read.mock.invocationCallOrder[1]).toBeLessThan(
      f.flush.mock.invocationCallOrder[0],
    );
    expect(f.fake.application.song.tracks[0].name).toBe("Beats");
    expect(f.fake.application.song.tracks[1].mute).toBe(true);
    expect(f.fake.transactions).toEqual([
      { committed: true, rolledBack: false },
    ]);
    const reads = await Promise.all(
      f.read.mock.results.map(
        (r) => r.value as Promise<LocalToolResultPayload>,
      ),
    );
    const writes = await (f.flush.mock.results[0].value as Promise<
      LocalToolResultPayload[]
    >);
    expect(f.provider.appendToolResults).toHaveBeenCalledExactlyOnceWith([
      reads[0],
      writes[0],
      reads[1],
      writes[1],
    ]);
    expect(f.provider.runTurn).toHaveBeenCalledTimes(2);
    expect(
      f.provider.appendToolResults.mock.invocationCallOrder[0],
    ).toBeLessThan(f.provider.runTurn.mock.invocationCallOrder[1]);
    expect(f.provider.appendAssistant.mock.calls.map(([t]) => t)).toEqual([
      initial,
      final,
    ]);
    expect(f.provider.runTurn.mock.calls[1][0].snapshot).toBeUndefined();
    expect(f.events.assistantDone).toHaveBeenCalledExactlyOnceWith("end_turn");
  });

  it.each([true, false])(
    "destructive batch confirmation %s controls the entire transaction",
    async (approve) => {
      const f = await setup([
        completion(
          call("rename", "live_update_track", {
            track: "track:0:Drums",
            name: "Beats",
          }),
          call("delete", "live_delete", { target: "track:2:Keys" }),
        ),
        completion(),
      ]);
      const before = f.fake.application.song.tracks.map((t) => t.name);
      const confirm = vi.fn(() => Promise.resolve(approve));
      expect((await f.run(confirm)).ok).toBe(true);
      await f.proxy.flush();
      expect(confirm).toHaveBeenCalledTimes(1);
      const results = f.provider.appendToolResults.mock.calls[0][0];
      expect(results.map((r) => r.toolUseId)).toEqual(["rename", "delete"]);
      if (approve) {
        expect(f.fake.application.song.tracks.map((t) => t.name)).toEqual([
          "Beats",
          "Bass",
          "Dup",
          "Dup",
        ]);
        expect(f.fake.transactions).toEqual([
          { committed: true, rolledBack: false },
        ]);
      } else {
        expect(f.flush).not.toHaveBeenCalled();
        expect(f.fake.application.song.tracks.map((t) => t.name)).toEqual(
          before,
        );
        expect(f.fake.transactions).toEqual([]);
        for (const result of results) {
          expect(result.isError).toBe(true);
          expect(result.content).toContain("user_declined");
        }
      }
    },
  );

  it("cancellation during confirmation leaves no action or undo boundary", async () => {
    const abort = new AbortController();
    const f = await setup(
      [completion(call("delete", "live_delete", { target: "track:2:Keys" }))],
      abort.signal,
    );
    const before = f.fake.application.song.tracks.map((t) => t.name);
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
    expect(f.fake.application.song.tracks.map((t) => t.name)).toEqual(before);
    expect(f.provider.runTurn).toHaveBeenCalledTimes(1);
    expect(f.events.assistantDone).not.toHaveBeenCalled();
  });

  it("rolls back a failed fake SDK mutation batch without a committed undo step", async () => {
    const f = await setup([
      completion(
        call("mute", "live_update_track", {
          track: "track:0:Drums",
          mute: true,
        }),
        call("rename", "live_update_track", {
          track: "track:1:Bass",
          name: "Not applied",
        }),
      ),
      completion(),
    ]);
    const mute = f.fake.application.song.tracks[0].mute;
    f.fake.failNameSets("synthetic setter failure");
    expect((await f.run()).ok).toBe(true);
    await f.proxy.flush();
    expect(f.fake.application.song.tracks[0].mute).toBe(mute);
    expect(f.fake.application.song.tracks[1].name).toBe("Bass");
    expect(f.fake.transactions).toEqual([
      { committed: false, rolledBack: true },
    ]);
    expect(f.fake.committedCount).toBe(0);
    const results = f.provider.appendToolResults.mock.calls[0][0];
    expect(results.map((r) => r.toolUseId)).toEqual(["mute", "rename"]);
    for (const result of results) {
      expect(result.isError).toBe(true);
      expect(result.content).toContain("transaction rolled back");
    }
  });

  it("re-resolves a named reference on the next paired turn after fake reorder", async () => {
    const f = await setup([
      completion(call("read", "live_get_track", { track: "track:1:Bass" })),
      () => {
        f.fake.reorder("", "tracks", 1, 0);
        return completion(
          call("rename", "live_update_track", {
            track: "track:1:Bass",
            name: "Sub",
          }),
        );
      },
      completion(),
    ]);
    expect((await f.run()).ok).toBe(true);
    await f.proxy.flush();
    expect(
      f.fake.application.song.tracks.slice(0, 2).map((t) => t.name),
    ).toEqual(["Sub", "Drums"]);
    expect(f.provider.appendToolResults.mock.calls[1][0][0].content).toContain(
      "track:0:Bass",
    );
    expect(f.fake.committedCount).toBe(1);
  });

  it("uncertain result ACK retains completed local action and undo evidence without replay", async () => {
    const f = await setup(
      [
        completion(
          call("rename", "live_update_track", {
            track: "track:0:Drums",
            name: "Beats",
          }),
        ),
      ],
      undefined,
      "append_tool_results",
    );
    expect(await f.run()).toMatchObject({ ok: false });
    expect(f.fake.application.song.tracks[0].name).toBe("Beats");
    expect(f.fake.transactions).toEqual([
      { committed: true, rolledBack: false },
    ]);
    expect(f.provider.appendToolResults).toHaveBeenCalledTimes(1);
    expect(f.provider.appendToolResults.mock.calls[0][0][0].toolUseId).toBe(
      "rename",
    );
    expect(f.proxy.status().state).toBe("invalid");
    expect(await f.run()).toMatchObject({ ok: false });
    expect(f.provider.runTurn).toHaveBeenCalledTimes(1);
    expect(f.flush).toHaveBeenCalledTimes(1);
    expect(f.fake.committedCount).toBe(1);
    expect(f.events.assistantDone).not.toHaveBeenCalled();
  });
});
