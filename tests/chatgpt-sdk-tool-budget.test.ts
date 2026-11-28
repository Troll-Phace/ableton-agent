import * as fs from "node:fs";
import { createContext, runInContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createCompanionRuntime,
  type CompanionRuntimeDependencies,
} from "../src/companion-feasibility/runtime.js";
import { createCompanionStorage } from "../src/companion-feasibility/storage.js";
import { CompanionPreflight } from "../src/companion-feasibility/preflight.js";
import { parseControlAction } from "../src/companion-feasibility/contracts.js";
import {
  DiagnosticBudget,
  DIAGNOSTIC_AUTHORIZATION_FILE,
  DIAGNOSTIC_BUDGET_FILE,
} from "../src/companion-feasibility/diagnostic-budget.js";
import {
  SdkBudget,
  SDK_AUTHORIZATION_FILE,
  SDK_BUDGET_FILE,
} from "../src/companion-feasibility/sdk-budget.js";
import { SDK_TOOL_EXPERIMENT } from "../src/companion-feasibility/sdk-tool-roundtrip.js";
import {
  SdkToolBudget,
  SDK_TOOL_AUTHORIZATION_FILE,
  SDK_TOOL_BUDGET_FILE,
  type SdkToolRecordName,
  type SdkToolRecordStore,
} from "../src/companion-feasibility/sdk-tool-budget.js";
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
  eventFrame,
  json,
  makeConnection,
  tokenPayload,
} from "./fixtures/chatgpt-signin.js";
import {
  SDK_MODEL,
  SDK_MARKER,
  SDK_SENTINEL,
  sdkFailure,
  sdkStream,
  stalledSdkStream,
} from "./fixtures/chatgpt-sdk-responses.js";
import {
  TOOL_CALL_ID,
  TOOL_ITEM_ID,
  REASON_ID,
  REASON_TEXT,
  ENCRYPTED_REASON,
  FUNCTION_ARGS,
  FUNCTION_OUTPUT,
  callCompleted,
  callFragments,
  echoCall,
  expectedInput,
  expectedTools,
  firstRequest,
  markerMessage,
  reasoning,
  roundtripTerminal,
} from "./fixtures/chatgpt-sdk-tool-roundtrip.js";

const AUTH_FILE = SDK_TOOL_AUTHORIZATION_FILE;
const BUDGET_FILE = SDK_TOOL_BUDGET_FILE;
const ACTION = { operatorStarted: true };
const PLAN = {
  ...ACTION,
  planOnlyConfirmed: true,
  creditFallbackDisabled: true,
};
const disposals: (() => void)[] = [];

beforeEach(() => {
  // Never allow a regression using non-injected global Fetch to touch a provider.
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
  const original = createCompanionStorage(h.deps);
  if (seedConnection) original.store.saveConnection(makeConnection());
  expect(original.store.reserveInferenceAttempt().attempts).toBe(1);
  const prior = new DiagnosticBudget(
    createCompanionStorage(h.deps, true).diagnosticRecords()
  );
  prior.authorize(true);
  prior.reserve();
  const text = new SdkBudget(
    createCompanionStorage(h.deps, true, true).sdkDiagnosticRecords()
  );
  text.authorize(true);
  text.reserve();
  const historical = [
    "run-budget.json",
    DIAGNOSTIC_AUTHORIZATION_FILE,
    DIAGNOSTIC_BUDGET_FILE,
    SDK_AUTHORIZATION_FILE,
    SDK_BUDGET_FILE,
  ].map((name) => ({ name, bytes: fs.readFileSync(h.file(name)) }));
  const unchanged = () => {
    for (const record of historical)
      expect(fs.readFileSync(h.file(record.name))).toEqual(record.bytes);
  };
  const absent = () => {
    expect(fs.existsSync(h.file(AUTH_FILE))).toBe(false);
    expect(fs.existsSync(h.file(BUDGET_FILE))).toBe(false);
  };
  const record = (): unknown =>
    JSON.parse(fs.readFileSync(h.file(BUDGET_FILE), "utf8")) as unknown;
  const authorization = (): unknown =>
    JSON.parse(fs.readFileSync(h.file(AUTH_FILE), "utf8")) as unknown;
  const budgetBytes = () => [
    fs.readFileSync(h.file(AUTH_FILE)),
    fs.readFileSync(h.file(BUDGET_FILE)),
  ];
  return { ...h, unchanged, absent, record, authorization, budgetBytes };
}

function runtime(
  h: ReturnType<typeof home>,
  overrides: Partial<CompanionRuntimeDependencies> = {}
) {
  const f = runtimeFixture(h);
  const app = createCompanionRuntime({
    ...f.deps,
    sdkToolLiveProbe: true,
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
            slug: "synthetic-other-model",
            display_name: "Other synthetic model",
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
    authorize: (owner = true) => app.authorizeSdkToolRoundtrip(owner),
    run: (owner = true) => app.runSdkToolRoundtrip(owner),
    status: () => app.status().sdkToolRoundtrip,
  };
}

function noPrivate(value: unknown) {
  const encoded = JSON.stringify(value);
  for (const secret of [
    ACCESS,
    REFRESH,
    SDK_SENTINEL,
    TOOL_CALL_ID,
    TOOL_ITEM_ID,
    REASON_ID,
    REASON_TEXT,
    ENCRYPTED_REASON,
    FUNCTION_ARGS,
    FUNCTION_OUTPUT,
    RESPONSES_ENDPOINT,
  ])
    expect(encoded).not.toContain(secret);
}

function memoryRecords() {
  const records = new Map<SdkToolRecordName, unknown>();
  const store: SdkToolRecordStore = {
    assertHistoricalFrozen() {},
    assertNoSdkToolTemporaries() {},
    read: (name) => structuredClone(records.get(name)),
    write: (name, value) => {
      records.set(name, structuredClone(value));
    },
  };
  return { records, store, open: () => new SdkToolBudget(store) };
}

describe("SDK tool durable intent and same-instance continuation accounting", () => {
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
            cap: 2,
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
            experimentId: SDK_TOOL_EXPERIMENT,
            cap: 3,
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
      "conflicting intent/count",
      (h: ReturnType<typeof home>) =>
        fs.writeFileSync(
          h.file(AUTH_FILE),
          JSON.stringify({
            version: 1,
            experimentId: SDK_TOOL_EXPERIMENT,
            cap: 2,
            reservationIntent: 1,
          })
        ),
    ],
  ] as const)(
    "actual storage rejects %s without recreating a usable cap",
    (_label, corrupt) => {
      const h = home();
      const open = () =>
        new SdkToolBudget(
          createCompanionStorage(
            h.deps,
            true,
            true,
            true
          ).sdkToolDiagnosticRecords()
        );
      open().authorize(true);
      corrupt(h);
      const restarted = open();
      expect(restarted.status()).toEqual({
        experiment: SDK_TOOL_EXPERIMENT,
        cap: 2,
        state: "blocked",
        attempts: null,
      });
      expect(() => restarted.authorize(true)).toThrow("storage_invalid");
      expect(() => restarted.reserve(1)).toThrow("storage_invalid");
      expect(() => restarted.reserve(2)).toThrow("storage_invalid");
      h.unchanged();
    }
  );

  it.each([
    "run-budget.json",
    DIAGNOSTIC_AUTHORIZATION_FILE,
    DIAGNOSTIC_BUDGET_FILE,
    SDK_AUTHORIZATION_FILE,
    SDK_BUDGET_FILE,
  ])("missing historical record %s blocks any new authorization", (name) => {
    const h = home();
    fs.unlinkSync(h.file(name));
    const budget = new SdkToolBudget(
      createCompanionStorage(
        h.deps,
        true,
        true,
        true
      ).sdkToolDiagnosticRecords()
    );
    expect(budget.status()).toMatchObject({ state: "blocked", attempts: null });
    expect(() => budget.authorize(true)).toThrow("storage_invalid");
    h.absent();
  });

  it("prior exhausted SDK text and diagnostic records are read-only in tool accounting storage", () => {
    const h = home();
    const storage = createCompanionStorage(h.deps, true, true, true);
    const old = storage.diagnosticRecords(),
      sdk = storage.sdkDiagnosticRecords();
    expect(() => old.write(DIAGNOSTIC_BUDGET_FILE, { attempts: 0 })).toThrow(
      "budget_exhausted"
    );
    expect(() =>
      old.write(DIAGNOSTIC_AUTHORIZATION_FILE, { reservationStarted: false })
    ).toThrow("budget_exhausted");
    expect(() => sdk.write(SDK_BUDGET_FILE, { attempts: 0 })).toThrow(
      "budget_exhausted"
    );
    expect(() =>
      sdk.write(SDK_AUTHORIZATION_FILE, { reservationStarted: false })
    ).toThrow("budget_exhausted");
    h.unchanged();
  });
  it("requires distinct authorization and sequential intent/count with no reconstructed second step", () => {
    const f = memoryRecords();
    const one = f.open();
    expect(one.status()).toEqual({
      experiment: SDK_TOOL_EXPERIMENT,
      cap: 2,
      attempts: null,
      state: "not_authorized",
    });
    expect(() => one.authorize(false)).toThrow("operator_required");
    expect(() => one.reserve(1)).toThrow("budget_exhausted");
    expect(() => one.reserve(2)).toThrow("budget_exhausted");
    expect(f.records.size).toBe(0);
    expect(one.authorize(true)).toMatchObject({ state: "ready", attempts: 0 });
    expect(f.records.get(AUTH_FILE)).toEqual({
      version: 1,
      experimentId: SDK_TOOL_EXPERIMENT,
      cap: 2,
      reservationIntent: 0,
    });
    expect(f.records.get(BUDGET_FILE)).toEqual({
      version: 1,
      experimentId: SDK_TOOL_EXPERIMENT,
      cap: 2,
      attempts: 0,
    });
    const resumedZero = f.open();
    expect(resumedZero.status()).toMatchObject({ state: "ready", attempts: 0 });
    expect(() => resumedZero.reserve(2)).toThrow("budget_exhausted");
    expect(() => resumedZero.authorize(true)).toThrow("storage_invalid");
    expect(resumedZero.reserve(1)).toMatchObject({
      state: "active",
      attempts: 1,
    });
    expect(f.records.get(AUTH_FILE)).toMatchObject({ reservationIntent: 1 });
    expect(f.records.get(BUDGET_FILE)).toMatchObject({ attempts: 1 });
    const restarted = f.open();
    expect(restarted.status()).toMatchObject({
      state: "interrupted",
      attempts: 1,
    });
    expect(() => restarted.reserve(1)).toThrow("budget_exhausted");
    expect(() => restarted.reserve(2)).toThrow("budget_exhausted");
    expect(() => restarted.authorize(true)).toThrow("storage_invalid");
    expect(() => resumedZero.reserve(1)).toThrow("budget_exhausted");
    expect(resumedZero.reserve(2)).toMatchObject({
      state: "exhausted",
      attempts: 2,
    });
    expect(f.records.get(AUTH_FILE)).toMatchObject({ reservationIntent: 2 });
    expect(f.records.get(BUDGET_FILE)).toMatchObject({ attempts: 2 });
    for (const budget of [resumedZero, f.open()]) {
      expect(budget.status()).toMatchObject({
        state: "exhausted",
        attempts: 2,
      });
      expect(() => budget.reserve(1)).toThrow("budget_exhausted");
      expect(() => budget.reserve(2)).toThrow("budget_exhausted");
      expect(() => budget.authorize(true)).toThrow("storage_invalid");
    }
  });

  it("finish invalidates same-instance continuation permanently without changing either durable record", () => {
    const f = memoryRecords();
    const budget = f.open();
    budget.authorize(true);
    budget.reserve(1);
    const before = structuredClone(f.records);
    budget.finish();
    expect(budget.status()).toMatchObject({
      state: "interrupted",
      attempts: 1,
    });
    expect(() => budget.reserve(2)).toThrow("budget_exhausted");
    expect(() => budget.reserve(1)).toThrow("budget_exhausted");
    expect(f.records).toEqual(before);
    expect(f.open().status()).toMatchObject({
      state: "interrupted",
      attempts: 1,
    });
  });

  it.each([
    [1, false],
    [1, true],
    [2, false],
    [2, true],
  ] as const)(
    "uncertain count write at step %s never grants replay or continuation (count committed=%s)",
    (step, committed) => {
      const f = memoryRecords();
      let deny = false;
      const budget = new SdkToolBudget({
        ...f.store,
        write: (name, value) => {
          if (deny && name === BUDGET_FILE) {
            if (committed) f.store.write(name, value);
            throw new SigninFault("storage_failed");
          }
          f.store.write(name, value);
        },
      });
      budget.authorize(true);
      if (step === 2) budget.reserve(1);
      deny = true;
      expect(() => budget.reserve(step)).toThrow("storage_failed");
      expect(budget.status()).toMatchObject({
        state: "blocked",
        attempts: null,
      });
      const restarted = f.open();
      expect(restarted.status()).toMatchObject(
        committed
          ? { state: step === 1 ? "interrupted" : "exhausted", attempts: step }
          : { state: "blocked", attempts: null }
      );
      expect(() => restarted.reserve(1)).toThrow();
      expect(() => restarted.reserve(2)).toThrow();
      expect(() => restarted.authorize(true)).toThrow();
    }
  );

  it("rejects counter rollback within the same process even when both modified records agree", () => {
    const f = memoryRecords();
    const budget = f.open();
    budget.authorize(true);
    budget.reserve(1);
    f.records.set(AUTH_FILE, {
      version: 1,
      experimentId: SDK_TOOL_EXPERIMENT,
      cap: 2,
      reservationIntent: 0,
    });
    f.records.set(BUDGET_FILE, {
      version: 1,
      experimentId: SDK_TOOL_EXPERIMENT,
      cap: 2,
      attempts: 0,
    });
    expect(budget.status()).toMatchObject({ state: "blocked", attempts: null });
    expect(() => budget.reserve(1)).toThrow("storage_invalid");
    expect(() => budget.reserve(2)).toThrow("storage_invalid");
  });
});

describe("SDK tool operator probe — distinct authorization and ordered durable reservation", () => {
  it("actual operator panel requires separate authorization, then Run, and disables both on interrupted or exhausted accounting", () => {
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
          mode: "offline_only",
          allowanceAvailable: false,
          budget: { cap: 1, attempts: 1, state: "exhausted" },
        },
        sdkToolRoundtrip: {
          experiment: SDK_TOOL_EXPERIMENT,
          mode: "operator_test",
          allowanceAvailable: false,
          budget: {
            cap: 2,
            attempts: null as number | null,
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
    expect(element("sdk-diagnostic").hidden).toBe(true);
    expect(element("authorize-sdk-tool-roundtrip").disabled).toBe(true);
    expect(element("run-sdk-tool-roundtrip").disabled).toBe(true);
    expect(element("sdk-tool-budget").textContent).toContain(
      "Original: 1/3 (frozen)"
    );
    expect(element("sdk-tool-budget").textContent).toContain(
      "Prior diagnostic: 1/1 (frozen)"
    );
    expect(element("sdk-tool-budget").textContent).toContain(
      "SDK text: 1/1 (frozen)"
    );
    expect(element("sdk-tool-budget").textContent).toContain(
      "no verified allowance"
    );
    for (const id of ["plan-only", "credits-off", "sdk-tool-consent"])
      element(id).checked = true;
    runInContext("render(data)", context);
    expect(element("authorize-sdk-tool-roundtrip").disabled).toBe(false);
    expect(element("run-sdk-tool-roundtrip").disabled).toBe(true);
    Object.assign(data.runtime.sdkToolRoundtrip.budget, {
      state: "ready",
      attempts: 0,
    });
    data.runtime.sdkToolRoundtrip.allowanceAvailable = true;
    runInContext("render(data)", context);
    expect(element("authorize-sdk-tool-roundtrip").disabled).toBe(true);
    expect(element("run-sdk-tool-roundtrip").disabled).toBe(false);
    expect(element("sdk-tool-budget").textContent).toContain("0/2");
    for (const [state, attempts] of [
      ["active", 1],
      ["interrupted", 1],
      ["exhausted", 2],
      ["blocked", null],
    ] as const) {
      Object.assign(data.runtime.sdkToolRoundtrip.budget, { state, attempts });
      data.runtime.sdkToolRoundtrip.allowanceAvailable = false;
      element("sdk-tool-consent").checked = true;
      runInContext("render(data)", context);
      expect(element("authorize-sdk-tool-roundtrip").disabled).toBe(true);
      expect(element("run-sdk-tool-roundtrip").disabled).toBe(true);
      expect(element("sdk-tool-consent").disabled).toBe(true);
      expect(element("sdk-tool-budget").textContent).toContain(
        `${state} · ${attempts === null ? "no verified allowance" : `${attempts}/2`}`
      );
    }
  });
  it("accepts exact named authorization and Run actions, not prompt, tool, model or budget overrides", () => {
    for (const action of [
      "authorize_sdk_tool_roundtrip",
      "run_sdk_tool_roundtrip",
    ]) {
      const valid = {
        action,
        operatorStarted: true,
        ownerAuthorized: true,
        experiment: SDK_TOOL_EXPERIMENT,
      };
      expect(parseControlAction(valid)).toEqual(valid);
      for (const invalid of [
        { ...valid, operatorStarted: false },
        { ...valid, ownerAuthorized: false },
        { ...valid, experiment: "alternate" },
        { ...valid, cap: 3 },
        { ...valid, input: SDK_SENTINEL },
        { ...valid, modelSlug: SDK_MODEL },
        { ...valid, tools: [] },
        { ...valid, authorization: true },
      ])
        expect(parseControlAction(invalid)).toBeUndefined();
    }
  });

  it("cannot authorize before preflight, persisted refresh, loaded catalog, selected model, both plan confirmations and separate owner gesture", async () => {
    const h = home();
    const f = runtime(h);
    try {
      const blocked = async () => {
        await f.authorize();
        h.absent();
        h.unchanged();
        expect(f.requests()).toHaveLength(0);
        expect(f.status()?.allowanceAvailable).toBe(false);
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

  it("not eligible or disconnected cannot create a cap, and injected synthetic authorization cannot bypass live-probe consent", async () => {
    const h = home(false);
    const unavailable = runtime(h, { eligibilityBasisReady: false });
    try {
      await unavailable.authorize();
      expect(unavailable.requests()).toHaveLength(0);
      h.absent();
    } finally {
      await unavailable.app.shutdown();
    }
    const disconnected = runtime(h);
    try {
      await disconnected.preflight();
      await disconnected.authorize();
      expect(disconnected.app.session.snapshot().hasConnection).toBe(false);
      expect(disconnected.requests()).toHaveLength(0);
      h.absent();
    } finally {
      await disconnected.app.shutdown();
    }
    createCompanionStorage(h.deps).store.saveConnection(makeConnection());
    const reserve = vi.fn(() => true);
    const injected = runtime(h, {
      sdkToolRoundtripAuthorization: { isAuthorized: () => true, reserve },
    });
    try {
      await injected.ready();
      await expect(injected.run()).rejects.toMatchObject({
        code: "budget_exhausted",
      });
      expect(reserve).not.toHaveBeenCalled();
      expect(injected.requests()).toHaveLength(0);
      h.absent();
      h.unchanged();
    } finally {
      await injected.app.shutdown();
    }
  });

  it("commits each ordered slot before Fetch and sends exact fixed echo request/continuation, never a third request or legacy replay", async () => {
    const h = home();
    const f = runtime(h);
    try {
      await f.ready();
      h.absent();
      expect(f.status()?.allowanceAvailable).toBe(false);
      await f.authorize();
      expect(f.status()?.allowanceAvailable).toBe(true);
      expect(h.record()).toMatchObject({
        version: 1,
        experimentId: SDK_TOOL_EXPERIMENT,
        cap: 2,
        attempts: 0,
      });
      expect(h.authorization()).toEqual({
        version: 1,
        experimentId: SDK_TOOL_EXPERIMENT,
        cap: 2,
        reservationIntent: 0,
      });
      expect(f.requests()).toHaveLength(0);
      const initial = h.budgetBytes();
      await f.authorize();
      expect(h.budgetBytes()).toEqual(initial);
      const request = (init: RequestInit | undefined, attempt: 1 | 2) => {
        expect(h.record()).toMatchObject({
          version: 1,
          experimentId: SDK_TOOL_EXPERIMENT,
          cap: 2,
          attempts: attempt,
        });
        expect(h.authorization()).toEqual({
          version: 1,
          experimentId: SDK_TOOL_EXPERIMENT,
          cap: 2,
          reservationIntent: attempt,
        });
        h.unchanged();
        expect(init?.method).toBe("POST");
        expect(init?.redirect).toBe("error");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Bearer ${ACCESS}`
        );
        if (typeof init?.body !== "string")
          throw new Error("Expected fixed JSON request");
        return JSON.parse(init.body) as unknown;
      };
      f.network.enqueue(RESPONSES_ENDPOINT, (init) => {
        expect(request(init, 1)).toEqual(firstRequest());
        return sdkStream(callCompleted(), null).response;
      });
      f.network.enqueue(RESPONSES_ENDPOINT, (init) => {
        expect(request(init, 2)).toEqual({
          model: SDK_MODEL,
          store: false,
          stream: true,
          input: [
            ...expectedInput(),
            reasoning(),
            echoCall(),
            {
              type: "function_call_output",
              call_id: TOOL_CALL_ID,
              output: FUNCTION_OUTPUT,
            },
          ],
          tools: expectedTools(),
        });
        return sdkStream(
          roundtripTerminal([markerMessage()]),
          "application/json"
        ).response;
      });
      await f.run();
      expect(f.status()).toMatchObject({
        allowanceAvailable: false,
        result: {
          outcome: "pass",
          code: "roundtrip_complete",
          attempts: 2,
          functionEchoValidated: true,
          finalMarkerAcknowledged: true,
          first: {
            reservation: "reserved",
            observedTerminal: "completed",
            mimeCategory: "missing",
          },
          second: {
            reservation: "reserved",
            observedTerminal: "completed",
            mimeCategory: "json",
          },
        },
      });
      expect(f.app.session.snapshot()).toMatchObject({
        state: "finished",
        code: "roundtrip_complete",
        attempts: 1,
      });
      expect(f.requests()).toHaveLength(2);
      expect(h.record()).toMatchObject({ attempts: 2 });
      noPrivate(f.status());
      await expect(f.run()).rejects.toMatchObject({ code: "budget_exhausted" });
      await expect(f.app.runSdkDiagnostic(true)).rejects.toMatchObject({
        code: "operator_required",
      });
      await expect(f.app.authorizeSdkDiagnostic(true)).rejects.toMatchObject({
        code: "operator_required",
      });
      await expect(f.app.runTextDiagnostic(true)).rejects.toMatchObject({
        code: "operator_required",
      });
      expect(await f.app.session.runRoundTrip(ACTION)).toMatchObject({
        code: "attempt_order_invalid",
      });
      expect(await f.app.session.runCancellation(ACTION)).toMatchObject({
        code: "attempt_order_invalid",
      });
      expect(f.requests()).toHaveLength(2);
      expect(f.network.unexpected).toEqual([]);
      expect(globalThis.fetch).not.toHaveBeenCalled();
      h.unchanged();
    } finally {
      await f.app.shutdown();
    }
    const consumed = h.budgetBytes();
    const restarted = runtime(h);
    try {
      await restarted.ready();
      await restarted.authorize();
      await expect(restarted.run()).rejects.toMatchObject({
        code: "budget_exhausted",
      });
      expect(restarted.requests()).toHaveLength(0);
      expect(h.budgetBytes()).toEqual(consumed);
      h.unchanged();
    } finally {
      await restarted.app.shutdown();
    }
  });

  it("ready zero survives restart but still needs fresh session and model-change/plan confirmation before Run", async () => {
    const h = home();
    const f = runtime(h);
    try {
      await f.ready();
      await f.authorize();
      expect(h.record()).toMatchObject({ attempts: 0 });
      expect(f.requests()).toHaveLength(0);
    } finally {
      await f.app.shutdown();
    }
    const authorized = h.budgetBytes();
    const restarted = runtime(h);
    try {
      expect(restarted.status()?.allowanceAvailable).toBe(true);
      await restarted.run();
      expect(restarted.app.session.snapshot().code).toBe("preflight_required");
      await restarted.ready();
      expect(
        restarted.app.session.selectModel("synthetic-other-model", ACTION)
      ).toMatchObject({
        planOnlyConfirmed: false,
        creditFallbackDisabled: false,
      });
      await restarted.run();
      expect(restarted.app.session.snapshot().code).toBe("plan_only_required");
      expect(restarted.requests()).toHaveLength(0);
      expect(h.budgetBytes()).toEqual(authorized);
      h.unchanged();
    } finally {
      await restarted.app.shutdown();
    }
  });

  it("fails closed when authorization intent rename succeeds but directory sync fails before paired count exists", async () => {
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
            if (deny && String(to) === h.file(AUTH_FILE)) renamed = true;
          },
          fsyncSync: (fd) => {
            if (renamed && fs.fstatSync(fd).isDirectory())
              throw Object.assign(new Error(SDK_SENTINEL), { code: "EACCES" });
            fs.fsyncSync(fd);
          },
        },
      },
    });
    try {
      await f.ready();
      deny = true;
      await f.authorize();
      expect(f.status()).toMatchObject({
        allowanceAvailable: false,
        budget: { state: "blocked", attempts: null },
      });
      expect(f.requests()).toHaveLength(0);
      expect(h.authorization()).toMatchObject({ reservationIntent: 0 });
      expect(fs.existsSync(h.file(BUDGET_FILE))).toBe(false);
      await expect(f.run()).rejects.toMatchObject({ code: "budget_exhausted" });
      h.unchanged();
    } finally {
      await f.app.shutdown();
    }
    const restarted = runtime(h);
    try {
      expect(restarted.status()?.budget).toMatchObject({
        state: "blocked",
        attempts: null,
      });
      await restarted.ready();
      await restarted.authorize();
      await expect(restarted.run()).rejects.toMatchObject({
        code: "budget_exhausted",
      });
      expect(restarted.requests()).toHaveLength(0);
      expect(fs.existsSync(h.file(BUDGET_FILE))).toBe(false);
      h.unchanged();
    } finally {
      await restarted.app.shutdown();
    }
  });

  it("rechecks frozen historical SDK text accounting after first terminal, before reserving any second request", async () => {
    const h = home();
    const f = runtime(h);
    try {
      await f.ready();
      await f.authorize();
      const wire = stalledSdkStream(callFragments());
      f.network.enqueue(RESPONSES_ENDPOINT, wire.response);
      const pending = f.run();
      await wire.readStarted;
      expect(h.record()).toMatchObject({ attempts: 1 });
      // Test-only temporary storage tampering; no real user account records.
      fs.unlinkSync(h.file(SDK_BUDGET_FILE));
      wire.completeLate(roundtripTerminal([reasoning(), echoCall()]));
      await pending;
      expect(f.app.session.snapshot().code).toBe("storage_invalid");
      expect(h.record()).toMatchObject({ attempts: 1 });
      expect(h.authorization()).toMatchObject({ reservationIntent: 1 });
      expect(f.requests()).toHaveLength(1);
      expect(f.status()?.allowanceAvailable).toBe(false);
      expect(fs.existsSync(h.file(SDK_BUDGET_FILE))).toBe(false);
    } finally {
      await f.app.shutdown();
    }
  });

  it.each([
    "partial EOF",
    "failed terminal",
    "http 503",
    "network rejection",
    "bad arguments",
  ])(
    "spends one step on first failure %s; no second request, retry, refund or restart resume",
    async (kind) => {
      const h = home();
      const f = runtime(h);
      try {
        await f.ready();
        await f.authorize();
        f.network.enqueue(RESPONSES_ENDPOINT, () => {
          expect(h.record()).toMatchObject({ attempts: 1 });
          h.unchanged();
          if (kind === "network rejection") throw new Error(SDK_SENTINEL);
          if (kind === "http 503")
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
          if (kind === "failed terminal")
            return sdkStream(callFragments() + sdkFailure("response.failed"))
              .response;
          if (kind === "bad arguments")
            return sdkStream(
              roundtripTerminal([
                echoCall({ arguments: '{"value":"p15_3","value":"p15_3"}' }),
              ])
            ).response;
          return sdkStream(callFragments()).response;
        });
        await f.run();
        expect(f.status()).toMatchObject({
          allowanceAvailable: false,
          result: {
            attempts: 1,
            functionEchoValidated: false,
            finalMarkerAcknowledged: false,
          },
        });
        noPrivate(f.status());
        expect(f.requests()).toHaveLength(1);
        await expect(f.run()).rejects.toMatchObject({
          code: "budget_exhausted",
        });
        h.unchanged();
      } finally {
        await f.app.shutdown();
      }
      const consumed = h.budgetBytes();
      const restarted = runtime(h);
      try {
        await restarted.ready();
        await restarted.authorize();
        await expect(restarted.run()).rejects.toMatchObject({
          code: "budget_exhausted",
        });
        expect(restarted.requests()).toHaveLength(0);
        expect(h.budgetBytes()).toEqual(consumed);
        h.unchanged();
      } finally {
        await restarted.app.shutdown();
      }
    }
  );

  it.each([1, 2] as const)(
    "cancel while step %s is stalled prevents late success, second/third dispatch and restart replay",
    async (step) => {
      const h = home();
      const f = runtime(h);
      try {
        await f.ready();
        await f.authorize();
        const wire = stalledSdkStream(
          step === 1
            ? callFragments()
            : eventFrame("response.output_text.delta", { delta: SDK_MARKER })
        );
        if (step === 2)
          f.network.enqueue(
            RESPONSES_ENDPOINT,
            sdkStream(callCompleted()).response
          );
        f.network.enqueue(RESPONSES_ENDPOINT, wire.response);
        const pending = f.run();
        await wire.readStarted;
        expect(h.record()).toMatchObject({ attempts: step });
        await expect(f.run()).rejects.toMatchObject({
          code: "budget_exhausted",
        });
        f.app.session.cancel();
        await pending;
        wire.completeLate(
          roundtripTerminal(
            step === 1 ? [reasoning(), echoCall()] : [markerMessage()]
          )
        );
        expect(f.status()?.result).toBeUndefined();
        expect(f.status()?.allowanceAvailable).toBe(false);
        expect(f.requests()).toHaveLength(step);
        h.unchanged();
      } finally {
        await f.app.shutdown();
      }
      const consumed = h.budgetBytes();
      const restarted = runtime(h);
      try {
        await restarted.ready();
        await expect(restarted.run()).rejects.toMatchObject({
          code: "budget_exhausted",
        });
        expect(restarted.requests()).toHaveLength(0);
        expect(h.budgetBytes()).toEqual(consumed);
        h.unchanged();
      } finally {
        await restarted.app.shutdown();
      }
    }
  );

  it.each([1, 2] as const)(
    "sign-out while step %s is stalled invalidates continuation and cannot publish late completion",
    async (step) => {
      const h = home();
      const f = runtime(h);
      try {
        await f.ready();
        await f.authorize();
        const wire = stalledSdkStream(
          step === 1
            ? callFragments()
            : eventFrame("response.output_text.delta", { delta: SDK_MARKER })
        );
        if (step === 2)
          f.network.enqueue(
            RESPONSES_ENDPOINT,
            sdkStream(callCompleted()).response
          );
        f.network.enqueue(RESPONSES_ENDPOINT, wire.response);
        f.network.enqueue(REVOKE, new Response(null, { status: 204 }));
        const pending = f.run();
        await wire.readStarted;
        expect(h.record()).toMatchObject({ attempts: step });
        expect(await f.app.session.signOut(ACTION)).toMatchObject({
          state: "signed_out",
          hasConnection: false,
          revocation: { localCleared: true },
          attempts: 1,
        });
        await pending;
        wire.completeLate(
          roundtripTerminal(
            step === 1 ? [reasoning(), echoCall()] : [markerMessage()]
          )
        );
        expect(f.status()?.result).toBeUndefined();
        expect(f.status()?.allowanceAvailable).toBe(false);
        expect(f.requests()).toHaveLength(step);
        expect(f.network.unexpected).toEqual([]);
        h.unchanged();
      } finally {
        await f.app.shutdown();
      }
    }
  );

  it("first reservation stays at one while call fragments arrive; only validated terminal advances ordered continuation", async () => {
    const h = home();
    const f = runtime(h);
    try {
      await f.ready();
      await f.authorize();
      const first = stalledSdkStream(callFragments());
      f.network.enqueue(RESPONSES_ENDPOINT, first.response);
      f.network.enqueue(RESPONSES_ENDPOINT, () => {
        expect(h.record()).toMatchObject({ attempts: 2 });
        expect(h.authorization()).toMatchObject({ reservationIntent: 2 });
        return sdkStream(roundtripTerminal([markerMessage()])).response;
      });
      const running = f.run();
      await first.readStarted;
      expect(f.requests()).toHaveLength(1);
      expect(h.record()).toMatchObject({ attempts: 1 });
      expect(h.authorization()).toMatchObject({ reservationIntent: 1 });
      expect(f.status()?.budget).toMatchObject({
        state: "active",
        attempts: 1,
      });
      await expect(f.run()).rejects.toMatchObject({ code: "budget_exhausted" });
      expect(f.requests()).toHaveLength(1);
      first.completeLate(roundtripTerminal([reasoning(), echoCall()]));
      await running;
      expect(f.status()).toMatchObject({
        allowanceAvailable: false,
        budget: { state: "exhausted", attempts: 2 },
        result: {
          outcome: "pass",
          functionEchoValidated: true,
          finalMarkerAcknowledged: true,
        },
      });
      expect(f.requests()).toHaveLength(2);
      h.unchanged();
    } finally {
      await f.app.shutdown();
    }
  });

  it.each(["failed", "wrong marker", "network"])(
    "second %s spends both slots but never dispatches a third",
    async (kind) => {
      const h = home();
      const f = runtime(h);
      try {
        await f.ready();
        await f.authorize();
        f.network.enqueue(
          RESPONSES_ENDPOINT,
          sdkStream(callCompleted()).response
        );
        f.network.enqueue(RESPONSES_ENDPOINT, () => {
          expect(h.record()).toMatchObject({ attempts: 2 });
          if (kind === "network") throw new Error(SDK_SENTINEL);
          return sdkStream(
            kind === "failed"
              ? sdkFailure("response.failed")
              : roundtripTerminal([markerMessage(SDK_SENTINEL)])
          ).response;
        });
        await f.run();
        expect(f.status()).toMatchObject({
          allowanceAvailable: false,
          budget: { state: "exhausted", attempts: 2 },
          result: {
            attempts: 2,
            functionEchoValidated: true,
            finalMarkerAcknowledged: false,
          },
        });
        noPrivate(f.status());
        await expect(f.run()).rejects.toMatchObject({
          code: "budget_exhausted",
        });
        expect(f.requests()).toHaveLength(2);
        h.unchanged();
      } finally {
        await f.app.shutdown();
      }
      const consumed = h.budgetBytes(),
        restarted = runtime(h);
      try {
        await restarted.ready();
        await expect(restarted.run()).rejects.toMatchObject({
          code: "budget_exhausted",
        });
        expect(restarted.requests()).toHaveLength(0);
        expect(h.budgetBytes()).toEqual(consumed);
        h.unchanged();
      } finally {
        await restarted.app.shutdown();
      }
    }
  );

  it.each([
    [1, AUTH_FILE],
    [1, BUDGET_FILE],
    [2, AUTH_FILE],
    [2, BUDGET_FILE],
  ] as const)(
    "directory-sync uncertainty at step %s (%s) prevents that Fetch and any restart replay",
    async (step, target) => {
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
        if (step === 1) deny = true;
        else
          f.network.enqueue(RESPONSES_ENDPOINT, () => {
            deny = true;
            return sdkStream(callCompleted()).response;
          });
        await f.run();
        expect(f.requests()).toHaveLength(step - 1);
        expect(f.status()).toMatchObject({
          allowanceAvailable: false,
          budget: { state: "blocked", attempts: null },
        });
        expect(f.app.status().storage).toMatchObject({
          state: "uncertain_commit",
        });
        expect(h.authorization()).toMatchObject({ reservationIntent: step });
        expect(h.record()).toMatchObject({
          attempts: target === BUDGET_FILE ? step : step - 1,
        });
        noPrivate(f.app.status());
        h.unchanged();
      } finally {
        await f.app.shutdown();
      }
      const restarted = runtime(h);
      try {
        expect(restarted.status()?.budget).toMatchObject(
          target === BUDGET_FILE
            ? {
                state: step === 1 ? "interrupted" : "exhausted",
                attempts: step,
              }
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

  it.each([1, 2] as const)(
    "timeout of step %s leaves prior reservation durable and never resumes after restart",
    async (step) => {
      const h = home();
      const f = runtime(h);
      try {
        await f.ready();
        await f.authorize();
        vi.useFakeTimers();
        const wire = stalledSdkStream(
          step === 1
            ? callFragments()
            : eventFrame("response.output_text.delta", { delta: SDK_MARKER })
        );
        if (step === 2)
          f.network.enqueue(
            RESPONSES_ENDPOINT,
            sdkStream(callCompleted()).response
          );
        f.network.enqueue(RESPONSES_ENDPOINT, wire.response);
        const pending = f.run();
        await wire.readStarted;
        expect(h.record()).toMatchObject({ attempts: step });
        await vi.advanceTimersByTimeAsync(125_000);
        await pending;
        expect(f.status()).toMatchObject({
          allowanceAvailable: false,
          budget: {
            state: step === 1 ? "interrupted" : "exhausted",
            attempts: step,
          },
          result: { code: "timeout", finalMarkerAcknowledged: false },
        });
        wire.completeLate(
          roundtripTerminal(
            step === 1 ? [reasoning(), echoCall()] : [markerMessage()]
          )
        );
        expect(f.requests()).toHaveLength(step);
        h.unchanged();
      } finally {
        vi.useRealTimers();
        await f.app.shutdown();
      }
      const restarted = runtime(h);
      try {
        await restarted.ready();
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
});
