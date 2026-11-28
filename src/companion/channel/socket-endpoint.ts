import { isUtf8 } from "node:buffer";

import WebSocket, { type RawData } from "ws";

import {
  ChannelFault,
  COMPANION_CHANNEL_LIMITS,
  COMPANION_CHANNEL_VERSION,
  decodeClientMessage,
  decodeServerMessage,
  type ChannelMessage,
  type CompanionChannelEndpoint,
} from "../../shared/companion-channel.js";

import {
  clearPairingKeys,
  createFrameProof,
  parsePairingHandshake,
  SYNTHETIC_COMPANION_LIMITS,
  verifyFrameProof,
  type ChannelDirection,
  type PairingHandshake,
  type PairingKeys,
} from "./pairing.js";

const closures = new WeakMap<WebSocket, Promise<void>>();

function ignoreSocketError(): void {
  // Never propagate socket error text, which can contain network metadata.
}

/** Bounded graceful WebSocket shutdown, then forced termination. */
export function closeSyntheticSocket(
  socket: WebSocket,
  code = 1000
): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  const prior = closures.get(socket);
  if (prior) return prior;
  const close = new Promise<void>((resolve) => {
    socket.on("error", ignoreSocketError);
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.off("close", finish);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        socket.terminate();
      } catch {
        // The local state has already ceased accepting messages.
      } finally {
        finish();
      }
    }, SYNTHETIC_COMPANION_LIMITS.shutdownMs);
    socket.once("close", finish);
    try {
      if (socket.readyState === WebSocket.OPEN) socket.close(code);
      else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else if (socket.readyState === WebSocket.CLOSED) finish();
    } catch {
      try {
        socket.terminate();
      } catch {
        // Deadline still bounds cleanup.
      }
    }
  });
  closures.set(socket, close);
  return close;
}

/** Validate one ordinary UTF-8 text frame before parsing it. */
export function textFrame(
  raw: RawData,
  binary: boolean,
  maxBytes: number
): string {
  if (binary) throw new ChannelFault("invalid_message");
  let bytes: Buffer;
  if (Array.isArray(raw)) {
    const total = raw.reduce((size, chunk) => size + chunk.byteLength, 0);
    if (total > maxBytes) throw new ChannelFault("limit_exceeded");
    bytes = Buffer.concat(raw, total);
  } else if (Buffer.isBuffer(raw)) {
    bytes = raw;
  } else {
    if (raw.byteLength > maxBytes) throw new ChannelFault("limit_exceeded");
    bytes = Buffer.from(raw);
  }
  if (bytes.byteLength > maxBytes) throw new ChannelFault("limit_exceeded");
  if (!isUtf8(bytes)) throw new ChannelFault("invalid_message");
  return bytes.toString("utf8");
}

/** Deliver a fixed handshake message with a bounded write deadline. */
export function sendPairingMessage(
  socket: WebSocket,
  message: PairingHandshake,
  failed: () => void
): void {
  let settled = false;
  const settle = (ok: boolean): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.off("close", onClose);
    if (!ok) failed();
  };
  const onClose = (): void => settle(false);
  const timer = setTimeout(
    () => settle(false),
    SYNTHETIC_COMPANION_LIMITS.sendMs
  );
  socket.once("close", onClose);
  try {
    const serialized = JSON.stringify(message);
    parsePairingHandshake(serialized);
    if (socket.readyState !== WebSocket.OPEN)
      throw new ChannelFault("disconnected");
    socket.send(serialized, { binary: false, compress: false }, (error) =>
      settle(!error)
    );
  } catch {
    settle(false);
  }
}

interface WireFrame {
  type: "channel_frame";
  version: typeof COMPANION_CHANNEL_VERSION;
  counter: number;
  payload: string;
  proof: string;
}

function frameRecord(text: string): WireFrame {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ChannelFault("invalid_message");
    const frame = value as Record<string, unknown>;
    const keys = ["type", "version", "counter", "payload", "proof"];
    if (
      Object.keys(frame).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(frame, key)) ||
      frame.type !== "channel_frame" ||
      frame.version !== COMPANION_CHANNEL_VERSION ||
      typeof frame.counter !== "number" ||
      !Number.isSafeInteger(frame.counter) ||
      frame.counter < 1 ||
      frame.counter > COMPANION_CHANNEL_LIMITS.messages ||
      typeof frame.payload !== "string" ||
      typeof frame.proof !== "string" ||
      frame.proof.length !== 43 ||
      JSON.stringify(frame) !== text
    )
      throw new ChannelFault("invalid_message");
    if (
      Buffer.byteLength(frame.payload, "utf8") >
      SYNTHETIC_COMPANION_LIMITS.payloadBytes
    )
      throw new ChannelFault("limit_exceeded");
    return frame as unknown as WireFrame;
  } catch (error) {
    if (error instanceof ChannelFault) throw error;
    throw new ChannelFault("invalid_message");
  }
}

interface PendingWrite {
  bytes: number;
  timer: ReturnType<typeof setTimeout>;
}

/** An isolated authenticated transport for an already paired synthetic socket.
 * No reconnects, buffering of untrusted pre-subscription messages or RPC. */
export class AuthenticatedCompanionEndpoint implements CompanionChannelEndpoint {
  readonly #socket: WebSocket;
  readonly #role: "client" | "server";
  readonly #keys: PairingKeys;
  #incoming = 0;
  #outgoing = 0;
  #pending = new Map<number, PendingWrite>();
  #pendingBytes = 0;
  #closed = false;
  #subscribed = false;
  #receiver?: { receive(message: unknown): void; disconnected(): void };

  constructor(socket: WebSocket, role: "client" | "server", keys: PairingKeys) {
    this.#socket = socket;
    this.#role = role;
    this.#keys = keys;
    if (socket.readyState !== WebSocket.OPEN) {
      clearPairingKeys(keys);
      throw new ChannelFault("disconnected");
    }
    socket.on("message", this.onMessage);
    socket.on("error", this.onError);
    socket.on("close", this.onClose);
  }

  private get outgoingDirection(): ChannelDirection {
    return this.#role === "client" ? "client_to_server" : "server_to_client";
  }
  private get incomingDirection(): ChannelDirection {
    return this.#role === "client" ? "server_to_client" : "client_to_server";
  }
  private get outgoingKey(): Buffer {
    return this.#role === "client"
      ? this.#keys.clientToServer
      : this.#keys.serverToClient;
  }
  private get incomingKey(): Buffer {
    return this.#role === "client"
      ? this.#keys.serverToClient
      : this.#keys.clientToServer;
  }

  /** Subscribe once, before any application message can be accepted. */
  subscribe(
    receive: (message: unknown) => void,
    disconnected: () => void
  ): () => void {
    if (this.#closed) throw new ChannelFault("disconnected");
    if (this.#subscribed) throw new ChannelFault("invalid_state");
    this.#subscribed = true;
    this.#receiver = { receive, disconnected };
    return () => {
      this.#receiver = undefined;
    };
  }

  /** Validate and authenticate each exact serialized canonical C1 message
   * with a fresh directional counter. Bound queued writes and their deadlines. */
  send(message: ChannelMessage): void {
    try {
      if (this.#closed || this.#socket.readyState !== WebSocket.OPEN)
        throw new ChannelFault("disconnected");
      const next = this.#outgoing + 1;
      if (next > COMPANION_CHANNEL_LIMITS.messages)
        throw new ChannelFault("limit_exceeded");
      const canonical =
        this.#role === "client"
          ? decodeClientMessage(message)
          : decodeServerMessage(message);
      const payload = JSON.stringify(canonical);
      if (
        Buffer.byteLength(payload, "utf8") >
        SYNTHETIC_COMPANION_LIMITS.payloadBytes
      )
        throw new ChannelFault("limit_exceeded");
      const frame: WireFrame = {
        type: "channel_frame",
        version: COMPANION_CHANNEL_VERSION,
        counter: next,
        payload,
        proof: createFrameProof(
          this.outgoingKey,
          this.outgoingDirection,
          next,
          payload
        ),
      };
      const serialized = JSON.stringify(frame);
      const bytes = Buffer.byteLength(serialized, "utf8");
      if (
        bytes > SYNTHETIC_COMPANION_LIMITS.frameBytes ||
        this.#pending.size >= SYNTHETIC_COMPANION_LIMITS.pendingFrames ||
        this.#pendingBytes + bytes > SYNTHETIC_COMPANION_LIMITS.pendingBytes ||
        this.#socket.bufferedAmount + bytes >
          SYNTHETIC_COMPANION_LIMITS.pendingBytes
      )
        throw new ChannelFault("limit_exceeded");
      this.#outgoing = next;
      const timer = setTimeout(() => {
        if (this.#pending.has(next)) this.rejectSocket();
      }, SYNTHETIC_COMPANION_LIMITS.sendMs);
      this.#pending.set(next, { bytes, timer });
      this.#pendingBytes += bytes;
      this.#socket.send(
        serialized,
        { binary: false, compress: false },
        (error) => {
          const pending = this.#pending.get(next);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.#pending.delete(next);
          this.#pendingBytes -= pending.bytes;
          if (error) this.rejectSocket();
        }
      );
    } catch (error) {
      this.rejectSocket();
      throw error instanceof ChannelFault
        ? error
        : new ChannelFault("disconnected");
    }
  }

  private onMessage = (raw: RawData, binary: boolean): void => {
    if (this.#closed) return;
    try {
      const frame = frameRecord(
        textFrame(raw, binary, SYNTHETIC_COMPANION_LIMITS.frameBytes)
      );
      if (frame.counter !== this.#incoming + 1)
        throw new ChannelFault("sequence_mismatch");
      if (
        !verifyFrameProof(
          this.incomingKey,
          this.incomingDirection,
          frame.counter,
          frame.payload,
          frame.proof
        )
      )
        throw new ChannelFault("invalid_message");
      const rawMessage: unknown = JSON.parse(frame.payload);
      const message =
        this.#role === "client"
          ? decodeServerMessage(rawMessage)
          : decodeClientMessage(rawMessage);
      // Canonical serialization forbids duplicate JSON keys and lost values.
      if (JSON.stringify(message) !== frame.payload || !this.#receiver)
        throw new ChannelFault("invalid_message");
      this.#incoming = frame.counter;
      this.#receiver.receive(message);
    } catch {
      this.rejectSocket();
    }
  };

  private onError = (): void => {
    this.rejectSocket();
  };

  private onClose = (): void => {
    this.finalize();
  };

  private finalize(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.off("message", this.onMessage);
    this.#socket.off("error", this.onError);
    this.#socket.off("close", this.onClose);
    for (const pending of this.#pending.values()) clearTimeout(pending.timer);
    this.#pending.clear();
    this.#pendingBytes = 0;
    clearPairingKeys(this.#keys);
    const receiver = this.#receiver;
    this.#receiver = undefined;
    try {
      receiver?.disconnected();
    } catch {
      // Both state machines are no longer permitted to reuse this endpoint.
    }
  }

  private rejectSocket(): void {
    // Install the neutral error sink before releasing our endpoint handlers.
    void closeSyntheticSocket(this.#socket, 1008);
    this.finalize();
  }

  /** Terminal disconnection; no send retry or session restoration. */
  disconnect(): void {
    void closeSyntheticSocket(this.#socket);
    this.finalize();
  }
}
