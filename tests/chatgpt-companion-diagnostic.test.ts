import * as fs from "node:fs";
import { createContext, runInContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseControlAction } from "../src/companion-feasibility/contracts.js";
import {
  DiagnosticBudget,
  DIAGNOSTIC_EXPERIMENT,
  DIAGNOSTIC_BUDGET_FILE,
  DIAGNOSTIC_AUTHORIZATION_FILE,
  type DiagnosticRecordName,
  type DiagnosticRecordStore,
} from "../src/companion-feasibility/diagnostic-budget.js";
import { createCompanionRuntime } from "../src/companion-feasibility/runtime.js";
import { createCompanionStorage } from "../src/companion-feasibility/storage.js";
import {
  MODELS_ENDPOINT,
  RESPONSES_ENDPOINT,
  SigninFault,
  TOKEN_ENDPOINT,
} from "../src/extension/feasibility/signin-contracts.js";
import { companionHome, runtimeFixture } from "./fixtures/chatgpt-companion.js";
import {
  completedText,
  diagnosticWire,
  encode,
  PRIVATE_SENTINEL,
} from "./fixtures/chatgpt-response-diagnostics.js";
import {
  ACCESS,
  REFRESH,
  REVOKE,
  makeConnection,
  json,
  tokenPayload,
} from "./fixtures/chatgpt-signin.js";

const ACTION = { operatorStarted: true };
const PLAN = {
  ...ACTION,
  planOnlyConfirmed: true,
  creditFallbackDisabled: true,
};
const MODEL = "synthetic-model";
const disposals: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dispose of disposals.splice(0)) dispose();
});

function originalHome() {
  const h = companionHome();
  disposals.push(h.dispose);
  const storage = createCompanionStorage(h.deps);
  expect(storage.probeDurability(123).code).toBe("restart_required");
  expect(storage.probeDurability(456).outcome).toBe("pass");
  storage.store.saveConnection(makeConnection());
  expect(storage.store.reserveInferenceAttempt().attempts).toBe(1);
  const original = fs.readFileSync(h.file("run-budget.json"));
  const unchanged = () =>
    expect(fs.readFileSync(h.file("run-budget.json"))).toEqual(original);
  return { ...h, unchanged };
}

function runtimeFor(
  h: ReturnType<typeof originalHome>,
  eligibilityBasisReady = true,
  diagnosticMode = true
) {
  const fixture = runtimeFixture(h, 789);
  const runtime = createCompanionRuntime({
    ...fixture.deps,
    eligibilityBasisReady,
    diagnosticMode,
  });
  const requests = () =>
    fixture.network.calls.filter((call) => call.url === RESPONSES_ENDPOINT);
  const preflight = async () => {
    fixture.network.enqueueDiscovery();
    fixture.network.enqueueJwks();
    expect(await runtime.session.preflight(ACTION)).toMatchObject({
      preflightReady: true,
      persistedConnectionLoaded: true,
      attempts: 1,
    });
  };
  const refresh = async () => {
    fixture.network.enqueue(
      TOKEN_ENDPOINT,
      json(tokenPayload({ id_token: undefined }))
    );
    expect(await runtime.session.refresh(ACTION)).toMatchObject({
      refreshVerified: true,
      attempts: 1,
    });
  };
  const models = async () => {
    fixture.network.enqueue(
      MODELS_ENDPOINT,
      json({
        models: [
          { visibility: "list", slug: MODEL, display_name: "Synthetic model" },
        ],
      })
    );
    expect(await runtime.session.loadModels(ACTION)).toMatchObject({
      code: "models_loaded",
      attempts: 1,
    });
  };
  const select = () =>
    expect(runtime.session.selectModel(MODEL, ACTION)).toMatchObject({
      selectedModelSlug: MODEL,
    });
  const confirm = () =>
    expect(runtime.session.confirmPlanOnly(PLAN)).toMatchObject({
      planOnlyConfirmed: true,
      creditFallbackDisabled: true,
    });
  const ready = async () => {
    await preflight();
    await refresh();
    await models();
    select();
    confirm();
  };
  return {
    ...fixture,
    runtime,
    requests,
    preflight,
    refresh,
    models,
    select,
    confirm,
    ready,
  };
}

const secretFree = (value: unknown) => {
  const text = JSON.stringify(value);
  for (const secret of [ACCESS, REFRESH, PRIVATE_SENTINEL, RESPONSES_ENDPOINT])
    expect(text).not.toContain(secret);
};

describe("D3 separate durable diagnostic budget", () => {
  it("is absent by default, authorizes only explicitly, and remains exhausted across store restart", () => {
    const h = originalHome();
    const open = () =>
      new DiagnosticBudget(
        createCompanionStorage(h.deps, true).diagnosticRecords()
      );
    const budget = open();
    expect(budget.status()).toMatchObject({
      state: "not_authorized",
      attempts: null,
      cap: 1,
    });
    expect(() => budget.reserve()).toThrow("storage_invalid");
    expect(() => budget.authorize(false)).toThrow("operator_required");
    expect(fs.existsSync(h.file(DIAGNOSTIC_BUDGET_FILE))).toBe(false);
    expect(budget.authorize(true)).toMatchObject({
      state: "ready",
      attempts: 0,
      cap: 1,
    });
    expect(open().reserve()).toMatchObject({
      state: "exhausted",
      attempts: 1,
      cap: 1,
    });
    const restarted = open();
    expect(restarted.status()).toMatchObject({
      state: "exhausted",
      attempts: 1,
      cap: 1,
    });
    expect(() => restarted.reserve()).toThrow("budget_exhausted");
    expect(() => restarted.authorize(true)).toThrow("storage_invalid");
    expect(
      JSON.parse(fs.readFileSync(h.file(DIAGNOSTIC_BUDGET_FILE), "utf8"))
    ).toEqual({
      version: 1,
      experimentId: DIAGNOSTIC_EXPERIMENT,
      cap: 1,
      attempts: 1,
    });
    h.unchanged();
  });

  it.each([
    "budget missing",
    "authorization missing",
    "corrupt budget",
    "orphan temporary",
    "original changed",
  ])("blocks durable dispatch after %s", (kind) => {
    const h = originalHome();
    const open = () =>
      new DiagnosticBudget(
        createCompanionStorage(h.deps, true).diagnosticRecords()
      );
    open().authorize(true);
    if (kind === "budget missing")
      fs.unlinkSync(h.file(DIAGNOSTIC_BUDGET_FILE));
    else if (kind === "authorization missing")
      fs.unlinkSync(h.file(DIAGNOSTIC_AUTHORIZATION_FILE));
    else if (kind === "corrupt budget")
      fs.writeFileSync(h.file(DIAGNOSTIC_BUDGET_FILE), PRIVATE_SENTINEL);
    else if (kind === "orphan temporary")
      fs.writeFileSync(
        h.file(
          `.${DIAGNOSTIC_BUDGET_FILE}.11111111-1111-4111-8111-111111111111.tmp`
        ),
        "{}",
        { mode: 0o600 }
      );
    else {
      const original = JSON.parse(
        fs.readFileSync(h.file("run-budget.json"), "utf8")
      ) as Record<string, unknown>;
      fs.writeFileSync(
        h.file("run-budget.json"),
        JSON.stringify({ ...original, attempts: 2 })
      );
    }
    const restarted = open();
    expect(restarted.status()).toMatchObject({
      state: "blocked",
      attempts: null,
    });
    expect(() => restarted.reserve()).toThrow("storage_invalid");
    expect(() => restarted.authorize(true)).toThrow("storage_invalid");
    if (kind !== "original changed") h.unchanged();
  });

  it.each([false, true])(
    "uncertain reservation blocks replay even across restart (budget write committed=%s)",
    (committed) => {
      const records = new Map<DiagnosticRecordName, unknown>();
      let interrupt = false;
      const store: DiagnosticRecordStore = {
        assertOriginalFrozen: () => {},
        assertNoDiagnosticTemporaries: () => {},
        read: (name) => structuredClone(records.get(name)),
        write: (name, value) => {
          if (interrupt && name === DIAGNOSTIC_BUDGET_FILE) {
            if (committed) records.set(name, structuredClone(value));
            throw new SigninFault("storage_failed");
          }
          records.set(name, structuredClone(value));
        },
      };
      const budget = new DiagnosticBudget(store);
      budget.authorize(true);
      interrupt = true;
      expect(() => budget.reserve()).toThrow("storage_failed");
      expect(budget.status()).toMatchObject({
        state: "blocked",
        attempts: null,
      });
      const restarted = new DiagnosticBudget(store);
      expect(restarted.status()).toMatchObject(
        committed
          ? { state: "exhausted", attempts: 1 }
          : { state: "blocked", attempts: null }
      );
      expect(() => restarted.reserve()).toThrow();
      expect(() => restarted.authorize(true)).toThrow();
    }
  );
});

describe("D3 explicit companion diagnostic action", () => {
  it("renders separate budget and nullable measurements in the actual panel script without enabling legacy probes", () => {
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
        selectedModelSlug: MODEL,
        models: [{ slug: MODEL, displayName: "Synthetic model" }],
        planOnlyConfirmed: true,
        creditFallbackDisabled: true,
        attempts: 1,
      },
      runtime: {
        storage: { state: "ready" },
        diagnostic: {
          originalAttempts: 1,
          budget: {
            cap: 1,
            state: "not_authorized",
            attempts: null as number | null,
          },
          result: {
            evidence: {
              bytes: null,
              events: null,
              diagnostics: { transportBytes: 0, parserBytes: null },
            },
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
    expect(element("roundtrip").disabled).toBe(true);
    expect(element("cancellation").disabled).toBe(true);
    expect(element("run-diagnostic").disabled).toBe(true);
    expect(element("authorize-diagnostic").disabled).toBe(true);
    expect(element("attempts").textContent).toContain("1/3");
    expect(element("diagnostic-attempts").textContent).toContain(
      "no verified allowance"
    );
    expect(JSON.parse(element("evidence").textContent)).toMatchObject({
      runtime: {
        diagnostic: {
          result: {
            evidence: {
              bytes: null,
              events: null,
              diagnostics: { transportBytes: 0, parserBytes: null },
            },
          },
        },
      },
    });
    for (const id of ["plan-only", "credits-off", "diagnostic-consent"])
      element(id).checked = true;
    runInContext("render(data)", context);
    expect(element("authorize-diagnostic").disabled).toBe(false);
    expect(element("run-diagnostic").disabled).toBe(true);
    Object.assign(data.runtime.diagnostic.budget, {
      state: "ready",
      attempts: 0,
    });
    runInContext("render(data)", context);
    expect(element("authorize-diagnostic").disabled).toBe(true);
    expect(element("run-diagnostic").disabled).toBe(false);
    expect(element("diagnostic-attempts").textContent).toContain("0/1");
    Object.assign(data.runtime.diagnostic.budget, {
      state: "exhausted",
      attempts: 1,
    });
    runInContext("render(data)", context);
    expect(element("run-diagnostic").disabled).toBe(true);
    expect(element("authorize-diagnostic").disabled).toBe(true);
    expect(element("diagnostic-attempts").textContent).toContain("1/1");
    expect(element("roundtrip").disabled).toBe(true);
    expect(element("cancellation").disabled).toBe(true);
  });

  it.each(["authorize_text_diagnostic", "run_text_diagnostic"])(
    "requires exact named owner gate, not arbitrary request fields for %s",
    (action) => {
      const approved = {
        action,
        operatorStarted: true,
        ownerAuthorized: true,
        experiment: DIAGNOSTIC_EXPERIMENT,
      };
      expect(parseControlAction(approved)).toEqual(approved);
      for (const bad of [
        { action, operatorStarted: true },
        { ...approved, operatorStarted: false },
        { ...approved, ownerAuthorized: false },
        { ...approved, experiment: "different-experiment" },
        { ...approved, input: PRIVATE_SENTINEL },
        { ...approved, model: MODEL },
        { ...approved, tools: [] },
      ])
        expect(parseControlAction(bad)).toBeUndefined();
    }
  );

  it("disabled mode and ineligible mode make no diagnostic request or permission record", async () => {
    const h = originalHome();
    const disabled = runtimeFor(h, true, false);
    await expect(
      disabled.runtime.authorizeTextDiagnostic(true)
    ).rejects.toMatchObject({ code: "operator_required" });
    await expect(
      disabled.runtime.runTextDiagnostic(true)
    ).rejects.toMatchObject({ code: "operator_required" });
    expect(disabled.runtime.status().diagnostic).toBeUndefined();
    expect(disabled.requests()).toHaveLength(0);
    const denied = runtimeFor(h, false);
    await denied.runtime.authorizeTextDiagnostic(true);
    await denied.runtime.runTextDiagnostic(true);
    expect(denied.runtime.session.snapshot().code).toBe("eligibility_pending");
    expect(denied.requests()).toHaveLength(0);
    expect(fs.existsSync(h.file(DIAGNOSTIC_BUDGET_FILE))).toBe(false);
    h.unchanged();
  });

  it("requires each fresh session gate and separately authorized named cap, rejecting old actions", async () => {
    const h = originalHome();
    const f = runtimeFor(h);
    const blocked = async () => {
      await f.runtime.authorizeTextDiagnostic(true);
      await f.runtime.runTextDiagnostic(true);
      expect(f.requests()).toHaveLength(0);
      expect(f.runtime.status().diagnostic?.budget).toMatchObject({
        state: "not_authorized",
        attempts: null,
      });
      h.unchanged();
    };
    await blocked();
    await f.preflight();
    await blocked();
    await f.refresh();
    await blocked();
    await f.models();
    await blocked();
    expect(f.runtime.session.selectModel("not-in-catalog", ACTION).code).toBe(
      "model_not_selected"
    );
    await blocked();
    f.select();
    await blocked();
    expect(
      f.runtime.session.confirmPlanOnly({
        ...PLAN,
        creditFallbackDisabled: false,
      }).code
    ).toBe("plan_only_required");
    await blocked();
    f.confirm();
    await expect(
      f.runtime.authorizeTextDiagnostic(false)
    ).rejects.toMatchObject({ code: "operator_required" });
    await expect(f.runtime.runTextDiagnostic(false)).rejects.toMatchObject({
      code: "operator_required",
    });
    await f.runtime.runTextDiagnostic(true);
    expect(f.runtime.status().diagnostic?.budget).toMatchObject({
      state: "not_authorized",
      attempts: null,
    });
    expect(await f.runtime.session.runRoundTrip(ACTION)).toMatchObject({
      code: "attempt_order_invalid",
    });
    expect(await f.runtime.session.runCancellation(ACTION)).toMatchObject({
      code: "attempt_order_invalid",
    });
    expect(f.requests()).toHaveLength(0);
    h.unchanged();
    await f.runtime.shutdown();
  });

  it("reserves before Fetch, sends precisely one fixed text-only request, and never replays after restart", async () => {
    const h = originalHome();
    const f = runtimeFor(h);
    await f.ready();
    await f.runtime.authorizeTextDiagnostic(true);
    expect(f.runtime.status().diagnostic).toMatchObject({
      originalAttempts: 1,
      budget: { state: "ready", attempts: 0, cap: 1 },
    });
    f.network.enqueue(RESPONSES_ENDPOINT, (init) => {
      expect(
        JSON.parse(fs.readFileSync(h.file(DIAGNOSTIC_BUDGET_FILE), "utf8"))
      ).toMatchObject({ attempts: 1, cap: 1 });
      h.unchanged();
      expect(init?.method).toBe("POST");
      if (typeof init?.body !== "string")
        throw new Error("Expected fixed JSON request");
      expect(JSON.parse(init.body)).toEqual({
        model: MODEL,
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
      return diagnosticWire([encode(completedText())]).asResponse();
    });
    await f.runtime.runTextDiagnostic(true);
    expect(f.runtime.status().diagnostic).toMatchObject({
      originalAttempts: 1,
      budget: { attempts: 1, state: "exhausted" },
      result: {
        outcome: "pass",
        markerAcknowledged: true,
        code: "response_completed",
        evidence: {
          diagnostics: { observedTerminal: "completed", transportChunks: 1 },
        },
      },
    });
    expect(f.requests()).toHaveLength(1);
    secretFree(f.runtime.status());
    await f.runtime.runTextDiagnostic(true);
    expect(f.requests()).toHaveLength(1);
    await f.runtime.shutdown();
    const restarted = runtimeFor(h);
    await restarted.ready();
    await restarted.runtime.authorizeTextDiagnostic(true);
    await restarted.runtime.runTextDiagnostic(true);
    expect(restarted.runtime.status().diagnostic?.budget).toMatchObject({
      attempts: 1,
      state: "exhausted",
    });
    expect(restarted.requests()).toHaveLength(0);
    h.unchanged();
    await restarted.runtime.shutdown();
  });

  it("late completion following sign-out cannot publish success or reauthorize the consumed experiment", async () => {
    const h = originalHome();
    const f = runtimeFor(h);
    await f.ready();
    await f.runtime.authorizeTextDiagnostic(true);
    const started = Promise.withResolvers<void>();
    const late = Promise.withResolvers<Response>();
    f.network.enqueue(RESPONSES_ENDPOINT, () => {
      started.resolve();
      return late.promise;
    });
    const running = f.runtime.runTextDiagnostic(true);
    await started.promise;
    expect(f.runtime.status().diagnostic?.budget).toMatchObject({
      attempts: 1,
      state: "exhausted",
    });
    f.network.enqueue(REVOKE, new Response(null, { status: 204 }));
    const signedOut = f.runtime.session.signOut(ACTION);
    late.resolve(diagnosticWire([encode(completedText())]).asResponse());
    await running;
    expect(await signedOut).toMatchObject({
      revocation: { localCleared: true },
    });
    expect(f.runtime.session.snapshot()).toMatchObject({
      hasConnection: false,
    });
    expect(f.runtime.status().diagnostic?.result).toBeUndefined();
    expect(f.runtime.status().diagnostic?.budget).toMatchObject({
      attempts: 1,
      state: "exhausted",
    });
    expect(f.requests()).toHaveLength(1);
    expect(f.network.unexpected).toEqual([]);
    h.unchanged();
    secretFree(f.runtime.status());
    await f.runtime.shutdown();
  });
});
