import * as crypto from "node:crypto";
import * as fs from "node:fs";
import type * as childProcess from "node:child_process";
import { URL } from "node:url";

import jwt from "jsonwebtoken";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProbeCancellation } from "../src/extension/feasibility/contracts.js";
import { validateDiscovery } from "../src/extension/feasibility/id-token.js";
import { validateAuthEndpoint } from "../src/extension/feasibility/official-http.js";
import {
  buildAuthorizationUrl,
  createPkceMaterial,
  launchAuthorizationBrowser,
  OAuthLifecycle,
  parseAuthorizationCallback,
  parseTokenFields,
} from "../src/extension/feasibility/oauth.js";
import {
  AUTH_ORIGIN,
  AUTHORIZATION_ENDPOINT,
  DISCOVERY_ENDPOINT,
  MODELS_ENDPOINT,
  PLAN_SCOPE,
  REQUESTED_SCOPES,
  RESOURCE,
  TOKEN_ENDPOINT,
} from "../src/extension/feasibility/signin-contracts.js";
import {
  ACCESS,
  APPROVED,
  CLIENT,
  CODE,
  DETAIL,
  DISCOVERY,
  fakeCallbacks,
  fakeHttp,
  idTokens,
  json,
  LOCAL_ID,
  HOST_UUID,
  HOST_URI,
  makeConnection,
  makeOAuthFixture,
  makeStorage,
  NONCE,
  NOW,
  RESOLVED_DISCOVERY,
  REVOKE,
  signedIdToken,
  STATE,
  SUBJECT,
  testClock,
  testJwk,
  tokenPayload,
  callbackPath,
  JWKS,
} from "./fixtures/chatgpt-signin.js";

const disposals: (() => void)[] = [];
function storage() {
  const f = makeStorage();
  disposals.push(f.dispose);
  return f;
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dispose of disposals.splice(0)) dispose();
});

describe("S5 OAuth protocol and bounded callback", () => {
  it("generates independent PKCE verifier/state/nonce and exact S256 authorization parameters", () => {
    const pkce = createPkceMaterial(crypto);
    const next = createPkceMaterial(crypto);
    expect(
      new Set([
        pkce.verifier,
        pkce.state,
        pkce.nonce,
        next.verifier,
        next.state,
        next.nonce,
      ]).size
    ).toBe(6);
    expect(pkce.challenge).toBe(
      crypto.createHash("sha256").update(pkce.verifier).digest("base64url")
    );
    const redirectUri = "http://127.0.0.1:12345/auth/callback";
    const url = new URL(
      buildAuthorizationUrl({ hostId: HOST_URI, redirectUri, pkce })
    );
    expect(url.origin + url.pathname).toBe(AUTHORIZATION_ENDPOINT);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "dynamic_agent_client",
      redirect_uri: redirectUri,
      scope: REQUESTED_SCOPES.join(" "),
      resource: RESOURCE,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      state: pkce.state,
      nonce: pkce.nonce,
      agent_name_hint: "Ableton Agent",
      ext_agent_host_id: HOST_URI,
    });
    const reused = new URL(
      buildAuthorizationUrl({
        hostId: HOST_URI,
        redirectUri,
        pkce,
        clientId: CLIENT,
      })
    );
    expect(reused.searchParams.get("client_id")).toBe(CLIENT);
    expect(reused.searchParams.has("agent_name_hint")).toBe(false);
    expect(reused.searchParams.get("ext_agent_host_id")).toBe(HOST_URI);
    expect(reused.searchParams.get("ext_agent_host_id")).not.toBe(HOST_UUID);
    expect(url.searchParams.getAll("ext_agent_host_id")).toEqual([HOST_URI]);
  });

  it.each([
    HOST_UUID,
    "urn:uuid:01234567-89ab-1cde-8f01-23456789abcd",
    "urn:uuid:01234567-89ab-4cde-0f01-23456789abcd",
    "urn:uuid:not-a-uuid",
    "https://example.invalid/host",
  ])(
    "rejects noncanonical or invalid host ID before creating an authorization URL (%s)",
    (hostId) => {
      expect(() =>
        buildAuthorizationUrl({
          hostId,
          redirectUri: "http://127.0.0.1:12345/auth/callback",
          pkce: createPkceMaterial(crypto),
        })
      ).toThrow("callback_invalid");
    }
  );

  it("rejects wrong-state, duplicate, wrong path and oversize callback without consuming the valid attempt", async () => {
    const callbacks = fakeCallbacks();
    const handle = await callbacks.open({ state: STATE });
    const server = callbacks.servers[0];
    if (!server) throw new Error("Missing fake callback");
    for (const raw of [
      callbackPath("wrong-state"),
      callbackPath("wrong-state", { error: "access_denied" }),
      callbackPath(STATE) + "&state=" + STATE,
      callbackPath(STATE) + "&code=synthetic-other-code",
      "/other?state=" + STATE,
      callbackPath(STATE) + "&extra=" + "x".repeat(8193),
    ]) {
      const reply = server.dispatch(raw);
      expect(reply.status).toBe(400);
      expect(reply.body).not.toContain(STATE);
      expect(reply.body).not.toContain(CODE);
    }
    expect(server.dispatch(callbackPath(STATE), "POST").status).toBe(405);
    const reply = server.dispatch(callbackPath(STATE));
    expect(reply.status).toBe(200);
    expect(reply.headers).toMatchObject({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'",
    });
    expect(reply.body).not.toMatch(
      /synthetic-(state|authorization-code|client-id)/
    );
    expect(server.dispatch(callbackPath(STATE)).status).toBe(409);
    await expect(handle.result).resolves.toEqual({
      code: CODE,
      clientId: CLIENT,
    });
    await handle.close();
    expect(server.listening).toBe(false);
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(server.listenerCount("error")).toBe(0);
    expect(server.listenerCount("connection")).toBe(0);
  });

  it.each([
    [
      "registration without client",
      "/auth/callback?state=" + STATE + "&code=" + CODE,
      undefined,
      "client_mismatch",
    ],
    [
      "returning client mismatch",
      callbackPath(STATE, { client_id: "synthetic-different-client" }),
      CLIENT,
      "client_mismatch",
    ],
    [
      "denial",
      "/auth/callback?state=" +
        STATE +
        "&error=access_denied&error_description=" +
        DETAIL,
      undefined,
      "access_denied",
    ],
    [
      "missing scope",
      "/auth/callback?state=" + STATE + "&error=invalid_scope",
      undefined,
      "plan_disabled",
    ],
    [
      "issuer mismatch",
      callbackPath(STATE, { iss: "https://example.invalid" }),
      undefined,
      "callback_invalid",
    ],
  ] as const)(
    "classifies %s callback, returns no private detail",
    async (_label, raw, expectedClientId, code) => {
      const callbacks = fakeCallbacks();
      const handle = await callbacks.open({ state: STATE, expectedClientId });
      const reply = callbacks.servers[0]?.dispatch(raw);
      expect(reply?.status).toBe(400);
      expect(reply?.body).not.toContain(DETAIL);
      await expect(handle.result).rejects.toMatchObject({
        code,
        message: code,
      });
      expect(callbacks.servers[0]?.listening).toBe(false);
    }
  );
  it("allows omitted client identity only for an existing registration", () => {
    expect(
      parseAuthorizationCallback(
        "/auth/callback?state=" + STATE + "&code=" + CODE,
        STATE,
        CLIENT,
        URL
      )
    ).toEqual({ kind: "code", value: { code: CODE, clientId: CLIENT } });
  });
  it("bounds callback consent timeout and removes listeners", async () => {
    vi.useFakeTimers();
    const callbacks = fakeCallbacks();
    const handle = await callbacks.open({ state: STATE });
    const rejected = expect(handle.result).rejects.toMatchObject({
      code: "callback_timeout",
    });
    await vi.advanceTimersByTimeAsync(300000);
    await rejected;
    expect(callbacks.servers[0]?.listening).toBe(false);
    expect(callbacks.servers[0]?.listenerCount("error")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels callback before acceptance, prevents a late callback and closes all resources", async () => {
    vi.useFakeTimers();
    const cancellation = createProbeCancellation();
    const callbacks = fakeCallbacks();
    const handle = await callbacks.open({ state: STATE, cancellation });
    cancellation.cancel();
    await expect(handle.result).rejects.toMatchObject({ code: "cancelled" });
    expect(callbacks.servers[0]?.listening).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await expect(
      callbacks.open({ state: STATE, cancellation })
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(callbacks.createServer).toHaveBeenCalledTimes(1);
  });
  it("only calls the fixed launcher seam with a URL argument array, and denies without fallback", async () => {
    const execFile = vi.fn(
      (
        _file: string,
        _args: string[],
        _opts: object,
        callback: (error: Error | null) => void
      ) => {
        callback(Object.assign(new Error(DETAIL), { code: "EACCES" }));
        return { kill: vi.fn() };
      }
    );
    const loader = vi.fn(() =>
      Promise.resolve({
        execFile: execFile as unknown as typeof childProcess.execFile,
      })
    );
    const url = buildAuthorizationUrl({
      hostId: HOST_URI,
      redirectUri: "http://127.0.0.1:12345/auth/callback",
      pkce: createPkceMaterial(crypto),
    });
    await expect(
      launchAuthorizationBrowser(url, {
        childProcess: loader,
        platform: "darwin",
        URL,
        clock: testClock(),
      })
    ).rejects.toMatchObject({
      code: "browser_denied",
      message: "browser_denied",
    });
    expect(execFile).toHaveBeenCalledExactlyOnceWith(
      "/usr/bin/open",
      [url],
      { shell: false, timeout: 10000, maxBuffer: 4096 },
      expect.any(Function)
    );
  });
});

describe("S5 discovery and maintained JWT verifier, generated test keys only", () => {
  it("loads only the fixed discovery and JWKS route; verifies genuine RSA signature and identity", async () => {
    const network = fakeHttp();
    network.enqueueDiscovery();
    network.enqueueJwks();
    const { verifier, verify } = idTokens(network);
    const discovery = await verifier.loadDiscovery();
    expect(discovery).toEqual(RESOLVED_DISCOVERY);
    const token = signedIdToken();
    await expect(
      verifier.verifyIdToken(discovery, token, {
        clientId: CLIENT,
        nonce: NONCE,
      })
    ).resolves.toEqual({ issuer: AUTH_ORIGIN, subject: SUBJECT });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]?.[2]).toMatchObject({
      algorithms: ["RS256"],
      issuer: AUTH_ORIGIN,
      audience: CLIENT,
      nonce: NONCE,
      clockTimestamp: NOW / 1000,
      clockTolerance: 0,
    });
    expect(network.calls.map((row) => row.url)).toEqual([
      DISCOVERY_ENDPOINT,
      JWKS,
    ]);
    expect(network.unexpected).toEqual([]);
  });
  it.each([
    ["issuer", { issuer: "https://example.invalid" }],
    [
      "authorization",
      { authorization_endpoint: "https://example.invalid/auth" },
    ],
    ["token", { token_endpoint: "https://example.invalid/token" }],
    ["jwks", { jwks_uri: "http://example.invalid/jwks" }],
    ["revocation", { revocation_endpoint: JWKS }],
    ["algorithm", { id_token_signing_alg_values_supported: ["HS256"] }],
    ["missing", { jwks_uri: undefined }],
  ])("rejects malformed discovery %s", (_name, invalid) => {
    expect(() => validateDiscovery({ ...DISCOVERY, ...invalid }, URL)).toThrow(
      "discovery_invalid"
    );
  });
  it.each([
    ["issuer", { iss: "https://example.invalid" }],
    ["audience", { aud: "synthetic-other-client" }],
    ["expiry", { exp: NOW / 1000 }],
    ["missing expiry", { exp: undefined }],
    ["future issued", { iat: NOW / 1000 + 1 }],
    ["nonce", { nonce: "synthetic-other-nonce" }],
    ["not yet valid", { nbf: NOW / 1000 + 1 }],
    ["subject", { sub: "" }],
    [
      "multiple audience without azp",
      { aud: [CLIENT, "synthetic-other-client"] },
    ],
    ["incorrect azp", { azp: "synthetic-other-client" }],
  ])("rejects invalid signed %s claim", async (_name, claims) => {
    const network = fakeHttp();
    network.enqueueJwks();
    const { verifier } = idTokens(network);
    // Only generated synthetic key and claim data. Missing field is removed before signing.
    const token = signedIdToken(claims);
    await expect(
      verifier.verifyIdToken(RESOLVED_DISCOVERY, token, {
        clientId: CLIENT,
        nonce: NONCE,
      })
    ).rejects.toMatchObject({ code: "id_token_invalid" });
  });
  it("rejects a valid signature from a different generated signing key", async () => {
    const network = fakeHttp();
    network.enqueueJwks();
    const { verifier, verify } = idTokens(network);
    const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const token = signedIdToken({}, "synthetic-key", other.privateKey);
    await expect(
      verifier.verifyIdToken(RESOLVED_DISCOVERY, token, {
        clientId: CLIENT,
        nonce: NONCE,
      })
    ).rejects.toMatchObject({ code: "id_token_invalid" });
    expect(verify).toHaveBeenCalledTimes(1);
  });
  it("rejects unsupported algorithm and malformed token before JWKS or signature call", async () => {
    const network = fakeHttp();
    const { verifier, verify } = idTokens(network);
    const unsupported = jwt.sign(
      { iss: AUTH_ORIGIN, aud: CLIENT, sub: SUBJECT },
      "synthetic-test-key",
      { algorithm: "HS256", keyid: "synthetic-key" }
    );
    for (const token of [unsupported, "not-a-token"]) {
      await expect(
        verifier.verifyIdToken(RESOLVED_DISCOVERY, token, { clientId: CLIENT })
      ).rejects.toMatchObject({ code: "id_token_invalid" });
    }
    expect(network.calls).toHaveLength(0);
    expect(verify).not.toHaveBeenCalled();
  });
  it.each(["unknown", "duplicate", "malformed", "wrong-use"] as const)(
    "rejects %s JWKS key selection",
    async (kind) => {
      const network = fakeHttp();
      const { verifier, verify } = idTokens(network);
      const key = testJwk();
      const keys =
        kind === "duplicate"
          ? [key, key]
          : kind === "unknown"
            ? [{ ...key, kid: "synthetic-other-key" }]
            : kind === "wrong-use"
              ? [{ ...key, use: "enc" }]
              : [{ kid: "synthetic-key", kty: "RSA" }];
      network.enqueue(JWKS, json({ keys }));
      await expect(
        verifier.verifyIdToken(RESOLVED_DISCOVERY, signedIdToken(), {
          clientId: CLIENT,
          nonce: NONCE,
        })
      ).rejects.toMatchObject({ code: "jwks_invalid" });
      expect(verify).not.toHaveBeenCalled();
    }
  );
  it("requires subject matching for returning identity and validates a matching multi-audience azp", async () => {
    const network = fakeHttp();
    const { verifier } = idTokens(network);
    network.enqueueJwks();
    network.enqueueJwks();
    await expect(
      verifier.verifyIdToken(RESOLVED_DISCOVERY, signedIdToken(), {
        clientId: CLIENT,
        subject: "synthetic-other-subject",
      })
    ).rejects.toMatchObject({ code: "identity_mismatch" });
    await expect(
      verifier.verifyIdToken(
        RESOLVED_DISCOVERY,
        signedIdToken({ aud: [CLIENT, "synthetic-secondary"], azp: CLIENT }),
        { clientId: CLIENT, subject: SUBJECT }
      )
    ).resolves.toEqual({ issuer: AUTH_ORIGIN, subject: SUBJECT });
  });
});
describe("S5 gated official HTTP and token field validation", () => {
  it("rejects non-official endpoint and redirects, with no off-origin fetch", async () => {
    const network = fakeHttp();
    expect(() =>
      validateAuthEndpoint("https://example.invalid/fixture", URL)
    ).toThrow("invalid_endpoint");
    await expect(
      network.http.requestJson({
        kind: "jwks",
        url: "https://example.invalid/fixture",
      })
    ).rejects.toMatchObject({ code: "invalid_endpoint" });
    expect(network.calls).toHaveLength(0);
    network.enqueue(
      DISCOVERY_ENDPOINT,
      new Response(null, {
        status: 302,
        headers: { Location: "https://example.invalid/fixture" },
      })
    );
    await expect(network.http.requestJson("discovery")).rejects.toMatchObject({
      code: "redirect_rejected",
    });
    expect(network.calls).toHaveLength(1);
    expect(network.unexpected).toEqual([]);
  });
  it("bounds a nonsettling request, aborts the signal, and discards a late body", async () => {
    vi.useFakeTimers();
    const network = fakeHttp();
    const late = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    const cancelled = vi.fn();
    network.enqueue(DISCOVERY_ENDPOINT, () => {
      started.resolve();
      return late.promise;
    });
    const pending = network.http.requestJson("discovery");
    const rejected = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await started.promise;
    await vi.advanceTimersByTimeAsync(15000);
    await rejected;
    expect(network.calls[0]?.init?.signal?.aborted).toBe(true);
    late.resolve(
      new Response(new ReadableStream({ cancel: cancelled }), {
        headers: { "Content-Type": "application/json" },
      })
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    network.enqueue(DISCOVERY_ENDPOINT, json(DISCOVERY));
    await expect(network.http.requestJson("discovery")).resolves.toEqual(
      DISCOVERY
    );
  });

  it("rejects concurrent operations, then cancellation releases a pending reader and later request can proceed", async () => {
    const network = fakeHttp();
    const cancellation = createProbeCancellation();
    const started = Promise.withResolvers<void>();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          started.resolve();
        },
        cancel,
      },
      { highWaterMark: 0 }
    );
    network.enqueue(
      DISCOVERY_ENDPOINT,
      new Response(body, { headers: { "Content-Type": "application/json" } })
    );
    const run = network.http.requestJson("discovery", { cancellation });
    const rejected = expect(run).rejects.toMatchObject({ code: "cancelled" });
    await started.promise;
    await expect(network.http.requestJson("discovery")).rejects.toMatchObject({
      code: "operation_busy",
    });
    cancellation.cancel();
    await rejected;
    expect(body.locked).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(network.calls).toHaveLength(1);
    network.enqueue(DISCOVERY_ENDPOINT, json(DISCOVERY));
    await expect(network.http.requestJson("discovery")).resolves.toEqual(
      DISCOVERY
    );
  });

  it("does not report success when response cleanup fails, and taints the HTTP client", async () => {
    const network = fakeHttp();
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        done: false,
        value: new TextEncoder().encode("{}"),
      })
      .mockResolvedValueOnce({ done: true });
    const cancel = vi.fn(() => Promise.reject(new Error(DETAIL)));
    const releaseLock = vi.fn();
    network.enqueue(DISCOVERY_ENDPOINT, {
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      body: { getReader: () => ({ read, cancel, releaseLock }) },
    } as unknown as Response);
    await expect(network.http.requestJson("discovery")).rejects.toMatchObject({
      code: "cleanup_failed",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
    await expect(network.http.requestJson("discovery")).rejects.toMatchObject({
      code: "cleanup_failed",
    });
    expect(network.calls).toHaveLength(1);
  });

  it.each([
    [429, "usage_limited"],
    [500, "temporary_failure"],
    [401, "reconnect_required"],
    [403, "plan_disabled"],
  ] as const)(
    "maps HTTP %d without raw remote diagnostics",
    async (status, code) => {
      const network = fakeHttp();
      network.enqueue(
        MODELS_ENDPOINT,
        json({ error: { message: DETAIL } }, status)
      );
      await expect(
        network.http.requestJson("models", { bearer: ACCESS })
      ).rejects.toMatchObject({ code, message: code });
      expect(network.calls[0]?.init?.headers).toMatchObject({
        Authorization: "Bearer " + ACCESS,
      });
    }
  );
  it.each([
    [{ scope: "openid resource.invoke" }, "plan_disabled"],
    [{ scope: "openid " + PLAN_SCOPE }, "plan_disabled"],
    [{ scope: undefined }, "plan_disabled"],
    [
      { scope: "openid openid " + PLAN_SCOPE + " resource.invoke" },
      "invalid_response",
    ],
    [{ client_id: "synthetic-other-client" }, "client_mismatch"],
    [{ token_type: "other" }, "invalid_response"],
    [{ expires_in: -1 }, "invalid_response"],
    [{ refresh_token: undefined }, "invalid_response"],
    [{ id_token: undefined }, "id_token_invalid"],
  ] as const)(
    "rejects malformed or unentitled token response %#",
    (overrides, code) => {
      expect(() =>
        parseTokenFields(tokenPayload(overrides), CLIENT, NOW)
      ).toThrow(code);
    }
  );
});

describe("S5 OAuth lifecycle with fake HTTP/browser and actual protected storage", () => {
  it("preflight confirms discovery/JWKS and storage without browser or token request", async () => {
    const s = storage();
    const f = makeOAuthFixture(s);
    const lifecycle = new OAuthLifecycle(f.deps);
    f.network.enqueueDiscovery();
    f.network.enqueueJwks();
    await expect(lifecycle.preflight()).resolves.toEqual({
      storageReady: true,
      budgetReady: true,
      discoveryReady: true,
      jwksReady: true,
    });
    expect(f.network.calls.map((row) => row.url)).toEqual([
      DISCOVERY_ENDPOINT,
      JWKS,
    ]);
    expect(f.browser).not.toHaveBeenCalled();
    expect(f.callbacks.open).not.toHaveBeenCalled();
    expect(s.store.loadSelectedConnection()).toBeUndefined();
  });
  it("requires explicit eligibility/operator gates before any side effect", async () => {
    const f = makeOAuthFixture(storage());
    const lifecycle = new OAuthLifecycle(f.deps);
    await expect(
      lifecycle.signIn({ eligible: false, operatorStarted: true })
    ).rejects.toMatchObject({ code: "eligibility_pending" });
    await expect(
      lifecycle.signIn({ eligible: true, operatorStarted: false })
    ).rejects.toMatchObject({ code: "operator_required" });
    expect(f.network.calls).toHaveLength(0);
    expect(f.browser).not.toHaveBeenCalled();
    expect(f.callbacks.open).not.toHaveBeenCalled();
  });
  it("performs one synthetic dynamic registration, exact exchange, verified persistence and returning-client sign-in", async () => {
    const s = storage();
    const f = makeOAuthFixture(s);
    const lifecycle = new OAuthLifecycle(f.deps);
    f.network.enqueueDiscovery();
    f.enqueueSignin();
    const progress = vi.fn();
    const result = await lifecycle.signIn(APPROVED, progress);
    expect(result).toEqual(makeConnection({ localId: result.localId }));
    expect(s.store.loadSelectedConnection()).toEqual(result);
    expect(progress.mock.calls).toEqual([
      [{ state: "awaiting_consent" }],
      [{ state: "validating" }],
    ]);
    const auth = new URL(f.browser.mock.calls[0]?.[0] ?? "");
    expect(auth.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(auth.searchParams.get("ext_agent_host_id")).toBe(
      s.store.ensureHostId()
    );
    expect(auth.searchParams.get("ext_agent_host_id")).toMatch(
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(auth.searchParams.getAll("ext_agent_host_id")).toHaveLength(1);
    const exchange = f.network.calls.find(
      (row) => row.url === TOKEN_ENDPOINT
    )?.init;
    const form = new URLSearchParams(
      typeof exchange?.body === "string" ? exchange.body : ""
    );
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "authorization_code",
      client_id: CLIENT,
      code: CODE,
      code_verifier: form.get("code_verifier"),
      redirect_uri: auth.searchParams.get("redirect_uri"),
      resource: RESOURCE,
    });
    expect(
      crypto
        .createHash("sha256")
        .update(form.get("code_verifier") ?? "")
        .digest("base64url")
    ).toBe(auth.searchParams.get("code_challenge"));
    expect(f.verify.mock.calls[0]?.[2].nonce).toBe(
      auth.searchParams.get("nonce")
    );
    expect(f.callbacks.servers[0]?.listening).toBe(false);
    expect(JSON.stringify(f.replies)).not.toMatch(
      /synthetic-(authorization-code|access-only|refresh-only|client-id)/
    );
    f.network.enqueue(REVOKE, new Response(null, { status: 204 }));
    expect(await lifecycle.signOut()).toEqual({
      localCleared: true,
      remoteRevocation: "request_accepted",
    });
    expect(s.store.loadSelectedConnection()).toBeUndefined();
    expect(s.store.selectedRegistration()?.clientId).toBe(CLIENT);
    f.network.enqueueDiscovery();
    f.enqueueSignin();
    const again = await lifecycle.signIn(APPROVED);
    expect(again.localId).toBe(result.localId);
    const returningAuth = new URL(f.browser.mock.calls[1]?.[0] ?? "");
    expect(returningAuth.searchParams.get("client_id")).toBe(CLIENT);
    expect(returningAuth.searchParams.get("ext_agent_host_id")).toBe(
      auth.searchParams.get("ext_agent_host_id")
    );
    expect(returningAuth.searchParams.get("ext_agent_host_id")).toBe(
      s.store.ensureHostId()
    );
    expect(returningAuth.searchParams.get("state")).not.toBe(
      auth.searchParams.get("state")
    );
    expect(f.network.unexpected).toEqual([]);
  });
  it("converts a synthetic legacy host record before the first mocked authorization and never transmits a bare host UUID", async () => {
    const s = storage();
    s.store.ensureHostId();
    const budget = s.store.reserveInferenceAttempt();
    fs.writeFileSync(
      s.file("host.json"),
      JSON.stringify({ version: 1, hostId: HOST_UUID })
    );
    const f = makeOAuthFixture(s);
    f.network.enqueueDiscovery();
    f.enqueueSignin();
    const lifecycle = new OAuthLifecycle(f.deps);
    await lifecycle.signIn(APPROVED);
    const auth = new URL(f.browser.mock.calls[0]?.[0] ?? "");
    expect(auth.searchParams.getAll("ext_agent_host_id")).toEqual([HOST_URI]);
    expect(s.store.ensureHostId()).toBe(HOST_URI);
    expect(s.store.getBudget()).toEqual(budget);
    expect(f.network.unexpected).toEqual([]);
  });

  it("denial without token exchange leaves no credential and no retry", async () => {
    const s = storage();
    const f = makeOAuthFixture(s);
    const lifecycle = new OAuthLifecycle(f.deps);
    f.network.enqueueDiscovery();
    f.browser.mockImplementationOnce((url) => {
      const state = new URL(url).searchParams.get("state");
      f.callbacks.servers[0]?.dispatch(
        "/auth/callback?state=" + state + "&error=access_denied"
      );
      return Promise.resolve();
    });
    await expect(lifecycle.signIn(APPROVED)).rejects.toMatchObject({
      code: "access_denied",
    });
    expect(f.network.calls.map((row) => row.url)).toEqual([DISCOVERY_ENDPOINT]);
    expect(s.store.loadSelectedConnection()).toBeUndefined();
    expect(f.browser).toHaveBeenCalledTimes(1);
  });
  it("blocks missing plan scope before ID verification or persistence", async () => {
    const s = storage();
    const f = makeOAuthFixture(s);
    f.network.enqueueDiscovery();
    f.network.enqueue(
      TOKEN_ENDPOINT,
      json(tokenPayload({ scope: "openid resource.invoke" }))
    );
    await expect(
      new OAuthLifecycle(f.deps).signIn(APPROVED)
    ).rejects.toMatchObject({ code: "plan_disabled" });
    expect(f.verify).not.toHaveBeenCalled();
    expect(s.store.loadSelectedConnection()).toBeUndefined();
  });
  it("cancels an already accepted callback during a pending synthetic token exchange without saving a late response", async () => {
    const s = storage();
    const f = makeOAuthFixture(s);
    const lifecycle = new OAuthLifecycle(f.deps);
    const started = Promise.withResolvers<void>();
    const late = Promise.withResolvers<Response>();
    const cancellation = createProbeCancellation();
    const save = vi.spyOn(s.store, "saveConnection");
    f.network.enqueueDiscovery();
    f.network.enqueue(TOKEN_ENDPOINT, () => {
      started.resolve();
      return late.promise;
    });
    const work = lifecycle.signIn({ ...APPROVED, cancellation });
    const rejected = expect(work).rejects.toMatchObject({ code: "cancelled" });
    await started.promise;
    cancellation.cancel();
    await rejected;
    late.resolve(json(tokenPayload()));
    await Promise.resolve();
    await Promise.resolve();
    expect(save).not.toHaveBeenCalled();
    expect(s.store.loadSelectedConnection()).toBeUndefined();
    expect(f.callbacks.servers[0]?.listening).toBe(false);
    expect(
      f.network.calls.filter((row) => row.url === TOKEN_ENDPOINT)
    ).toHaveLength(1);
  });
  it("clears credentials on a successfully returned but mismatched refreshed identity", async () => {
    const s = storage();
    s.store.saveConnection(makeConnection());
    const f = makeOAuthFixture(s);
    f.network.enqueueDiscovery();
    f.network.enqueue(
      TOKEN_ENDPOINT,
      json(
        tokenPayload({
          id_token: signedIdToken({ sub: "synthetic-other-subject" }),
        })
      )
    );
    f.network.enqueueJwks();
    await expect(
      new OAuthLifecycle(f.deps).refresh(APPROVED)
    ).rejects.toMatchObject({ code: "identity_mismatch" });
    expect(f.verify).toHaveBeenCalledTimes(1);
    expect(s.store.loadSelectedConnection()).toBeUndefined();
    expect(s.store.selectedRegistration()?.clientId).toBe(CLIENT);
  });

  it("rotates tokens once and uses existing refresh token when not rotated", async () => {
    const s = storage();
    s.store.saveConnection(makeConnection());
    const f = makeOAuthFixture(s);
    const lifecycle = new OAuthLifecycle(f.deps);
    f.network.enqueueDiscovery();
    f.network.enqueue(
      TOKEN_ENDPOINT,
      json(
        tokenPayload({
          access_token: "synthetic-new-access",
          refresh_token: "synthetic-new-refresh",
          id_token: undefined,
        })
      )
    );
    const updated = await lifecycle.refresh(APPROVED);
    expect(updated).toMatchObject({
      accessToken: "synthetic-new-access",
      refreshToken: "synthetic-new-refresh",
      localId: LOCAL_ID,
    });
    expect(s.store.loadSelectedConnection()).toEqual(updated);
    f.network.enqueue(
      TOKEN_ENDPOINT,
      json(
        tokenPayload({
          access_token: "synthetic-next-access",
          refresh_token: undefined,
          id_token: undefined,
        })
      )
    );
    const again = await lifecycle.refresh(APPROVED);
    expect(again.refreshToken).toBe(updated.refreshToken);
    expect(
      f.network.calls.filter((row) => row.url === TOKEN_ENDPOINT)
    ).toHaveLength(2);
  });
  it.each([
    [400, "invalid_grant", "reconnect_required", false],
    [503, "temporarily_unavailable", "temporary_failure", true],
  ] as const)(
    "classifies refresh HTTP %d and clears only terminal invalidation",
    async (status, remote, code, preserve) => {
      const s = storage();
      s.store.saveConnection(makeConnection());
      const f = makeOAuthFixture(s);
      f.network.enqueueDiscovery();
      f.network.enqueue(
        TOKEN_ENDPOINT,
        json({ error: remote, error_description: DETAIL }, status)
      );
      await expect(
        new OAuthLifecycle(f.deps).refresh(APPROVED)
      ).rejects.toMatchObject({ code, message: code });
      expect(s.store.loadSelectedConnection()).toEqual(
        preserve ? makeConnection() : undefined
      );
      expect(s.store.selectedRegistration()?.clientId).toBe(CLIENT);
    }
  );
  it("does not restore a late refresh result after sign-out", async () => {
    const s = storage();
    s.store.saveConnection(makeConnection());
    const f = makeOAuthFixture(s);
    const lifecycle = new OAuthLifecycle(f.deps);
    f.network.enqueueDiscovery();
    const started = Promise.withResolvers<void>();
    const late = Promise.withResolvers<Response>();
    f.network.enqueue(TOKEN_ENDPOINT, () => {
      started.resolve();
      return late.promise;
    });
    const refresh = lifecycle.refresh(APPROVED);
    const rejected = expect(refresh).rejects.toMatchObject({
      code: "cancelled",
    });
    await started.promise;
    f.network.enqueue(REVOKE, new Response(null, { status: 204 }));
    const signout = await lifecycle.signOut();
    await rejected;
    expect(signout.localCleared).toBe(true);
    late.resolve(
      json(
        tokenPayload({
          access_token: "synthetic-late-access",
          id_token: undefined,
        })
      )
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(s.store.loadSelectedConnection()).toBeUndefined();
  });
  it("clears local tokens even if remote revocation fails; says unconfirmed", async () => {
    const s = storage();
    s.store.saveConnection(makeConnection());
    const f = makeOAuthFixture(s);
    f.network.enqueueDiscovery();
    f.network.enqueue(REVOKE, json({ error: { message: DETAIL } }, 503));
    await expect(new OAuthLifecycle(f.deps).signOut()).resolves.toEqual({
      localCleared: true,
      remoteRevocation: "unconfirmed",
    });
    expect(s.store.loadSelectedConnection()).toBeUndefined();
    expect(s.store.selectedRegistration()?.clientId).toBe(CLIENT);
  });
});
