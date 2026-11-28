import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";

import WebSocket, { WebSocketServer, type RawData } from "ws";

import {
  ChannelFault,
  COMPANION_CHANNEL_VERSION,
  validateChannelSelection,
  type ChannelSelection,
} from "../../shared/companion-channel.js";

import {
  createSyntheticDescriptor,
  createPairingProof,
  derivePairingKeys,
  pairingTranscript,
  parsePairingHandshake,
  randomPairingBytes,
  randomPairingChallenge,
  SYNTHETIC_COMPANION_HOST,
  SYNTHETIC_COMPANION_PATH,
  SYNTHETIC_COMPANION_LIMITS,
  verifyPairingProof,
  type SyntheticCompanionDescriptor,
} from "./pairing.js";
import {
  CompanionChannelSession,
  type CompanionSessionProvider,
} from "./session.js";
import {
  AuthenticatedCompanionEndpoint,
  closeSyntheticSocket,
  sendPairingMessage,
  textFrame,
} from "./socket-endpoint.js";

export interface SyntheticCompanionServerOptions {
  selection: ChannelSelection;
  /** Invoked only after mutual capability authentication, never for an
   * unauthenticated candidate. This lane accepts only injected providers. */
  createProvider: (selection: ChannelSelection) => CompanionSessionProvider;
}

export interface SyntheticCompanionServer {
  descriptor: SyntheticCompanionDescriptor;
  close(): Promise<void>;
}

const MAX_UPGRADE_HEADER_FIELDS = 32;

function rawHeaderCount(request: IncomingMessage, name: string): number {
  let count = 0;
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    if (request.rawHeaders[i].toLowerCase() === name) count++;
  }
  return count;
}

function localUpgrade(request: IncomingMessage, port: number): boolean {
  const count = request.rawHeaders.length / 2;
  // The parser retains the entire byte-bounded header set. Enforce our field
  // count before inspecting singleton headers or any forbidden header names.
  if (!Number.isInteger(count) || count > MAX_UPGRADE_HEADER_FIELDS)
    return false;
  return (
    request.method === "GET" &&
    request.url === SYNTHETIC_COMPANION_PATH &&
    request.socket.remoteAddress === SYNTHETIC_COMPANION_HOST &&
    request.socket.localAddress === SYNTHETIC_COMPANION_HOST &&
    request.headers.host === SYNTHETIC_COMPANION_HOST + ":" + String(port) &&
    [
      "host",
      "upgrade",
      "connection",
      "sec-websocket-key",
      "sec-websocket-version",
    ].every((name) => rawHeaderCount(request, name) === 1) &&
    rawHeaderCount(request, "origin") === 0 &&
    rawHeaderCount(request, "sec-websocket-protocol") === 0
  );
}

function ignoreError(): void {
  // Fixed rejection behavior only; never emit socket or request details.
}

/** Explicitly start one credential-free loopback fixture; no discovery,
 * external bind, launch, persistence, automatic reconnect or live provider. */
export async function startSyntheticCompanionServer(
  options: SyntheticCompanionServerOptions
): Promise<SyntheticCompanionServer> {
  const selection = validateChannelSelection(options?.selection);
  const createProvider = options?.createProvider;
  if (typeof createProvider !== "function")
    throw new ChannelFault("invalid_message");
  let capability: Buffer;
  try {
    capability = randomPairingBytes();
  } catch {
    throw new ChannelFault("disconnected");
  }
  let descriptor: SyntheticCompanionDescriptor | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
  let candidate: WebSocket | undefined;
  let candidateRaw: Socket | undefined;
  let consumed = false;
  let attempts = 0;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let session: CompanionChannelSession | undefined;
  const rawSockets = new Set<Socket>();

  const http = createServer(
    {
      maxHeaderSize: SYNTHETIC_COMPANION_LIMITS.handshakeBytes,
      headersTimeout: SYNTHETIC_COMPANION_LIMITS.handshakeMs,
      requestTimeout: SYNTHETIC_COMPANION_LIMITS.handshakeMs,
      keepAliveTimeout: SYNTHETIC_COMPANION_LIMITS.shutdownMs,
    },
    (_request, response) => {
      response.writeHead(404, { Connection: "close", "Content-Length": "0" });
      response.end();
    }
  );
  http.maxConnections = 1;
  // Keep the complete header set under the existing 4 KiB byte cap;
  // localUpgrade enforces the stricter field count without parser truncation.
  http.maxHeadersCount = 0;
  http.maxRequestsPerSocket = 1;
  http.setTimeout(SYNTHETIC_COMPANION_LIMITS.handshakeMs, (socket) =>
    socket.destroy()
  );
  http.on("connection", (socket) => {
    rawSockets.add(socket);
    socket.on("error", ignoreError);
    socket.once("close", () => rawSockets.delete(socket));
    if (closing) socket.destroy();
  });

  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: SYNTHETIC_COMPANION_LIMITS.frameBytes,
    skipUTF8Validation: false,
  });

  function dropCapability(): void {
    clearTimeout(expiryTimer);
    expiryTimer = undefined;
    capability.fill(0);
    descriptor?.capability.fill(0);
  }

  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closing = true;
    clearTimeout(lifetimeTimer);
    lifetimeTimer = undefined;
    dropCapability();
    let finished: () => void = () => undefined;
    closePromise = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const shutdown = async (): Promise<void> => {
      try {
        try {
          session?.disconnect();
        } catch {
          // Even a failed injected provider cleanup cannot keep the listener.
        }
        const socketClosed = candidate
          ? closeSyntheticSocket(candidate)
          : Promise.resolve();
        const listenerClosed = new Promise<void>((resolve) => {
          try {
            http.close(() => resolve());
          } catch {
            resolve();
          }
        });
        for (const socket of rawSockets) {
          if (socket !== candidateRaw) socket.destroy();
        }
        await socketClosed;
        // Force-close even an uncooperative raw peer at the shutdown bound.
        for (const socket of rawSockets) socket.destroy();
        await listenerClosed;
        await new Promise<void>((resolve) => {
          try {
            wss.close(() => resolve());
          } catch {
            resolve();
          }
        });
      } finally {
        finished();
      }
    };
    // The asynchronous cleanup owns no content-bearing errors.
    void shutdown().catch(() => finished());
    return closePromise;
  }

  function attach(
    socket: WebSocket,
    address: SyntheticCompanionDescriptor
  ): void {
    let phase: "hello" | "proof" | "paired" | "failed" = "hello";
    let transcript: string | undefined;

    const cleanup = (): void => {
      clearTimeout(deadline);
      socket.off("message", onMessage);
      socket.off("error", fail);
      transcript = undefined;
    };
    const fail = (): void => {
      if (phase === "failed") return;
      if (phase === "paired") {
        void close();
        return;
      }
      phase = "failed";
      // Install the bounded close/error sink before releasing listeners.
      void closeSyntheticSocket(socket, 1008);
      cleanup();
    };
    const onClose = (): void => {
      cleanup();
      if (candidate === socket) {
        candidate = undefined;
        candidateRaw = undefined;
      }
      if (consumed || attempts >= SYNTHETIC_COMPANION_LIMITS.attempts)
        void close();
    };
    const onMessage = (raw: RawData, binary: boolean): void => {
      try {
        if (
          closing ||
          Date.now() >= address.expiresAt ||
          phase === "paired" ||
          phase === "failed"
        )
          throw new ChannelFault("invalid_state");
        const message = parsePairingHandshake(
          textFrame(raw, binary, SYNTHETIC_COMPANION_LIMITS.handshakeBytes)
        );
        if (phase === "hello") {
          if (message.type !== "client_hello")
            throw new ChannelFault("invalid_message");
          const challenge = randomPairingChallenge();
          transcript = pairingTranscript(address, message.challenge, challenge);
          phase = "proof";
          sendPairingMessage(
            socket,
            {
              type: "server_hello",
              version: COMPANION_CHANNEL_VERSION,
              challenge,
              proof: createPairingProof(capability, "server_hello", transcript),
            },
            fail
          );
          return;
        }
        if (
          message.type !== "client_proof" ||
          !transcript ||
          !verifyPairingProof(
            capability,
            "client_proof",
            transcript,
            message.proof
          )
        )
          throw new ChannelFault("invalid_message");
        const readyProof = createPairingProof(
          capability,
          "server_ready",
          transcript
        );
        const keys = derivePairingKeys(capability, transcript);
        // Consume before any provider construction or confirmation can fail.
        consumed = true;
        phase = "paired";
        dropCapability();
        let endpoint: AuthenticatedCompanionEndpoint | undefined;
        let provider: CompanionSessionProvider | undefined;
        try {
          endpoint = new AuthenticatedCompanionEndpoint(socket, "server", keys);
          cleanup();
          provider = createProvider(selection);
          session = new CompanionChannelSession({
            selection,
            provider,
            endpoint,
          });
          sendPairingMessage(
            socket,
            {
              type: "server_ready",
              version: COMPANION_CHANNEL_VERSION,
              proof: readyProof,
            },
            fail
          );
        } catch {
          if (!session && provider) {
            try {
              provider.dispose();
            } catch {
              /* Terminal fixture. */
            }
          }
          endpoint?.disconnect();
          void close();
        }
      } catch {
        fail();
      }
    };
    const deadline = setTimeout(
      fail,
      Math.min(
        SYNTHETIC_COMPANION_LIMITS.handshakeMs,
        Math.max(1, address.expiresAt - Date.now())
      )
    );
    socket.once("close", onClose);
    socket.on("error", fail);
    socket.on("message", onMessage);
  }

  http.on("upgrade", (request, socket, head) => {
    const address = descriptor;
    if (
      closing ||
      consumed ||
      candidate ||
      !address ||
      Date.now() >= address.expiresAt ||
      attempts >= SYNTHETIC_COMPANION_LIMITS.attempts ||
      !localUpgrade(request, address.port)
    ) {
      socket.destroy();
      return;
    }
    attempts++;
    request.socket.once("close", () => {
      if (!candidate && attempts >= SYNTHETIC_COMPANION_LIMITS.attempts)
        void close();
    });
    try {
      wss.handleUpgrade(request, socket, head, (peer) => {
        candidate = peer;
        candidateRaw = request.socket;
        attach(peer, address);
      });
    } catch {
      socket.destroy();
    }
  });

  wss.on("error", () => {
    void close();
  });
  http.on("error", () => {
    if (descriptor) void close();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = (): void => reject(new ChannelFault("disconnected"));
      http.once("error", failed);
      http.listen(
        { host: SYNTHETIC_COMPANION_HOST, port: 0, exclusive: true },
        () => {
          http.off("error", failed);
          resolve();
        }
      );
    });
    const address = http.address();
    if (
      !address ||
      typeof address === "string" ||
      address.address !== SYNTHETIC_COMPANION_HOST
    )
      throw new ChannelFault("disconnected");
    descriptor = createSyntheticDescriptor(
      selection,
      address.port,
      Date.now() + SYNTHETIC_COMPANION_LIMITS.capabilityMs,
      capability
    );
    expiryTimer = setTimeout(() => {
      void close();
    }, SYNTHETIC_COMPANION_LIMITS.capabilityMs);
    lifetimeTimer = setTimeout(() => {
      void close();
    }, SYNTHETIC_COMPANION_LIMITS.lifetimeMs);
    return { descriptor, close };
  } catch {
    await close();
    throw new ChannelFault("disconnected");
  }
}
