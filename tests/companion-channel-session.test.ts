import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CompanionChannelSession,
  createInMemoryCompanionChannel,
} from "../src/companion/channel/session.js";
import { CompanionProvider } from "../src/extension/providers/companion-provider.js";
import {
  channelEnvelope,
  decodeServerMessage,
  type ChannelClientBody,
  type ChannelMessage,
  type ChannelServerMessage,
} from "../src/shared/companion-channel.js";
import type {
  CompletedTurn,
  ProviderTurnInput,
  ProviderTurnResult,
  ToolResultPayload,
} from "../src/shared/provider.js";
import { TOOL_DEFINITIONS } from "../src/shared/tools.js";

const selection = {
  pairSessionId: "pair_fixture",
  epoch: 1,
  conversationId: "conversation_fixture",
  accountRevision: 1,
  model: "fixture-model",
};
const tools = () => structuredClone([...TOOL_DEFINITIONS]);
const textTurn = (): CompletedTurn => ({
  stopReason: "end_turn",
  blocks: [{ type: "text", text: "completed" }],
  continuation: {
    type: "opaque",
    provider: "injected",
    value: { privateFixture: "not_on_wire" },
  },
});
const toolTurn = (): CompletedTurn => ({
  ...textTurn(),
  stopReason: "tool_use",
  blocks: [
    { type: "text", text: "reading" },
    {
      type: "tool_call",
      call: { id: "first", name: TOOL_DEFINITIONS[0].name, input: {} },
    },
    {
      type: "tool_call",
      call: { id: "second", name: TOOL_DEFINITIONS[1].name, input: {} },
    },
  ],
});
const results = () => [
  { toolUseId: "first", content: "first_result" },
  {
    toolUseId: "second",
    content: "second_result",
    isError: true,
    summary: "declined",
  },
];
const ok = (turn: CompletedTurn): ProviderTurnResult => ({ ok: true, turn });
function completed(result: ProviderTurnResult): CompletedTurn {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected a completed turn");
  return result.turn;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function makePair(
  dropAck?: "commit_assistant" | "append_tool_results" | "append_user_text",
  boundSelection = selection
) {
  const peer = createInMemoryCompanionChannel();
  const sent: ChannelMessage[] = [];
  const replies: ChannelServerMessage[] = [];
  const order: string[] = [];
  const held: ChannelServerMessage[] = [];
  const provider = {
    appendUserText: vi.fn((text: string) => {
      order.push("user:" + text);
    }),
    runTurn: vi.fn<(input: ProviderTurnInput) => Promise<ProviderTurnResult>>(
      () => {
        order.push("run");
        return Promise.resolve(ok(textTurn()));
      }
    ),
    appendAssistant: vi.fn<(turn: CompletedTurn) => void>(() => {
      order.push("assistant");
    }),
    appendToolResults: vi.fn<(results: ToolResultPayload[]) => void>(() => {
      order.push("results");
    }),
    dispose: vi.fn(),
  };
  const session = new CompanionChannelSession({
    selection: boundSelection,
    endpoint: {
      ...peer.server,
      send(message) {
        const reply = decodeServerMessage(message);
        replies.push(reply);
        if (
          dropAck &&
          reply.body.type === "ack" &&
          reply.body.operation === dropAck
        ) {
          held.push(reply);
          return;
        }
        peer.server.send(reply);
      },
    },
    provider,
    timeoutMs: vi.isFakeTimers() ? 100 : 30000,
  });
  const proxy = new CompanionProvider({
    selection: boundSelection,
    endpoint: {
      ...peer.client,
      send(message) {
        sent.push(message);
        peer.client.send(message);
      },
    },
    timeoutMs: vi.isFakeTimers() ? 100 : 30000,
  });
  cleanup.push(() => peer.client.disconnect());
  return { peer, sent, replies, order, held, provider, session, proxy };
}
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  vi.useRealTimers();
});
async function opened(dropAck?: Parameters<typeof makePair>[0]) {
  const pair = makePair(dropAck);
  await pair.proxy.open();
  return pair;
}
async function start(
  pair: ReturnType<typeof makePair>,
  input: Partial<ProviderTurnInput> = {}
) {
  pair.proxy.appendUserText("fixture_user");
  return pair.proxy.runTurn({ tools: tools(), ...input });
}
async function drainMicrotasks() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("C1 companion channel synthetic session and provider", () => {
  it("preserves exact canonical turn order, snapshot scope, and private continuation identity", async () => {
    const pair = await opened();
    const first = toolTurn();
    const final = textTurn();
    pair.provider.runTurn
      .mockResolvedValueOnce(ok(first))
      .mockResolvedValueOnce(ok(final));
    const local = completed(
      await start(pair, { snapshot: "fixture_snapshot" })
    );
    expect(local.blocks).toEqual(first.blocks);
    expect(local.continuation).toEqual({
      type: "opaque",
      provider: "companion_channel",
      value: {},
    });
    expect(Object.isFrozen(local)).toBe(true);
    expect(JSON.stringify(pair.replies)).not.toContain("not_on_wire");
    expect(pair.provider.runTurn.mock.calls[0][0]).toMatchObject({
      model: selection.model,
      snapshot: "fixture_snapshot",
      tools: tools(),
    });
    pair.proxy.appendAssistant(local);
    expect(pair.provider.appendAssistant.mock.calls[0][0]).toBe(first);
    pair.proxy.appendToolResults(results());
    const second = completed(await pair.proxy.runTurn({ tools: tools() }));
    pair.proxy.appendAssistant(second);
    await pair.proxy.flush();
    expect(pair.provider.appendAssistant.mock.calls[1][0]).toBe(final);
    expect(pair.provider.appendToolResults).toHaveBeenCalledExactlyOnceWith(
      results()
    );
    expect(pair.provider.runTurn.mock.calls[1][0].snapshot).toBeUndefined();
    expect(pair.sent.map((m) => m.body.type)).toEqual([
      "open",
      "append_user_text",
      "run_turn",
      "commit_assistant",
      "append_tool_results",
      "run_turn",
      "commit_assistant",
    ]);
    expect(pair.sent.map((m) => m.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(pair.replies.map((m) => m.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(pair.provider.runTurn).toHaveBeenCalledTimes(2);
    expect(await pair.proxy.remoteStatus()).toBe("ready");
    await pair.proxy.close();
    expect(pair.proxy.status().state).toBe("closed");
    expect(pair.session.status()).toBe("closed");
    expect(pair.provider.dispose).toHaveBeenCalledTimes(1);
  });

  it("waits for exact assistant ACK and detaches staged ordered results before dispatching next turn", async () => {
    const pair = await opened("commit_assistant");
    pair.provider.runTurn.mockResolvedValueOnce(ok(toolTurn()));
    const local = completed(await start(pair));
    pair.proxy.appendAssistant(local);
    const staged = results();
    pair.proxy.appendToolResults(staged);
    staged[0].content = "changed_after_append";
    const next = pair.proxy.runTurn({ tools: tools() });
    await drainMicrotasks();
    expect(pair.held).toHaveLength(1);
    expect(pair.provider.appendAssistant).toHaveBeenCalledTimes(1);
    expect(pair.provider.appendToolResults).not.toHaveBeenCalled();
    expect(pair.provider.runTurn).toHaveBeenCalledTimes(1);
    // Release only the assistant ACK; subsequent result ACK is synchronous.
    pair.peer.server.send(pair.held[0]);
    const final = completed(await next);
    expect(pair.provider.appendToolResults).toHaveBeenCalledExactlyOnceWith(
      results()
    );
    expect(pair.provider.runTurn).toHaveBeenCalledTimes(2);
    expect(final.blocks).toEqual(textTurn().blocks);
  });

  it.each(["commit_assistant", "append_tool_results"] as const)(
    "invalidates permanently on uncertain %s ACK without replay",
    async (operation) => {
      vi.useFakeTimers();
      const pair = await opened(operation);
      pair.provider.runTurn.mockResolvedValueOnce(ok(toolTurn()));
      const local = completed(await start(pair));
      pair.proxy.appendAssistant(local);
      pair.proxy.appendToolResults(results());
      const next = pair.proxy.runTurn({ tools: tools() });
      await drainMicrotasks();
      expect(pair.held).toHaveLength(1);
      expect(pair.provider.appendAssistant).toHaveBeenCalledTimes(1);
      expect(pair.provider.appendToolResults).toHaveBeenCalledTimes(
        operation === "append_tool_results" ? 1 : 0
      );
      await vi.advanceTimersByTimeAsync(100);
      expect(await next).toMatchObject({
        ok: false,
        err: { detail: "timeout" },
      });
      expect(pair.proxy.status()).toMatchObject({
        state: "invalid",
        queued: 0,
        pending: false,
      });
      expect(pair.session.status()).toBe("invalid");
      expect(await pair.proxy.runTurn({ tools: tools() })).toMatchObject({
        ok: false,
      });
      await expect(pair.proxy.flush()).rejects.toThrow("timeout");
      expect(pair.sent.filter((m) => m.body.type === operation)).toHaveLength(
        1
      );
      expect(pair.provider.runTurn).toHaveBeenCalledTimes(1);
      expect(pair.provider.dispose).toHaveBeenCalledTimes(1);
    }
  );

  it("requires a final assistant ACK even when no next turn is requested", async () => {
    vi.useFakeTimers();
    const pair = await opened("commit_assistant");
    const local = completed(await start(pair));
    pair.proxy.appendAssistant(local);
    const flushed = expect(pair.proxy.flush()).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(100);
    await flushed;
    expect(pair.provider.appendAssistant).toHaveBeenCalledTimes(1);
    expect(pair.proxy.status().state).toBe("invalid");
  });

  it("rejects an ACK for a different operation and does not forward queued results", async () => {
    const pair = await opened("commit_assistant");
    pair.provider.runTurn.mockResolvedValueOnce(ok(toolTurn()));
    const local = completed(await start(pair));
    pair.proxy.appendAssistant(local);
    pair.proxy.appendToolResults(results());
    const ack = pair.held[0];
    pair.peer.server.send({
      ...ack,
      body: { type: "ack", operation: "append_tool_results" },
    });
    expect(pair.proxy.status()).toMatchObject({
      state: "invalid",
      failure: "invalid_message",
    });
    expect(pair.provider.appendToolResults).not.toHaveBeenCalled();
    expect(pair.session.status()).toBe("invalid");
  });

  it.each([
    { accountRevision: 2 },
    { model: "another-model" },
    { conversationId: "another_conversation" },
    { pairSessionId: "another_pair" },
    { epoch: 2 },
  ])("invalidates on server-owned selection change %j", async (patch) => {
    const pair = await opened();
    pair.session.updateSelection({ ...selection });
    expect(pair.session.status()).toBe("ready");
    pair.session.updateSelection({ ...selection, ...patch });
    expect(pair.proxy.status().state).toBe("invalid");
    expect(pair.session.status()).toBe("invalid");
    expect(() => pair.proxy.appendUserText("new")).toThrow();
    expect(pair.provider.appendUserText).not.toHaveBeenCalled();
    expect(pair.provider.dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects a mismatched per-turn model before invoking the provider", async () => {
    const pair = await opened();
    expect(await start(pair, { model: "different-model" })).toMatchObject({
      ok: false,
    });
    expect(pair.provider.runTurn).not.toHaveBeenCalled();
    expect(pair.session.status()).toBe("invalid");
  });

  it("rejects copied and foreign local continuations", async () => {
    const pair = await opened();
    const another = await opened();
    const first = completed(await start(pair));
    const second = completed(await start(another));
    expect(() => pair.proxy.appendAssistant(structuredClone(first))).toThrow(
      "invalid_continuation"
    );
    expect(() => another.proxy.appendAssistant(first)).toThrow(
      "invalid_continuation"
    );
    expect(second).toEqual(first);
    expect(pair.provider.appendAssistant).not.toHaveBeenCalled();
    expect(another.provider.appendAssistant).not.toHaveBeenCalled();
  });

  it("consumes the exact local completion only once", async () => {
    const pair = await opened();
    const local = completed(await start(pair));
    pair.proxy.appendAssistant(local);
    await pair.proxy.flush();
    expect(() => pair.proxy.appendAssistant(local)).toThrow("invalid_state");
    expect(pair.provider.appendAssistant).toHaveBeenCalledTimes(1);
    expect(pair.session.status()).toBe("invalid");
  });

  it.each([
    () => results().reverse(),
    () => results().slice(0, 1),
    () => [results()[0], results()[0]],
    () => [...results(), { toolUseId: "extra", content: "extra" }],
  ])(
    "does not forward incomplete, repeated or misordered local results (%#)",
    async (makeResults) => {
      const pair = await opened();
      pair.provider.runTurn.mockResolvedValueOnce(ok(toolTurn()));
      pair.proxy.appendAssistant(completed(await start(pair)));
      expect(() => pair.proxy.appendToolResults(makeResults())).toThrow(
        "invalid_results"
      );
      expect(pair.provider.appendToolResults).not.toHaveBeenCalled();
      expect(pair.session.status()).toBe("invalid");
    }
  );

  it("cancels the pending generation, suppresses late display and completion, and never reuses pairing", async () => {
    const pair = await opened();
    const pending = deferred<ProviderTurnResult>();
    const entered = deferred<ProviderTurnInput>();
    pair.provider.runTurn.mockImplementationOnce((input) => {
      entered.resolve(input);
      input.onDelta?.("before_cancel");
      return pending.promise;
    });
    const controller = new AbortController();
    const display = vi.fn();
    const running = start(pair, {
      signal: controller.signal,
      onDelta: display,
    });
    const input = await entered.promise;
    expect(display).toHaveBeenCalledExactlyOnceWith("before_cancel");
    controller.abort();
    expect(await running).toMatchObject({
      ok: false,
      err: { error: "aborted" },
    });
    expect(input.signal?.aborted).toBe(true);
    input.onDelta?.("late_delta");
    pending.resolve(ok(toolTurn()));
    await drainMicrotasks();
    expect(display).toHaveBeenCalledTimes(1);
    expect(pair.replies.some((m) => m.body.type === "completed")).toBe(false);
    expect(pair.provider.appendAssistant).not.toHaveBeenCalled();
    expect(pair.sent.filter((m) => m.body.type === "cancel")).toHaveLength(1);
    expect(pair.session.status()).toBe("invalid");
    expect(
      () => new CompanionProvider({ selection, endpoint: pair.peer.client })
    ).toThrow();
    expect(pair.provider.dispose).toHaveBeenCalledTimes(1);
  });

  it("ignores a finished turn's abort signal after final commit ACK and keeps the conversation usable", async () => {
    const pair = await opened();
    const controller = new AbortController();
    pair.proxy.appendAssistant(
      completed(await start(pair, { signal: controller.signal }))
    );
    await pair.proxy.flush();
    expect(await pair.proxy.remoteStatus()).toBe("ready");
    controller.abort();
    expect(pair.proxy.status()).toMatchObject({
      state: "ready",
      pending: false,
      queued: 0,
    });
    expect(pair.session.status()).toBe("ready");
    expect(pair.sent.some((m) => m.body.type === "cancel")).toBe(false);
    expect(pair.provider.dispose).not.toHaveBeenCalled();
    pair.proxy.appendAssistant(completed(await start(pair)));
    await pair.proxy.flush();
    expect(pair.provider.runTurn).toHaveBeenCalledTimes(2);
    expect(pair.provider.appendAssistant).toHaveBeenCalledTimes(2);
    expect(await pair.proxy.remoteStatus()).toBe("ready");
  });

  it("invalidates if abort occurs before a final commit acknowledgment is received", async () => {
    const pair = await opened("commit_assistant");
    const controller = new AbortController();
    pair.proxy.appendAssistant(
      completed(await start(pair, { signal: controller.signal }))
    );
    expect(pair.held).toHaveLength(1);
    expect(pair.provider.appendAssistant).toHaveBeenCalledTimes(1);
    const flushed = expect(pair.proxy.flush()).rejects.toThrow("aborted");
    controller.abort();
    await flushed;
    expect(pair.proxy.status()).toMatchObject({
      state: "invalid",
      pending: false,
      queued: 0,
      failure: "aborted",
    });
    expect(pair.session.status()).toBe("invalid");
    expect(pair.provider.appendAssistant).toHaveBeenCalledTimes(1);
    expect(pair.provider.runTurn).toHaveBeenCalledTimes(1);
    expect(await pair.proxy.runTurn({ tools: tools() })).toMatchObject({
      ok: false,
    });
  });

  it("completes a fresh pairing after disconnect and rejects the former binding before provider dispatch", async () => {
    const old = await opened();
    old.proxy.appendAssistant(completed(await start(old)));
    await old.proxy.flush();
    old.peer.client.disconnect();
    expect(old.proxy.status().state).toBe("invalid");
    const freshSelection = {
      ...selection,
      pairSessionId: "fresh_pair",
      epoch: 2,
      conversationId: "fresh_conversation",
    };
    const fresh = makePair(undefined, freshSelection);
    await fresh.proxy.open();
    fresh.proxy.appendAssistant(completed(await start(fresh)));
    await fresh.proxy.flush();
    expect(await fresh.proxy.remoteStatus()).toBe("ready");
    expect(fresh.provider.runTurn).toHaveBeenCalledTimes(1);
    expect(fresh.provider.appendAssistant).toHaveBeenCalledTimes(1);
    expect(old.provider.runTurn).toHaveBeenCalledTimes(1);
    // A clean replacement fixture with the new selection must not accept
    // a message carrying the previous pairing's binding.
    const another = makePair(undefined, freshSelection);
    another.peer.client.send(
      channelEnvelope(selection, "old_request", 1, {
        type: "open",
        model: selection.model,
      })
    );
    expect(another.session.status()).toBe("invalid");
    expect(another.provider.appendUserText).not.toHaveBeenCalled();
    expect(another.provider.runTurn).not.toHaveBeenCalled();
    expect(another.provider.appendAssistant).not.toHaveBeenCalled();
  });

  it("disconnects a running request without replay or late completion", async () => {
    const pair = await opened();
    const pending = deferred<ProviderTurnResult>();
    const entered = deferred<ProviderTurnInput>();
    pair.provider.runTurn.mockImplementationOnce((input) => {
      entered.resolve(input);
      return pending.promise;
    });
    const display = vi.fn();
    const running = start(pair, { onDelta: display });
    const input = await entered.promise;
    pair.peer.server.disconnect();
    expect(await running).toMatchObject({
      ok: false,
      err: { detail: "disconnected" },
    });
    expect(input.signal?.aborted).toBe(true);
    input.onDelta?.("late");
    pending.resolve(ok(textTurn()));
    await drainMicrotasks();
    expect(display).not.toHaveBeenCalled();
    expect(pair.replies.some((m) => m.body.type === "completed")).toBe(false);
    expect(pair.provider.runTurn).toHaveBeenCalledTimes(1);
    expect(pair.provider.dispose).toHaveBeenCalledTimes(1);
  });

  it("exposes deltas only as display text and does not issue a completed call on provider failure", async () => {
    const pair = await opened();
    const display = vi.fn();
    pair.provider.runTurn.mockImplementationOnce((input) => {
      input.onDelta?.(JSON.stringify(toolTurn().blocks[1]));
      return Promise.resolve({
        ok: false,
        err: {
          error: "api_error",
          detail: "synthetic private detail",
          hint: "private hint",
        },
      });
    });
    const failed = await start(pair, { onDelta: display });
    expect(display).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify(toolTurn().blocks[1])
    );
    expect(failed).toMatchObject({
      ok: false,
      err: { detail: "provider_failed" },
    });
    expect(JSON.stringify(failed)).not.toContain("synthetic private detail");
    expect(JSON.stringify(pair.replies)).not.toContain("private hint");
    expect(pair.replies.some((m) => m.body.type === "completed")).toBe(false);
    expect(pair.provider.appendAssistant).not.toHaveBeenCalled();
    expect(pair.provider.appendToolResults).not.toHaveBeenCalled();
  });

  it("rejects an excessive number of pending flush waiters", async () => {
    const pair = await opened("append_user_text");
    pair.proxy.appendUserText("fixture");
    const waiters = Array.from({ length: 4 }, () =>
      expect(pair.proxy.flush()).rejects.toThrow("limit_exceeded")
    );
    await expect(pair.proxy.flush()).rejects.toThrow("limit_exceeded");
    await Promise.all(waiters);
    expect(pair.provider.appendUserText).toHaveBeenCalledTimes(1);
    expect(pair.provider.runTurn).not.toHaveBeenCalled();
    expect(pair.proxy.status()).toMatchObject({ state: "invalid", queued: 0 });
  });

  it("does not forward queued results when disconnected before the assistant acknowledgment", async () => {
    const pair = await opened("commit_assistant");
    pair.provider.runTurn.mockResolvedValueOnce(ok(toolTurn()));
    pair.proxy.appendAssistant(completed(await start(pair)));
    pair.proxy.appendToolResults(results());
    const next = pair.proxy.runTurn({ tools: tools() });
    await drainMicrotasks();
    pair.peer.server.disconnect();
    expect(await next).toMatchObject({
      ok: false,
      err: { detail: "disconnected" },
    });
    expect(pair.provider.appendAssistant).toHaveBeenCalledTimes(1);
    expect(pair.provider.appendToolResults).not.toHaveBeenCalled();
    expect(pair.provider.runTurn).toHaveBeenCalledTimes(1);
    expect(pair.proxy.status()).toMatchObject({ state: "invalid", queued: 0 });
  });

  it.each([
    { accountRevision: 2 },
    { conversationId: "other" },
    { pairSessionId: "other" },
    { epoch: 2 },
  ])("rejects an ACK from an unrelated synthetic session %j", async (patch) => {
    const pair = await opened("append_user_text");
    pair.proxy.appendUserText("fixture");
    expect(pair.held).toHaveLength(1);
    pair.peer.server.send({ ...pair.held[0], ...patch });
    expect(pair.proxy.status()).toMatchObject({
      state: "invalid",
      failure: "binding_mismatch",
    });
    expect(pair.provider.runTurn).not.toHaveBeenCalled();
    expect(pair.session.status()).toBe("invalid");
  });

  it("times out a pending provider call and suppresses later output", async () => {
    vi.useFakeTimers();
    const pair = await opened();
    const pending = deferred<ProviderTurnResult>();
    const entered = deferred<ProviderTurnInput>();
    pair.provider.runTurn.mockImplementationOnce((input) => {
      entered.resolve(input);
      return pending.promise;
    });
    const display = vi.fn();
    const turn = start(pair, { onDelta: display });
    const input = await entered.promise;
    await vi.advanceTimersByTimeAsync(100);
    expect(await turn).toMatchObject({ ok: false, err: { detail: "timeout" } });
    expect(input.signal?.aborted).toBe(true);
    input.onDelta?.("late");
    pending.resolve(ok(textTurn()));
    await drainMicrotasks();
    expect(display).not.toHaveBeenCalled();
    expect(pair.replies.some((m) => m.body.type === "completed")).toBe(false);
    expect(pair.provider.runTurn).toHaveBeenCalledTimes(1);
    expect(pair.provider.dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects a concurrent turn rather than issue another provider call", async () => {
    const pair = await opened();
    const entered = deferred<void>();
    const pending = deferred<ProviderTurnResult>();
    pair.provider.runTurn.mockImplementationOnce(() => {
      entered.resolve();
      return pending.promise;
    });
    const first = start(pair);
    await entered.promise;
    expect(await pair.proxy.runTurn({ tools: tools() })).toMatchObject({
      ok: false,
    });
    expect(await first).toMatchObject({ ok: false });
    pending.resolve(ok(textTurn()));
    await drainMicrotasks();
    expect(pair.provider.runTurn).toHaveBeenCalledTimes(1);
  });
});

describe("C1 companion server state checks with synthetic peer", () => {
  function rawPeer() {
    const peer = createInMemoryCompanionChannel();
    const messages: ChannelServerMessage[] = [];
    const provider = {
      appendUserText: vi.fn(),
      runTurn: vi.fn<(input: ProviderTurnInput) => Promise<ProviderTurnResult>>(
        () => Promise.resolve(ok(toolTurn()))
      ),
      appendAssistant: vi.fn(),
      appendToolResults: vi.fn(),
      dispose: vi.fn(),
    };
    const session = new CompanionChannelSession({
      selection,
      endpoint: peer.server,
      provider,
    });
    peer.client.subscribe(
      (value) => messages.push(decodeServerMessage(value)),
      () => undefined
    );
    cleanup.push(() => peer.client.disconnect());
    let next = 0;
    function send(
      body: ChannelClientBody,
      sequence?: number,
      requestId?: string
    ) {
      next++;
      peer.client.send(
        channelEnvelope(
          selection,
          requestId ?? "request_" + String(next),
          sequence ?? next,
          body
        )
      );
    }
    return { peer, messages, provider, session, send };
  }

  it.each([
    { pairSessionId: "other" },
    { epoch: 2 },
    { conversationId: "other" },
    { accountRevision: 2 },
  ])("rejects a nonmatching synthetic binding %j", (patch) => {
    const raw = rawPeer();
    raw.peer.client.send(
      channelEnvelope({ ...selection, ...patch }, "req", 1, {
        type: "open",
        model: selection.model,
      })
    );
    expect(raw.session.status()).toBe("invalid");
    expect(raw.provider.runTurn).not.toHaveBeenCalled();
    expect(raw.provider.dispose).toHaveBeenCalledTimes(1);
  });

  it("validates the selected model on open", () => {
    const raw = rawPeer();
    raw.send({ type: "open", model: "different-model" });
    expect(raw.session.status()).toBe("invalid");
    expect(raw.messages.at(-1)?.body).toEqual({
      type: "failure",
      code: "binding_mismatch",
    });
  });

  it.each([1, 3])("rejects nonmonotonic sequence %i", (sequence) => {
    const raw = rawPeer();
    raw.send({ type: "open", model: selection.model });
    raw.send({ type: "append_user_text", text: "fixture" }, sequence);
    expect(raw.messages.at(-1)?.body).toEqual({
      type: "failure",
      code: "sequence_mismatch",
    });
    expect(raw.provider.appendUserText).not.toHaveBeenCalled();
  });

  it("rejects repeated request identity even with the next sequence", () => {
    const raw = rawPeer();
    raw.send({ type: "open", model: selection.model });
    raw.send({ type: "append_user_text", text: "fixture" }, 2, "request_1");
    expect(raw.messages.at(-1)?.body).toEqual({
      type: "failure",
      code: "duplicate_request",
    });
    expect(raw.provider.appendUserText).not.toHaveBeenCalled();
  });

  it("does not commit a completion with a mismatched continuation reference", async () => {
    const raw = rawPeer();
    raw.send({ type: "open", model: selection.model });
    raw.send({ type: "append_user_text", text: "fixture" });
    raw.send({ type: "run_turn", tools: tools() });
    await drainMicrotasks();
    expect(raw.messages.at(-1)?.body.type).toBe("completed");
    raw.send({ type: "commit_assistant", continuationId: "unissued" });
    expect(raw.messages.at(-1)?.body).toEqual({
      type: "failure",
      code: "invalid_continuation",
    });
    expect(raw.provider.appendAssistant).not.toHaveBeenCalled();
  });

  it("rejects a cancellation targeting an already acknowledged final turn instead of accepting the cancellation", async () => {
    const raw = rawPeer();
    raw.provider.runTurn.mockResolvedValueOnce(ok(textTurn()));
    raw.send({ type: "open", model: selection.model });
    raw.send({ type: "append_user_text", text: "fixture" });
    raw.send({ type: "run_turn", tools: tools() });
    await drainMicrotasks();
    const response = raw.messages.at(-1);
    if (response?.body.type !== "completed")
      throw new Error("Expected completion");
    raw.send({
      type: "commit_assistant",
      continuationId: response.body.continuationId,
    });
    expect(raw.messages.at(-1)?.body).toEqual({
      type: "ack",
      operation: "commit_assistant",
    });
    expect(raw.session.status()).toBe("ready");
    raw.send({ type: "cancel", targetRequestId: response.requestId });
    // Rejection remains fail-closed under the channel contract; a stale
    // request must not be acknowledged as an active-generation cancellation.
    expect(raw.messages.at(-1)?.body).toEqual({
      type: "failure",
      code: "invalid_state",
    });
    expect(raw.provider.appendAssistant).toHaveBeenCalledTimes(1);
    expect(raw.provider.runTurn).toHaveBeenCalledTimes(1);
  });

  it("rejects a reordered result batch independently of the proxy", async () => {
    const raw = rawPeer();
    raw.send({ type: "open", model: selection.model });
    raw.send({ type: "append_user_text", text: "fixture" });
    raw.send({ type: "run_turn", tools: tools() });
    await drainMicrotasks();
    const body = raw.messages.at(-1)?.body;
    if (body?.type !== "completed") throw new Error("Expected completion");
    raw.send({ type: "commit_assistant", continuationId: body.continuationId });
    expect(raw.provider.appendAssistant).toHaveBeenCalledTimes(1);
    raw.send({ type: "append_tool_results", results: results().reverse() });
    expect(raw.messages.at(-1)?.body).toEqual({
      type: "failure",
      code: "invalid_results",
    });
    expect(raw.provider.appendToolResults).not.toHaveBeenCalled();
  });
});
