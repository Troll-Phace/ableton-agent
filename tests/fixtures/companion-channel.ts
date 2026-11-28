import { EventEmitter } from "node:events";

import WebSocket from "ws";
import { vi } from "vitest";

import {
  createSyntheticDescriptor,
  derivePairingKeys,
  pairingTranscript,
  randomPairingBytes,
  randomPairingChallenge,
} from "../../src/companion/channel/pairing.js";
import { AuthenticatedCompanionEndpoint } from "../../src/companion/channel/socket-endpoint.js";
import { startSyntheticCompanionServer } from "../../src/companion/channel/server.js";
import type { CompanionSessionProvider } from "../../src/companion/channel/session.js";
import { connectSyntheticCompanionChannel } from "../../src/extension/providers/companion-channel-client.js";
import { CompanionProvider } from "../../src/extension/providers/companion-provider.js";
import {
  decodeServerMessage,
  type ChannelAckOperation,
  type ChannelSelection,
  type CompanionChannelEndpoint,
} from "../../src/shared/companion-channel.js";
import type {
  CompletedTurn,
  CompletedTurnBlock,
  ProviderTurnInput,
  ProviderTurnResult,
  ToolResultPayload,
} from "../../src/shared/provider.js";

export const SELECTION: ChannelSelection = {
  pairSessionId: "synthetic_pair",
  epoch: 1,
  conversationId: "synthetic_conversation",
  accountRevision: 1,
  model: "synthetic-model",
};
export const SNAPSHOT = '{"fixture":true}';
export const FINAL = "Synthetic turn complete";

/** A fully synthetic completion with server-owned opaque continuation. */
export function completion(...blocks: CompletedTurnBlock[]): CompletedTurn {
  return {
    stopReason: blocks.some((block) => block.type === "tool_call")
      ? "tool_use"
      : "end_turn",
    blocks: blocks.length ? blocks : [{ type: "text", text: FINAL }],
    continuation: {
      type: "opaque",
      provider: "synthetic_fixture",
      value: { fixture: "server-only continuation" },
    },
  };
}

/** A canonical registered music tool call for the fake Live context. */
export function call(
  id: string,
  name: string,
  input: unknown = {},
): CompletedTurnBlock {
  return { type: "tool_call", call: { id, name, input } };
}

type Reply =
  | CompletedTurn
  | ((input: ProviderTurnInput) => CompletedTurn | Promise<CompletedTurn>);

/** Create a scripted, offline provider and its invocation evidence. */
export function makeScript(...replies: Reply[]) {
  const provider = {
    appendUserText: vi.fn<(text: string) => void>(),
    appendAssistant: vi.fn<(turn: CompletedTurn) => void>(),
    appendToolResults: vi.fn<(results: ToolResultPayload[]) => void>(),
    runTurn: vi.fn<(input: ProviderTurnInput) => Promise<ProviderTurnResult>>(
      async (input) => {
        const reply = replies.shift();
        if (!reply) throw new Error("Unexpected synthetic provider request");
        const turn = typeof reply === "function" ? await reply(input) : reply;
        return { ok: true, turn };
      },
    ),
    dispose: vi.fn<() => void>(),
  } satisfies CompanionSessionProvider;
  const createProvider = vi.fn(() => provider);
  return { provider, createProvider };
}

/** Cleanup is registered before connection so failed pairing cannot leak a listener. */
export async function startFixture(
  script: ReturnType<typeof makeScript>,
  cleanup: (() => Promise<void>)[],
  selection = SELECTION,
) {
  const server = await startSyntheticCompanionServer({
    selection,
    createProvider: script.createProvider,
  });
  cleanup.push(() => server.close());
  return server;
}

/** Establish an ordinary paired channel. Optionally simulate a lost ACK at
 * the local consumer, after actual transport receipt; no raw frame injection. */
export async function openFixture(
  server: Awaited<ReturnType<typeof startFixture>>,
  cleanup: (() => Promise<void>)[],
  loseAck?: ChannelAckOperation,
) {
  const channel = await connectSyntheticCompanionChannel(server.descriptor);
  cleanup.push(() => channel.close());
  const incoming: string[] = [];
  const outgoing: string[] = [];
  const endpoint: CompanionChannelEndpoint = {
    send(message) {
      outgoing.push(message.body.type);
      channel.endpoint.send(message);
    },
    subscribe(receive, disconnected) {
      return channel.endpoint.subscribe((raw) => {
        const message = decodeServerMessage(raw);
        incoming.push(message.body.type);
        if (message.body.type === "ack" && message.body.operation === loseAck) {
          channel.endpoint.disconnect();
          return;
        }
        receive(raw);
      }, disconnected);
    },
    disconnect() {
      channel.endpoint.disconnect();
    },
  };
  const proxy = new CompanionProvider({
    selection: channel.selection,
    endpoint,
  });
  await proxy.open();
  return { channel, proxy, incoming, outgoing };
}

/** Event-only stand-in for a WebSocket. Delivers only normal endpoint-generated
 * frames to its paired in-memory peer, never opening a network connection. */
class MemorySocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly counters: number[] = [];
  closeCount = 0;
  terminateCount = 0;
  peer?: MemorySocket;

  constructor(
    private readonly options: {
      holdWrites?: boolean;
      hangClose?: boolean;
      dropFirstDelivery?: boolean;
    } = {},
  ) {
    super();
  }

  send(data: string, _options: unknown, done: (error?: Error) => void): void {
    const frame = JSON.parse(data) as { counter: number };
    // Record only the public counter, never payload or proof bytes.
    this.counters.push(frame.counter);
    // Simulate ordinary delivery loss without constructing or modifying frames.
    if (!this.options.dropFirstDelivery || this.counters.length !== 1)
      this.peer?.emit("message", Buffer.from(data, "utf8"), false);
    if (!this.options.holdWrites) done();
  }

  close(): void {
    this.closeCount++;
    this.readyState = WebSocket.CLOSING;
    if (!this.options.hangClose) this.finish();
  }

  terminate(): void {
    this.terminateCount++;
    this.finish();
  }

  private finish(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
    this.peer?.finish();
  }

  asSocket(): WebSocket {
    // Narrow synthetic adapter for the subset of ws used by the endpoint.
    return this as unknown as WebSocket;
  }
}

/** Create two authenticated endpoints over ordinary event-only socket doubles.
 * All pairing inputs are generated locally and no listener is created. */
export function makeMemoryEndpoints(
  options: {
    holdWrites?: boolean;
    hangClose?: boolean;
    dropFirstDelivery?: boolean;
  } = {},
) {
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
  const clientKeys = derivePairingKeys(capability, transcript);
  const serverKeys = derivePairingKeys(capability, transcript);
  capability.fill(0);
  descriptor.capability.fill(0);
  const clientSocket = new MemorySocket(options);
  const serverSocket = new MemorySocket();
  clientSocket.peer = serverSocket;
  serverSocket.peer = clientSocket;
  const client = new AuthenticatedCompanionEndpoint(
    clientSocket.asSocket(),
    "client",
    clientKeys,
  );
  const server = new AuthenticatedCompanionEndpoint(
    serverSocket.asSocket(),
    "server",
    serverKeys,
  );
  return {
    client,
    server,
    clientSocket,
    serverSocket,
    keysCleared: () =>
      [clientKeys, serverKeys].every((keys) =>
        [keys.clientToServer, keys.serverToClient].every((key) =>
          key.every((byte) => byte === 0),
        ),
      ),
    close() {
      client.disconnect();
      server.disconnect();
    },
  };
}
