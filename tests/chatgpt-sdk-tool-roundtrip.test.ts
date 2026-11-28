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
import {
  SdkToolRoundtrip,
  SDK_TOOL_EXPERIMENT,
} from "../src/companion-feasibility/sdk-tool-roundtrip.js";
import type { InferenceContext } from "../src/extension/feasibility/responses.js";
import {
  ACCESS,
  REFRESH,
  NOW,
  REVOKE,
  eventFrame,
  makeConnection,
  testClock,
  json,
  tokenPayload,
} from "./fixtures/chatgpt-signin.js";
import {
  SDK_MARKER,
  SDK_MODEL,
  SDK_SENTINEL,
  sdkContext,
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
  echoCall,
  reasoning,
  markerMessage,
  roundtripTerminal,
  callFragments,
  callCompleted,
  expectedInput,
  expectedTools,
  firstRequest,
  roundtripFetch,
} from "./fixtures/chatgpt-sdk-tool-roundtrip.js";
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
import { companionHome, runtimeFixture } from "./fixtures/chatgpt-companion.js";

function adapter(fetch: typeof globalThis.fetch, context = sdkContext()) {
  const reserve = vi.fn((step: 1 | 2) => step === 1 || step === 2);
  const isAuthorized = vi.fn(() => true);
  const assertFrozenBudgets = vi.fn();
  const loadConnection = vi.fn(() => context.connection);
  const sdk = new SdkToolRoundtrip({
    fetch,
    AbortController,
    clock: testClock(),
    loadConnection,
    assertFrozenBudgets,
    authorization: { reserve, isAuthorized },
  });
  return {
    sdk,
    reserve,
    isAuthorized,
    assertFrozenBudgets,
    loadConnection,
    run: (input: InferenceContext = context, gesture = true) =>
      sdk.run(input, gesture),
  };
}

const noPrivate = (value: unknown) => {
  const text = JSON.stringify(value);
  for (const secret of [
    ACCESS,
    REFRESH,
    SDK_SENTINEL,
    SDK_MARKER,
    SDK_MODEL,
    TOOL_CALL_ID,
    TOOL_ITEM_ID,
    REASON_ID,
    REASON_TEXT,
    ENCRYPTED_REASON,
    FUNCTION_ARGS,
    FUNCTION_OUTPUT,
    RESPONSES_ENDPOINT,
  ])
    expect(text).not.toContain(secret);
};

const ACTION = { operatorStarted: true };
const PLAN = {
  ...ACTION,
  planOnlyConfirmed: true,
  creditFallbackDisabled: true,
};
const disposals: (() => void)[] = [];

function historicalHome() {
  const h = companionHome();
  disposals.push(h.dispose);
  const storage = createCompanionStorage(h.deps);
  storage.store.saveConnection(makeConnection());
  expect(storage.store.reserveInferenceAttempt().attempts).toBe(1);
  const old = new DiagnosticBudget(
    createCompanionStorage(h.deps, true).diagnosticRecords()
  );
  old.authorize(true);
  old.reserve();
  const text = new SdkBudget(
    createCompanionStorage(h.deps, true, true).sdkDiagnosticRecords()
  );
  text.authorize(true);
  text.reserve();
  const records = [
    "run-budget.json",
    DIAGNOSTIC_AUTHORIZATION_FILE,
    DIAGNOSTIC_BUDGET_FILE,
    SDK_AUTHORIZATION_FILE,
    SDK_BUDGET_FILE,
  ].map((name) => ({ name, bytes: fs.readFileSync(h.file(name)) }));
  const unchanged = () => {
    for (const { name, bytes } of records)
      expect(fs.readFileSync(h.file(name))).toEqual(bytes);
    expect(
      fs
        .readdirSync(h.directory)
        .filter((name) => /(?:budget|authorization)/.test(name))
        .sort()
    ).toEqual(records.map((row) => row.name).sort());
  };
  return { ...h, unchanged };
}

function runtime(
  h: ReturnType<typeof historicalHome>,
  overrides: Partial<CompanionRuntimeDependencies> = {}
) {
  vi.spyOn(CompanionPreflight.prototype, "run").mockResolvedValue({
    nativeTransport: true,
    callbackBinding: true,
    privateStorage: true,
    bundledVerifier: true,
  });
  const f = runtimeFixture(h);
  const app = createCompanionRuntime({
    ...f.deps,
    sdkToolRoundtripMode: true,
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
        ],
      })
    );
    expect(await app.session.loadModels(ACTION)).toMatchObject({
      code: "models_loaded",
    });
  };
  const select = () =>
    expect(app.session.selectModel(SDK_MODEL, ACTION)).toMatchObject({
      selectedModelSlug: SDK_MODEL,
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
  };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("Unexpected non-injected Fetch")))
  );
});

describe("SDK tool companion checkpoint: historical budgets frozen, no native allowance", () => {
  it("actual panel shows all three historical budgets read-only and no native tool allowance", () => {
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
    expect(element("sdk-diagnostic").hidden).toBe(true);
    expect(element("sdk-tool-roundtrip").hidden).toBe(false);
    for (const id of [
      "plan-only",
      "credits-off",
      "sdk-consent",
      "sdk-tool-consent",
    ])
      element(id).checked = true;
    runInContext("render(data)", context);
    for (const id of [
      "run-sdk-tool-roundtrip",
      "sdk-tool-consent",
      "run-sdk-diagnostic",
      "authorize-sdk-diagnostic",
      "roundtrip",
      "cancellation",
    ])
      expect(element(id).disabled).toBe(true);
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
      "Tool allowance: none"
    );
  });

  it("allows only named exact fixed-action gesture, not prompt, tools, endpoint or model overrides", () => {
    const valid = {
      action: "run_sdk_tool_roundtrip",
      operatorStarted: true,
      ownerAuthorized: true,
      experiment: SDK_TOOL_EXPERIMENT,
    };
    expect(parseControlAction(valid)).toEqual(valid);
    for (const invalid of [
      { ...valid, operatorStarted: false },
      { ...valid, ownerAuthorized: false },
      { ...valid, experiment: "other" },
      { ...valid, prompt: SDK_SENTINEL },
      { ...valid, modelSlug: SDK_MODEL },
      { ...valid, tools: [] },
      { ...valid, endpoint: RESPONSES_ENDPOINT },
      { ...valid, authorization: true },
    ])
      expect(parseControlAction(invalid)).toBeUndefined();
  });

  it("native-shaped mode refuses every inference action even after all session gates, preserving previous 1/3, 1/1 and 1/1 records", async () => {
    const h = historicalHome();
    const f = runtime(h);
    try {
      await f.ready();
      expect(f.app.status()).toMatchObject({
        diagnostic: {
          originalAttempts: 1,
          budget: { attempts: 1, state: "exhausted" },
        },
        sdk: {
          mode: "offline_only",
          allowanceAvailable: false,
          budget: { attempts: 1, state: "exhausted" },
        },
        sdkToolRoundtrip: {
          experiment: SDK_TOOL_EXPERIMENT,
          mode: "offline_only",
          allowanceAvailable: false,
        },
      });
      await expect(f.app.runSdkToolRoundtrip(true)).rejects.toMatchObject({
        code: "budget_exhausted",
      });
      await expect(f.app.runSdkDiagnostic(true)).rejects.toMatchObject({
        code: "operator_required",
      });
      await expect(f.app.authorizeSdkDiagnostic(true)).rejects.toMatchObject({
        code: "operator_required",
      });
      await expect(f.app.authorizeTextDiagnostic(true)).rejects.toMatchObject({
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
      expect(f.requests()).toHaveLength(0);
      expect(f.network.unexpected).toEqual([]);
      expect(f.createServer).not.toHaveBeenCalled();
      expect(f.browser).not.toHaveBeenCalled();
      h.unchanged();
    } finally {
      await f.app.shutdown();
    }
  });

  it("synthetic injection cannot bypass preflight, refresh, catalog, model selection or owner plan confirmation", async () => {
    const h = historicalHome();
    const reserve = vi.fn(() => true);
    const f = runtime(h, {
      sdkToolRoundtripAuthorization: { isAuthorized: () => true, reserve },
    });
    try {
      const blocked = async () => {
        await f.app.runSdkToolRoundtrip(true);
        expect(f.requests()).toHaveLength(0);
        expect(reserve).not.toHaveBeenCalled();
        h.unchanged();
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
      f.confirm();
      await expect(f.app.runSdkToolRoundtrip(false)).rejects.toMatchObject({
        code: "operator_required",
      });
      expect(reserve).not.toHaveBeenCalled();
      expect(f.requests()).toHaveLength(0);
      h.unchanged();
    } finally {
      await f.app.shutdown();
    }
  });

  it("actual SDK integration reserves each injected step, projects sanitized result and cannot restart or rerun an exhausted synthetic exchange", async () => {
    const h = historicalHome();
    let reserved = 0;
    const reserve = vi.fn((step: 1 | 2) => {
      if (step !== reserved + 1) return false;
      reserved = step;
      return true;
    });
    const authorization = { isAuthorized: () => reserved < 2, reserve };
    const f = runtime(h, { sdkToolRoundtripAuthorization: authorization });
    try {
      await f.ready();
      f.network.enqueue(RESPONSES_ENDPOINT, () => {
        expect(reserved).toBe(1);
        h.unchanged();
        return sdkStream(callCompleted(), null).response;
      });
      f.network.enqueue(RESPONSES_ENDPOINT, () => {
        expect(reserved).toBe(2);
        h.unchanged();
        return sdkStream(roundtripTerminal([markerMessage()]), null).response;
      });
      await f.app.runSdkToolRoundtrip(true);
      expect(f.app.session.snapshot()).toMatchObject({
        state: "finished",
        code: "roundtrip_complete",
        attempts: 1,
      });
      expect(f.app.status().sdkToolRoundtrip).toMatchObject({
        allowanceAvailable: false,
        result: {
          outcome: "pass",
          code: "roundtrip_complete",
          attempts: 2,
          functionEchoValidated: true,
          finalMarkerAcknowledged: true,
          first: { mimeCategory: "missing" },
          second: { mimeCategory: "missing" },
        },
      });
      noPrivate(f.app.status().sdkToolRoundtrip?.result);
      expect(f.requests()).toHaveLength(2);
      await expect(f.app.runSdkToolRoundtrip(true)).rejects.toMatchObject({
        code: "budget_exhausted",
      });
      expect(f.network.unexpected).toEqual([]);
      h.unchanged();
    } finally {
      await f.app.shutdown();
    }
    const restarted = runtime(h, {
      sdkToolRoundtripAuthorization: authorization,
    });
    try {
      await restarted.ready();
      await expect(
        restarted.app.runSdkToolRoundtrip(true)
      ).rejects.toMatchObject({ code: "budget_exhausted" });
      expect(restarted.requests()).toHaveLength(0);
      expect(reserve.mock.calls).toEqual([[1], [2]]);
      h.unchanged();
    } finally {
      await restarted.app.shutdown();
    }
  });

  it("a partial first-step failure cannot resume or spend second step after restart", async () => {
    const h = historicalHome();
    let reserved = 0;
    const reserve = vi.fn((step: 1 | 2) => {
      if (step !== reserved + 1) return false;
      reserved = step;
      return true;
    });
    const authorization = { isAuthorized: () => reserved < 2, reserve };
    const f = runtime(h, { sdkToolRoundtripAuthorization: authorization });
    try {
      await f.ready();
      f.network.enqueue(
        RESPONSES_ENDPOINT,
        sdkStream(callFragments()).response
      );
      await f.app.runSdkToolRoundtrip(true);
      expect(f.app.status().sdkToolRoundtrip?.result).toMatchObject({
        attempts: 1,
        functionEchoValidated: false,
        finalMarkerAcknowledged: false,
      });
      expect(f.requests()).toHaveLength(1);
      h.unchanged();
    } finally {
      await f.app.shutdown();
    }
    const restarted = runtime(h, {
      sdkToolRoundtripAuthorization: authorization,
    });
    try {
      await restarted.ready();
      await restarted.app.runSdkToolRoundtrip(true);
      expect(restarted.requests()).toHaveLength(0);
      expect(reserve.mock.calls).toEqual([[1], [1]]);
      h.unchanged();
    } finally {
      await restarted.app.shutdown();
    }
  });

  it("refuses injected dispatch when historical SDK text accounting is missing", async () => {
    const h = historicalHome();
    const reserve = vi.fn(() => true);
    const f = runtime(h, {
      sdkToolRoundtripAuthorization: { isAuthorized: () => true, reserve },
    });
    try {
      await f.ready();
      fs.unlinkSync(h.file(SDK_BUDGET_FILE));
      await f.app.runSdkToolRoundtrip(true);
      expect(f.app.session.snapshot().code).toBe("storage_invalid");
      expect(reserve).not.toHaveBeenCalled();
      expect(f.requests()).toHaveLength(0);
      expect(fs.existsSync(h.file(SDK_BUDGET_FILE))).toBe(false);
    } finally {
      await f.app.shutdown();
    }
  });

  it.each([1, 2])(
    "sign-out during step %s invalidates one shared generation and cannot publish late success",
    async (step) => {
      const h = historicalHome();
      const reserve = vi.fn(() => true);
      const f = runtime(h, {
        sdkToolRoundtripAuthorization: { isAuthorized: () => true, reserve },
      });
      try {
        await f.ready();
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
        const pending = f.app.runSdkToolRoundtrip(true);
        await wire.readStarted;
        await expect(f.app.runSdkToolRoundtrip(true)).rejects.toMatchObject({
          code: "budget_exhausted",
        });
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
        expect(f.app.status().sdkToolRoundtrip?.result).toBeUndefined();
        expect(f.app.status().sdkToolRoundtrip?.allowanceAvailable).toBe(false);
        expect(f.app.session.snapshot()).toMatchObject({
          state: "signed_out",
          hasConnection: false,
        });
        expect(f.requests()).toHaveLength(step);
        expect(reserve).toHaveBeenCalledTimes(step);
        expect(f.network.unexpected).toEqual([]);
        h.unchanged();
      } finally {
        await f.app.shutdown();
      }
    }
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const dispose of disposals.splice(0)) dispose();
});

describe("actual pinned SDK fixed synthetic local tool roundtrip", () => {
  it.each(["text/event-stream", null, "application/json"])(
    "completes exact fixed two-request history, with MIME %s",
    async (mime) => {
      const first = sdkStream(callCompleted(), mime, 7);
      const second = sdkStream(roundtripTerminal([markerMessage()]), mime, 9);
      const f = roundtripFetch(first.response, second.response);
      const model = adapter(f.fetch);
      const result = await model.run();
      expect(result).toMatchObject({
        outcome: "pass",
        code: "roundtrip_complete",
        attempts: 2,
        functionEchoValidated: true,
        finalMarkerAcknowledged: true,
        first: {
          reservation: "reserved",
          fetchInvoked: true,
          observedTerminal: "completed",
          cleanup: "complete",
        },
        second: {
          reservation: "reserved",
          fetchInvoked: true,
          observedTerminal: "completed",
          cleanup: "complete",
        },
      });
      expect(f.requests).toHaveLength(2);
      expect(model.reserve).toHaveBeenCalledTimes(2);
      expect(model.reserve.mock.calls).toEqual([[1], [2]]);
      const [one, two] = f.requests;
      if (!one || !two)
        throw new Error("Expected precisely two injected requests");
      for (const request of [one, two]) {
        expect(request.url).toBe(RESPONSES_ENDPOINT);
        expect(request.method).toBe("POST");
        expect(request.redirect).toBe("error");
        expect(request.headers.get("authorization")).toBe(`Bearer ${ACCESS}`);
      }
      const initial: unknown = await one.json();
      expect(initial).toEqual(firstRequest());
      const continuation: unknown = await two.json();
      expect(continuation).toEqual({
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
      expect(first.body.locked).toBe(false);
      expect(second.body.locked).toBe(false);
      expect(globalThis.fetch).not.toHaveBeenCalled();
      noPrivate(result);
      const replay = await model.run();
      expect(replay.outcome).not.toBe("pass");
      expect(f.requests).toHaveLength(2);
      expect(model.reserve).toHaveBeenCalledTimes(2);
    }
  );

  it("reserves each request before Fetch and only the terminal-validated echo permits step two", async () => {
    const seen = vi.fn();
    const first = stalledSdkStream(callFragments());
    const f = roundtripFetch(
      () => {
        expect(seen).toHaveBeenCalledTimes(1);
        return first.response;
      },
      () => {
        expect(seen).toHaveBeenCalledTimes(2);
        return sdkStream(roundtripTerminal([markerMessage()])).response;
      }
    );
    const model = adapter(f.fetch);
    model.reserve.mockImplementation(() => {
      seen();
      return true;
    });
    const pending = model.run();
    await first.readStarted;
    expect(seen).toHaveBeenCalledTimes(1);
    expect(f.requests).toHaveLength(1);
    const concurrent = await model.run();
    expect(concurrent.outcome).not.toBe("pass");
    expect(f.requests).toHaveLength(1);
    first.completeLate(roundtripTerminal([reasoning(), echoCall()]));
    expect(await pending).toMatchObject({
      outcome: "pass",
      functionEchoValidated: true,
      finalMarkerAcknowledged: true,
    });
    expect(f.requests).toHaveLength(2);
    expect(model.reserve).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["wrong namespace", [echoCall({ namespace: "other" })]],
    ["missing namespace", [echoCall({ namespace: undefined })]],
    ["wrong name", [echoCall({ name: "other" })]],
    [
      "qualified instead of exact name",
      [echoCall({ name: "feasibility.echo" })],
    ],
    ["missing call ID", [echoCall({ call_id: undefined })]],
    ["empty call ID", [echoCall({ call_id: "" })]],
    ["unbounded call ID", [echoCall({ call_id: "x".repeat(257) })]],
    ["empty item ID", [echoCall({ id: "" })]],
    ["whitespace ID", [echoCall({ id: "not one ID" })]],
    ["same item and call ID", [echoCall({ call_id: TOOL_ITEM_ID })]],
    ["asynchronous call not supported", [echoCall({ async: true })]],
    ["unbounded item ID", [echoCall({ id: "x".repeat(257) })]],
    ["incomplete item", [echoCall({ status: "in_progress" })]],
    [
      "duplicate exact JSON key",
      [echoCall({ arguments: '{"value":"p15_3","value":"p15_3"}' })],
    ],
    [
      "escaped duplicate JSON key",
      [echoCall({ arguments: '{"value":"p15_3","\\u0076alue":"p15_3"}' })],
    ],
    [
      "extra JSON property",
      [echoCall({ arguments: '{"value":"p15_3","extra":true}' })],
    ],
    ["malformed JSON", [echoCall({ arguments: '{"value":' })]],
    ["wrong fixed marker", [echoCall({ arguments: '{"value":"other"}' })]],
    ["wrong value type", [echoCall({ arguments: '{"value":42}' })]],
    ["wrong argument container", [echoCall({ arguments: ["p15_3"] })]],
    ["missing arguments", [echoCall({ arguments: undefined })]],
    ["no function call", [reasoning(), markerMessage()]],
    ["duplicate call identity", [echoCall(), echoCall()]],
    [
      "multiple distinct calls",
      [
        echoCall(),
        echoCall({ id: "different-item", call_id: "different-call" }),
      ],
    ],
    [
      "duplicate item ID with reasoning",
      [reasoning(), echoCall({ id: REASON_ID })],
    ],
    ["unknown tool item type", [echoCall({ type: "custom_tool_call" })]],
  ] as const)(
    "rejects %s before fixed echo and second reservation",
    async (_label, output) => {
      const f = roundtripFetch(
        sdkStream(roundtripTerminal([...output])).response
      );
      const model = adapter(f.fetch);
      const result = await model.run();
      expect(result.outcome).not.toBe("pass");
      expect(result.functionEchoValidated).toBe(false);
      expect(result.finalMarkerAcknowledged).toBe(false);
      expect(f.requests).toHaveLength(1);
      expect(model.reserve).toHaveBeenCalledTimes(1);
      noPrivate(result);
    }
  );

  it.each([
    ["partial call EOF", callFragments()],
    ["partial call DONE", callFragments() + "data: [DONE]\n\n"],
    ["failed terminal", callFragments() + sdkFailure("response.failed")],
    [
      "incomplete terminal",
      callFragments() + sdkFailure("response.incomplete"),
    ],
    ["error terminal", callFragments() + sdkFailure("error")],
    ["mismatched status", roundtripTerminal([echoCall()], "incomplete")],
    ["malformed non-SSE", JSON.stringify({ argument: FUNCTION_ARGS })],
    ["duplicate terminal", callCompleted() + roundtripTerminal([echoCall()])],
    [
      "mismatched partial ID",
      callFragments(echoCall({ id: "different-item" })) +
        roundtripTerminal([reasoning(), echoCall()]),
    ],
    [
      "mismatched partial arguments",
      callFragments(echoCall({ arguments: '{"value":"other"}' })) +
        roundtripTerminal([reasoning(), echoCall()]),
    ],
  ])("refuses %s instead of executing partial call", async (_label, frames) => {
    const f = roundtripFetch(sdkStream(frames, null).response);
    const model = adapter(f.fetch);
    const result = await model.run();
    expect(result.outcome).not.toBe("pass");
    expect(result.functionEchoValidated).toBe(false);
    expect(f.requests).toHaveLength(1);
    expect(model.reserve).toHaveBeenCalledTimes(1);
    noPrivate(result);
  });

  it.each([
    ["wrong final marker", roundtripTerminal([markerMessage(SDK_SENTINEL)])],
    ["second failed", sdkFailure("response.failed")],
    ["second incomplete", sdkFailure("response.incomplete")],
    ["second error", sdkFailure("error")],
    [
      "second EOF",
      eventFrame("response.output_text.delta", { delta: SDK_MARKER }),
    ],
    ["second wrong status", roundtripTerminal([markerMessage()], "incomplete")],
    [
      "second unexpected function call",
      roundtripTerminal([
        markerMessage(),
        echoCall({ id: "new-item", call_id: "new-call" }),
      ]),
    ],
    [
      "second partial call",
      callFragments() + roundtripTerminal([markerMessage()]),
    ],
    [
      "second unsupported custom tool fragment",
      eventFrame("response.output_item.added", {
        output_index: 0,
        item: {
          type: "custom_tool_call",
          id: "synthetic-extra-item",
          call_id: "synthetic-extra-call",
          name: "unsupported",
          input: "",
        },
      }) +
        eventFrame("response.custom_tool_call_input.delta", {
          output_index: 0,
          item_id: "synthetic-extra-item",
          delta: SDK_SENTINEL,
        }) +
        roundtripTerminal([markerMessage()]),
    ],
    [
      "second duplicate completion",
      roundtripTerminal([markerMessage()]) +
        roundtripTerminal([markerMessage()]),
    ],
  ])(
    "rejects %s after one valid echo but never sends a third request",
    async (_label, frames) => {
      const f = roundtripFetch(
        sdkStream(callCompleted()).response,
        sdkStream(frames).response
      );
      const model = adapter(f.fetch);
      const result = await model.run();
      expect(result.outcome).not.toBe("pass");
      expect(result.functionEchoValidated).toBe(true);
      expect(result.finalMarkerAcknowledged).toBe(false);
      expect(model.reserve).toHaveBeenCalledTimes(2);
      expect(f.requests).toHaveLength(2);
      expect((await model.run()).outcome).not.toBe("pass");
      expect(f.requests).toHaveLength(2);
      noPrivate(result);
    }
  );

  it.each([
    [1, "HTTP"],
    [2, "HTTP"],
    [1, "network"],
    [2, "network"],
  ] as const)("never retries rejected step %s (%s)", async (step, kind) => {
    const failed =
      kind === "network"
        ? () => {
            throw new Error(SDK_SENTINEL);
          }
        : new Response(
            JSON.stringify({
              error: { code: SDK_SENTINEL, message: SDK_SENTINEL },
            }),
            {
              status: 503,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": "0",
              },
            }
          );
    const f =
      step === 1
        ? roundtripFetch(failed)
        : roundtripFetch(sdkStream(callCompleted()).response, failed);
    const model = adapter(f.fetch);
    const result = await model.run();
    expect(result.outcome).not.toBe("pass");
    expect(result.finalMarkerAcknowledged).toBe(false);
    expect(f.requests).toHaveLength(step);
    expect(model.reserve).toHaveBeenCalledTimes(step);
    noPrivate(result);
  });

  it("accepts valid unique escaped JSON string keys and values while preserving returned history verbatim", async () => {
    const returned = echoCall({
      arguments: '{ "\\u0076alue" : "p15\\u005f3" }',
    });
    const f = roundtripFetch(
      sdkStream(roundtripTerminal([reasoning(), returned])).response,
      sdkStream(roundtripTerminal([markerMessage()])).response
    );
    const result = await adapter(f.fetch).run();
    expect(result).toMatchObject({
      outcome: "pass",
      functionEchoValidated: true,
      finalMarkerAcknowledged: true,
    });
    expect(f.requests).toHaveLength(2);
    const history: unknown = await f.requests[1]?.json();
    expect(history).toMatchObject({
      input: [
        ...expectedInput(),
        reasoning(),
        returned,
        {
          type: "function_call_output",
          call_id: TOOL_CALL_ID,
          output: FUNCTION_OUTPUT,
        },
      ],
    });
    noPrivate(result);
  });

  it("preserves completed reasoning item encrypted context when terminal reasoning omits it", async () => {
    const done = reasoning();
    const { encrypted_content: omitted, ...terminalReasoning } = done;
    expect(omitted).toBe(ENCRYPTED_REASON);
    const frames =
      eventFrame("response.output_item.added", {
        output_index: 0,
        item: terminalReasoning,
      }) +
      eventFrame("response.output_item.done", { output_index: 0, item: done }) +
      callFragments() +
      roundtripTerminal([terminalReasoning, echoCall()]);
    const f = roundtripFetch(
      sdkStream(frames).response,
      sdkStream(roundtripTerminal([markerMessage()])).response
    );
    expect(await adapter(f.fetch).run()).toMatchObject({ outcome: "pass" });
    const history: unknown = await f.requests[1]?.json();
    expect(history).toMatchObject({
      input: [
        ...expectedInput(),
        done,
        echoCall(),
        {
          type: "function_call_output",
          call_id: TOOL_CALL_ID,
          output: FUNCTION_OUTPUT,
        },
      ],
    });
  });

  it("preserves additional returned assistant phase/content and reasoning history before the matching output", async () => {
    const message = { ...markerMessage(SDK_SENTINEL), phase: "commentary" };
    const output = [reasoning(), message, echoCall()];
    const f = roundtripFetch(
      sdkStream(roundtripTerminal(output)).response,
      sdkStream(roundtripTerminal([markerMessage()])).response
    );
    const result = await adapter(f.fetch).run();
    expect(result).toMatchObject({ outcome: "pass", attempts: 2 });
    expect(await f.requests[1]?.json()).toMatchObject({
      input: [
        ...expectedInput(),
        ...output,
        {
          type: "function_call_output",
          call_id: TOOL_CALL_ID,
          output: FUNCTION_OUTPUT,
        },
      ],
    });
    noPrivate(result);
  });

  it("rejects over-budget continuation history before second reservation even when first stream fits the byte cap", async () => {
    const base = roundtripTerminal([
      { ...reasoning(), encrypted_content: "" },
      echoCall(),
    ]);
    const spare = 1_048_576 - new TextEncoder().encode(base).byteLength;
    const first = roundtripTerminal([
      { ...reasoning(), encrypted_content: "x".repeat(spare - 10) },
      echoCall(),
    ]);
    expect(new TextEncoder().encode(first).byteLength).toBeLessThanOrEqual(
      1_048_576
    );
    const f = roundtripFetch(sdkStream(first, null, 65536).response);
    const model = adapter(f.fetch);
    expect(await model.run()).toMatchObject({
      code: "response_limit",
      attempts: 1,
      finalMarkerAcknowledged: false,
    });
    expect(f.requests).toHaveLength(1);
    expect(model.reserve.mock.calls).toEqual([[1]]);
  });

  it("rejects conflicting reasoning continuation context before second request", async () => {
    const frames =
      eventFrame("response.output_item.done", {
        output_index: 0,
        item: reasoning(),
      }) +
      callFragments() +
      roundtripTerminal([
        { ...reasoning(), encrypted_content: "different-encrypted-context" },
        echoCall(),
      ]);
    const f = roundtripFetch(sdkStream(frames).response);
    const model = adapter(f.fetch);
    expect(await model.run()).toMatchObject({
      outcome: "failed",
      functionEchoValidated: false,
      finalMarkerAcknowledged: false,
    });
    expect(f.requests).toHaveLength(1);
    expect(model.reserve).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["eligibility", { eligible: false }],
    ["operator initiation", { operatorStarted: false }],
    ["plan-only", { planOnlyConfirmed: false }],
    ["no-credit fallback", { creditFallbackDisabled: false }],
  ] as const)(
    "requires %s before reservation and Fetch",
    async (_label, authorization) => {
      const f = roundtripFetch(sdkStream(callCompleted()).response);
      const model = adapter(f.fetch);
      const context = sdkContext();
      expect(
        (
          await model.run({
            ...context,
            authorization: { ...context.authorization, ...authorization },
          })
        ).outcome
      ).not.toBe("pass");
      expect(model.reserve).not.toHaveBeenCalled();
      expect(f.requests).toHaveLength(0);
    }
  );

  it("refuses separate owner gesture, absent authorization and stale historic budgets before reservation", async () => {
    const f = roundtripFetch(sdkStream(callCompleted()).response);
    const model = adapter(f.fetch);
    expect((await model.run(sdkContext(), false)).outcome).not.toBe("pass");
    model.isAuthorized.mockReturnValue(false);
    expect((await model.run()).outcome).not.toBe("pass");
    model.isAuthorized.mockReturnValue(true);
    model.assertFrozenBudgets.mockImplementation(() => {
      throw new SigninFault("storage_invalid");
    });
    expect((await model.run()).outcome).not.toBe("pass");
    expect(model.reserve).not.toHaveBeenCalled();
    expect(f.requests).toHaveLength(0);
  });

  it.each([
    makeConnection({ expiresAt: NOW }),
    makeConnection({ scopes: ["openid"] }),
  ])("refuses expired or unentitled account", async (connection) => {
    const f = roundtripFetch(sdkStream(callCompleted()).response);
    const model = adapter(f.fetch, sdkContext({ connection }));
    expect((await model.run()).outcome).not.toBe("pass");
    expect(model.reserve).not.toHaveBeenCalled();
    expect(f.requests).toHaveLength(0);
  });

  it("refuses stale token and invalid selected model before reservation", async () => {
    const f = roundtripFetch(sdkStream(callCompleted()).response);
    const model = adapter(f.fetch);
    expect(
      (
        await model.run(
          sdkContext({
            connection: makeConnection({ accessToken: SDK_SENTINEL }),
          })
        )
      ).outcome
    ).not.toBe("pass");
    expect(
      (await model.run(sdkContext({ modelSlug: "invalid model" }))).outcome
    ).not.toBe("pass");
    expect(model.reserve).not.toHaveBeenCalled();
    expect(f.requests).toHaveLength(0);
  });

  it.each([1, 2])(
    "reservation uncertainty at step %s prevents its dispatch and cannot be replayed",
    async (step) => {
      const f = roundtripFetch(
        sdkStream(callCompleted()).response,
        sdkStream(roundtripTerminal([markerMessage()])).response
      );
      const model = adapter(f.fetch);
      if (step === 2) model.reserve.mockReturnValueOnce(true);
      model.reserve.mockImplementationOnce(() => {
        throw new SigninFault("storage_failed");
      });
      const failed = await model.run();
      expect(failed.outcome).not.toBe("pass");
      expect(failed.finalMarkerAcknowledged).toBe(false);
      expect(f.requests).toHaveLength(step - 1);
      expect(model.reserve).toHaveBeenCalledTimes(step);
      expect((await model.run()).outcome).not.toBe("pass");
      expect(f.requests).toHaveLength(step - 1);
      noPrivate(failed);
    }
  );

  it("refuses second step if account binding changes before first completion settles", async () => {
    const wire = stalledSdkStream(callFragments());
    const f = roundtripFetch(wire.response);
    const model = adapter(f.fetch);
    const pending = model.run();
    await wire.readStarted;
    model.loadConnection.mockReturnValue(
      makeConnection({ accessToken: SDK_SENTINEL })
    );
    wire.completeLate(roundtripTerminal([reasoning(), echoCall()]));
    const failed = await pending;
    expect(failed.outcome).not.toBe("pass");
    expect(failed.finalMarkerAcknowledged).toBe(false);
    expect(f.requests).toHaveLength(1);
    expect(model.reserve).toHaveBeenCalledTimes(1);
    noPrivate(failed);
  });

  it("refuses second step if selected model changes during the first stream", async () => {
    const wire = stalledSdkStream(callFragments());
    const f = roundtripFetch(wire.response);
    const context = sdkContext();
    const model = adapter(f.fetch, context);
    const pending = model.run();
    await wire.readStarted;
    context.modelSlug = "synthetic-other-model";
    wire.completeLate(roundtripTerminal([reasoning(), echoCall()]));
    expect(await pending).toMatchObject({
      code: "model_not_selected",
      finalMarkerAcknowledged: false,
    });
    expect(f.requests).toHaveLength(1);
    expect(model.reserve.mock.calls).toEqual([[1]]);
  });

  it("revalidates authorization after first request and before spending second step", async () => {
    const wire = stalledSdkStream(callFragments());
    const f = roundtripFetch(wire.response);
    const model = adapter(f.fetch);
    const pending = model.run();
    await wire.readStarted;
    model.isAuthorized.mockReturnValue(false);
    wire.completeLate(roundtripTerminal([reasoning(), echoCall()]));
    expect(await pending).toMatchObject({
      code: "budget_exhausted",
      finalMarkerAcknowledged: false,
    });
    expect(f.requests).toHaveLength(1);
    expect(model.reserve.mock.calls).toEqual([[1]]);
  });

  it.each([1, 2])(
    "cancellation during step %s reservation cannot dispatch even after reservation succeeds",
    async (step) => {
      const cancellation = createProbeCancellation();
      const f = roundtripFetch(
        sdkStream(callCompleted()).response,
        sdkStream(roundtripTerminal([markerMessage()])).response
      );
      const model = adapter(f.fetch, sdkContext({ cancellation }));
      model.reserve.mockImplementation((value) => {
        if (value === step) cancellation.cancel();
        return true;
      });
      expect(await model.run()).toMatchObject({
        code: "cancelled",
        attempts: step,
        finalMarkerAcknowledged: false,
      });
      expect(f.requests).toHaveLength(step - 1);
      expect(model.reserve).toHaveBeenCalledTimes(step);
      expect((await model.run()).outcome).not.toBe("pass");
      expect(f.requests).toHaveLength(step - 1);
    }
  );

  it("default adapter has no synthetic allowance, even with all owner and account gates satisfied", async () => {
    const f = roundtripFetch(sdkStream(callCompleted()).response);
    const sdk = new SdkToolRoundtrip({
      fetch: f.fetch,
      AbortController,
      clock: testClock(),
      loadConnection: () => makeConnection(),
      assertFrozenBudgets: () => {},
    });
    expect(sdk.status()).toMatchObject({
      experiment: SDK_TOOL_EXPERIMENT,
      mode: "offline_only",
      allowanceAvailable: false,
    });
    const result = await sdk.run(sdkContext(), true);
    expect(result).toMatchObject({
      outcome: "blocked",
      code: "budget_exhausted",
      attempts: 0,
      functionEchoValidated: false,
      finalMarkerAcknowledged: false,
    });
    expect(f.requests).toHaveLength(0);
  });

  it("publishes only authentic immutable sanitized result, not arbitrary copied or replayed evidence", async () => {
    const f = roundtripFetch(
      sdkStream(callCompleted()).response,
      sdkStream(roundtripTerminal([markerMessage()])).response
    );
    const model = adapter(f.fetch);
    const result = await model.run();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.first)).toBe(true);
    expect(Object.isFrozen(result.second)).toBe(true);
    model.sdk.publish({ ...result });
    expect(model.sdk.status().result).toBeUndefined();
    model.sdk.publish(result);
    const accepted = model.sdk.status();
    expect(accepted).toMatchObject({ allowanceAvailable: false, result });
    noPrivate(accepted.result);
    model.sdk.publish(await model.run());
    expect(model.sdk.status()).toEqual(accepted);
    expect(f.requests).toHaveLength(2);
  });

  it.each([1, 2])(
    "cancel while step %s is stalled rejects late completion and retains no additional allowance",
    async (step) => {
      const cancellation = createProbeCancellation();
      const wire = stalledSdkStream(
        step === 1
          ? callFragments()
          : eventFrame("response.output_text.delta", { delta: SDK_MARKER })
      );
      const f =
        step === 1
          ? roundtripFetch(wire.response)
          : roundtripFetch(sdkStream(callCompleted()).response, wire.response);
      const model = adapter(f.fetch, sdkContext({ cancellation }));
      const pending = model.run();
      await wire.readStarted;
      cancellation.cancel();
      const failed = await pending;
      expect(failed).toMatchObject({
        code: "cancelled",
        finalMarkerAcknowledged: false,
      });
      expect(f.requests).toHaveLength(step);
      expect(model.reserve).toHaveBeenCalledTimes(step);
      expect(f.requests[step - 1]?.signal.aborted).toBe(true);
      wire.completeLate(
        roundtripTerminal(
          step === 1 ? [reasoning(), echoCall()] : [markerMessage()]
        )
      );
      expect((await model.run()).outcome).not.toBe("pass");
      expect(f.requests).toHaveLength(step);
      noPrivate(failed);
    }
  );

  it.each([1, 2])(
    "timeout while step %s is stalled rejects late data without replay",
    async (step) => {
      vi.useFakeTimers();
      const wire = stalledSdkStream(
        step === 1
          ? callFragments()
          : eventFrame("response.output_text.delta", { delta: SDK_MARKER })
      );
      const f =
        step === 1
          ? roundtripFetch(wire.response)
          : roundtripFetch(sdkStream(callCompleted()).response, wire.response);
      const model = adapter(f.fetch);
      const pending = model.run();
      await wire.readStarted;
      await vi.advanceTimersByTimeAsync(120_000);
      const failed = await pending;
      expect(failed).toMatchObject({
        code: "timeout",
        finalMarkerAcknowledged: false,
      });
      expect(f.requests).toHaveLength(step);
      expect(model.reserve).toHaveBeenCalledTimes(step);
      expect(f.requests[step - 1]?.signal.aborted).toBe(true);
      wire.completeLate(
        roundtripTerminal(
          step === 1 ? [reasoning(), echoCall()] : [markerMessage()]
        )
      );
      await vi.advanceTimersByTimeAsync(0);
      expect((await model.run()).outcome).not.toBe("pass");
      expect(f.requests).toHaveLength(step);
    }
  );
});
