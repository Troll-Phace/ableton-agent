import type * as Http from "node:http";
import type * as Crypto from "node:crypto";
import type { Socket } from "node:net";

import type { ProbeCancellation } from "../extension/feasibility/contracts.js";
import {
  SigninDeadline,
  type OfficialHttpClient,
} from "../extension/feasibility/official-http.js";
import {
  OidcIdTokenVerifier,
  type MaintainedJwtVerifier,
  type OfficialDiscovery,
} from "../extension/feasibility/id-token.js";
import { openAuthorizationCallback } from "../extension/feasibility/oauth.js";
import {
  AUTH_ORIGIN,
  AUTHORIZATION_ENDPOINT,
  TOKEN_ENDPOINT,
  SigninFault,
  errorCode,
  type SigninClock,
} from "../extension/feasibility/signin-contracts.js";
import type { HostPreflightEvidence } from "../extension/feasibility/signin-session.js";
import type { CompanionStorage, CompanionStorageProbe } from "./storage.js";

const HOST = "127.0.0.1";
const LIMIT = 5000;
const FRAME = 'data: {"marker":"p15_3","text":"€"}\n\n';
const firstBytes = new Uint8Array([
  ...Array.from('data: {"marker":"p15_3","text":"', (char) =>
    char.charCodeAt(0)
  ),
  0xe2,
]);
// Keep the fixed SSE frame valid JSON; split the multibyte scalar across writes.
const lastBytes = new Uint8Array([0x82, 0xac, 0x22, 0x7d, 10, 10]);
const ABORT_FRAME = new Uint8Array(
  Array.from("data: p15_3\n\n", (char) => char.charCodeAt(0))
);
const EXPECTED = FRAME;

export type CompanionJwt = Pick<
  typeof import("jsonwebtoken"),
  "decode" | "verify" | "sign"
>;
export interface CompanionPreflightDependencies {
  storage: Pick<CompanionStorage, "probeDurability">;
  pid: number;
  http: Pick<typeof Http, "createServer">;
  fetch: typeof globalThis.fetch;
  AbortController: typeof globalThis.AbortController;
  TextDecoder: typeof globalThis.TextDecoder;
  URL: typeof globalThis.URL;
  crypto: Pick<
    typeof Crypto,
    "randomBytes" | "generateKeyPairSync" | "createPublicKey"
  >;
  jwt: CompanionJwt;
  clock: SigninClock;
}
export interface LocalTransportEvidence {
  outcome: "pass" | "blocked";
  code:
    | "transport_verified"
    | "transport_unproven"
    | "cancelled"
    | "timeout"
    | "permission_denied"
    | "cleanup_failed"
    | "native_unavailable";
  preEofRead: boolean;
  streamComplete: boolean;
  pendingRead: boolean;
  abortRejected: boolean;
  responseClosed: boolean;
  cleanup: boolean;
}
export interface LocalCheckEvidence {
  outcome: "pass" | "blocked";
  code: "verified" | "not_verified" | "cancelled";
}
export interface CompanionPreflightReport {
  storage?: CompanionStorageProbe;
  transport: LocalTransportEvidence;
  callback: LocalCheckEvidence;
  verifier: LocalCheckEvidence;
  evidence: HostPreflightEvidence;
}
function check(cancellation: ProbeCancellation): void {
  if (cancellation.cancelled) throw new SigninFault("cancelled");
}
function abortError(error: unknown): boolean {
  try {
    return (
      typeof error === "object" &&
      error !== null &&
      (("name" in error && error.name === "AbortError") ||
        ("code" in error && error.code === "ABORT_ERR"))
    );
  } catch {
    return false;
  }
}
function transportCode(
  error: unknown,
  cancelled: boolean
): LocalTransportEvidence["code"] {
  if (cancelled) return "cancelled";
  const code = errorCode(error);
  return code === "timeout" ||
    code === "permission_denied" ||
    code === "cleanup_failed" ||
    code === "native_unavailable"
    ? code
    : "transport_unproven";
}
function blankTransport(
  code: LocalTransportEvidence["code"] = "transport_unproven"
): LocalTransportEvidence {
  return {
    outcome: "blocked",
    code,
    preEofRead: false,
    streamComplete: false,
    pendingRead: false,
    abortRejected: false,
    responseClosed: false,
    cleanup: false,
  };
}

/** Actual native loopback SSE and pending-read cancellation. No auth/HTTPS or
 * arbitrary destination; every listener, reader and timer is bounded. */
export async function verifyCompanionTransport(
  deps: Pick<
    CompanionPreflightDependencies,
    "http" | "fetch" | "AbortController" | "TextDecoder" | "clock"
  >,
  cancellation: ProbeCancellation
): Promise<LocalTransportEvidence> {
  const evidence = blankTransport();
  if (cancellation.cancelled) return blankTransport("cancelled");
  let server: Http.Server | undefined;
  const sockets = new Set<Socket>();
  let streamResponse: Http.ServerResponse | undefined;
  let abortResponse: Http.ServerResponse | undefined;
  let abortRequested = false;
  let closedAfterAbort = false;
  let receipt: () => void = () => undefined;
  const responseClosed = new Promise<void>((resolve) => {
    receipt = resolve;
  });
  let serverError = false;
  let readersCleaned = true;
  const onSocket = (socket: Socket) => {
    sockets.add(socket);
  };
  const onError = () => {
    serverError = true;
  };
  const onAbortClose = () => {
    closedAfterAbort = abortRequested && abortResponse?.writableEnded === false;
    receipt();
  };
  const run = async (kind: "stream" | "abort", base: string): Promise<void> => {
    const controller = new deps.AbortController();
    const deadline = new SigninDeadline(deps.clock, LIMIT, cancellation, () =>
      controller.abort()
    );
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let body: ReadableStream<Uint8Array> | null | undefined;
    let cleanupOk = true;
    try {
      check(cancellation);
      const response = await deadline.wait(
        deps.fetch(`${base}/companion-${kind}`, {
          signal: controller.signal,
          redirect: "error",
        })
      );
      body = response.body;
      if (
        response.status !== 200 ||
        response.headers.get("content-type") !== "text/event-stream" ||
        !body
      )
        throw new SigninFault("invalid_response");
      reader = body.getReader();
      const received: number[] = [];
      let chunks = 0;
      const decode = new deps.TextDecoder("utf-8", { fatal: true });
      let text = "";
      const append = (bytes: Uint8Array) => {
        chunks++;
        if (chunks > 128 || received.length + bytes.length > 128)
          throw new SigninFault("response_limit");
        received.push(...bytes);
        text += decode.decode(bytes, { stream: true });
      };
      let first = await deadline.wait(reader.read());
      while (!first.done && first.value.length === 0) {
        append(first.value);
        first = await deadline.wait(reader.read());
      }
      if (first.done) throw new SigninFault("invalid_response");
      append(first.value);
      const initial = kind === "stream" ? firstBytes : ABORT_FRAME;
      const target = kind === "stream" ? streamResponse : abortResponse;
      if (
        !target ||
        target.writableEnded ||
        received.length > initial.length ||
        received.some((byte, i) => byte !== initial[i])
      )
        throw new SigninFault("invalid_response");
      if (kind === "stream") {
        evidence.preEofRead = true;
        target.end(lastBytes);
        while (true) {
          const row = await deadline.wait(reader.read());
          if (row.done) break;
          append(row.value);
        }
        text += decode.decode();
        if (text !== EXPECTED) throw new SigninFault("invalid_response");
        evidence.streamComplete = true;
      } else {
        while (received.length < ABORT_FRAME.length) {
          const row = await deadline.wait(reader.read());
          if (row.done) throw new SigninFault("invalid_response");
          append(row.value);
          if (
            received.length > ABORT_FRAME.length ||
            received.some((byte, i) => byte !== ABORT_FRAME[i])
          )
            throw new SigninFault("invalid_response");
        }
        let settled = false;
        const pending = reader.read().then(
          (value) => {
            settled = true;
            return { ok: true as const, value };
          },
          (error: unknown) => {
            settled = true;
            return { ok: false as const, error };
          }
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await deadline.wait(
            new Promise<void>((resolve) => {
              timer = deps.clock.setTimeout(resolve, 0);
            })
          );
        } finally {
          if (timer !== undefined) deps.clock.clearTimeout(timer);
        }
        check(cancellation);
        if (settled || target.writableEnded)
          throw new SigninFault("invalid_response");
        evidence.pendingRead = true;
        abortRequested = true;
        controller.abort();
        const result = await deadline.wait(pending);
        deadline.check();
        if (
          !controller.signal.aborted ||
          result.ok ||
          !abortError(result.error)
        )
          throw new SigninFault("invalid_response");
        evidence.abortRejected = true;
        await deadline.wait(responseClosed);
        deadline.check();
        if (!closedAfterAbort) throw new SigninFault("invalid_response");
        evidence.responseClosed = true;
      }
      if (serverError) throw new SigninFault("network_failed");
      check(cancellation);
    } finally {
      deadline.close();
      const cleanup = new SigninDeadline(deps.clock, LIMIT);
      try {
        try {
          if (!controller.signal.aborted) controller.abort();
        } catch {
          cleanupOk = false;
        }
        try {
          const pending = reader ? reader.cancel() : body?.cancel();
          if (pending) await cleanup.wait(pending);
        } catch (error) {
          if (!abortError(error)) cleanupOk = false;
        }
        try {
          reader?.releaseLock();
        } catch {
          cleanupOk = false;
        }
      } finally {
        cleanup.close();
      }
      if (!cleanupOk) readersCleaned = false;
    }
  };
  try {
    server = deps.http.createServer((req, res) => {
      if (req.method !== "GET") {
        res.writeHead(404).end();
        return;
      }
      if (req.url === "/companion-stream" && !streamResponse) {
        streamResponse = res;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
        });
        res.write(firstBytes);
      } else if (req.url === "/companion-abort" && !abortResponse) {
        abortResponse = res;
        res.once("close", onAbortClose);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
        });
        res.write(ABORT_FRAME);
      } else res.writeHead(404).end();
    });
    const running = server;
    running.on("connection", onSocket);
    running.on("error", onError);
    const binding = new SigninDeadline(deps.clock, LIMIT, cancellation);
    let onListening: () => void = () => undefined;
    let onBindError: (error: Error) => void = () => undefined;
    let port: number;
    try {
      port = await binding.wait(
        new Promise<number>((resolve, reject) => {
          onListening = () => {
            const address = running.address();
            if (
              address &&
              typeof address !== "string" &&
              address.address === HOST &&
              address.port > 0
            )
              resolve(address.port);
            else reject(new SigninFault("native_unavailable"));
          };
          onBindError = reject;
          running.once("error", onBindError);
          running.listen(0, HOST, onListening);
        })
      );
    } finally {
      binding.close();
      running.off("error", onBindError);
      running.off("listening", onListening);
    }
    await run("stream", `http://${HOST}:${port}`);
    if (!readersCleaned) throw new SigninFault("cleanup_failed");
    await run("abort", `http://${HOST}:${port}`);
    if (!readersCleaned) throw new SigninFault("cleanup_failed");
    evidence.code = "transport_verified";
    evidence.outcome = "pass";
  } catch (error) {
    evidence.outcome = "blocked";
    evidence.code = transportCode(error, cancellation.cancelled);
  } finally {
    if (server) {
      const running = server;
      const deadline = new SigninDeadline(deps.clock, LIMIT);
      try {
        const closed = new Promise<void>((resolve, reject) => {
          running.close((error) => {
            if (
              error &&
              !("code" in error && error.code === "ERR_SERVER_NOT_RUNNING")
            )
              reject(new SigninFault("cleanup_failed"));
            else resolve();
          });
        });
        running.closeAllConnections();
        for (const socket of sockets) socket.destroy();
        await deadline.wait(closed);
        evidence.cleanup = !running.listening && readersCleaned;
      } catch {
        evidence.cleanup = false;
      } finally {
        deadline.close();
        running.off("connection", onSocket);
        running.off("error", onError);
        abortResponse?.off("close", onAbortClose);
        sockets.clear();
      }
    } else evidence.cleanup = true;
    if (!evidence.cleanup) {
      evidence.outcome = "blocked";
      evidence.code = "cleanup_failed";
    }
  }
  return evidence;
}

/** Maintained verifier adapter; only the library verifies signatures. */
export function companionJwtAdapter(jwt: CompanionJwt): MaintainedJwtVerifier {
  return {
    decode: (token, options) => jwt.decode(token, options),
    verify: (token, key, options) => jwt.verify(token, key, options),
  };
}
export async function verifyCompanionJwt(
  deps: Pick<
    CompanionPreflightDependencies,
    "jwt" | "crypto" | "URL" | "clock"
  >,
  cancellation: ProbeCancellation
): Promise<boolean> {
  try {
    check(cancellation);
    const { privateKey, publicKey } = deps.crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const kid = "synthetic-companion-key",
      audience = "synthetic-companion-audience",
      subject = "synthetic-companion-subject",
      nonce = "synthetic-companion-nonce";
    const now = Math.floor(deps.clock.now() / 1000);
    const token = deps.jwt.sign(
      {
        iss: AUTH_ORIGIN,
        aud: audience,
        sub: subject,
        nonce,
        iat: now,
        exp: now + 60,
      },
      privateKey,
      { algorithm: "RS256", keyid: kid }
    );
    const discovery: OfficialDiscovery = {
      issuer: AUTH_ORIGIN,
      authorizationEndpoint: AUTHORIZATION_ENDPOINT,
      tokenEndpoint: TOKEN_ENDPOINT,
      jwksUri: `${AUTH_ORIGIN}/companion-synthetic-jwks`,
      revocationEndpoint: `${AUTH_ORIGIN}/companion-synthetic-revoke`,
    };
    const http: OfficialHttpClient = {
      requestJson: async (route) => {
        await Promise.resolve();
        if (
          typeof route === "object" &&
          route.kind === "jwks" &&
          route.url === discovery.jwksUri
        )
          return {
            keys: [
              {
                ...publicKey.export({ format: "jwk" }),
                kid,
                alg: "RS256",
                use: "sig",
              },
            ],
          };
        throw new SigninFault("invalid_endpoint");
      },
      requestEmpty: () => Promise.reject(new SigninFault("invalid_endpoint")),
      requestStream: () => Promise.reject(new SigninFault("invalid_endpoint")),
    };
    const verifier = new OidcIdTokenVerifier({
      http,
      jwt: companionJwtAdapter(deps.jwt),
      crypto: deps.crypto,
      URL: deps.URL,
      clock: deps.clock,
    });
    const expected = { clientId: audience, nonce, subject };
    const identity = await verifier.verifyIdToken(
      discovery,
      token,
      expected,
      cancellation
    );
    if (identity.issuer !== AUTH_ORIGIN || identity.subject !== subject)
      return false;
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[2]) return false;
    const signature = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
    let invalid = false,
      wrongNonce = false;
    try {
      await verifier.verifyIdToken(
        discovery,
        `${parts[0]}.${parts[1]}.${signature}`,
        expected,
        cancellation
      );
    } catch (error) {
      invalid = errorCode(error) === "id_token_invalid";
    }
    try {
      await verifier.verifyIdToken(
        discovery,
        token,
        { ...expected, nonce: "wrong-synthetic-nonce" },
        cancellation
      );
    } catch (error) {
      wrongNonce = errorCode(error) === "id_token_invalid";
    }
    check(cancellation);
    return invalid && wrongNonce;
  } catch {
    return false;
  }
}

/** No browser is launched by callback-binding check. */
export async function verifyCompanionCallback(
  deps: Pick<
    CompanionPreflightDependencies,
    "http" | "URL" | "clock" | "crypto"
  >,
  cancellation: ProbeCancellation
): Promise<boolean> {
  try {
    check(cancellation);
    const callback = await openAuthorizationCallback(
      {
        state: deps.crypto.randomBytes(32).toString("base64url"),
        cancellation,
      },
      {
        http: () => Promise.resolve(deps.http),
        URL: deps.URL,
        clock: deps.clock,
      }
    );
    const rejected = callback.result.then(
      () => false,
      (error) => errorCode(error) === "cancelled"
    );
    await callback.close();
    return await rejected;
  } catch {
    return false;
  }
}

/** Credential-free local checks only. Shared OAuth performs HTTPS discovery
 * later, solely after all these real local gates pass. */
export class CompanionPreflight {
  private last?: CompanionPreflightReport;
  constructor(private readonly deps: CompanionPreflightDependencies) {}
  report(): CompanionPreflightReport | undefined {
    return this.last ? structuredClone(this.last) : undefined;
  }
  async run(cancellation: ProbeCancellation): Promise<HostPreflightEvidence> {
    const blocked: LocalCheckEvidence = {
      outcome: "blocked",
      code: cancellation.cancelled ? "cancelled" : "not_verified",
    };
    const evidence: HostPreflightEvidence = {
      nativeTransport: false,
      callbackBinding: false,
      privateStorage: false,
      bundledVerifier: false,
    };
    const report: CompanionPreflightReport = {
      evidence,
      transport: blankTransport(
        cancellation.cancelled ? "cancelled" : "transport_unproven"
      ),
      callback: blocked,
      verifier: blocked,
    };
    try {
      if (!cancellation.cancelled) {
        report.storage = this.deps.storage.probeDurability(this.deps.pid);
        evidence.privateStorage = report.storage.outcome === "pass";
      }
      if (!cancellation.cancelled) {
        report.transport = await verifyCompanionTransport(
          this.deps,
          cancellation
        );
        evidence.nativeTransport = report.transport.outcome === "pass";
      }
      if (!cancellation.cancelled) {
        evidence.callbackBinding = await verifyCompanionCallback(
          this.deps,
          cancellation
        );
        report.callback = {
          outcome: evidence.callbackBinding ? "pass" : "blocked",
          code: evidence.callbackBinding ? "verified" : "not_verified",
        };
      }
      if (!cancellation.cancelled) {
        evidence.bundledVerifier = await verifyCompanionJwt(
          this.deps,
          cancellation
        );
        report.verifier = {
          outcome: evidence.bundledVerifier ? "pass" : "blocked",
          code: evidence.bundledVerifier ? "verified" : "not_verified",
        };
      }
    } finally {
      this.last = report;
    }
    return { ...evidence };
  }
}
