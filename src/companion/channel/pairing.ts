import {
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  ChannelFault,
  COMPANION_CHANNEL_VERSION,
  validateChannelSelection,
  type ChannelSelection,
} from "../../shared/companion-channel.js";

export const SYNTHETIC_COMPANION_HOST = "127.0.0.1" as const;
export const SYNTHETIC_COMPANION_PATH = "/companion-channel" as const;
export const SYNTHETIC_COMPANION_LIMITS = Object.freeze({
  capabilityBytes: 32,
  capabilityMs: 30000,
  handshakeMs: 5000,
  attempts: 3,
  handshakeBytes: 4096,
  payloadBytes: 1024 * 1024,
  frameBytes: 2 * 1024 * 1024,
  pendingFrames: 4,
  pendingBytes: 4 * 1024 * 1024,
  sendMs: 5000,
  lifetimeMs: 120000,
  shutdownMs: 1000,
});

const DOMAIN = "ableton-agent.synthetic-companion.v1";

export interface SyntheticCompanionAddress {
  readonly host: typeof SYNTHETIC_COMPANION_HOST;
  readonly path: typeof SYNTHETIC_COMPANION_PATH;
  readonly version: typeof COMPANION_CHANNEL_VERSION;
  readonly port: number;
  readonly expiresAt: number;
  readonly selection: ChannelSelection;
}

/** In-memory fixture capability only. Never serialize it or place it in a URL.
 * The server clears its mutable descriptor buffer on consumption or teardown. */
export interface SyntheticCompanionDescriptor extends SyntheticCompanionAddress {
  readonly capability: Uint8Array;
}

export type PairingHandshake =
  | { type: "client_hello"; version: 1; challenge: string }
  | { type: "server_hello"; version: 1; challenge: string; proof: string }
  | { type: "client_proof"; version: 1; proof: string }
  | { type: "server_ready"; version: 1; proof: string };

export type PairingProofRole = "server_hello" | "client_proof" | "server_ready";
export type ChannelDirection = "client_to_server" | "server_to_client";

export interface PairingKeys {
  clientToServer: Buffer;
  serverToClient: Buffer;
}

function invalid(): never {
  throw new ChannelFault("invalid_message");
}

function record(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    invalid();
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
}

/** Generate a uniformly random 256-bit synthetic capability or challenge. */
export function randomPairingBytes(): Buffer {
  return randomBytes(SYNTHETIC_COMPANION_LIMITS.capabilityBytes);
}

/** A fresh public challenge; not the pairing capability. */
export function randomPairingChallenge(): string {
  return randomPairingBytes().toString("base64url");
}

function token(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value))
    return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === value;
}

/** Mint the explicitly passed descriptor for a server-owned ephemeral address.
 * Hide the capability from incidental object/JSON enumeration. */
export function createSyntheticDescriptor(
  selection: ChannelSelection,
  port: number,
  expiresAt: number,
  capability: Buffer
): SyntheticCompanionDescriptor {
  const address = {
    host: SYNTHETIC_COMPANION_HOST,
    path: SYNTHETIC_COMPANION_PATH,
    version: COMPANION_CHANNEL_VERSION,
    port,
    expiresAt,
    selection: validateChannelSelection(selection),
  };
  Object.defineProperty(address, "capability", {
    value: new Uint8Array(capability),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(address) as SyntheticCompanionDescriptor;
}

/** Validate a passed descriptor, returning a separate mutable secret copy
 * owned by the caller of this function. No arbitrary address is accepted. */
export function copySyntheticDescriptor(value: unknown): {
  address: SyntheticCompanionAddress;
  capability: Buffer;
} {
  try {
    const candidate = record(value);
    exact(candidate, [
      "host",
      "path",
      "version",
      "port",
      "expiresAt",
      "selection",
      "capability",
    ]);
    for (const key of Reflect.ownKeys(candidate)) {
      const d = Object.getOwnPropertyDescriptor(candidate, key);
      if (!d || !("value" in d)) invalid();
    }
    const { host, path, version, port, expiresAt, capability } = candidate;
    const now = Date.now();
    if (
      host !== SYNTHETIC_COMPANION_HOST ||
      path !== SYNTHETIC_COMPANION_PATH ||
      version !== COMPANION_CHANNEL_VERSION ||
      typeof port !== "number" ||
      !Number.isSafeInteger(port) ||
      port < 1 ||
      port > 65535 ||
      typeof expiresAt !== "number" ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt > now + SYNTHETIC_COMPANION_LIMITS.capabilityMs ||
      !(capability instanceof Uint8Array) ||
      capability.byteLength !== SYNTHETIC_COMPANION_LIMITS.capabilityBytes
    )
      invalid();
    if (expiresAt <= now) throw new ChannelFault("timeout");
    const selection = validateChannelSelection(candidate.selection);
    return {
      address: Object.freeze({
        host,
        path,
        version,
        port,
        expiresAt,
        selection,
      }),
      capability: Buffer.from(capability),
    };
  } catch (error) {
    if (error instanceof ChannelFault) throw error;
    return invalid();
  }
}

/** Match the complete agreed synthetic binding with fresh bilateral challenges.
 * This is an unambiguous ordered transcript, not an attestation of a process. */
export function pairingTranscript(
  address: SyntheticCompanionAddress,
  clientChallenge: string,
  serverChallenge: string
): string {
  if (!token(clientChallenge) || !token(serverChallenge)) invalid();
  const s = address.selection;
  return JSON.stringify([
    DOMAIN,
    address.version,
    address.host,
    address.port,
    address.path,
    address.expiresAt,
    s.pairSessionId,
    s.epoch,
    s.conversationId,
    s.accountRevision,
    s.model,
    clientChallenge,
    serverChallenge,
  ]);
}

function mac(key: Buffer, message: string): Buffer {
  return createHmac("sha256", key).update(message, "utf8").digest();
}

function verifyMac(key: Buffer, message: string, expected: unknown): boolean {
  if (!token(expected)) return false;
  const given = Buffer.from(expected, "base64url");
  const actual = mac(key, message);
  try {
    return timingSafeEqual(actual, given);
  } finally {
    actual.fill(0);
    given.fill(0);
  }
}

/** Role-separated proofs of capability possession over the complete transcript. */
export function createPairingProof(
  key: Buffer,
  role: PairingProofRole,
  transcript: string
): string {
  const value = mac(
    key,
    JSON.stringify([DOMAIN, "handshake", role, transcript])
  );
  try {
    return value.toString("base64url");
  } finally {
    value.fill(0);
  }
}

/** Constant-time comparison of fixed-width, canonical proof bytes. */
export function verifyPairingProof(
  key: Buffer,
  role: PairingProofRole,
  transcript: string,
  proof: unknown
): boolean {
  return verifyMac(
    key,
    JSON.stringify([DOMAIN, "handshake", role, transcript]),
    proof
  );
}

/** HKDF-SHA256 yields distinct authentication keys, bound to this transcript
 * and direction. These keys ensure integrity, not transport confidentiality. */
export function derivePairingKeys(
  capability: Buffer,
  transcript: string
): PairingKeys {
  const salt = createHash("sha256").update(transcript, "utf8").digest();
  try {
    const derive = (direction: ChannelDirection): Buffer =>
      Buffer.from(
        hkdfSync(
          "sha256",
          capability,
          salt,
          JSON.stringify([DOMAIN, "channel", direction]),
          32
        )
      );
    return {
      clientToServer: derive("client_to_server"),
      serverToClient: derive("server_to_client"),
    };
  } finally {
    salt.fill(0);
  }
}

/** Clear owned mutable key buffers when an authenticated channel settles. */
export function clearPairingKeys(keys: PairingKeys): void {
  keys.clientToServer.fill(0);
  keys.serverToClient.fill(0);
}

/** Strict, canonical handshake JSON; no extra, duplicated, or aliased keys. */
export function parsePairingHandshake(text: string): PairingHandshake {
  try {
    if (
      Buffer.byteLength(text, "utf8") >
      SYNTHETIC_COMPANION_LIMITS.handshakeBytes
    )
      throw new ChannelFault("limit_exceeded");
    const value: unknown = JSON.parse(text);
    const candidate = record(value);
    if (candidate.version !== COMPANION_CHANNEL_VERSION) invalid();
    switch (candidate.type) {
      case "client_hello":
        exact(candidate, ["type", "version", "challenge"]);
        if (!token(candidate.challenge)) invalid();
        break;
      case "server_hello":
        exact(candidate, ["type", "version", "challenge", "proof"]);
        if (!token(candidate.challenge) || !token(candidate.proof)) invalid();
        break;
      case "client_proof":
      case "server_ready":
        exact(candidate, ["type", "version", "proof"]);
        if (!token(candidate.proof)) invalid();
        break;
      default:
        invalid();
    }
    if (JSON.stringify(candidate) !== text) invalid();
    return candidate as unknown as PairingHandshake;
  } catch (error) {
    if (error instanceof ChannelFault) throw error;
    return invalid();
  }
}

/** Authenticate the exact serialized payload string and directional counter.
 * JSON string escaping preserves even unusual UTF-16 code units unambiguously. */
export function createFrameProof(
  key: Buffer,
  direction: ChannelDirection,
  counter: number,
  payload: string
): string {
  const value = mac(
    key,
    JSON.stringify([DOMAIN, "frame", direction, counter, payload])
  );
  try {
    return value.toString("base64url");
  } finally {
    value.fill(0);
  }
}

/** Verify a directional message authenticator without exposing proof bytes. */
export function verifyFrameProof(
  key: Buffer,
  direction: ChannelDirection,
  counter: number,
  payload: string,
  proof: unknown
): boolean {
  return verifyMac(
    key,
    JSON.stringify([DOMAIN, "frame", direction, counter, payload]),
    proof
  );
}
