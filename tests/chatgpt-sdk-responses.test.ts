import * as fs from "node:fs";
import { createContext, runInContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProbeCancellation } from "../src/extension/feasibility/contracts.js";
import {
  MODELS_ENDPOINT,
  RESPONSES_ENDPOINT,
  TOKEN_ENDPOINT,
  SigninFault,
} from "../src/extension/feasibility/signin-contracts.js";
import type { InferenceContext } from "../src/extension/feasibility/responses.js";
import {
  SdkResponses,
  SDK_EXPERIMENT,
  type SdkDiagnosticAuthorization,
} from "../src/companion-feasibility/sdk-responses.js";
import { createCompanionRuntime } from "../src/companion-feasibility/runtime.js";
import { createCompanionStorage } from "../src/companion-feasibility/storage.js";
import { CompanionPreflight } from "../src/companion-feasibility/preflight.js";
import { parseControlAction } from "../src/companion-feasibility/contracts.js";
import {
  DiagnosticBudget,
  DIAGNOSTIC_BUDGET_FILE,
  DIAGNOSTIC_AUTHORIZATION_FILE,
} from "../src/companion-feasibility/diagnostic-budget.js";
import { companionHome, runtimeFixture } from "./fixtures/chatgpt-companion.js";
import {
  ACCESS,
  REFRESH,
  eventFrame,
  json,
  makeConnection,
  NOW,
  REVOKE,
  testClock,
  tokenPayload,
} from "./fixtures/chatgpt-signin.js";
import {
  SDK_MARKER,
  SDK_MODEL,
  SDK_SENTINEL,
  sdkCompleted,
  sdkContext,
  sdkDelta,
  sdkFailure,
  sdkFetch,
  sdkStream,
  stalledSdkStream,
} from "./fixtures/chatgpt-sdk-responses.js";

function adapter(fetch: typeof globalThis.fetch, context = sdkContext()) {
  const reserve = vi.fn(() => true);
  const isAuthorized = vi.fn(() => true);
  const assertFrozenBudgets = vi.fn();
  const sdk = new SdkResponses({
    fetch,
    AbortController,
    clock: testClock(),
    loadConnection: () => context.connection,
    assertFrozenBudgets,
    authorization: { reserve, isAuthorized },
  });
  return {
    sdk,
    reserve,
    isAuthorized,
    assertFrozenBudgets,
    run: (input: InferenceContext = context) => sdk.run(input, true),
  };
}

function noPrivate(value: unknown) {
  const encoded = JSON.stringify(value);
  for (const secret of [
    ACCESS,
    REFRESH,
    SDK_SENTINEL,
    SDK_MARKER,
    SDK_MODEL,
    RESPONSES_ENDPOINT,
  ])
    expect(encoded).not.toContain(secret);
}

const disposals: (() => void)[] = [];
const ACTION = { operatorStarted: true };
const PLAN = {
  ...ACTION,
  planOnlyConfirmed: true,
  creditFallbackDisabled: true,
};

function checkpointHome() {
  const h = companionHome();
  disposals.push(h.dispose);
  const storage = createCompanionStorage(h.deps);
  storage.store.saveConnection(makeConnection());
  expect(storage.store.reserveInferenceAttempt().attempts).toBe(1);
  const oldBudget = new DiagnosticBudget(
    createCompanionStorage(h.deps, true).diagnosticRecords()
  );
  oldBudget.authorize(true);
  oldBudget.reserve();
  const frozen = [
    "run-budget.json",
    DIAGNOSTIC_BUDGET_FILE,
    DIAGNOSTIC_AUTHORIZATION_FILE,
  ].map((name) => ({ name, contents: fs.readFileSync(h.file(name)) }));
  const unchanged = () => {
    for (const { name, contents } of frozen)
      expect(fs.readFileSync(h.file(name))).toEqual(contents);
  };
  return { ...h, unchanged };
}

function checkpointRuntime(
  h: ReturnType<typeof checkpointHome>,
  sdkAuthorization?: SdkDiagnosticAuthorization
) {
  // The real companion preflight/loopback transport has dedicated tests. This
  // seam isolates SDK/session integration and needs no native sockets at all.
  vi.spyOn(CompanionPreflight.prototype, "run").mockResolvedValue({
    nativeTransport: true,
    callbackBinding: true,
    privateStorage: true,
    bundledVerifier: true,
  });
  const fixture = runtimeFixture(h);
  const runtime = createCompanionRuntime({
    ...fixture.deps,
    sdkMode: true,
    sdkAuthorization,
  });
  const requests = () =>
    fixture.network.calls.filter((call) => call.url === RESPONSES_ENDPOINT);
  const ready = async () => {
    fixture.network.enqueueDiscovery();
    fixture.network.enqueueJwks();
    expect(await runtime.session.preflight(ACTION)).toMatchObject({
      preflightReady: true,
      persistedConnectionLoaded: true,
      attempts: 1,
    });
    fixture.network.enqueue(
      TOKEN_ENDPOINT,
      json(tokenPayload({ id_token: undefined }))
    );
    expect(await runtime.session.refresh(ACTION)).toMatchObject({
      refreshVerified: true,
      attempts: 1,
    });
    fixture.network.enqueue(
      MODELS_ENDPOINT,
      json({
        models: [
          {
            visibility: "list",
            slug: SDK_MODEL,
            display_name: "Synthetic model",
          },
        ],
      })
    );
    expect(await runtime.session.loadModels(ACTION)).toMatchObject({
      code: "models_loaded",
    });
    expect(runtime.session.selectModel(SDK_MODEL, ACTION)).toMatchObject({
      selectedModelSlug: SDK_MODEL,
    });
    expect(runtime.session.confirmPlanOnly(PLAN)).toMatchObject({
      planOnlyConfirmed: true,
      creditFallbackDisabled: true,
    });
  };
  return { ...fixture, runtime, requests, ready };
}

beforeEach(() => {
  // A regression falling back to ambient Fetch must fail closed, not touch a
  // provider. Every successful stream test must pass through injected Fetch.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("Unexpected non-injected Fetch")))
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dispose of disposals.splice(0)) dispose();
});

describe("official SDK actual injected-Fetch stream adapter", () => {
  it.each([
    "text/event-stream",
    "text/event-stream; charset=utf-8",
    null,
    "application/json",
    "application/octet-stream",
  ])("accepts valid ordinary SDK SSE with MIME %s", async (mime) => {
    const wire = sdkStream(sdkDelta(SDK_MARKER) + sdkCompleted(), mime, 5);
    const f = sdkFetch(wire.response);
    const model = adapter(f.fetch);
    const result = await model.run();
    expect(result).toMatchObject({
      outcome: "pass",
      code: "response_completed",
      markerAcknowledged: true,
    });
    expect(f.requests).toHaveLength(1);
    expect(model.reserve).toHaveBeenCalledTimes(1);
    expect(wire.body.locked).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    noPrivate(result);
  });

  it("uses exact public endpoint, selected catalog model, OAuth bearer and a fixed text-only request; does not inherit ambient SDK configuration", async () => {
    vi.stubEnv("OPENAI_API_KEY", SDK_SENTINEL);
    vi.stubEnv("OPENAI_ADMIN_KEY", SDK_SENTINEL);
    vi.stubEnv("OPENAI_ORG_ID", SDK_SENTINEL);
    vi.stubEnv("OPENAI_PROJECT_ID", SDK_SENTINEL);
    vi.stubEnv("OPENAI_BASE_URL", "https://synthetic.invalid/v1");
    vi.stubEnv(
      "OPENAI_CUSTOM_HEADERS",
      `X-Synthetic-Unapproved: ${SDK_SENTINEL}`
    );
    vi.stubEnv("OPENAI_LOG", "debug");
    const f = sdkFetch(sdkStream(sdkCompleted()).response);
    const model = adapter(f.fetch);
    expect(await model.run()).toMatchObject({ outcome: "pass" });
    const [request] = f.requests;
    if (!request) throw new Error("Expected injected SDK request");
    expect(request.url).toBe(RESPONSES_ENDPOINT);
    expect(request.method).toBe("POST");
    expect(request.headers.get("authorization")).toBe(`Bearer ${ACCESS}`);
    expect(request.headers.get("openai-organization")).toBeNull();
    expect(request.headers.get("openai-project")).toBeNull();
    expect(request.headers.get("x-synthetic-unapproved")).toBeNull();
    expect(JSON.stringify([...request.headers])).not.toContain(SDK_SENTINEL);
    expect(request.redirect).toBe("error");
    const body: unknown = await request.json();
    expect(body).toEqual({
      model: SDK_MODEL,
      store: false,
      stream: true,
      input: [
        {
          role: "developer",
          content:
            "This is a fixed synthetic text-only feasibility diagnostic. Reply with exactly p15_3.",
        },
        { role: "user", content: "Reply with p15_3." },
      ],
    });
  });

  it("never sends ambient credential override to Fetch", async () => {
    vi.stubEnv(
      "OPENAI_CUSTOM_HEADERS",
      `Authorization: Bearer ${SDK_SENTINEL}`
    );
    const f = sdkFetch(sdkStream(sdkCompleted()).response);
    const result = await adapter(f.fetch).run();
    if (f.requests.length === 0) expect(result.outcome).not.toBe("pass");
    else {
      expect(f.requests).toHaveLength(1);
      expect(f.requests[0]?.headers.get("authorization")).toBe(
        `Bearer ${ACCESS}`
      );
    }
    noPrivate(result);
  });

  it.each([
    ["wrong marker", sdkCompleted(SDK_SENTINEL)],
    ["wrong terminal status", sdkCompleted(SDK_MARKER, "incomplete")],
    ["failed", sdkFailure("response.failed")],
    ["incomplete", sdkFailure("response.incomplete")],
    ["error", sdkFailure("error")],
    ["premature EOF", sdkDelta(SDK_MARKER)],
    ["bare EOF", ""],
    ["DONE without terminal", sdkDelta(SDK_MARKER) + "data: [DONE]\n\n"],
    ["invalid JSON", `data: {${SDK_SENTINEL}}\n\n`],
    [
      "plain non-SSE JSON",
      JSON.stringify({ text: SDK_MARKER, private: SDK_SENTINEL }),
    ],
    [
      "unexpected tool call",
      eventFrame("response.completed", {
        response: {
          status: "completed",
          output: [
            {
              type: "function_call",
              id: SDK_SENTINEL,
              name: SDK_SENTINEL,
              arguments: SDK_SENTINEL,
            },
          ],
        },
      }),
    ],
  ])("does not report success on %s", async (_label, frames) => {
    const wire = sdkStream(frames, null);
    const f = sdkFetch(wire.response);
    const result = await adapter(f.fetch).run();
    expect(result.outcome).not.toBe("pass");
    expect(result.markerAcknowledged).toBe(false);
    expect(result.code).not.toBe("response_completed");
    expect(f.requests).toHaveLength(1);
    expect(wire.body.locked).toBe(false);
    noPrivate(result);
  });

  it.each([429, 500, 503])(
    "never retries HTTP %s and normalizes raw SDK errors",
    async (status) => {
      const f = sdkFetch(
        new Response(
          JSON.stringify({
            error: { code: SDK_SENTINEL, message: SDK_SENTINEL },
          }),
          {
            status,
            headers: {
              "Content-Type": "application/json",
              "X-Request-Id": SDK_SENTINEL,
              "Retry-After": "0",
            },
          }
        )
      );
      const result = await adapter(f.fetch).run();
      expect(result.outcome).not.toBe("pass");
      expect(result.markerAcknowledged).toBe(false);
      expect(f.requests).toHaveLength(1);
      noPrivate(result);
    }
  );

  it("never retries a network rejection or leaks raw errors or SDK logs", async () => {
    const logs = ["log", "info", "warn", "error", "debug"].map((level) =>
      vi.spyOn(console, level as "log").mockImplementation(() => {})
    );
    vi.stubEnv("OPENAI_LOG", "debug");
    const f = sdkFetch(() => {
      throw new Error(SDK_SENTINEL);
    });
    const result = await adapter(f.fetch).run();
    expect(result.outcome).not.toBe("pass");
    expect(f.requests).toHaveLength(1);
    noPrivate(result);
    expect(logs.every((log) => log.mock.calls.length === 0)).toBe(true);
  });

  it.each(["cancel", "timeout"] as const)(
    "ends stalled stream on application %s and cannot publish a late success",
    async (reason) => {
      vi.useFakeTimers();
      const cancellation = createProbeCancellation();
      const wire = stalledSdkStream(sdkDelta(SDK_MARKER));
      const f = sdkFetch(wire.response);
      const model = adapter(f.fetch, sdkContext({ cancellation }));
      const pending = model.run();
      await wire.readStarted;
      if (reason === "cancel") cancellation.cancel();
      else await vi.advanceTimersByTimeAsync(120_000);
      const result = await pending;
      expect(result).toMatchObject({
        code: reason === "cancel" ? "cancelled" : "timeout",
        markerAcknowledged: false,
      });
      expect(result.outcome).not.toBe("pass");
      expect(f.requests[0]?.signal.aborted).toBe(true);
      expect(f.requests).toHaveLength(1);
      expect(wire.body.locked).toBe(false);
      wire.completeLate(sdkCompleted());
      await vi.advanceTimersByTimeAsync(0);
      expect(result.markerAcknowledged).toBe(false);
      noPrivate(result);
    }
  );

  it("does not dispatch after synthetic reservation fails", async () => {
    const f = sdkFetch(sdkStream(sdkCompleted()).response);
    const model = adapter(f.fetch);
    model.reserve.mockImplementation(() => {
      throw new SigninFault("budget_exhausted");
    });
    expect(await model.run()).toMatchObject({
      outcome: "blocked",
      code: "budget_exhausted",
      markerAcknowledged: false,
    });
    expect(f.requests).toHaveLength(0);
    expect(await model.run()).toMatchObject({ code: "budget_exhausted" });
    expect(model.reserve).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["eligibility", { eligible: false }, "eligibility_pending"],
    ["operator", { operatorStarted: false }, "operator_required"],
    ["plan-only", { planOnlyConfirmed: false }, "plan_only_required"],
    [
      "no-credit fallback",
      { creditFallbackDisabled: false },
      "plan_only_required",
    ],
  ] as const)(
    "requires %s gate before reservation or Fetch",
    async (_label, authorization, code) => {
      const f = sdkFetch(sdkStream(sdkCompleted()).response);
      const model = adapter(f.fetch);
      const context = sdkContext();
      expect(
        await model.run({
          ...context,
          authorization: { ...context.authorization, ...authorization },
        })
      ).toMatchObject({
        outcome: "blocked",
        code,
        markerAcknowledged: false,
        evidence: { reservation: "not_started", fetchInvoked: false },
      });
      expect(model.reserve).not.toHaveBeenCalled();
      expect(f.requests).toHaveLength(0);
    }
  );

  it.each([
    [
      "operator action",
      (model: ReturnType<typeof adapter>) => model.sdk.run(sdkContext(), false),
      "operator_required",
    ],
    [
      "named allowance",
      (model: ReturnType<typeof adapter>) => {
        model.isAuthorized.mockReturnValue(false);
        return model.run();
      },
      "budget_exhausted",
    ],
    [
      "original and diagnostic frozen budgets",
      (model: ReturnType<typeof adapter>) => {
        model.assertFrozenBudgets.mockImplementation(() => {
          throw new SigninFault("storage_invalid");
        });
        return model.run();
      },
      "storage_invalid",
    ],
    [
      "account binding",
      (model: ReturnType<typeof adapter>) =>
        model.run(
          sdkContext({
            connection: makeConnection({ accessToken: SDK_SENTINEL }),
          })
        ),
      "reconnect_required",
    ],
    [
      "model slug",
      (model: ReturnType<typeof adapter>) =>
        model.run(sdkContext({ modelSlug: "invalid model" })),
      "model_not_selected",
    ],
  ] as const)("rejects absent or invalid %s", async (_label, invoke, code) => {
    const f = sdkFetch(sdkStream(sdkCompleted()).response);
    const model = adapter(f.fetch);
    expect(await invoke(model)).toMatchObject({
      code,
      markerAcknowledged: false,
      evidence: { reservation: "not_started", fetchInvoked: false },
    });
    expect(model.reserve).not.toHaveBeenCalled();
    expect(f.requests).toHaveLength(0);
  });

  it.each([
    [makeConnection({ expiresAt: NOW }), "reconnect_required"],
    [makeConnection({ scopes: ["openid"] }), "plan_disabled"],
  ] as const)(
    "refuses expired or unentitled connection",
    async (connection, code) => {
      const f = sdkFetch(sdkStream(sdkCompleted()).response);
      const model = adapter(f.fetch, sdkContext({ connection }));
      expect(await model.run()).toMatchObject({
        code,
        markerAcknowledged: false,
      });
      expect(model.reserve).not.toHaveBeenCalled();
      expect(f.requests).toHaveLength(0);
    }
  );

  it("default composition has no usable allowance even with otherwise valid synthetic account context", async () => {
    const f = sdkFetch(sdkStream(sdkCompleted()).response);
    const sdk = new SdkResponses({
      fetch: f.fetch,
      AbortController,
      clock: testClock(),
      loadConnection: () => makeConnection(),
      assertFrozenBudgets: () => {},
    });
    expect(sdk.status()).toMatchObject({
      mode: "offline_only",
      allowanceAvailable: false,
    });
    expect(await sdk.run(sdkContext(), true)).toMatchObject({
      code: "budget_exhausted",
      evidence: {
        reservation: "not_started",
        fetchInvoked: false,
        transportBytes: null,
      },
    });
    expect(f.requests).toHaveLength(0);
  });

  it("reserves before Fetch, consumes the one synthetic allowance on failure, and never republishes conflicting evidence", async () => {
    const reserved = vi.fn();
    const f = sdkFetch(() => {
      expect(reserved).toHaveBeenCalledTimes(1);
      return sdkStream(sdkFailure("response.failed")).response;
    });
    const model = adapter(f.fetch);
    model.reserve.mockImplementation(() => {
      reserved();
      return true;
    });
    const result = await model.run();
    expect(result).toMatchObject({
      code: "response_failed",
      markerAcknowledged: false,
      evidence: {
        reservation: "reserved",
        fetchInvoked: true,
        observedTerminal: "failed",
        httpStatus: 200,
      },
    });
    model.sdk.publish(result);
    const safe = model.sdk.status();
    expect(safe).toMatchObject({ allowanceAvailable: false, result });
    const replay = await model.run();
    expect(replay.code).toBe("budget_exhausted");
    model.sdk.publish(replay);
    expect(model.sdk.status()).toEqual(safe);
    expect(reserved).toHaveBeenCalledTimes(1);
    expect(f.requests).toHaveLength(1);
    noPrivate(safe.result);
  });

  it.each([
    [
      sdkFailure(
        "response.failed",
        "subscription_sharing_usage_limit_exceeded"
      ),
      "usage_limited",
    ],
    [
      sdkFailure("response.failed", "subscription_sharing_usage_unavailable"),
      "temporary_failure",
    ],
    [sdkFailure("response.incomplete"), "response_incomplete"],
    [sdkDelta(SDK_MARKER), "premature_eof"],
    [sdkCompleted(SDK_SENTINEL), "missing_acknowledgement"],
    [sdkCompleted(SDK_MARKER, "incomplete"), "invalid_response"],
  ] as const)(
    "classifies stream terminal without raw provider data %#",
    async (wire, code) => {
      const f = sdkFetch(sdkStream(wire).response);
      const result = await adapter(f.fetch).run();
      expect(result).toMatchObject({
        code,
        markerAcknowledged: false,
        evidence: { primaryFailureCode: code },
      });
      noPrivate(result);
      expect(f.requests).toHaveLength(1);
    }
  );

  it("retains capped transport counts and rejects oversized stream without marker success", async () => {
    const wire = sdkStream(new Uint8Array(1048578), null, 1048578);
    const f = sdkFetch(wire.response);
    const result = await adapter(f.fetch).run();
    expect(result).toMatchObject({
      code: "response_limit",
      markerAcknowledged: false,
      evidence: { transportBytes: 1048577, transportChunks: 1 },
    });
    expect(wire.body.locked).toBe(false);
  });

  it("bounds transport chunk count independently of byte count", async () => {
    const wire = sdkStream(":\n".repeat(5_001), null, 1);
    const f = sdkFetch(wire.response);
    expect(await adapter(f.fetch).run()).toMatchObject({
      code: "response_limit",
      markerAcknowledged: false,
      evidence: { transportBytes: 10001, transportChunks: 10001 },
    });
    expect(wire.body.locked).toBe(false);
  });

  it("bounds decoded SDK event count independently of transport chunk count", async () => {
    const wire = sdkStream(
      'data: {"type":"synthetic"}\n\n'.repeat(10_001),
      null,
      32768
    );
    const f = sdkFetch(wire.response);
    expect(await adapter(f.fetch).run()).toMatchObject({
      code: "response_limit",
      markerAcknowledged: false,
      evidence: { consumerEvents: 10001 },
    });
    expect(wire.body.locked).toBe(false);
  });

  it("bounds a stalled Fetch as well as stream consumption; late headers cannot restore success", async () => {
    vi.useFakeTimers();
    const dispatch = Promise.withResolvers<void>();
    const late = Promise.withResolvers<Response>();
    const f = sdkFetch(() => {
      dispatch.resolve();
      return late.promise;
    });
    const model = adapter(f.fetch);
    const pending = model.run();
    await dispatch.promise;
    await vi.advanceTimersByTimeAsync(70_000);
    const result = await pending;
    expect(result).toMatchObject({
      markerAcknowledged: false,
      evidence: {
        reservation: "reserved",
        fetchInvoked: true,
        httpStatus: null,
        primaryFailureCode: "timeout",
        cleanupFailureCode: "cleanup_failed",
      },
    });
    expect(f.requests[0]?.signal.aborted).toBe(true);
    const wire = sdkStream(sdkCompleted());
    late.resolve(wire.response);
    await vi.advanceTimersByTimeAsync(0);
    expect(wire.cancellation).toHaveBeenCalledTimes(1);
    expect(result.markerAcknowledged).toBe(false);
    expect(f.requests).toHaveLength(1);
  });
});

describe("official SDK companion composition (offline only)", () => {
  it("actual panel exposes old budgets separately and leaves SDK/legacy actions disabled with no allowance", () => {
    const html = fs.readFileSync(
      "src/companion-feasibility/control-view.html",
      "utf8"
    );
    const script = /<script[^>]*>([\s\S]*?)<\/script>/u.exec(html)?.[1];
    if (!script) throw new Error("Missing companion panel script");
    const fakeElement = () => ({
      disabled: false,
      hidden: false,
      checked: false,
      value: "",
      textContent: "",
      replaceChildren: vi.fn(),
      append: vi.fn(),
      addEventListener: vi.fn(),
    });
    const elements = new Map<string, ReturnType<typeof fakeElement>>(
      Array.from(html.matchAll(/\bid="([^"]+)"/gu), (match) => [
        match[1],
        fakeElement(),
      ])
    );
    const element = (id: string) => {
      const result = elements.get(id);
      if (!result) throw new Error("Missing panel fixture element");
      return result;
    };
    const data = {
      snapshot: {
        state: "model_selected",
        code: "plan_only_confirmed",
        busy: false,
        eligibilityBasisReady: true,
        preflightReady: true,
        hasConnection: true,
        persistedConnectionLoaded: true,
        refreshVerified: true,
        planScopeGranted: true,
        selectedModelSlug: SDK_MODEL,
        models: [{ slug: SDK_MODEL, displayName: "Synthetic model" }],
        planOnlyConfirmed: true,
        creditFallbackDisabled: true,
        attempts: 1,
      },
      runtime: {
        storage: { state: "ready" },
        diagnostic: {
          originalAttempts: 1,
          budget: { cap: 1, attempts: 1, state: "exhausted" },
        },
        sdk: {
          experiment: SDK_EXPERIMENT,
          mode: "offline_only",
          allowanceAvailable: false,
        },
      },
    };
    const context = createContext({
      document: { getElementById: element },
      Option: class {},
      setInterval: vi.fn(),
      fetch: vi.fn(() => new Promise(() => {})),
      data,
    });
    runInContext(script + '\ncsrf = "synthetic"; render(data);', context);
    expect(element("legacy-probes").hidden).toBe(true);
    expect(element("text-diagnostic").hidden).toBe(true);
    expect(element("sdk-diagnostic").hidden).toBe(false);
    for (const id of [
      "plan-only",
      "credits-off",
      "diagnostic-consent",
      "sdk-consent",
    ])
      element(id).checked = true;
    runInContext("render(data)", context);
    for (const id of [
      "run-sdk-diagnostic",
      "sdk-consent",
      "authorize-diagnostic",
      "run-diagnostic",
      "roundtrip",
      "cancellation",
    ])
      expect(element(id).disabled).toBe(true);
    expect(element("attempts").textContent).toContain("1/3");
    expect(element("sdk-budget").textContent).toContain("1/1 (frozen)");
    expect(element("sdk-budget").textContent).toContain("SDK allowance: none");
  });

  it("preserves exact action schema; the action itself cannot confer allowance", () => {
    const approved = {
      action: "run_sdk_diagnostic",
      operatorStarted: true,
      ownerAuthorized: true,
      experiment: SDK_EXPERIMENT,
    };
    expect(parseControlAction(approved)).toEqual(approved);
    for (const rejected of [
      { ...approved, ownerAuthorized: false },
      { ...approved, operatorStarted: false },
      { ...approved, experiment: "other" },
      { ...approved, prompt: SDK_SENTINEL },
      { ...approved, modelSlug: SDK_MODEL },
      { ...approved, authorization: true },
      { ...approved, apiKey: SDK_SENTINEL },
      { ...approved, tools: [] },
    ])
      expect(parseControlAction(rejected)).toBeUndefined();
  });

  it("blocks all inference in real checkpoint composition with no injection, preserving both original 1/3 and prior diagnostic 1/1", async () => {
    const h = checkpointHome();
    const f = checkpointRuntime(h);
    try {
      await f.ready();
      expect(f.runtime.status()).toMatchObject({
        diagnostic: {
          originalAttempts: 1,
          budget: { attempts: 1, state: "exhausted" },
        },
        sdk: { mode: "offline_only", allowanceAvailable: false },
      });
      await expect(f.runtime.runSdkDiagnostic(true)).rejects.toMatchObject({
        code: "budget_exhausted",
      });
      await expect(
        f.runtime.authorizeTextDiagnostic(true)
      ).rejects.toMatchObject({ code: "operator_required" });
      await expect(f.runtime.runTextDiagnostic(true)).rejects.toMatchObject({
        code: "operator_required",
      });
      expect(await f.runtime.session.runRoundTrip(ACTION)).toMatchObject({
        code: "attempt_order_invalid",
      });
      expect(await f.runtime.session.runCancellation(ACTION)).toMatchObject({
        code: "attempt_order_invalid",
      });
      expect(f.requests()).toHaveLength(0);
      expect(f.network.unexpected).toEqual([]);
      h.unchanged();
      expect(f.createServer).not.toHaveBeenCalled();
      expect(f.browser).not.toHaveBeenCalled();
    } finally {
      await f.runtime.shutdown();
    }
  });

  it("SDK-mode storage refuses old diagnostic writes, including attempts to reset the exhausted record", () => {
    const h = checkpointHome();
    const store = createCompanionStorage(h.deps, true, true);
    const records = store.diagnosticRecords();
    const prior = new DiagnosticBudget(records);
    expect(prior.status()).toMatchObject({ state: "exhausted", attempts: 1 });
    expect(() =>
      records.write(DIAGNOSTIC_BUDGET_FILE, { attempts: 0 })
    ).toThrow("budget_exhausted");
    expect(() =>
      records.write(DIAGNOSTIC_AUTHORIZATION_FILE, {
        reservationStarted: false,
      })
    ).toThrow("budget_exhausted");
    h.unchanged();
  });

  it("blocks injected SDK dispatch if prior durable diagnostic budget is missing", async () => {
    const h = checkpointHome();
    const reserve = vi.fn(() => true);
    const f = checkpointRuntime(h, { isAuthorized: () => true, reserve });
    try {
      await f.ready();
      fs.unlinkSync(h.file(DIAGNOSTIC_BUDGET_FILE));
      await f.runtime.runSdkDiagnostic(true);
      expect(f.runtime.session.snapshot().code).toBe("storage_invalid");
      expect(f.requests()).toHaveLength(0);
      expect(reserve).not.toHaveBeenCalled();
      expect(fs.existsSync(h.file(DIAGNOSTIC_BUDGET_FILE))).toBe(false);
    } finally {
      await f.runtime.shutdown();
    }
  });

  it("requires session preflight, account refresh, fresh catalog and confirmation; injection does not confer a bypass", async () => {
    const h = checkpointHome();
    const reserve = vi.fn(() => true);
    const f = checkpointRuntime(h, { isAuthorized: () => true, reserve });
    try {
      await f.runtime.runSdkDiagnostic(true);
      expect(f.runtime.session.snapshot().code).toBe("preflight_required");
      expect(reserve).not.toHaveBeenCalled();
      expect(f.requests()).toHaveLength(0);
      await f.ready();
      await expect(f.runtime.runSdkDiagnostic(false)).rejects.toMatchObject({
        code: "operator_required",
      });
      expect(f.runtime.session.selectModel(SDK_MODEL, ACTION)).toMatchObject({
        planOnlyConfirmed: false,
        creditFallbackDisabled: false,
      });
      await f.runtime.runSdkDiagnostic(true);
      expect(f.runtime.session.snapshot().code).toBe("plan_only_required");
      expect(reserve).not.toHaveBeenCalled();
      expect(f.requests()).toHaveLength(0);
      h.unchanged();
    } finally {
      await f.runtime.shutdown();
    }
  });

  it("dispatches actual SDK only through synthetic reservation and preserves both old budgets across restart", async () => {
    const h = checkpointHome();
    let reserved = false;
    const reserve = vi.fn(() => {
      if (reserved) return false;
      reserved = true;
      return true;
    });
    const authorization = { isAuthorized: () => !reserved, reserve };
    const f = checkpointRuntime(h, authorization);
    try {
      await f.ready();
      f.network.enqueue(RESPONSES_ENDPOINT, () => {
        expect(reserved).toBe(true);
        h.unchanged();
        return sdkStream(sdkCompleted(), null).response;
      });
      await f.runtime.runSdkDiagnostic(true);
      expect(f.runtime.session.snapshot()).toMatchObject({
        state: "finished",
        attempts: 1,
      });
      expect(f.runtime.status().sdk).toMatchObject({
        allowanceAvailable: false,
        result: {
          outcome: "pass",
          markerAcknowledged: true,
          evidence: {
            mimeCategory: "missing",
            observedTerminal: "completed",
            cleanup: "complete",
          },
        },
      });
      noPrivate(f.runtime.status().sdk?.result);
      expect(f.requests()).toHaveLength(1);
      await expect(f.runtime.runSdkDiagnostic(true)).rejects.toMatchObject({
        code: "budget_exhausted",
      });
      h.unchanged();
    } finally {
      await f.runtime.shutdown();
    }
    const restarted = checkpointRuntime(h, authorization);
    try {
      await restarted.ready();
      await expect(
        restarted.runtime.runSdkDiagnostic(true)
      ).rejects.toMatchObject({ code: "budget_exhausted" });
      expect(restarted.requests()).toHaveLength(0);
      expect(reserve).toHaveBeenCalledTimes(1);
      h.unchanged();
    } finally {
      await restarted.runtime.shutdown();
    }
  });

  it("sign-out invalidates the pending SDK generation; even a late marker cannot publish or replace account state", async () => {
    const h = checkpointHome();
    const reserve = vi.fn(() => true);
    const f = checkpointRuntime(h, { isAuthorized: () => true, reserve });
    try {
      await f.ready();
      const wire = stalledSdkStream(sdkDelta(SDK_MARKER));
      f.network.enqueue(RESPONSES_ENDPOINT, wire.response);
      f.network.enqueue(REVOKE, new Response(null, { status: 204 }));
      const running = f.runtime.runSdkDiagnostic(true);
      await wire.readStarted;
      const signedOut = await f.runtime.session.signOut(ACTION);
      await running;
      wire.completeLate(sdkCompleted());
      expect(signedOut).toMatchObject({
        state: "signed_out",
        hasConnection: false,
        revocation: { localCleared: true },
        attempts: 1,
      });
      expect(f.runtime.session.snapshot()).toMatchObject({
        state: "signed_out",
        hasConnection: false,
      });
      expect(f.runtime.status().sdk).toMatchObject({
        allowanceAvailable: false,
      });
      expect(f.runtime.status().sdk?.result).toBeUndefined();
      expect(f.requests()).toHaveLength(1);
      expect(f.network.unexpected).toEqual([]);
      expect(reserve).toHaveBeenCalledTimes(1);
      h.unchanged();
    } finally {
      await f.runtime.shutdown();
    }
  });
});
