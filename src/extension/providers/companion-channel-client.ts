import WebSocket, { type RawData } from "ws";

import {
  ChannelFault,
  COMPANION_CHANNEL_VERSION,
  type ChannelFaultCode,
  type ChannelSelection,
  type CompanionChannelEndpoint,
} from "../../shared/companion-channel.js";
import {
  copySyntheticDescriptor,
  createPairingProof,
  derivePairingKeys,
  pairingTranscript,
  parsePairingHandshake,
  randomPairingChallenge,
  SYNTHETIC_COMPANION_LIMITS,
  verifyPairingProof,
  type SyntheticCompanionDescriptor,
} from "../../companion/channel/pairing.js";
import {
  AuthenticatedCompanionEndpoint,
  closeSyntheticSocket,
  sendPairingMessage,
  textFrame,
} from "../../companion/channel/socket-endpoint.js";

export interface SyntheticCompanionChannel {
  selection: ChannelSelection;
  endpoint: CompanionChannelEndpoint;
  close(): Promise<void>;
}

/** Connect only to the explicitly passed ephemeral 127.0.0.1 fixture.
 * No discovery, proxy, redirect, secret-bearing URL or automatic reconnect.
 * The pairing proves possession of a synthetic capability, not identity of
 * any particular process, and does not supply transport confidentiality. */
export async function connectSyntheticCompanionChannel(
  descriptor: SyntheticCompanionDescriptor
): Promise<SyntheticCompanionChannel> {
  const { address, capability } = copySyntheticDescriptor(descriptor);
  let socket: WebSocket;
  let challenge: string;
  try {
    challenge = randomPairingChallenge();
    socket = new WebSocket(
      "ws://" + address.host + ":" + String(address.port) + address.path,
      {
        agent: false,
        followRedirects: false,
        perMessageDeflate: false,
        handshakeTimeout: SYNTHETIC_COMPANION_LIMITS.handshakeMs,
        maxPayload: SYNTHETIC_COMPANION_LIMITS.frameBytes,
        skipUTF8Validation: false,
      }
    );
  } catch {
    capability.fill(0);
    throw new ChannelFault("disconnected");
  }
  return new Promise<SyntheticCompanionChannel>((resolve, reject) => {
    let phase: "connecting" | "hello" | "ready" | "finished" = "connecting";
    let transcript: string | undefined;

    const cleanup = (): void => {
      clearTimeout(deadline);
      socket.off("open", onOpen);
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
      capability.fill(0);
      transcript = undefined;
    };
    const fail = (code: ChannelFaultCode): void => {
      if (phase === "finished") return;
      phase = "finished";
      // Install a neutral error sink before removing handshake listeners.
      const closed = closeSyntheticSocket(socket, 1008);
      cleanup();
      const settle = async (): Promise<void> => {
        await closed;
        reject(new ChannelFault(code));
      };
      void settle();
    };
    const onError = (): void => fail("disconnected");
    const onClose = (): void => fail("disconnected");
    const onOpen = (): void => {
      if (phase !== "connecting" || Date.now() >= address.expiresAt) {
        fail("timeout");
        return;
      }
      phase = "hello";
      sendPairingMessage(
        socket,
        {
          type: "client_hello",
          version: COMPANION_CHANNEL_VERSION,
          challenge,
        },
        onError
      );
    };
    const onMessage = (raw: RawData, binary: boolean): void => {
      try {
        if (Date.now() >= address.expiresAt) throw new ChannelFault("timeout");
        const message = parsePairingHandshake(
          textFrame(raw, binary, SYNTHETIC_COMPANION_LIMITS.handshakeBytes)
        );
        if (phase === "hello") {
          if (message.type !== "server_hello")
            throw new ChannelFault("invalid_message");
          transcript = pairingTranscript(address, challenge, message.challenge);
          if (
            !verifyPairingProof(
              capability,
              "server_hello",
              transcript,
              message.proof
            )
          )
            throw new ChannelFault("binding_mismatch");
          phase = "ready";
          sendPairingMessage(
            socket,
            {
              type: "client_proof",
              version: COMPANION_CHANNEL_VERSION,
              proof: createPairingProof(capability, "client_proof", transcript),
            },
            onError
          );
          return;
        }
        if (
          phase !== "ready" ||
          message.type !== "server_ready" ||
          !transcript ||
          !verifyPairingProof(
            capability,
            "server_ready",
            transcript,
            message.proof
          )
        )
          throw new ChannelFault("invalid_message");
        const endpoint = new AuthenticatedCompanionEndpoint(
          socket,
          "client",
          derivePairingKeys(capability, transcript)
        );
        phase = "finished";
        cleanup();
        const lifetime = setTimeout(
          () => endpoint.disconnect(),
          Math.max(
            1,
            address.expiresAt -
              SYNTHETIC_COMPANION_LIMITS.capabilityMs +
              SYNTHETIC_COMPANION_LIMITS.lifetimeMs -
              Date.now()
          )
        );
        socket.once("close", () => clearTimeout(lifetime));
        resolve({
          selection: address.selection,
          endpoint,
          async close() {
            clearTimeout(lifetime);
            endpoint.disconnect();
            await closeSyntheticSocket(socket);
          },
        });
      } catch (error) {
        fail(error instanceof ChannelFault ? error.code : "invalid_message");
      }
    };
    const deadline = setTimeout(
      () => fail("timeout"),
      Math.min(
        SYNTHETIC_COMPANION_LIMITS.handshakeMs,
        Math.max(1, address.expiresAt - Date.now())
      )
    );
    socket.on("open", onOpen);
    socket.on("message", onMessage);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}
