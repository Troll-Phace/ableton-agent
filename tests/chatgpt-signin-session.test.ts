import * as fs from "node:fs";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { TextDecoder } from "node:util";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OAuthLifecycle } from "../src/extension/feasibility/oauth.js";
import {
  FixtureController,
  createSigninRequestHandler,
  verifyPrivateStorage,
  type PrivateStorageDiagnosticReport,
  type FixtureUiState,
} from "../src/extension/feasibility/index.js";
import { SyntheticResponses } from "../src/extension/feasibility/responses.js";
import {
  SigninSession,
  type HostPreflightEvidence,
} from "../src/extension/feasibility/signin-session.js";
import {
  MODELS_ENDPOINT,
  RESPONSES_ENDPOINT,
  TOKEN_ENDPOINT,
  REQUESTED_SCOPES,
  DISCOVERY_ENDPOINT,
} from "../src/extension/feasibility/signin-contracts.js";
import {
  ACCESS,
  CLIENT,
  CODE,
  DETAIL,
  eventFrame,
  json,
  LOCAL_ID,
  makeConnection,
  makeOAuthFixture,
  makeStorage,
  NOW,
  pendingSse,
  REFRESH,
  REVOKE,
  sseText,
  SUBJECT,
  tokenPayload,
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
const ACTION = { operatorStarted: true };
const PLAN = {
  ...ACTION,
  planOnlyConfirmed: true,
  creditFallbackDisabled: true,
};
const HOST: HostPreflightEvidence = {
  nativeTransport: true,
  callbackBinding: true,
  privateStorage: true,
  bundledVerifier: true,
};
const MODELS = {
  models: [
    {
      visibility: "list",
      slug: "synthetic-model",
      display_name: "Synthetic model",
    },
    { visibility: "hidden", slug: "synthetic-hidden", display_name: "Hidden" },
  ],
};
function fixture(s = storage(), eligibilityBasisReady = true) {
  const f = makeOAuthFixture(s);
  const oauth = new OAuthLifecycle(f.deps);
  const responses = new SyntheticResponses({
    http: f.network.http,
    store: s.store,
    TextDecoder,
    clock: f.network.deps.clock,
  });
  const hostPreflight = vi.fn(() => Promise.resolve(HOST));
  const session = new SigninSession({
    eligibilityBasisReady,
    clock: f.network.deps.clock,
    oauth,
    responses,
    store: s.store,
    hostPreflight,
  });
  const preflight = async () => {
    f.network.enqueueDiscovery();
    f.network.enqueueJwks();
    return await session.preflight(ACTION);
  };
  const refresh = async () => {
    f.network.enqueue(
      TOKEN_ENDPOINT,
      json(tokenPayload({ id_token: undefined }))
    );
    return await session.refresh(ACTION);
  };
  const models = async () => {
    f.network.enqueue(MODELS_ENDPOINT, json(MODELS));
    return await session.loadModels(ACTION);
  };
  const ready = async () => {
    s.store.saveConnection(makeConnection());
    await preflight();
    await refresh();
    await models();
  };
  const roundtrip = async () => {
    f.network.enqueue(
      RESPONSES_ENDPOINT,
      sseText(
        eventFrame("response.completed", {
          response: {
            status: "completed",
            output: [
              {
                type: "function_call",
                id: "synthetic-item",
                call_id: "synthetic-call",
                namespace: "feasibility",
                name: "echo",
                arguments: '{"value":"p15_3"}',
                status: "completed",
              },
            ],
          },
        })
      )
    );
    f.network.enqueue(
      RESPONSES_ENDPOINT,
      sseText(
        eventFrame("response.completed", {
          response: {
            status: "completed",
            output: [
              {
                type: "message",
                id: "synthetic-msg",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "p15_3" }],
              },
            ],
          },
        })
      )
    );
    return await session.runRoundTrip(ACTION);
  };
  return {
    ...f,
    s,
    oauth,
    responses,
    hostPreflight,
    session,
    preflight,
    refresh,
    models,
    ready,
    roundtrip,
    requests: () =>
      f.network.calls.filter((row) => row.url === RESPONSES_ENDPOINT),
  };
}
function secretFree(value: unknown) {
  const encoded = JSON.stringify(value);
  for (const secret of [
    ACCESS,
    REFRESH,
    CLIENT,
    SUBJECT,
    LOCAL_ID,
    CODE,
    DETAIL,
    "synthetic-call",
    "synthetic-item",
    "synthetic-msg",
  ])
    expect(encoded).not.toContain(secret);
  for (const key of [
    "accessToken",
    "refreshToken",
    "clientId",
    "subject",
    "localId",
    "runId",
    "authorizationUrl",
    "idToken",
    "nonce",
    "verifier",
  ])
    expect(encoded).not.toContain('"' + key + '"');
}
describe("S5 session preflight, operator gates and persisted refresh", () => {
  it("blocks absent eligibility or operator action before all side effects", async () => {
    const f = fixture(storage(), false);
    expect(await f.session.preflight(ACTION)).toMatchObject({
      state: "blocked",
      code: "eligibility_pending",
      preflightReady: false,
    });
    expect(f.hostPreflight).not.toHaveBeenCalled();
    expect(f.network.calls).toHaveLength(0);
    expect(fs.readdirSync(f.s.base)).toEqual([]);
    const eligible = fixture();
    expect(
      await eligible.session.preflight({ operatorStarted: false })
    ).toMatchObject({ state: "blocked", code: "operator_required" });
    expect(eligible.hostPreflight).not.toHaveBeenCalled();
    expect(eligible.network.calls).toHaveLength(0);
    expect(await eligible.session.signIn(ACTION)).toMatchObject({
      code: "preflight_required",
    });
    expect(eligible.browser).not.toHaveBeenCalled();
    expect(eligible.requests()).toHaveLength(0);
  });
  it.each([
    "nativeTransport",
    "callbackBinding",
    "privateStorage",
    "bundledVerifier",
  ] as const)(
    "blocks if %s host preflight fails before discovery",
    async (key) => {
      const f = fixture();
      f.hostPreflight.mockResolvedValueOnce({ ...HOST, [key]: false });
      expect(await f.session.preflight(ACTION)).toMatchObject({
        state: "blocked",
        code: "host_preflight_failed",
        preflightReady: false,
        hostPreflight: { [key]: false },
      });
      expect(f.network.calls).toHaveLength(0);
      expect(f.browser).not.toHaveBeenCalled();
      expect(fs.readdirSync(f.s.base)).toEqual([]);
    }
  );
  it("sign-in creates protected connection but needs a persisted fresh-session load and refresh before inference", async () => {
    const f = fixture();
    expect(await f.preflight()).toMatchObject({
      state: "preflight_ready",
      attempts: 0,
      hasConnection: false,
    });
    f.enqueueSignin();
    const connected = await f.session.signIn(ACTION);
    expect(connected).toMatchObject({
      state: "connected",
      hasConnection: true,
      accountLabel: "Connection 1",
      persistedConnectionLoaded: false,
      refreshVerified: false,
      planScopeGranted: true,
      grantedScopes: [...REQUESTED_SCOPES],
    });
    secretFree(connected);
    expect(await f.session.refresh(ACTION)).toMatchObject({
      code: "restart_required",
      refreshVerified: false,
    });
    expect(await f.session.loadModels(ACTION)).toMatchObject({
      code: "refresh_required",
    });
    expect(f.requests()).toHaveLength(0);
    const restarted = fixture(f.s);
    expect(await restarted.preflight()).toMatchObject({
      state: "connected",
      persistedConnectionLoaded: true,
      refreshVerified: false,
    });
    expect(await restarted.refresh()).toMatchObject({
      state: "connected",
      code: "refreshed",
      refreshVerified: true,
    });
    expect(restarted.network.calls.map((row) => row.url)).toEqual([
      DISCOVERY_ENDPOINT,
      JWKS,
      TOKEN_ENDPOINT,
    ]);
    expect(await restarted.session.refresh(ACTION)).toMatchObject({
      code: "refresh_required",
    });
    expect(
      restarted.network.calls.filter((row) => row.url === TOKEN_ENDPOINT)
    ).toHaveLength(1);
    expect(restarted.requests()).toHaveLength(0);
  });
  it("reports missing plan scope from persisted record without sending model or inference requests", async () => {
    const f = fixture();
    f.s.store.saveConnection(
      makeConnection({ scopes: ["openid", "resource.invoke"] })
    );
    expect(await f.preflight()).toMatchObject({
      state: "plan_disabled",
      code: "plan_disabled",
      planScopeGranted: false,
    });
    expect(await f.session.refresh(ACTION)).toMatchObject({
      code: "plan_disabled",
    });
    expect(await f.session.loadModels(ACTION)).toMatchObject({
      code: "plan_disabled",
    });
    expect(f.network.calls.map((row) => row.url)).toEqual([
      DISCOVERY_ENDPOINT,
      JWKS,
    ]);
    expect(f.requests()).toHaveLength(0);
  });
  it("reports expired persisted identity and blocks models until explicit refresh", async () => {
    const f = fixture();
    f.s.store.saveConnection(makeConnection({ expiresAt: NOW }));
    expect(await f.preflight()).toMatchObject({
      state: "reconnect_required",
      code: "reconnect_required",
      refreshVerified: false,
    });
    expect(await f.session.runRoundTrip(ACTION)).toMatchObject({
      state: "reconnect_required",
    });
    expect(f.requests()).toHaveLength(0);
  });
  it("terminal refresh invalidation clears persisted tokens and blocks inference", async () => {
    const f = fixture();
    f.s.store.saveConnection(makeConnection());
    await f.preflight();
    f.network.enqueue(
      TOKEN_ENDPOINT,
      json({ error: "invalid_grant", error_description: DETAIL }, 400)
    );
    const failed = await f.session.refresh(ACTION);
    expect(failed).toMatchObject({
      state: "reconnect_required",
      hasConnection: false,
      refreshVerified: false,
      code: "reconnect_required",
    });
    expect(f.s.store.loadSelectedConnection()).toBeUndefined();
    expect(await f.session.runRoundTrip(ACTION)).toMatchObject({
      code: "reconnect_required",
    });
    expect(f.requests()).toHaveLength(0);
    secretFree(failed);
  });
});
describe("S5 guarded synthetic inference and immutable sanitized snapshots", () => {
  it("requires visible model selection plus separate plan-only and no-credit confirmation", async () => {
    const f = fixture();
    await f.ready();
    expect(await f.session.runRoundTrip(ACTION)).toMatchObject({
      code: "model_not_selected",
      attempts: 0,
    });
    expect(f.session.selectModel("synthetic-hidden", ACTION)).toMatchObject({
      code: "model_not_selected",
    });
    expect(f.session.selectModel("synthetic-model", ACTION)).toMatchObject({
      state: "model_selected",
      selectedModelSlug: "synthetic-model",
      planOnlyConfirmed: false,
    });
    expect(await f.session.runRoundTrip(ACTION)).toMatchObject({
      code: "plan_only_required",
      attempts: 0,
    });
    expect(
      f.session.confirmPlanOnly({ ...PLAN, creditFallbackDisabled: false })
    ).toMatchObject({ code: "plan_only_required", planOnlyConfirmed: false });
    expect(await f.session.runRoundTrip(ACTION)).toMatchObject({
      code: "plan_only_required",
      attempts: 0,
    });
    expect(f.session.confirmPlanOnly(PLAN)).toMatchObject({
      code: "plan_only_confirmed",
      planOnlyConfirmed: true,
      creditFallbackDisabled: true,
    });
    expect(f.session.selectModel("synthetic-model", ACTION)).toMatchObject({
      planOnlyConfirmed: false,
      creditFallbackDisabled: false,
    });
    expect(f.requests()).toHaveLength(0);
  });
  it("successfully gates exactly three requests and sign-out; projection has no raw identity, payloads, or secret values", async () => {
    const f = fixture();
    await f.ready();
    f.session.selectModel("synthetic-model", ACTION);
    f.session.confirmPlanOnly(PLAN);
    const roundtrip = await f.roundtrip();
    expect(roundtrip).toMatchObject({
      state: "roundtrip_complete",
      attempts: 2,
      roundtrip: {
        outcome: "pass",
        functionEchoValidated: true,
        finalMarkerAcknowledged: true,
      },
    });
    secretFree(roundtrip);
    f.network.enqueue(RESPONSES_ENDPOINT, (init) => {
      if (!init?.signal) throw new Error("Missing synthetic signal");
      return pendingSse(
        init.signal,
        eventFrame("response.output_text.delta", {
          delta: "Synthetic private response text",
        })
      ).response;
    });
    const finished = await f.session.runCancellation(ACTION);
    expect(finished).toMatchObject({
      state: "finished",
      code: "cancellation_demonstrated",
      attempts: 3,
      cancellation: {
        outcome: "pass",
        textDeltaObserved: true,
        abortRequested: true,
        pendingReadRejected: true,
        cleanupVerified: true,
      },
    });
    secretFree(finished);
    expect(JSON.stringify(finished)).not.toContain(
      "Synthetic private response text"
    );
    expect(await f.session.runCancellation(ACTION)).toMatchObject({
      code: "budget_exhausted",
    });
    expect(f.requests()).toHaveLength(3);
    f.network.enqueue(REVOKE, new Response(null, { status: 204 }));
    const signedOut = await f.session.signOut(ACTION);
    expect(signedOut).toMatchObject({
      state: "signed_out",
      attempts: 3,
      hasConnection: false,
      models: [],
      revocation: { localCleared: true, remoteRevocation: "request_accepted" },
    });
    secretFree(signedOut);
    expect(f.s.store.loadSelectedConnection()).toBeUndefined();
    expect(f.network.unexpected).toEqual([]);
  });
  it("snapshots are copies; malformed or private model fields at injected seam are rejected", async () => {
    const f = fixture();
    await f.ready();
    const snap = f.session.snapshot();
    const model = snap.models[0];
    if (!model) throw new Error("Missing synthetic model");
    model.displayName = "modified by consumer";
    snap.grantedScopes.push("unknown");
    expect(f.session.snapshot().models[0]?.displayName).toBe("Synthetic model");
    expect(f.session.snapshot().grantedScopes).not.toContain("unknown");
    vi.spyOn(f.responses, "loadCatalog").mockResolvedValueOnce([
      { slug: "synthetic-model", displayName: ACCESS },
    ]);
    const failed = await f.session.loadModels(ACTION);
    expect(failed).toMatchObject({ code: "catalog_invalid", models: [] });
    secretFree(failed);
    expect(f.requests()).toHaveLength(0);
  });
  it("does not treat injected passing evidence as success without durable counters and terminal proofs", async () => {
    const f = fixture();
    await f.ready();
    f.session.selectModel("synthetic-model", ACTION);
    f.session.confirmPlanOnly(PLAN);
    vi.spyOn(f.responses, "runRoundTrip").mockResolvedValueOnce({
      outcome: "pass",
      code: "roundtrip_complete",
      attempts: 2,
      functionEchoValidated: true,
      finalMarkerAcknowledged: true,
    });
    const result = await f.session.runRoundTrip(ACTION);
    expect(result).toMatchObject({
      state: "failed",
      code: "invalid_response",
      attempts: 0,
    });
    expect(f.requests()).toHaveLength(0);
    expect(await f.session.runCancellation(ACTION)).toMatchObject({
      code: "roundtrip_required",
    });
  });
  it("usage-limit and uncertain request remain stopped; no automatic refresh or replay", async () => {
    const f = fixture();
    await f.ready();
    f.session.selectModel("synthetic-model", ACTION);
    f.session.confirmPlanOnly(PLAN);
    f.network.enqueue(
      RESPONSES_ENDPOINT,
      json({ error: { message: DETAIL } }, 429)
    );
    const failed = await f.session.runRoundTrip(ACTION);
    expect(failed).toMatchObject({
      state: "blocked",
      code: "usage_limited",
      attempts: 1,
    });
    secretFree(failed);
    expect(await f.session.runRoundTrip(ACTION)).toMatchObject({
      code: "attempt_order_invalid",
      attempts: 1,
    });
    expect(f.requests()).toHaveLength(1);
    expect(
      f.network.calls.filter((row) => row.url === TOKEN_ENDPOINT)
    ).toHaveLength(1);
  });
  it("cancels pending catalog and ignores its late result; concurrent actions do not overlap", async () => {
    const f = fixture();
    f.s.store.saveConnection(makeConnection());
    await f.preflight();
    await f.refresh();
    const started = Promise.withResolvers<void>();
    const late = Promise.withResolvers<Response>();
    f.network.enqueue(MODELS_ENDPOINT, () => {
      started.resolve();
      return late.promise;
    });
    const pending = f.session.loadModels(ACTION);
    await started.promise;
    expect(await f.session.loadModels(ACTION)).toMatchObject({
      code: "operation_busy",
      busy: true,
    });
    expect(f.session.cancel()).toMatchObject({
      state: "cancelled",
      code: "cancelled",
      models: [],
    });
    await pending;
    late.resolve(json(MODELS));
    await Promise.resolve();
    await Promise.resolve();
    expect(f.session.snapshot()).toMatchObject({
      state: "cancelled",
      models: [],
    });
    expect(f.requests()).toHaveLength(0);
    expect(
      f.network.calls.filter((row) => row.url === MODELS_ENDPOINT)
    ).toHaveLength(1);
  });
  it("permits authorized local cleanup when eligibility gate is unavailable, without remote request", async () => {
    const f = fixture(storage(), false);
    f.s.store.saveConnection(makeConnection());
    expect(await f.session.signOut({ operatorStarted: false })).toMatchObject({
      code: "operator_required",
    });
    expect(f.s.store.loadSelectedConnection()).toBeDefined();
    expect(await f.session.signOut(ACTION)).toMatchObject({
      state: "signed_out",
      revocation: { localCleared: true, remoteRevocation: "unconfirmed" },
    });
    expect(f.s.store.loadSelectedConnection()).toBeUndefined();
    expect(f.network.calls).toHaveLength(0);
  });
  it("normalizes raw host error at seam to a fixed code only", async () => {
    const f = fixture();
    f.hostPreflight.mockRejectedValueOnce(new Error(DETAIL));
    const result = await f.session.preflight(ACTION);
    expect(result).toMatchObject({ state: "failed", code: "network_failed" });
    secretFree(result);
  });
});

describe("S5 bundle graph isolation", () => {
  it("bundles the actual package entry with only its reviewed SDK and maintained verifier closure", async () => {
    const graph = await actualEntryBuild();
    const inputs = Object.keys(graph.metafile.inputs);
    const dependencyNames = [
      ...new Set(
        inputs
          .filter((path) => path.startsWith("node_modules/"))
          .map((path) =>
            path.startsWith("node_modules/@ableton-extensions/sdk/")
              ? "@ableton-extensions/sdk"
              : path.split("/")[1]
          )
      ),
    ].sort();
    expect(dependencyNames).toEqual(
      [
        "@ableton-extensions/sdk",
        "buffer-equal-constant-time",
        "ecdsa-sig-formatter",
        "jsonwebtoken",
        "jwa",
        "jws",
        "lodash.includes",
        "lodash.isboolean",
        "lodash.isinteger",
        "lodash.isnumber",
        "lodash.isplainobject",
        "lodash.isstring",
        "lodash.once",
        "ms",
        "safe-buffer",
        "semver",
      ].sort()
    );
    expect(
      inputs.filter(
        (path) =>
          !path.startsWith("node_modules/") &&
          !path.startsWith("src/extension/feasibility/") &&
          path !== "signin-feasibility-entry.ts"
      )
    ).toEqual([]);
  });

  it("sign-in module graph has only standalone fixture files and documented Node builtins", async () => {
    const paths = [
      "signin-session",
      "oauth",
      "credential-store",
      "id-token",
      "responses",
      "official-http",
    ];
    const graph = await build({
      entryPoints: paths.map(
        (name) => "src/extension/feasibility/" + name + ".ts"
      ),
      outdir: "unused",
      bundle: true,
      platform: "node",
      format: "cjs",
      metafile: true,
      write: false,
      logLevel: "silent",
    });
    const inputs = Object.keys(graph.metafile.inputs);
    for (const name of paths)
      expect(inputs).toContain("src/extension/feasibility/" + name + ".ts");
    expect(
      inputs.filter((path) => !path.startsWith("src/extension/feasibility/"))
    ).toEqual([]);
    const imports = Object.values(graph.metafile.inputs).flatMap((input) =>
      input.imports.filter((item) => item.external).map((item) => item.path)
    );
    expect(
      imports.filter(
        (name) =>
          ![
            "node:fs",
            "node:path",
            "node:crypto",
            "node:http",
            "node:url",
            "node:util",
            "node:child_process",
          ].includes(name)
      )
    ).toEqual([]);
    const production = await build({
      entryPoints: ["src/extension/index.ts"],
      bundle: true,
      platform: "node",
      format: "cjs",
      loader: { ".html": "text" },
      metafile: true,
      write: false,
      logLevel: "silent",
    });
    expect(
      Object.keys(production.metafile.inputs).filter(
        (path) =>
          path.includes("/feasibility/") || path.includes("/jsonwebtoken/")
      )
    ).toEqual([]);
  });
});

const MODAL_ORIGIN = "http://127.0.0.1:12345";
const TEST_NONCE = "a".repeat(64);
const OTHER_NONCE = "b".repeat(64);
type ModalListener = (req: IncomingMessage, res: ServerResponse) => void;
function fakeRequest(
  listener: ModalListener,
  method: string,
  url: string,
  origin = MODAL_ORIGIN,
  headers: Record<string, string | undefined> = {}
) {
  const reply = { status: 0, headers: {} as Record<string, string>, body: "" };
  const response = {
    writeHead(status: number, fields?: Record<string, string>) {
      reply.status = status;
      reply.headers = fields ?? {};
      return this;
    },
    end(body?: string) {
      reply.body = body ?? "";
      return this;
    },
  };
  listener(
    {
      method,
      url,
      headers: { host: new URL(origin).host, origin, ...headers },
    } as IncomingMessage,
    response as unknown as ServerResponse
  );
  return reply;
}
function modal(controller: FixtureController, nonce = TEST_NONCE) {
  const html = fs.readFileSync(
    "src/extension/feasibility/signin-view.html",
    "utf8"
  );
  const listener = createSigninRequestHandler(
    controller,
    nonce,
    () => MODAL_ORIGIN,
    html
  );
  return {
    get: (route: string) => fakeRequest(listener, "GET", `/${nonce}/${route}`),
    post: (route: string) =>
      fakeRequest(listener, "POST", `/${nonce}/${route}`),
    listener,
    html,
  };
}
async function settle(controller: FixtureController) {
  await vi.waitFor(
    () => expect(controller.snapshot().snapshot?.busy).toBe(false),
    { timeout: 1500, interval: 5 }
  );
  await controller.modalClosed();
}

describe("S4 integrated nonce modal and per-activation continuity", () => {
  it("makes status polling read-only and rejects nonmatching nonce, origin, method, body, and unknown fixed actions", async () => {
    const f = fixture();
    const controller = new FixtureController({
      session: f.session,
      hasPriorRegistration: () => !!f.s.store.selectedRegistration(),
    });
    const driver = modal(controller);
    const page = driver.get("");
    expect(page.status).toBe(200);
    expect(page.headers["Content-Security-Policy"]).toContain(
      "connect-src 'self'"
    );
    expect(page.body).toContain("Continue with ChatGPT");
    expect(driver.get("status").status).toBe(200);
    expect(driver.get("signin").status).toBe(404);
    for (const request of [
      fakeRequest(driver.listener, "POST", `/${OTHER_NONCE}/preflight`),
      fakeRequest(
        driver.listener,
        "POST",
        `/${TEST_NONCE}/preflight`,
        MODAL_ORIGIN,
        { origin: "http://127.0.0.1:54321" }
      ),
      fakeRequest(
        driver.listener,
        "POST",
        `/${TEST_NONCE}/preflight`,
        MODAL_ORIGIN,
        { host: "127.0.0.1:54321" }
      ),
      fakeRequest(
        driver.listener,
        "POST",
        `/${TEST_NONCE}/preflight`,
        MODAL_ORIGIN,
        { "content-length": "3" }
      ),
      fakeRequest(
        driver.listener,
        "POST",
        `/${TEST_NONCE}/preflight`,
        MODAL_ORIGIN,
        { "transfer-encoding": "chunked" }
      ),
      driver.post("unexpected-action"),
    ])
      expect(request.status).toBe(404);
    expect(f.hostPreflight).not.toHaveBeenCalled();
    expect(f.network.calls).toHaveLength(0);
    expect(f.browser).not.toHaveBeenCalled();
    expect(driver.post("signin").status).toBe(200);
    await settle(controller);
    expect(controller.snapshot().snapshot).toMatchObject({
      code: "preflight_required",
    });
    expect(f.browser).not.toHaveBeenCalled();
    expect(f.network.calls).toHaveLength(0);
    secretFree(JSON.parse(driver.get("status").body) as unknown);
  });

  it("preflight failure cannot open consent even when a fixed action is explicitly requested", async () => {
    const f = fixture();
    const controller = new FixtureController({
      session: f.session,
      hasPriorRegistration: () => false,
    });
    const driver = modal(controller);
    f.hostPreflight.mockResolvedValueOnce({ ...HOST, bundledVerifier: false });
    expect(driver.post("preflight").status).toBe(200);
    await settle(controller);
    expect(controller.snapshot().snapshot).toMatchObject({
      code: "host_preflight_failed",
      preflightReady: false,
    });
    driver.post("signin");
    await settle(controller);
    expect(controller.snapshot().snapshot).toMatchObject({
      code: "preflight_required",
    });
    expect(f.browser).not.toHaveBeenCalled();
    expect(f.network.calls).toHaveLength(0);
  });

  it("preserves sign-in and welcome dismissal over modal closure, without manufacturing restart evidence", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const f = fixture();
    const controller = new FixtureController({
      session: f.session,
      hasPriorRegistration: () => !!f.s.store.selectedRegistration(),
    });
    let driver = modal(controller);
    f.network.enqueueDiscovery();
    f.network.enqueueJwks();
    driver.post("preflight");
    await settle(controller);
    expect(controller.snapshot().snapshot?.state).toBe("preflight_ready");
    f.enqueueSignin();
    driver.post("signin");
    await settle(controller);
    expect(controller.snapshot()).toMatchObject({
      welcomeVisible: true,
      snapshot: {
        state: "connected",
        persistedConnectionLoaded: false,
        refreshVerified: false,
      },
    });
    expect(driver.post("dismiss-welcome").status).toBe(200);
    expect(controller.snapshot().welcomeVisible).toBe(false);
    await controller.modalClosed();
    // New modal nonce, same activation/controller and persisted data.
    driver = modal(controller, OTHER_NONCE);
    expect(driver.get("status").status).toBe(200);
    expect(
      fakeRequest(driver.listener, "GET", `/${TEST_NONCE}/status`).status
    ).toBe(404);
    expect(controller.snapshot()).toMatchObject({
      welcomeVisible: false,
      snapshot: {
        state: "connected",
        persistedConnectionLoaded: false,
        refreshVerified: false,
      },
    });
    driver.post("preflight");
    await settle(controller);
    expect(f.hostPreflight).toHaveBeenCalledTimes(1);
    driver.post("refresh");
    await settle(controller);
    expect(controller.snapshot().snapshot).toMatchObject({
      code: "restart_required",
      persistedConnectionLoaded: false,
      refreshVerified: false,
    });
    expect(
      f.network.calls.filter((row) => row.url === TOKEN_ENDPOINT)
    ).toHaveLength(1);
    const restarted = fixture(f.s);
    const freshController = new FixtureController({
      session: restarted.session,
      hasPriorRegistration: () => true,
    });
    const freshModal = modal(freshController);
    restarted.network.enqueueDiscovery();
    restarted.network.enqueueJwks();
    freshModal.post("preflight");
    await settle(freshController);
    expect(freshController.snapshot()).toMatchObject({
      welcomeVisible: false,
      snapshot: { state: "connected", persistedConnectionLoaded: true },
    });
    restarted.network.enqueue(
      TOKEN_ENDPOINT,
      json(tokenPayload({ id_token: undefined }))
    );
    freshModal.post("refresh");
    await settle(freshController);
    expect(freshController.snapshot().snapshot).toMatchObject({
      refreshVerified: true,
    });
    secretFree(JSON.parse(freshModal.get("status").body) as unknown);
    secretFree(info.mock.calls);
    expect(f.requests()).toHaveLength(0);
    expect(restarted.requests()).toHaveLength(0);
  });

  it("modal closure cancels a pending action without silently signing out or restoring late state", async () => {
    const f = fixture();
    f.s.store.saveConnection(makeConnection());
    await f.preflight();
    await f.refresh();
    const controller = new FixtureController({
      session: f.session,
      hasPriorRegistration: () => true,
    });
    const driver = modal(controller);
    const started = Promise.withResolvers<void>();
    const late = Promise.withResolvers<Response>();
    f.network.enqueue(MODELS_ENDPOINT, () => {
      started.resolve();
      return late.promise;
    });
    expect(driver.post("models").status).toBe(200);
    await started.promise;
    expect(driver.post("models").status).toBe(409);
    await controller.modalClosed();
    late.resolve(json(MODELS));
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.snapshot().snapshot).toMatchObject({
      state: "cancelled",
      models: [],
      hasConnection: true,
    });
    expect(f.s.store.loadSelectedConnection()).toBeDefined();
    expect(
      f.network.calls.filter((row) => row.url === MODELS_ENDPOINT)
    ).toHaveLength(1);
    expect(f.network.calls.some((row) => row.url === REVOKE)).toBe(false);
  });
});

class FakeElement {
  disabled = true;
  hidden = false;
  checked = false;
  value = "";
  textContent = "";
  children: unknown[] = [];
  private listeners = new Map<string, (() => void)[]>();
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  replaceChildren(...children: unknown[]) {
    this.children = children;
  }
  append(child: unknown) {
    this.children.push(child);
  }
  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
  click() {
    if (!this.disabled) this.emit("click");
  }
}
function modelView(controller: FixtureController) {
  const driver = modal(controller);
  const elements = new Map<string, FakeElement>();
  for (const match of driver.html.matchAll(/id="([^"]+)"/g))
    if (match[1]) elements.set(match[1], new FakeElement());
  const byId = (id: string) => {
    const node = elements.get(id);
    if (!node) throw Error("Unknown fake element");
    return node;
  };
  const calls: string[] = [];
  const fetch = vi.fn((route: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    calls.push(method + " " + route);
    const reply = method === "POST" ? driver.post(route) : driver.get(route);
    return Promise.resolve({
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: () => Promise.resolve(JSON.parse(reply.body) as unknown),
    });
  });
  const script = /<script>([\s\S]*?)<\/script>/.exec(driver.html)?.[1];
  if (!script) throw Error("Missing fixture script");
  const sandbox = {
    document: {
      getElementById: byId,
      querySelectorAll: () => [...elements.values()],
    },
    Option: class {
      constructor(
        readonly text: string,
        readonly value: string
      ) {}
    },
    fetch,
    setTimeout: vi.fn(), // polling is manually delivered through the same handler
    render: undefined as ((value: FixtureUiState) => void) | undefined,
  };
  runInNewContext(script, sandbox);
  const render = () => sandbox.render?.(controller.snapshot());
  const flush = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return { byId, calls, fetch, render, flush };
}

describe("S4 actual webview script owner controls (no browser)", () => {
  it("requires visible model selection and both explicit checkbox confirmations before inference becomes clickable", async () => {
    const f = fixture();
    await f.ready();
    const controller = new FixtureController({
      session: f.session,
      hasPriorRegistration: () => true,
    });
    const view = modelView(controller);
    await view.flush();
    const node = view.byId;
    expect(node("roundtrip").disabled).toBe(true);
    expect(node("confirm").disabled).toBe(true);
    expect(node("usage-row").hidden).toBe(false);
    expect(node("plan-indicator").hidden).toBe(false);
    node("model").value = "synthetic-model";
    node("model").emit("change");
    expect(node("select-model").disabled).toBe(false);
    node("select-model").click();
    await view.flush();
    view.render();
    expect(controller.snapshot().snapshot?.selectedModelSlug).toBe(
      "synthetic-model"
    );
    expect(node("confirm").disabled).toBe(true);
    node("plan-only").checked = true;
    node("plan-only").emit("change");
    node("confirm").click();
    await view.flush();
    expect(view.calls).not.toContain("POST confirm-plan-only");
    expect(node("roundtrip").disabled).toBe(true);
    node("credits-off").checked = true;
    node("credits-off").emit("change");
    expect(node("confirm").disabled).toBe(false);
    node("confirm").click();
    await view.flush();
    view.render();
    expect(
      view.calls.filter((call) => call === "POST confirm-plan-only")
    ).toHaveLength(1);
    expect(controller.snapshot().snapshot).toMatchObject({
      planOnlyConfirmed: true,
      creditFallbackDisabled: true,
    });
    expect(node("roundtrip").disabled).toBe(false);
    expect(f.requests()).toHaveLength(0);
    expect(view.calls.some((call) => call === "POST roundtrip")).toBe(false);
    node("credits-off").checked = false;
    node("credits-off").emit("change");
    expect(node("roundtrip").disabled).toBe(true);
    secretFree(JSON.parse(node("evidence").textContent) as unknown);
  });
  it("does not enable consent in an uninitialized or preflight-blocked session", async () => {
    const f = fixture(storage(), false);
    const controller = new FixtureController({
      session: f.session,
      hasPriorRegistration: () => false,
    });
    const view = modelView(controller);
    await view.flush();
    expect(view.byId("preflight").disabled).toBe(true);
    expect(view.byId("signin").disabled).toBe(true);
    view.byId("signin").click();
    await view.flush();
    expect(view.calls).toEqual(["GET status"]);
    expect(f.browser).not.toHaveBeenCalled();
    expect(f.network.calls).toHaveLength(0);
    const empty = modelView(
      new FixtureController(undefined, "native_unavailable")
    );
    await empty.flush();
    expect(empty.byId("signin").disabled).toBe(true);
    expect(empty.byId("status").textContent).toContain("native_unavailable");
  });
});

/** Build the actual packager adapter, without running the packaging script or writing files. */
async function actualEntryBuild() {
  const cwd = process.cwd();
  const script = fs.readFileSync(
    "scripts/build-chatgpt-feasibility.ts",
    "utf8"
  );
  const adapter = /const adapterEntry = `([\s\S]*?)`;/u.exec(script)?.[1];
  if (!adapter) throw Error("Missing actual fixture adapter");
  const html = fs
    .readFileSync("src/extension/feasibility/signin-view.html", "utf8")
    .replaceAll("{{FIXTURE_VERSION}}", "0.0.3")
    .replaceAll("{{BUILD_ID}}", "f3-offline-test");
  return await build({
    absWorkingDir: cwd,
    stdin: {
      contents: adapter,
      resolveDir: cwd,
      sourcefile: "signin-feasibility-entry.ts",
      loader: "ts",
    },
    outfile: "extension.js",
    bundle: true,
    platform: "node",
    format: "cjs",
    supported: { "dynamic-import": false },
    define: {
      __FEASIBILITY_WEBVIEW__: JSON.stringify(html),
      __FEASIBILITY_BUILD_ID__: JSON.stringify("f3-offline-test"),
    },
    sourcemap: false,
    legalComments: "eof",
    metafile: true,
    write: false,
    logLevel: "silent",
  });
}
class FakePackageServer extends EventEmitter {
  listening = false;
  constructor(
    readonly listener: ModalListener,
    readonly port: number
  ) {
    super();
  }
  listen(port: number, host: string, onListening: () => void) {
    if (port !== 0 || host !== "127.0.0.1")
      throw Error("Unexpected synthetic bind");
    this.listening = true;
    queueMicrotask(onListening);
    return this;
  }
  address() {
    return this.listening
      ? { address: "127.0.0.1", port: this.port, family: "IPv4" }
      : null;
  }
  close(callback?: () => void) {
    this.listening = false;
    callback?.();
    return this;
  }
  closeAllConnections() {}
  closeIdleConnections() {}
}
describe("S4 actual package adapter (in-memory CJS, fake host)", () => {
  it("activates the actual entry lazily, blocks consent before preflight, and executes bundled signature preflight without provider/browser access", async () => {
    const f = storage();
    const graph = await actualEntryBuild();
    const bundle = graph.outputFiles[0]?.text;
    if (!bundle) throw Error("Missing CJS output");
    const module = { exports: {} as unknown };
    const servers: FakePackageServer[] = [];
    const calls: string[] = [];
    const fakeFetch = vi.fn((input: unknown) => {
      if (typeof input !== "string") throw Error("Unexpected synthetic fetch");
      calls.push(input);
      return Promise.reject(new Error(DETAIL));
    });
    const loadBuiltin = createRequire(import.meta.url);
    const child = vi.fn(() => {
      throw Error("Real browser forbidden in test");
    });
    const allowed = new Set([
      "buffer",
      "crypto",
      "node:crypto",
      "node:fs",
      "node:path",
      "node:stream/web",
      "node:url",
      "node:util",
      "stream",
      "util",
    ]);
    const logs = vi.fn();
    const require = vi.fn((name: string): unknown => {
      if (name === "node:http")
        return {
          createServer: (listener: ModalListener) => {
            const server = new FakePackageServer(
              listener,
              12345 + servers.length
            );
            servers.push(server);
            return server;
          },
        };
      if (name === "node:child_process") {
        child();
        throw Error("Unexpected child-process request");
      }
      if (!allowed.has(name)) throw Error("Unexpected external builtin");
      return loadBuiltin(name) as unknown;
    });
    runInNewContext(bundle, {
      module,
      exports: module.exports,
      require,
      console: { info: logs, warn: logs, error: logs },
      Buffer,
      AbortController,
      TextDecoder,
      URL,
      ReadableStream,
      fetch: fakeFetch,
      process: {
        getuid: () => f.deps.uid,
        versions: { node: process.versions.node },
        version: process.version,
        platform: process.platform,
      },
      setTimeout,
      clearTimeout,
      queueMicrotask,
    });
    const exported = module.exports;
    if (
      typeof exported !== "object" ||
      exported === null ||
      !("activate" in exported) ||
      typeof exported.activate !== "function"
    )
      throw Error("Missing packaged activate export");
    const activate = exported.activate as (context: object) => void;
    const txn = vi.fn(() => {
      throw Error("No SDK transactions allowed");
    });
    const command = Promise.withResolvers<() => void>();
    const modalOpened = Promise.withResolvers<{
      url: string;
      close: () => void;
    }>();
    const contextAction = vi.fn(
      (
        _scope: string,
        _title: string,
        _command: string,
        callback: (unregister: () => void) => void
      ) => callback(() => undefined)
    );
    activate({
      initializeExtensionHost: () => ({
        dataModel: {
          getRoot: () => ({ id: 1n }),
          getObjectIsOfClass: (_handle: unknown, cls: string) =>
            cls === "Application",
          withinTransaction: txn,
        },
        commands: {
          registerCommand: (_id: string, callback: () => void) =>
            command.resolve(callback),
        },
        environment: { storageDirectory: f.base },
        resources: {},
        ui: {
          registerContextMenuAction: contextAction,
          showModalDialog: (
            url: string,
            _w: number,
            _h: number,
            close: () => void
          ) => modalOpened.resolve({ url, close }),
        },
      }),
    });
    expect(fakeFetch).not.toHaveBeenCalled();
    expect(require).not.toHaveBeenCalled();
    expect(fs.readdirSync(f.base)).toEqual([]);
    const run = await command.promise;
    run();
    const opened = await modalOpened.promise;
    try {
      const url = new URL(opened.url);
      const origin = url.origin;
      const root = url.pathname;
      const server = servers[0];
      if (!server) throw Error("Missing synthetic modal server");
      const read = () =>
        JSON.parse(
          fakeRequest(server.listener, "GET", root + "status", origin).body
        ) as FixtureUiState;
      expect(read()).toMatchObject({
        version: "0.0.3",
        buildId: "f3-offline-test",
        snapshot: {
          eligibilityBasisReady: true,
          state: "idle",
          preflightReady: false,
        },
      });
      expect(fakeFetch).not.toHaveBeenCalled();
      expect(child).not.toHaveBeenCalled();
      expect(
        fakeRequest(server.listener, "POST", root + "signin", origin).status
      ).toBe(200);
      await vi.waitFor(
        () =>
          expect(read().snapshot).toMatchObject({
            code: "preflight_required",
            busy: false,
          }),
        { timeout: 1500, interval: 5 }
      );
      expect(fakeFetch).not.toHaveBeenCalled();
      expect(
        fakeRequest(server.listener, "POST", root + "preflight", origin).status
      ).toBe(200);
      await vi.waitFor(
        () =>
          expect(read().snapshot).toMatchObject({
            state: "blocked",
            code: "host_preflight_failed",
            busy: false,
            hostPreflight: {
              nativeTransport: false,
              callbackBinding: true,
              privateStorage: true,
              bundledVerifier: true,
            },
          }),
        { timeout: 2500, interval: 10 }
      );
      expect(calls).toHaveLength(2);
      expect(
        calls.every((url) =>
          /^http:\/\/127\.0\.0\.1:\d+\/compat-(stream|abort)$/.test(url)
        )
      ).toBe(true);
      expect(child).not.toHaveBeenCalled();
      expect(txn).not.toHaveBeenCalled();
      expect(contextAction).toHaveBeenCalledTimes(1);
      secretFree(read());
      secretFree(logs.mock.calls);
    } finally {
      opened.close();
      await vi.waitFor(
        () => expect(servers.every((server) => !server.listening)).toBe(true),
        { timeout: 1500, interval: 5 }
      );
    }
  });
});

describe("S5 protected-storage diagnostic preflight stop", () => {
  it("classifies denied durable sync at write_sync, cleans its file and closes the gate before consent", async () => {
    const f = fixture();
    const tempId = "22222222-2222-4222-8222-222222222222";
    const rawContent = "synthetic-private-diagnostic-content";
    const randomUUID = vi
      .fn()
      .mockReturnValueOnce(LOCAL_ID)
      .mockReturnValueOnce(tempId);
    const fsyncSync = vi.fn<typeof fs.fsyncSync>((fd) => {
      // The real test-only descriptor contains bytes and has the private mode.
      const stat = fs.fstatSync(fd);
      expect(stat.size).toBeGreaterThan(0);
      expect(stat.mode & 0o777).toBe(0o600);
      expect(
        fs.readFileSync(f.s.file(".host.json." + tempId + ".tmp"), "utf8")
      ).toContain(LOCAL_ID);
      throw Object.assign(
        new Error(DETAIL + " " + f.s.base + " " + rawContent),
        {
          code: "ERR_ACCESS_DENIED",
          path: f.s.base,
          content: rawContent,
        }
      );
    });
    const closeSync = vi.fn<typeof fs.closeSync>((fd) => fs.closeSync(fd));
    const unlinkSync = vi.fn<typeof fs.unlinkSync>((name) =>
      fs.unlinkSync(name)
    );
    const renameSync = vi.fn<typeof fs.renameSync>((from, to) =>
      fs.renameSync(from, to)
    );
    let diagnostic: PrivateStorageDiagnosticReport | undefined;
    f.hostPreflight.mockImplementationOnce(() => {
      diagnostic = verifyPrivateStorage(f.s.base, {
        ...f.s.deps,
        randomUUID: randomUUID as () => string,
        fs: { ...fs, fsyncSync, closeSync, unlinkSync, renameSync },
      });
      return Promise.resolve({ ...HOST, privateStorage: diagnostic.verified });
    });
    const blocked = await f.session.preflight(ACTION);
    expect(blocked).toMatchObject({
      state: "blocked",
      code: "host_preflight_failed",
      preflightReady: false,
      hostPreflight: {
        nativeTransport: true,
        callbackBinding: true,
        privateStorage: false,
        bundledVerifier: true,
      },
      hasConnection: false,
      attempts: null,
    });
    if (!diagnostic)
      throw new Error("Expected actual protected-storage diagnostic");
    expect(diagnostic.verified).toBe(false);
    expect(diagnostic.truncated).toBe(false);
    expect(diagnostic.lastFailure).toEqual({
      phase: "ensure_host_id",
      stage: "write_sync",
      outcome: "blocked",
      code: "permission_denied",
    });
    for (const stage of [
      "root_metadata",
      "directory_metadata",
      "directory_list",
      "write_flags",
      "write_open",
      "write_fstat",
      "write_bytes",
      "file_metadata",
      "write_close",
      "cleanup_metadata",
      "cleanup_unlink",
      "cleanup_absence",
      "cleanup",
    ]) {
      expect(diagnostic.rows).toContainEqual({
        phase: "ensure_host_id",
        stage,
        outcome: "pass",
        code: "verified",
      });
    }
    expect(diagnostic.rows.some((row) => row.stage === "write_rename")).toBe(
      false
    );
    for (const row of diagnostic.rows) {
      expect(Object.keys(row).sort()).toEqual([
        "code",
        "outcome",
        "phase",
        "stage",
      ]);
    }
    const serialized = JSON.stringify({ diagnostic, blocked });
    for (const forbidden of [
      f.s.base,
      f.s.directory,
      LOCAL_ID,
      tempId,
      DETAIL,
      rawContent,
      "ERR_ACCESS_DENIED",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(fsyncSync).toHaveBeenCalledTimes(1);
    expect(closeSync).toHaveBeenCalledTimes(1);
    expect(closeSync.mock.calls[0]?.[0]).toBe(fsyncSync.mock.calls[0]?.[0]);
    expect(renameSync).not.toHaveBeenCalled();
    expect(unlinkSync).toHaveBeenCalledExactlyOnceWith(
      f.s.file(".host.json." + tempId + ".tmp")
    );
    expect(fs.readdirSync(f.s.directory)).toEqual([]);
    expect(await f.session.signIn(ACTION)).toMatchObject({
      state: "blocked",
      code: "preflight_required",
    });
    expect(await f.session.runRoundTrip(ACTION)).toMatchObject({
      state: "blocked",
      code: "preflight_required",
    });
    expect(f.network.calls).toHaveLength(0);
    expect(f.browser).not.toHaveBeenCalled();
    expect(f.callbacks.open).not.toHaveBeenCalled();
  });
});
