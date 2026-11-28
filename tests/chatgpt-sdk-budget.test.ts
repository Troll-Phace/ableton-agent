import * as fs from "node:fs";
import { createContext, runInContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createCompanionRuntime,
  type CompanionRuntimeDependencies,
} from "../src/companion-feasibility/runtime.js";
import { createCompanionStorage } from "../src/companion-feasibility/storage.js";
import { CompanionPreflight } from "../src/companion-feasibility/preflight.js";
import {
  DiagnosticBudget,
  DIAGNOSTIC_BUDGET_FILE,
  DIAGNOSTIC_AUTHORIZATION_FILE,
} from "../src/companion-feasibility/diagnostic-budget.js";
import { SDK_EXPERIMENT } from "../src/companion-feasibility/sdk-responses.js";
import {
  SdkBudget,
  SDK_AUTHORIZATION_FILE,
  SDK_BUDGET_FILE,
  type SdkRecordName,
  type SdkRecordStore,
} from "../src/companion-feasibility/sdk-budget.js";
import { parseControlAction } from "../src/companion-feasibility/contracts.js";
import {
  MODELS_ENDPOINT,
  RESPONSES_ENDPOINT,
  TOKEN_ENDPOINT,
  SigninFault,
} from "../src/extension/feasibility/signin-contracts.js";
import { companionHome, runtimeFixture } from "./fixtures/chatgpt-companion.js";
import {
  ACCESS,
  REFRESH,
  REVOKE,
  json,
  makeConnection,
  tokenPayload,
} from "./fixtures/chatgpt-signin.js";
import {
  SDK_MARKER,
  SDK_MODEL,
  SDK_SENTINEL,
  sdkCompleted,
  sdkDelta,
  sdkStream,
  stalledSdkStream,
} from "./fixtures/chatgpt-sdk-responses.js";

const AUTH_FILE = SDK_AUTHORIZATION_FILE;
const BUDGET_FILE = SDK_BUDGET_FILE;
const ACTION = { operatorStarted: true };
const PLAN = {
  ...ACTION,
  planOnlyConfirmed: true,
  creditFallbackDisabled: true,
};
const disposals: (() => void)[] = [];

beforeEach(() => {
  // Fail closed even if the implementation were to bypass injected Fetch.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("Unexpected non-injected Fetch")))
  );
  vi.spyOn(CompanionPreflight.prototype, "run").mockResolvedValue({
    nativeTransport: true,
    callbackBinding: true,
    privateStorage: true,
    bundledVerifier: true,
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const dispose of disposals.splice(0)) dispose();
});

function home(seedConnection = true) {
  const h = companionHome();
  disposals.push(h.dispose);
  const storage = createCompanionStorage(h.deps);
  if (seedConnection) storage.store.saveConnection(makeConnection());
  expect(storage.store.reserveInferenceAttempt().attempts).toBe(1);
  const prior = new DiagnosticBudget(
    createCompanionStorage(h.deps, true).diagnosticRecords()
  );
  prior.authorize(true);
  prior.reserve();
  const old = [
    "run-budget.json",
    DIAGNOSTIC_AUTHORIZATION_FILE,
    DIAGNOSTIC_BUDGET_FILE,
  ].map((name) => ({ name, raw: fs.readFileSync(h.file(name)) }));
  const unchanged = () => {
    for (const record of old)
      expect(fs.readFileSync(h.file(record.name))).toEqual(record.raw);
  };
  const absent = () => {
    expect(fs.existsSync(h.file(AUTH_FILE))).toBe(false);
    expect(fs.existsSync(h.file(BUDGET_FILE))).toBe(false);
  };
  const record = (): unknown =>
    JSON.parse(fs.readFileSync(h.file(BUDGET_FILE), "utf8")) as unknown;
  return { ...h, unchanged, absent, record };
}

function runtime(
  h: ReturnType<typeof home>,
  overrides: Partial<CompanionRuntimeDependencies> = {}
) {
  const f = runtimeFixture(h);
  const app = createCompanionRuntime({
    ...f.deps,
    sdkLiveProbe: true,
    ...overrides,
  });
  const requests = () =>
    f.network.calls.filter((call) => call.url === RESPONSES_ENDPOINT);
  const preflight = async () => {
    f.network.enqueueDiscovery();
    f.network.enqueueJwks();
    expect(await app.session.preflight(ACTION)).toMatchObject({
      preflightReady: true,
      attempts: 1,
    });
  };
  const refresh = async () => {
    f.network.enqueue(
      TOKEN_ENDPOINT,
      json(tokenPayload({ id_token: undefined }))
    );
    expect(await app.session.refresh(ACTION)).toMatchObject({
      refreshVerified: true,
      attempts: 1,
    });
  };
  const catalog = async () => {
    f.network.enqueue(
      MODELS_ENDPOINT,
      json({
        models: [
          {
            visibility: "list",
            slug: SDK_MODEL,
            display_name: "Synthetic model",
          },
          {
            visibility: "list",
            slug: "synthetic-alternate-model",
            display_name: "Another synthetic model",
          },
        ],
      })
    );
    expect(await app.session.loadModels(ACTION)).toMatchObject({
      code: "models_loaded",
      attempts: 1,
    });
  };
  const select = () =>
    expect(app.session.selectModel(SDK_MODEL, ACTION)).toMatchObject({
      selectedModelSlug: SDK_MODEL,
      planOnlyConfirmed: false,
    });
  const confirm = () =>
    expect(app.session.confirmPlanOnly(PLAN)).toMatchObject({
      planOnlyConfirmed: true,
      creditFallbackDisabled: true,
    });
  const ready = async () => {
    await preflight();
    await refresh();
    await catalog();
    select();
    confirm();
  };
  return {
    ...f,
    app,
    requests,
    preflight,
    refresh,
    catalog,
    select,
    confirm,
    ready,
    authorize: (owner = true) => app.authorizeSdkDiagnostic(owner),
    run: (owner = true) => app.runSdkDiagnostic(owner),
    status: () => app.status().sdk,
  };
}

function noPrivate(value: unknown) {
  const encoded = JSON.stringify(value);
  for (const secret of [ACCESS, REFRESH, SDK_SENTINEL, RESPONSES_ENDPOINT])
    expect(encoded).not.toContain(secret);
}

describe("SDK budget record storage and fail-closed durable accounting", () => {
  it("requires separate authorization, exact one-slot record shape, and only monotonic updates across restart", () => {
    const h = home();
    const open = () =>
      new SdkBudget(
        createCompanionStorage(h.deps, true, true).sdkDiagnosticRecords()
      );
    const budget = open();
    expect(budget.status()).toEqual({
      experiment: SDK_EXPERIMENT,
      state: "not_authorized",
      cap: 1,
      attempts: null,
    });
    expect(() => budget.authorize(false)).toThrow("operator_required");
    expect(() => budget.reserve()).toThrow("storage_invalid");
    h.absent();
    expect(budget.authorize(true)).toMatchObject({
      state: "ready",
      attempts: 0,
      cap: 1,
    });
    expect(h.record()).toEqual({
      version: 1,
      experimentId: SDK_EXPERIMENT,
      cap: 1,
      attempts: 0,
    });
    expect(JSON.parse(fs.readFileSync(h.file(AUTH_FILE), "utf8"))).toEqual({
      version: 1,
      experimentId: SDK_EXPERIMENT,
      cap: 1,
      reservationStarted: false,
    });
    const restarted = open();
    expect(restarted.status()).toMatchObject({ state: "ready", attempts: 0 });
    expect(() => restarted.authorize(true)).toThrow("storage_invalid");
    expect(restarted.reserve()).toMatchObject({
      state: "exhausted",
      attempts: 1,
    });
    expect(h.record()).toEqual({
      version: 1,
      experimentId: SDK_EXPERIMENT,
      cap: 1,
      attempts: 1,
    });
    expect(JSON.parse(fs.readFileSync(h.file(AUTH_FILE), "utf8"))).toEqual({
      version: 1,
      experimentId: SDK_EXPERIMENT,
      cap: 1,
      reservationStarted: true,
    });
    expect(open().status()).toMatchObject({ state: "exhausted", attempts: 1 });
    expect(() => open().reserve()).toThrow("budget_exhausted");
    expect(() => open().authorize(true)).toThrow("storage_invalid");
    h.unchanged();
  });

  it.each([
    [
      "authorization missing",
      (h: ReturnType<typeof home>) => fs.unlinkSync(h.file(AUTH_FILE)),
    ],
    [
      "budget missing",
      (h: ReturnType<typeof home>) => fs.unlinkSync(h.file(BUDGET_FILE)),
    ],
    [
      "budget corrupt",
      (h: ReturnType<typeof home>) =>
        fs.writeFileSync(h.file(BUDGET_FILE), SDK_SENTINEL),
    ],
    [
      "alternate experiment",
      (h: ReturnType<typeof home>) =>
        fs.writeFileSync(
          h.file(BUDGET_FILE),
          JSON.stringify({
            version: 1,
            experimentId: "alternate",
            cap: 1,
            attempts: 0,
          })
        ),
    ],
    [
      "wrong cap",
      (h: ReturnType<typeof home>) =>
        fs.writeFileSync(
          h.file(BUDGET_FILE),
          JSON.stringify({
            version: 1,
            experimentId: SDK_EXPERIMENT,
            cap: 2,
            attempts: 0,
          })
        ),
    ],
    [
      "orphan temporary",
      (h: ReturnType<typeof home>) =>
        fs.writeFileSync(
          h.file(`.${BUDGET_FILE}.11111111-1111-4111-8111-111111111111.tmp`),
          "{}",
          { mode: 0o600 }
        ),
    ],
    [
      "conflicting reservation",
      (h: ReturnType<typeof home>) =>
        fs.writeFileSync(
          h.file(AUTH_FILE),
          JSON.stringify({
            version: 1,
            experimentId: SDK_EXPERIMENT,
            cap: 1,
            reservationStarted: true,
          })
        ),
    ],
  ] as const)("does not recreate allowance after %s", (_label, corrupt) => {
    const h = home();
    const open = () =>
      new SdkBudget(
        createCompanionStorage(h.deps, true, true).sdkDiagnosticRecords()
      );
    open().authorize(true);
    corrupt(h);
    const restarted = open();
    expect(restarted.status()).toEqual({
      experiment: SDK_EXPERIMENT,
      state: "blocked",
      cap: 1,
      attempts: null,
    });
    expect(() => restarted.reserve()).toThrow("storage_invalid");
    expect(() => restarted.authorize(true)).toThrow("storage_invalid");
    h.unchanged();
  });

  it.each([false, true])(
    "uncertain record reservation consumes or blocks rather than permits replay (committed=%s)",
    (committed) => {
      const rows = new Map<SdkRecordName, unknown>();
      let fault = false;
      const store: SdkRecordStore = {
        assertHistoricalFrozen() {},
        assertNoSdkTemporaries() {},
        read: (name) => structuredClone(rows.get(name)),
        write: (name, value) => {
          if (fault && name === BUDGET_FILE) {
            if (committed) rows.set(name, structuredClone(value));
            throw new SigninFault("storage_failed");
          }
          rows.set(name, structuredClone(value));
        },
      };
      const budget = new SdkBudget(store);
      budget.authorize(true);
      fault = true;
      expect(() => budget.reserve()).toThrow("storage_failed");
      expect(budget.status()).toMatchObject({
        state: "blocked",
        attempts: null,
      });
      const restarted = new SdkBudget(store);
      expect(restarted.status()).toMatchObject(
        committed
          ? { state: "exhausted", attempts: 1 }
          : { state: "blocked", attempts: null }
      );
      expect(() => restarted.reserve()).toThrow();
      expect(() => restarted.authorize(true)).toThrow();
    }
  );

  it.each(["original", "prior"] as const)(
    "refuses allowance when %s historic budget is not intact",
    (kind) => {
      const h = home();
      if (kind === "original") fs.unlinkSync(h.file("run-budget.json"));
      else fs.unlinkSync(h.file(DIAGNOSTIC_BUDGET_FILE));
      const budget = new SdkBudget(
        createCompanionStorage(h.deps, true, true).sdkDiagnosticRecords()
      );
      expect(budget.status()).toMatchObject({
        state: "blocked",
        attempts: null,
      });
      expect(() => budget.authorize(true)).toThrow("storage_invalid");
      h.absent();
    }
  );
});

describe("SDK live probe: one distinctly authorized durable synthetic allowance", () => {
  it("actual live-probe panel enables authorization first, then Run, then neither, without showing legacy probes", () => {
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
          mode: "operator_test",
          allowanceAvailable: false,
          budget: {
            cap: 1,
            attempts: null as null | number,
            state: "not_authorized",
          },
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
    expect(element("authorize-sdk-diagnostic").disabled).toBe(true);
    expect(element("run-sdk-diagnostic").disabled).toBe(true);
    expect(element("attempts").textContent).toContain("1/3");
    expect(element("sdk-budget").textContent).toContain("1/1 (frozen)");
    expect(element("sdk-budget").textContent).toContain(
      "no verified allowance"
    );
    for (const id of ["plan-only", "credits-off", "sdk-consent"])
      element(id).checked = true;
    runInContext("render(data)", context);
    expect(element("authorize-sdk-diagnostic").disabled).toBe(false);
    expect(element("run-sdk-diagnostic").disabled).toBe(true);
    Object.assign(data.runtime.sdk.budget, { state: "ready", attempts: 0 });
    data.runtime.sdk.allowanceAvailable = true;
    runInContext("render(data)", context);
    expect(element("authorize-sdk-diagnostic").disabled).toBe(true);
    expect(element("run-sdk-diagnostic").disabled).toBe(false);
    expect(element("sdk-budget").textContent).toContain("0/1");
    Object.assign(data.runtime.sdk.budget, { state: "exhausted", attempts: 1 });
    data.runtime.sdk.allowanceAvailable = false;
    runInContext("render(data)", context);
    for (const id of [
      "authorize-sdk-diagnostic",
      "run-sdk-diagnostic",
      "sdk-consent",
      "roundtrip",
      "cancellation",
      "authorize-diagnostic",
      "run-diagnostic",
    ])
      expect(element(id).disabled).toBe(true);
    expect(element("sdk-budget").textContent).toContain("exhausted · 1/1");
  });

  it("accepts exact named authorization and Run contracts and rejects payload overrides", () => {
    for (const action of ["authorize_sdk_diagnostic", "run_sdk_diagnostic"]) {
      const valid = {
        action,
        operatorStarted: true,
        ownerAuthorized: true,
        experiment: SDK_EXPERIMENT,
      };
      expect(parseControlAction(valid)).toEqual(valid);
      for (const invalid of [
        { ...valid, operatorStarted: false },
        { ...valid, ownerAuthorized: false },
        { ...valid, experiment: "alternate" },
        { ...valid, input: SDK_SENTINEL },
        { ...valid, cap: 2 },
        { ...valid, modelSlug: SDK_MODEL },
        { ...valid, endpoint: RESPONSES_ENDPOINT },
        { ...valid, tools: [] },
      ])
        expect(parseControlAction(invalid)).toBeUndefined();
    }
  });

  it("preflight, refresh, fresh catalog selection and both plan-only confirmations are required before authorization", async () => {
    const h = home();
    const f = runtime(h);
    try {
      const blocked = async () => {
        await f.authorize();
        expect(f.status()?.allowanceAvailable).toBe(false);
        h.absent();
        h.unchanged();
        expect(f.requests()).toHaveLength(0);
      };
      await blocked();
      await f.preflight();
      await blocked();
      await f.refresh();
      await blocked();
      await f.catalog();
      await blocked();
      expect(f.app.session.selectModel("not-in-catalog", ACTION).code).toBe(
        "model_not_selected"
      );
      await blocked();
      f.select();
      await blocked();
      expect(
        f.app.session.confirmPlanOnly({
          ...PLAN,
          creditFallbackDisabled: false,
        }).code
      ).toBe("plan_only_required");
      await blocked();
      f.confirm();
      await expect(f.authorize(false)).rejects.toMatchObject({
        code: "operator_required",
      });
      await expect(f.run(false)).rejects.toMatchObject({
        code: "operator_required",
      });
      await expect(f.run()).rejects.toMatchObject({ code: "budget_exhausted" });
      h.absent();
      h.unchanged();
      expect(f.requests()).toHaveLength(0);
    } finally {
      await f.app.shutdown();
    }
  });

  it("not eligible and disconnected sessions cannot create an allowance", async () => {
    const h = home(false);
    const f = runtime(h, { eligibilityBasisReady: false });
    try {
      await f.authorize();
      expect(f.requests()).toHaveLength(0);
      h.absent();
      h.unchanged();
      expect(f.browser).not.toHaveBeenCalled();
    } finally {
      await f.app.shutdown();
    }
    const disconnected = runtime(h);
    try {
      await disconnected.preflight();
      await disconnected.authorize();
      expect(disconnected.app.session.snapshot()).toMatchObject({
        hasConnection: false,
      });
      expect(disconnected.requests()).toHaveLength(0);
      h.absent();
      h.unchanged();
    } finally {
      await disconnected.app.shutdown();
    }
  });

  it("live-probe mode ignores synthetic allowance injection until a distinct durable operator authorization", async () => {
    const h = home();
    const reserve = vi.fn(() => true);
    const f = runtime(h, {
      sdkAuthorization: { isAuthorized: () => true, reserve },
    });
    try {
      await f.ready();
      expect(f.status()).toMatchObject({
        allowanceAvailable: false,
        budget: { state: "not_authorized", attempts: null },
      });
      await expect(f.run()).rejects.toMatchObject({ code: "budget_exhausted" });
      expect(f.requests()).toHaveLength(0);
      expect(reserve).not.toHaveBeenCalled();
      h.absent();
      h.unchanged();
    } finally {
      await f.app.shutdown();
    }
  });

  it("persisted authorization survives restart but does not skip fresh gates or model-change confirmation", async () => {
    const h = home();
    const f = runtime(h);
    try {
      await f.ready();
      await f.authorize();
      expect(f.status()).toMatchObject({
        allowanceAvailable: true,
        budget: { state: "ready", attempts: 0 },
      });
      expect(f.requests()).toHaveLength(0);
    } finally {
      await f.app.shutdown();
    }
    const authorized = fs.readFileSync(h.file(BUDGET_FILE));
    const consent = fs.readFileSync(h.file(AUTH_FILE));
    const restarted = runtime(h);
    try {
      expect(restarted.status()).toMatchObject({
        allowanceAvailable: true,
        budget: { state: "ready", attempts: 0 },
      });
      await restarted.run();
      expect(restarted.app.session.snapshot().code).toBe("preflight_required");
      await restarted.ready();
      expect(
        restarted.app.session.selectModel("synthetic-alternate-model", ACTION)
      ).toMatchObject({
        planOnlyConfirmed: false,
        creditFallbackDisabled: false,
      });
      await restarted.run();
      expect(restarted.app.session.snapshot().code).toBe("plan_only_required");
      expect(restarted.requests()).toHaveLength(0);
      expect(fs.readFileSync(h.file(BUDGET_FILE))).toEqual(authorized);
      expect(fs.readFileSync(h.file(AUTH_FILE))).toEqual(consent);
      h.unchanged();
    } finally {
      await restarted.app.shutdown();
    }
  });

  it("durably authorizes separately, reserves before Fetch, enforces fixed request/no tools, and preserves frozen bytes through restart", async () => {
    const h = home();
    const f = runtime(h);
    try {
      await f.ready();
      expect(f.status()?.allowanceAvailable).toBe(false);
      h.absent();
      await f.authorize();
      expect(f.status()?.allowanceAvailable).toBe(true);
      expect(h.record()).toMatchObject({
        version: 1,
        experimentId: SDK_EXPERIMENT,
        cap: 1,
        attempts: 0,
      });
      expect(fs.existsSync(h.file(AUTH_FILE))).toBe(true);
      expect(f.requests()).toHaveLength(0);
      const authorization = fs.readFileSync(h.file(AUTH_FILE));
      const authorized = fs.readFileSync(h.file(BUDGET_FILE));
      await f.authorize();
      expect(fs.readFileSync(h.file(AUTH_FILE))).toEqual(authorization);
      expect(fs.readFileSync(h.file(BUDGET_FILE))).toEqual(authorized);
      f.network.enqueue(RESPONSES_ENDPOINT, (init) => {
        expect(h.record()).toMatchObject({
          version: 1,
          experimentId: SDK_EXPERIMENT,
          cap: 1,
          attempts: 1,
        });
        h.unchanged();
        expect(init?.method).toBe("POST");
        expect(init?.redirect).toBe("error");
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          `Bearer ${ACCESS}`
        );
        if (typeof init?.body !== "string")
          throw new Error("Expected fixed JSON");
        expect(JSON.parse(init.body)).toEqual({
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
        return sdkStream(sdkCompleted(), null).response;
      });
      await f.run();
      expect(f.status()).toMatchObject({
        allowanceAvailable: false,
        result: {
          outcome: "pass",
          code: "response_completed",
          markerAcknowledged: true,
          evidence: {
            reservation: "reserved",
            fetchInvoked: true,
            observedTerminal: "completed",
            cleanup: "complete",
          },
        },
      });
      expect(f.requests()).toHaveLength(1);
      expect(h.record()).toMatchObject({ attempts: 1 });
      noPrivate(f.status());
      expect(f.network.unexpected).toEqual([]);
      expect(globalThis.fetch).not.toHaveBeenCalled();
      await expect(f.run()).rejects.toMatchObject({ code: "budget_exhausted" });
      h.unchanged();
    } finally {
      await f.app.shutdown();
    }
    const consumed = fs.readFileSync(h.file(BUDGET_FILE));
    const consent = fs.readFileSync(h.file(AUTH_FILE));
    const restarted = runtime(h);
    try {
      await restarted.ready();
      expect(restarted.status()?.allowanceAvailable).toBe(false);
      await restarted.authorize();
      await expect(restarted.run()).rejects.toMatchObject({
        code: "budget_exhausted",
      });
      expect(restarted.requests()).toHaveLength(0);
      expect(fs.readFileSync(h.file(BUDGET_FILE))).toEqual(consumed);
      expect(fs.readFileSync(h.file(AUTH_FILE))).toEqual(consent);
      h.unchanged();
    } finally {
      await restarted.app.shutdown();
    }
  });

  it.each(["http rejection", "network rejection"])(
    "consumes a slot on %s; no retry or legacy action",
    async (kind) => {
      const h = home();
      const f = runtime(h);
      try {
        await f.ready();
        await f.authorize();
        f.network.enqueue(RESPONSES_ENDPOINT, () => {
          expect(h.record()).toMatchObject({ attempts: 1 });
          if (kind === "network rejection") throw new Error(SDK_SENTINEL);
          return new Response(
            JSON.stringify({
              error: { message: SDK_SENTINEL, code: SDK_SENTINEL },
            }),
            {
              status: 503,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": "0",
              },
            }
          );
        });
        await f.run();
        expect(f.status()).toMatchObject({
          allowanceAvailable: false,
          result: {
            markerAcknowledged: false,
            evidence: { reservation: "reserved", fetchInvoked: true },
          },
        });
        noPrivate(f.status());
        expect(f.requests()).toHaveLength(1);
        await expect(f.run()).rejects.toMatchObject({
          code: "budget_exhausted",
        });
        await expect(f.app.authorizeTextDiagnostic(true)).rejects.toMatchObject(
          { code: "operator_required" }
        );
        await expect(f.app.runTextDiagnostic(true)).rejects.toMatchObject({
          code: "operator_required",
        });
        expect(await f.app.session.runRoundTrip(ACTION)).toMatchObject({
          code: "attempt_order_invalid",
        });
        expect(await f.app.session.runCancellation(ACTION)).toMatchObject({
          code: "attempt_order_invalid",
        });
        expect(f.requests()).toHaveLength(1);
        h.unchanged();
      } finally {
        await f.app.shutdown();
      }
    }
  );

  it.each(["cancel", "signout"] as const)(
    "consumes once before stalled read; concurrent Run and %s cannot restore allowance or publish late success",
    async (kind) => {
      const h = home();
      const f = runtime(h);
      try {
        await f.ready();
        await f.authorize();
        const wire = stalledSdkStream(sdkDelta(SDK_MARKER));
        f.network.enqueue(RESPONSES_ENDPOINT, wire.response);
        const running = f.run();
        await wire.readStarted;
        expect(h.record()).toMatchObject({ attempts: 1 });
        expect(f.status()?.allowanceAvailable).toBe(false);
        await expect(f.run()).rejects.toMatchObject({
          code: "budget_exhausted",
        });
        expect(f.requests()).toHaveLength(1);
        if (kind === "signout") {
          f.network.enqueue(REVOKE, new Response(null, { status: 204 }));
          expect(await f.app.session.signOut(ACTION)).toMatchObject({
            state: "signed_out",
            hasConnection: false,
            revocation: { localCleared: true },
            attempts: 1,
          });
        } else f.app.session.cancel();
        await running;
        wire.completeLate(sdkCompleted());
        expect(f.status()?.result).toBeUndefined();
        expect(f.status()?.allowanceAvailable).toBe(false);
        expect(h.record()).toMatchObject({ attempts: 1 });
        expect(f.requests()).toHaveLength(1);
        expect(f.network.unexpected).toEqual([]);
        h.unchanged();
      } finally {
        await f.app.shutdown();
      }
    }
  );

  it.each([AUTH_FILE, BUDGET_FILE] as const)(
    "never dispatches after directory-sync uncertainty on %s; restart blocks replay",
    async (target) => {
      const h = home();
      let deny = false,
        renamed = false;
      const f = runtime(h, {
        storage: {
          ...h.deps,
          fs: {
            ...fs,
            renameSync: (from, to) => {
              fs.renameSync(from, to);
              if (deny && String(to) === h.file(target)) renamed = true;
            },
            fsyncSync: (fd) => {
              if (renamed && fs.fstatSync(fd).isDirectory())
                throw Object.assign(new Error(SDK_SENTINEL), {
                  code: "EACCES",
                });
              fs.fsyncSync(fd);
            },
          },
        },
      });
      try {
        await f.ready();
        await f.authorize();
        deny = true;
        await f.run();
        expect(f.requests()).toHaveLength(0);
        expect(f.status()).toMatchObject({
          allowanceAvailable: false,
          budget: { state: "blocked", attempts: null },
        });
        expect(f.app.status().storage).toMatchObject({
          state: "uncertain_commit",
        });
        noPrivate(f.app.status());
        expect(h.record()).toMatchObject({
          attempts: target === BUDGET_FILE ? 1 : 0,
        });
        h.unchanged();
      } finally {
        await f.app.shutdown();
      }
      const restarted = runtime(h);
      try {
        expect(restarted.status()?.budget).toMatchObject(
          target === BUDGET_FILE
            ? { state: "exhausted", attempts: 1 }
            : { state: "blocked", attempts: null }
        );
        await restarted.ready();
        await restarted.authorize();
        await expect(restarted.run()).rejects.toMatchObject({
          code: "budget_exhausted",
        });
        expect(restarted.requests()).toHaveLength(0);
        h.unchanged();
      } finally {
        await restarted.app.shutdown();
      }
    }
  );

  it("times out stalled SDK stream after actual durable reservation and leaves exhausted cap across a fresh runtime", async () => {
    const h = home();
    const f = runtime(h);
    try {
      await f.ready();
      await f.authorize();
      vi.useFakeTimers();
      const wire = stalledSdkStream(sdkDelta(SDK_MARKER));
      f.network.enqueue(RESPONSES_ENDPOINT, wire.response);
      const pending = f.run();
      await wire.readStarted;
      expect(h.record()).toMatchObject({ attempts: 1 });
      await vi.advanceTimersByTimeAsync(70_000);
      await pending;
      expect(f.status()).toMatchObject({
        allowanceAvailable: false,
        budget: { state: "exhausted", attempts: 1 },
        result: { markerAcknowledged: false, code: "timeout" },
      });
      expect(f.requests()).toHaveLength(1);
      wire.completeLate(sdkCompleted());
      await vi.advanceTimersByTimeAsync(0);
      expect(f.status()?.result?.markerAcknowledged).toBe(false);
      h.unchanged();
    } finally {
      vi.useRealTimers();
      await f.app.shutdown();
    }
    const restarted = runtime(h);
    try {
      expect(restarted.status()?.budget).toMatchObject({
        state: "exhausted",
        attempts: 1,
      });
      await restarted.ready();
      await expect(restarted.run()).rejects.toMatchObject({
        code: "budget_exhausted",
      });
      expect(restarted.requests()).toHaveLength(0);
      h.unchanged();
    } finally {
      await restarted.app.shutdown();
    }
  });
});
