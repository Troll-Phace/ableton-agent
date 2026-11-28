import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearPairingKeys,
  copySyntheticDescriptor,
  createFrameProof,
  createPairingProof,
  createSyntheticDescriptor,
  derivePairingKeys,
  pairingTranscript,
  randomPairingBytes,
  randomPairingChallenge,
  SYNTHETIC_COMPANION_LIMITS,
  verifyFrameProof,
  verifyPairingProof,
} from "../src/companion/channel/pairing.js";
import {
  channelEnvelope,
  COMPANION_CHANNEL_LIMITS,
  type ChannelClientBody,
  type ChannelServerBody,
} from "../src/shared/companion-channel.js";
import { TOOL_DEFINITIONS } from "../src/shared/tools.js";
import type { CompletedTurn } from "../src/shared/provider.js";
import {
  call,
  completion,
  makeMemoryEndpoints,
  makeScript,
  openFixture,
  SELECTION,
  SNAPSHOT,
  startFixture,
} from "./fixtures/companion-channel.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) await close();
});
const tools = () => structuredClone([...TOOL_DEFINITIONS]);

async function setup(...replies: Parameters<typeof makeScript>) {
  const script = makeScript(...replies);
  const server = await startFixture(script, cleanup);
  const pair = await openFixture(server, cleanup);
  return { ...script, ...pair, server };
}

describe("C2 ordinary synthetic loopback channel", () => {
  it("pairs only on explicit connection, completes text and final ACK, then closes once", async () => {
    const turn = completion();
    const script = makeScript((input) => {
      input.onDelta?.("Synthetic ");
      input.onDelta?.("turn");
      return turn;
    });
    const server = await startFixture(script, cleanup);
    expect(script.createProvider).not.toHaveBeenCalled();
    expect(server.descriptor.host).toBe("127.0.0.1");
    expect(server.descriptor.port).toBeGreaterThan(0);
    expect(Object.keys(server.descriptor)).not.toContain("capability");
    const pair = await openFixture(server, cleanup);
    expect(pair.channel.selection).toEqual(SELECTION);
    expect(script.createProvider).toHaveBeenCalledExactlyOnceWith(SELECTION);
    expect(server.descriptor.capability.every((byte) => byte === 0)).toBe(true);
    pair.proxy.appendUserText("Synthetic ordinary text");
    const delta = vi.fn();
    const result = await pair.proxy.runTurn({
      tools: tools(),
      snapshot: SNAPSHOT,
      onDelta: delta,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected completion");
    expect(result.turn.blocks).toEqual(turn.blocks);
    expect(result.turn.continuation).toEqual({
      type: "opaque",
      provider: "companion_channel",
      value: {},
    });
    expect(delta.mock.calls).toEqual([["Synthetic "], ["turn"]]);
    pair.proxy.appendAssistant(result.turn);
    await pair.proxy.flush();
    expect(script.provider.appendAssistant.mock.calls[0][0]).toBe(turn);
    expect(script.provider.runTurn.mock.calls[0][0]).toMatchObject({
      model: SELECTION.model,
      snapshot: SNAPSHOT,
      tools: tools(),
    });
    expect(pair.outgoing).toEqual([
      "open",
      "append_user_text",
      "run_turn",
      "commit_assistant",
    ]);
    expect(pair.incoming).toEqual([
      "ack",
      "ack",
      "delta",
      "delta",
      "completed",
      "ack",
    ]);
    expect(await pair.proxy.remoteStatus()).toBe("ready");
    await pair.proxy.close();
    await pair.channel.close();
    await server.close();
    expect(pair.proxy.status().state).toBe("closed");
    expect(script.provider.dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects expired synthetic pairing metadata before opening any listener or socket", () => {
    const capability = randomPairingBytes();
    const descriptor = createSyntheticDescriptor(
      SELECTION,
      12345,
      Date.now() - 1,
      capability,
    );
    try {
      expect(Object.keys(descriptor)).not.toContain("capability");
      expect(() => copySyntheticDescriptor(descriptor)).toThrow("timeout");
    } finally {
      descriptor.capability.fill(0);
      capability.fill(0);
    }
  });

  it("enforces the selected model and snapshot bounds before dispatch", async () => {
    for (const extra of [
      { model: "different-synthetic-model" },
      { snapshot: "x".repeat(COMPANION_CHANNEL_LIMITS.snapshotChars + 1) },
    ]) {
      const f = await setup(completion());
      f.proxy.appendUserText("Synthetic request");
      expect(await f.proxy.runTurn({ tools: tools(), ...extra })).toMatchObject(
        { ok: false },
      );
      expect(f.provider.runTurn).not.toHaveBeenCalled();
      expect(f.proxy.status().state).toBe("invalid");
    }
  });

  it("preserves ordered results across a real paired transport", async () => {
    const first = completion(
      call("first", "live_get_project"),
      call("second", "live_get_track", { track: "track:0:Drums" }),
    );
    const f = await setup(first, completion());
    f.proxy.appendUserText("Synthetic reads");
    const result = await f.proxy.runTurn({ tools: tools() });
    if (!result.ok) throw new Error("Expected first completion");
    f.proxy.appendAssistant(result.turn);
    const results = [
      { toolUseId: "first", content: "one" },
      { toolUseId: "second", content: "two", isError: true },
    ];
    f.proxy.appendToolResults(results);
    results[0].content = "local change after staging";
    const next = await f.proxy.runTurn({ tools: tools() });
    expect(next.ok).toBe(true);
    if (!next.ok) throw new Error("Expected final completion");
    f.proxy.appendAssistant(next.turn);
    await f.proxy.flush();
    expect(f.provider.appendToolResults).toHaveBeenCalledExactlyOnceWith([
      { toolUseId: "first", content: "one" },
      { toolUseId: "second", content: "two", isError: true },
    ]);
    expect(f.outgoing).toEqual([
      "open",
      "append_user_text",
      "run_turn",
      "commit_assistant",
      "append_tool_results",
      "run_turn",
      "commit_assistant",
    ]);
    expect(f.provider.runTurn).toHaveBeenCalledTimes(2);
  });

  it("cancels a pending turn, suppresses late completion, and never replays", async () => {
    const entered = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<CompletedTurn>();
    const signal = new AbortController();
    const aborted = Promise.withResolvers<void>();
    const delta = vi.fn();
    const f = await setup((input) => {
      input.signal?.addEventListener("abort", () => aborted.resolve(), {
        once: true,
      });
      entered.resolve();
      return reply.promise;
    });
    f.proxy.appendUserText("Synthetic pending turn");
    const task = f.proxy.runTurn({
      tools: tools(),
      signal: signal.signal,
      onDelta: delta,
    });
    await entered.promise;
    signal.abort();
    expect(await task).toMatchObject({ ok: false, err: { error: "aborted" } });
    await aborted.promise;
    reply.resolve(completion());
    expect(await f.proxy.runTurn({ tools: tools() })).toMatchObject({
      ok: false,
    });
    await f.server.close();
    expect(f.provider.runTurn).toHaveBeenCalledTimes(1);
    expect(f.provider.appendAssistant).not.toHaveBeenCalled();
    expect(delta).not.toHaveBeenCalled();
    expect(f.provider.dispose).toHaveBeenCalledTimes(1);
  });

  it("invalidates an already completed turn on cancellation before local commit", async () => {
    const signal = new AbortController();
    const f = await setup(completion());
    f.proxy.appendUserText("Synthetic completed but uncommitted turn");
    const result = await f.proxy.runTurn({
      tools: tools(),
      signal: signal.signal,
    });
    if (!result.ok) throw new Error("Expected completion");
    signal.abort();
    expect(() => f.proxy.appendAssistant(result.turn)).toThrow("aborted");
    expect(await f.proxy.runTurn({ tools: tools() })).toMatchObject({
      ok: false,
    });
    await f.server.close();
    expect(f.provider.runTurn).toHaveBeenCalledTimes(1);
    expect(f.provider.appendAssistant).not.toHaveBeenCalled();
    expect(f.provider.dispose).toHaveBeenCalledTimes(1);
  });

  it("disconnect rejects pending work and a new pairing starts a new provider", async () => {
    const entered = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<CompletedTurn>();
    const f = await setup(() => {
      entered.resolve();
      return reply.promise;
    });
    f.proxy.appendUserText("Synthetic disconnect");
    const task = f.proxy.runTurn({ tools: tools() });
    await entered.promise;
    await f.server.close();
    expect(await task).toMatchObject({ ok: false });
    reply.resolve(completion());
    expect(await f.proxy.runTurn({ tools: tools() })).toMatchObject({
      ok: false,
    });
    expect(f.provider.runTurn).toHaveBeenCalledTimes(1);
    expect(f.provider.dispose).toHaveBeenCalledTimes(1);
    const script = makeScript(completion());
    const fresh = {
      ...SELECTION,
      pairSessionId: "fresh_pair",
      epoch: 2,
      conversationId: "fresh_conversation",
    };
    const server = await startFixture(script, cleanup, fresh);
    const peer = await openFixture(server, cleanup);
    expect(peer.channel.selection).toEqual(fresh);
    peer.proxy.appendUserText("Fresh synthetic conversation");
    const result = await peer.proxy.runTurn({ tools: tools() });
    expect(result.ok).toBe(true);
    expect(script.provider.appendUserText).toHaveBeenCalledExactlyOnceWith(
      "Fresh synthetic conversation",
    );
    expect(script.provider.runTurn).toHaveBeenCalledTimes(1);
  });
});

describe("C2 in-memory pairing and bounded endpoint contracts", () => {
  it.each([
    { pairSessionId: "other_synthetic_pair" },
    { epoch: 2 },
    { conversationId: "other_synthetic_conversation" },
    { accountRevision: 2 },
    { model: "other-synthetic-model" },
  ])(
    "rejects mismatched expected synthetic selection %j in handshake verification",
    (changed) => {
      const capability = randomPairingBytes();
      const descriptor = createSyntheticDescriptor(
        SELECTION,
        12345,
        Date.now() + 10000,
        capability,
      );
      try {
        const clientChallenge = randomPairingChallenge();
        const serverChallenge = randomPairingChallenge();
        const transcript = pairingTranscript(
          descriptor,
          clientChallenge,
          serverChallenge,
        );
        const expected = pairingTranscript(
          { ...descriptor, selection: { ...SELECTION, ...changed } },
          clientChallenge,
          serverChallenge,
        );
        const proof = createPairingProof(
          capability,
          "server_hello",
          transcript,
        );
        expect(
          verifyPairingProof(capability, "server_hello", transcript, proof),
        ).toBe(true);
        expect(
          verifyPairingProof(capability, "server_hello", expected, proof),
        ).toBe(false);
      } finally {
        capability.fill(0);
        descriptor.capability.fill(0);
      }
    },
  );

  it("validates ordinary directional authentication and expected sequence metadata", () => {
    const capability = randomPairingBytes();
    const descriptor = createSyntheticDescriptor(
      SELECTION,
      12345,
      Date.now() + 10000,
      capability,
    );
    const transcript = pairingTranscript(
      descriptor,
      randomPairingChallenge(),
      randomPairingChallenge(),
    );
    const keys = derivePairingKeys(capability, transcript);
    try {
      const payload = JSON.stringify(clientMessage(1));
      const proof = createFrameProof(
        keys.clientToServer,
        "client_to_server",
        1,
        payload,
      );
      expect(
        verifyFrameProof(
          keys.clientToServer,
          "client_to_server",
          1,
          payload,
          proof,
        ),
      ).toBe(true);
      expect(
        verifyFrameProof(
          keys.clientToServer,
          "client_to_server",
          2,
          payload,
          proof,
        ),
      ).toBe(false);
      expect(
        verifyFrameProof(
          keys.serverToClient,
          "server_to_client",
          1,
          payload,
          proof,
        ),
      ).toBe(false);
    } finally {
      clearPairingKeys(keys);
      capability.fill(0);
      descriptor.capability.fill(0);
    }
  });

  it("delivers normal messages in order with independent directional counters", () => {
    const pair = makeMemoryEndpoints();
    const clientReceive = vi.fn();
    const serverReceive = vi.fn();
    const clientClosed = vi.fn();
    const serverClosed = vi.fn();
    try {
      pair.client.subscribe(clientReceive, clientClosed);
      pair.server.subscribe(serverReceive, serverClosed);
      pair.client.send(clientMessage(1));
      pair.client.send(clientMessage(2));
      pair.server.send(serverMessage(1));
      pair.client.send(clientMessage(3));
      pair.server.send(serverMessage(2));
      expect(pair.clientSocket.counters).toEqual([1, 2, 3]);
      expect(pair.serverSocket.counters).toEqual([1, 2]);
      expect(serverReceive.mock.calls).toEqual([
        [clientMessage(1)],
        [clientMessage(2)],
        [clientMessage(3)],
      ]);
      expect(clientReceive.mock.calls).toEqual([
        [serverMessage(1)],
        [serverMessage(2)],
      ]);
    } finally {
      pair.close();
    }
    expect(clientClosed).toHaveBeenCalledTimes(1);
    expect(serverClosed).toHaveBeenCalledTimes(1);
    expect(pair.keysCleared()).toBe(true);
  });

  it("closes before receiver delivery on a gap in ordinary in-memory message sequencing", () => {
    const pair = makeMemoryEndpoints({ dropFirstDelivery: true });
    const serverReceive = vi.fn();
    const clientClosed = vi.fn();
    const serverClosed = vi.fn();
    try {
      pair.client.subscribe(vi.fn(), clientClosed);
      pair.server.subscribe(serverReceive, serverClosed);
      pair.client.send(clientMessage(1));
      expect(serverReceive).not.toHaveBeenCalled();
      expect(serverClosed).not.toHaveBeenCalled();
      pair.client.send(clientMessage(2));
      expect(pair.clientSocket.counters).toEqual([1, 2]);
      expect(serverReceive).not.toHaveBeenCalled();
      expect(serverClosed).toHaveBeenCalledTimes(1);
      expect(clientClosed).toHaveBeenCalledTimes(1);
      expect(pair.keysCleared()).toBe(true);
      expect(() => pair.client.send(clientMessage(3))).toThrow("disconnected");
      expect(pair.clientSocket.counters).toEqual([1, 2]);
    } finally {
      pair.close();
    }
  });

  it("bounds ordinary pending writes when callbacks are stalled", () => {
    vi.useFakeTimers();
    const pair = makeMemoryEndpoints({ holdWrites: true });
    const disconnected = vi.fn();
    try {
      pair.client.subscribe(vi.fn(), disconnected);
      pair.server.subscribe(vi.fn(), vi.fn());
      for (let i = 1; i <= SYNTHETIC_COMPANION_LIMITS.pendingFrames; i++)
        pair.client.send(clientMessage(i));
      expect(pair.clientSocket.counters).toHaveLength(
        SYNTHETIC_COMPANION_LIMITS.pendingFrames,
      );
      expect(() =>
        pair.client.send(
          clientMessage(SYNTHETIC_COMPANION_LIMITS.pendingFrames + 1),
        ),
      ).toThrow("limit_exceeded");
      expect(pair.clientSocket.counters).toHaveLength(
        SYNTHETIC_COMPANION_LIMITS.pendingFrames,
      );
      expect(disconnected).toHaveBeenCalledTimes(1);
      expect(pair.keysCleared()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      pair.close();
    }
  });

  it("rejects ordinary writes when the local socket reports a full byte buffer", () => {
    vi.useFakeTimers();
    const pair = makeMemoryEndpoints();
    const disconnected = vi.fn();
    try {
      pair.client.subscribe(vi.fn(), disconnected);
      pair.server.subscribe(vi.fn(), vi.fn());
      pair.clientSocket.bufferedAmount =
        SYNTHETIC_COMPANION_LIMITS.pendingBytes;
      expect(() => pair.client.send(clientMessage(1))).toThrow(
        "limit_exceeded",
      );
      expect(pair.clientSocket.counters).toEqual([]);
      expect(disconnected).toHaveBeenCalledTimes(1);
      expect(pair.keysCleared()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      pair.close();
    }
  });

  it("terminates an unresponsive write and shutdown at their documented deadlines", async () => {
    vi.useFakeTimers();
    const pair = makeMemoryEndpoints({ holdWrites: true, hangClose: true });
    const disconnected = vi.fn();
    try {
      pair.client.subscribe(vi.fn(), disconnected);
      pair.server.subscribe(vi.fn(), vi.fn());
      pair.client.send(clientMessage(1));
      await vi.advanceTimersByTimeAsync(SYNTHETIC_COMPANION_LIMITS.sendMs - 1);
      expect(disconnected).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(disconnected).toHaveBeenCalledTimes(1);
      expect(pair.clientSocket.closeCount).toBe(1);
      expect(pair.clientSocket.terminateCount).toBe(0);
      await vi.advanceTimersByTimeAsync(SYNTHETIC_COMPANION_LIMITS.shutdownMs);
      expect(pair.clientSocket.terminateCount).toBe(1);
      expect(pair.keysCleared()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      pair.close();
    }
  });
});

function clientMessage(sequence: number) {
  return channelEnvelope<ChannelClientBody>(
    SELECTION,
    "ordinary_" + String(sequence),
    sequence,
    { type: "status" },
  );
}

function serverMessage(sequence: number) {
  return channelEnvelope<ChannelServerBody>(
    SELECTION,
    "ordinary_" + String(sequence),
    sequence,
    { type: "status", state: "ready" },
  );
}

describe("C2 listener expiry and fixture lifetime", () => {
  it("clears an unused fixture on the capability deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const script = makeScript(completion());
    const server = await startFixture(script, cleanup);
    await vi.advanceTimersByTimeAsync(
      SYNTHETIC_COMPANION_LIMITS.capabilityMs - 1,
    );
    expect(server.descriptor.capability.some((byte) => byte !== 0)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.descriptor.capability.every((byte) => byte === 0)).toBe(true);
    expect(script.createProvider).not.toHaveBeenCalled();
    await server.close();
  });

  it("cleans up a normally paired fixture at the lifetime deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const f = await setup(completion());
    await vi.advanceTimersByTimeAsync(
      SYNTHETIC_COMPANION_LIMITS.lifetimeMs - 1,
    );
    expect(f.proxy.status().state).toBe("ready");
    expect(f.provider.dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.provider.dispose).toHaveBeenCalledTimes(1);
    expect(f.proxy.status().state).toBe("invalid");
    await vi.advanceTimersByTimeAsync(SYNTHETIC_COMPANION_LIMITS.shutdownMs);
    await f.server.close();
    expect(f.provider.runTurn).not.toHaveBeenCalled();
  });
});
