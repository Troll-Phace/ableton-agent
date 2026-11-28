import * as crypto from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import type * as http from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { URL } from "node:url";
import { TextDecoder } from "node:util";

import jwt from "jsonwebtoken";
import { vi } from "vitest";

import {
  CredentialStore,
  SIGNIN_STORAGE_DIRECTORY,
  type CredentialStoreDependencies,
} from "../../src/extension/feasibility/credential-store.js";
import {
  OidcIdTokenVerifier,
  type OfficialDiscovery,
} from "../../src/extension/feasibility/id-token.js";
import {
  OfficialHttp,
  type OfficialHttpDependencies,
} from "../../src/extension/feasibility/official-http.js";
import {
  openAuthorizationCallback,
  type CallbackOptions,
  type OAuthLifecycleDependencies,
} from "../../src/extension/feasibility/oauth.js";
import {
  AUTH_ORIGIN,
  AUTHORIZATION_ENDPOINT,
  TOKEN_ENDPOINT,
  DISCOVERY_ENDPOINT,
  REQUESTED_SCOPES,
  type SigninClock,
  type StoredConnection,
} from "../../src/extension/feasibility/signin-contracts.js";

export const NOW = 1_800_000_000_000;
export const CLIENT = "synthetic-client-id";
export const SUBJECT = "synthetic-subject-id";
export const ACCESS = "synthetic-access-only-fixture";
export const REFRESH = "synthetic-refresh-only-fixture";
export const CODE = "synthetic-authorization-code";
export const DETAIL = "synthetic-private-error-detail";
export const LOCAL_ID = "11111111-1111-4111-8111-111111111111";
export const NONCE = "synthetic-nonce";
export const STATE = "synthetic-state";
export const JWKS = AUTH_ORIGIN + "/synthetic-jwks";
export const REVOKE = AUTH_ORIGIN + "/synthetic-revoke";
export const APPROVED = { eligible: true, operatorStarted: true };
export const DISCOVERY = {
  issuer: AUTH_ORIGIN,
  authorization_endpoint: AUTHORIZATION_ENDPOINT,
  token_endpoint: TOKEN_ENDPOINT,
  jwks_uri: JWKS,
  revocation_endpoint: REVOKE,
  id_token_signing_alg_values_supported: ["RS256"],
};
export const RESOLVED_DISCOVERY: OfficialDiscovery = {
  issuer: AUTH_ORIGIN,
  authorizationEndpoint: AUTHORIZATION_ENDPOINT,
  tokenEndpoint: TOKEN_ENDPOINT,
  jwksUri: JWKS,
  revocationEndpoint: REVOKE,
};

export function testClock(): SigninClock {
  return {
    now: () => NOW,
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer),
  };
}

export function makeConnection(
  overrides: Partial<StoredConnection> = {}
): StoredConnection {
  return {
    version: 1,
    localId: LOCAL_ID,
    clientId: CLIENT,
    issuer: AUTH_ORIGIN,
    subject: SUBJECT,
    accessToken: ACCESS,
    refreshToken: REFRESH,
    expiresAt: NOW + 3600_000,
    scopes: [...REQUESTED_SCOPES],
    ...overrides,
  };
}

/** Credential-store test files never touch the SDK's actual storage. */
export function makeStorage() {
  const base = fs.mkdtempSync(path.join(tmpdir(), "p15-signin-tests-"));
  const directory = path.join(base, SIGNIN_STORAGE_DIRECTORY);
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Test requires POSIX owner identity");
  const deps: CredentialStoreDependencies = {
    fs,
    path,
    uid,
    randomUUID: () => crypto.randomUUID(),
    TextDecoder,
  };
  const store = new CredentialStore(base, deps);
  return {
    base,
    directory,
    deps,
    store,
    file: (name: string) => path.join(directory, name),
    dispose: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

let pair:
  | { publicKey: crypto.KeyObject; privateKey: crypto.KeyObject }
  | undefined;
function signingKeys() {
  pair ??= crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return pair;
}
export function testJwk() {
  return {
    ...signingKeys().publicKey.export({ format: "jwk" }),
    kid: "synthetic-key",
    alg: "RS256",
    use: "sig",
  };
}
export function signedIdToken(
  overrides: Record<string, unknown> = {},
  keyId = "synthetic-key",
  privateKey = signingKeys().privateKey
) {
  const claims = {
    iss: AUTH_ORIGIN,
    aud: CLIENT,
    sub: SUBJECT,
    iat: NOW / 1000 - 10,
    exp: NOW / 1000 + 600,
    nonce: NONCE,
    ...overrides,
  };
  return jwt.sign(
    Object.fromEntries(
      Object.entries(claims).filter(([, value]) => value !== undefined)
    ),
    privateKey,
    { algorithm: "RS256", keyid: keyId }
  );
}
export function tokenPayload(overrides: Record<string, unknown> = {}) {
  return {
    access_token: ACCESS,
    refresh_token: REFRESH,
    token_type: "Bearer",
    expires_in: 3600,
    scope: REQUESTED_SCOPES.join(" "),
    client_id: CLIENT,
    id_token: signedIdToken(),
    ...overrides,
  };
}
export function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
export function sseText(value: string) {
  return new Response(value, {
    headers: { "Content-Type": "text/event-stream" },
  });
}
export type FetchHandler = (
  init: RequestInit | undefined
) => Response | Promise<Response>;
/** Fail-closed scripted fetch. Never invokes native fetch or a real service. */
export function fakeHttp(clock = testClock()) {
  const queue: { url: string; handler: FetchHandler }[] = [];
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const unexpected: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    if (typeof input !== "string") throw new Error("Invalid synthetic request");
    calls.push({ url: input, init });
    const item = queue.shift();
    if (!item || item.url !== input || init?.redirect !== "error") {
      unexpected.push(input);
      throw new Error("Unexpected synthetic request");
    }
    return await item.handler(init);
  });
  const deps: OfficialHttpDependencies = {
    fetch,
    AbortController,
    TextDecoder,
    URL,
    clock,
  };
  return {
    http: new OfficialHttp(deps),
    deps,
    calls,
    unexpected,
    queue,
    enqueue(url: string, response: Response | FetchHandler) {
      queue.push({
        url,
        handler: typeof response === "function" ? response : () => response,
      });
    },
    enqueueDiscovery() {
      queue.push({ url: DISCOVERY_ENDPOINT, handler: () => json(DISCOVERY) });
    },
    enqueueJwks() {
      queue.push({ url: JWKS, handler: () => json({ keys: [testJwk()] }) });
    },
  };
}

export function idTokens(network: ReturnType<typeof fakeHttp>) {
  const verify = vi.fn(
    (token: string, key: crypto.KeyObject, options: jwt.VerifyOptions) =>
      jwt.verify(token, key, options)
  );
  const verifier = new OidcIdTokenVerifier({
    http: network.http,
    clock: network.deps.clock,
    URL,
    crypto,
    jwt: { decode: (token, options) => jwt.decode(token, options), verify },
  });
  return { verifier, verify };
}

export interface FakeCallbackReply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** HTTP callback server double. No actual socket binds; requests are in process. */
class CallbackServer extends EventEmitter {
  listening = false;
  private listener: http.RequestListener;
  constructor(listener: http.RequestListener) {
    super();
    this.listener = listener;
  }
  listen = vi.fn((port: number, host: string, callback: () => void) => {
    if (port !== 0 || host !== "127.0.0.1")
      throw new Error("Unexpected synthetic bind");
    this.listening = true;
    queueMicrotask(() => callback());
    return this;
  });
  address() {
    return this.listening
      ? { address: "127.0.0.1", port: 12345, family: "IPv4" }
      : null;
  }
  close = vi.fn((callback: (error?: Error) => void) => {
    this.listening = false;
    callback();
  });
  closeIdleConnections = vi.fn();
  closeAllConnections = vi.fn();
  dispatch(raw: string, method = "GET"): FakeCallbackReply {
    if (!this.listening) throw new Error("Synthetic callback closed");
    const reply: FakeCallbackReply = { status: 0, headers: {}, body: "" };
    const response = {
      writeHead(status: number, headers: Record<string, string>) {
        reply.status = status;
        reply.headers = headers;
        return this;
      },
      end(body: string) {
        reply.body = body;
        return this;
      },
    };
    this.listener(
      { url: raw, method } as http.IncomingMessage,
      response as unknown as http.ServerResponse
    );
    return reply;
  }
}

export function fakeCallbacks(clock = testClock()) {
  const servers: CallbackServer[] = [];
  const createServer = vi.fn((listener: http.RequestListener) => {
    const server = new CallbackServer(listener);
    servers.push(server);
    return server as unknown as http.Server;
  });
  const httpLoader = vi.fn(() =>
    Promise.resolve({
      createServer: createServer as unknown as typeof http.createServer,
    })
  );
  const open = vi.fn((options: CallbackOptions) =>
    openAuthorizationCallback(options, {
      http: httpLoader,
      URL,
      clock,
    })
  );
  return { open, servers, createServer, httpLoader };
}
export function callbackPath(
  state: string,
  values: Record<string, string> = {}
) {
  return (
    "/auth/callback?" +
    new URLSearchParams({
      state,
      code: CODE,
      client_id: CLIENT,
      ...values,
    }).toString()
  );
}

export function makeOAuthFixture(storage: ReturnType<typeof makeStorage>) {
  const network = fakeHttp();
  const { verifier, verify } = idTokens(network);
  const callbacks = fakeCallbacks(network.deps.clock);
  const replies: FakeCallbackReply[] = [];
  const browser = vi.fn((url: string) => {
    const query = new URL(url).searchParams;
    const server = callbacks.servers.at(-1);
    const state = query.get("state");
    if (!server || !state) throw new Error("Expected synthetic callback");
    replies.push(server.dispatch(callbackPath(state)));
    return Promise.resolve();
  });
  const deps: OAuthLifecycleDependencies = {
    http: network.http,
    store: storage.store,
    idTokens: verifier,
    crypto,
    callback: callbacks.open,
    browser,
    clock: network.deps.clock,
  };
  const enqueueSignin = () => {
    network.enqueue(TOKEN_ENDPOINT, () => {
      const url = browser.mock.calls.at(-1)?.[0];
      const nonce = url ? new URL(url).searchParams.get("nonce") : undefined;
      return json(tokenPayload({ id_token: signedIdToken({ nonce }) }));
    });
    network.enqueueJwks();
  };
  return {
    network,
    verifier,
    verify,
    callbacks,
    browser,
    replies,
    deps,
    enqueueSignin,
  };
}

/** Split fake SSE byte streams, including UTF-8 and framing boundaries, without network. */
export function eventFrame(type: string, fields: Record<string, unknown> = {}) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
}

export function chunkedSse(text: string, size = 7) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) controller.close();
      else {
        controller.enqueue(
          bytes.subarray(offset, Math.min(offset + size, bytes.length))
        );
        offset = Math.min(offset + size, bytes.length);
      }
    },
    cancel,
  });
  const response = new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
  });
  return { response, body, cancel };
}

/** Fake pending-read stream: abort behavior can be independently selected without contacting a host. */
export function pendingSse(
  signal: AbortSignal,
  firstFrame: string,
  behavior: "abort" | "ignored" | "other" = "abort"
) {
  const aborted = vi.fn();
  const cancelled = vi.fn();
  let remove: (() => void) | undefined;
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        controller.enqueue(new TextEncoder().encode(firstFrame));
        const onAbort = () => {
          aborted();
          if (behavior === "abort")
            controller.error(new DOMException(DETAIL, "AbortError"));
          else if (behavior === "other") controller.error(new Error(DETAIL));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        remove = () => signal.removeEventListener("abort", onAbort);
      },
      cancel() {
        cancelled();
        remove?.();
      },
    },
    { highWaterMark: 0 }
  );
  return {
    response: new Response(body, {
      headers: { "Content-Type": "text/event-stream" },
    }),
    body,
    aborted,
    cancelled,
  };
}
