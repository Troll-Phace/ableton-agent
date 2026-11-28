import * as fs from "node:fs";
import type { RequestListener } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquireCompanionSingleton,
  startForegroundCompanion,
  COMPANION_CONTROL_ORIGIN,
  COMPANION_IDLE_MS,
  type CompanionControlContext,
  type ForegroundDependencies,
} from "../src/companion-feasibility/main.js";
import { createCompanionRuntime } from "../src/companion-feasibility/runtime.js";
import { createCompanionStorage } from "../src/companion-feasibility/storage.js";
import {
  MODELS_ENDPOINT,
  TOKEN_ENDPOINT,
  RESPONSES_ENDPOINT,
} from "../src/extension/feasibility/signin-contracts.js";
import {
  companionHome,
  fakeSingleton,
  runtimeFixture,
} from "./fixtures/chatgpt-companion.js";
import {
  ACCESS,
  REFRESH,
  CLIENT,
  SUBJECT,
  CODE,
  LOCAL_ID,
  REVOKE,
  DETAIL,
  eventFrame,
  json,
  makeConnection,
  pendingSse,
  signedIdToken,
  sseText,
  tokenPayload,
} from "./fixtures/chatgpt-signin.js";

const disposals: (() => void)[] = [];
function home() {
  const f = companionHome();
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
const MODELS = {
  models: [
    {
      visibility: "list",
      slug: "synthetic-model",
      display_name: "Synthetic model",
    },
  ],
};
function noSecrets(value: unknown) {
  const text = JSON.stringify(value);
  for (const secret of [
    ACCESS,
    REFRESH,
    CLIENT,
    SUBJECT,
    CODE,
    LOCAL_ID,
    REVOKE,
    DETAIL,
  ])
    expect(text).not.toContain(secret);
}
async function readyRuntime(
  f: ReturnType<typeof companionHome>,
  options: { pid?: number; seed?: boolean } = {}
) {
  const initial = createCompanionStorage(f.deps);
  if (options.seed !== false) {
    expect(initial.probeDurability(123).code).toBe("restart_required");
    expect(initial.probeDurability(456).outcome).toBe("pass");
    initial.store.saveConnection(makeConnection());
  }
  const fixture = runtimeFixture(f, options.pid ?? 789);
  const runtime = createCompanionRuntime(fixture.deps);
  fixture.network.enqueueDiscovery();
  fixture.network.enqueueJwks();
  expect(await runtime.session.preflight(ACTION)).toMatchObject({
    preflightReady: true,
    state: "connected",
    persistedConnectionLoaded: true,
  });
  return { ...fixture, runtime };
}
function transportClean(f: ReturnType<typeof runtimeFixture>) {
  expect(f.servers.every((server) => !server.listening)).toBe(true);
  expect(f.sockets.every((socket) => socket.destroyed)).toBe(true);
}
describe("F3C runtime actual isolated composition", () => {
  it("startup is inert for provider/callback/browser; storage proof first process blocks OAuth despite local transport/verifier success", async () => {
    const h = home();
    const f = runtimeFixture(h, 123);
    const runtime = createCompanionRuntime(f.deps);
    expect(runtime.status()).toEqual({ storage: { state: "ready" } });
    expect(runtime.session.snapshot()).toMatchObject({
      state: "idle",
      preflightReady: false,
    });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.createServer).not.toHaveBeenCalled();
    expect(f.browser).not.toHaveBeenCalled();
    expect(await runtime.session.signIn(ACTION)).toMatchObject({
      code: "preflight_required",
    });
    expect(f.fetch).not.toHaveBeenCalled();
    const result = await runtime.session.preflight(ACTION);
    expect(result).toMatchObject({
      code: "host_preflight_failed",
      preflightReady: false,
      hostPreflight: {
        nativeTransport: true,
        callbackBinding: true,
        privateStorage: false,
        bundledVerifier: true,
      },
    });
    expect(runtime.status().preflight).toMatchObject({
      storage: {
        outcome: "blocked",
        code: "restart_required",
        fileSync: true,
        directorySync: true,
      },
      transport: {
        outcome: "pass",
        preEofRead: true,
        streamComplete: true,
        pendingRead: true,
        abortRejected: true,
        responseClosed: true,
        cleanup: true,
      },
      verifier: { outcome: "pass" },
    });
    expect(f.loopback).toEqual(["/companion-stream", "/companion-abort"]);
    expect(await runtime.session.signIn(ACTION)).toMatchObject({
      code: "preflight_required",
    });
    expect(f.network.calls).toHaveLength(0);
    expect(f.browser).not.toHaveBeenCalled();
    transportClean(f);
    noSecrets(runtime.status());
    expect(await runtime.shutdown()).toEqual({
      cleanup: "complete",
      credentials: "not_cleared_by_shutdown",
    });
  });
  it("requires restart proof and mocked personal authorization, preserving identity through quit/new runtime", async () => {
    const h = home();
    const first = createCompanionStorage(h.deps);
    expect(first.probeDurability(123).code).toBe("restart_required");
    const f = runtimeFixture(h, 456);
    const runtime = createCompanionRuntime(f.deps);
    f.network.enqueueDiscovery();
    f.network.enqueueJwks();
    expect(await runtime.session.preflight(ACTION)).toMatchObject({
      state: "preflight_ready",
      hasConnection: false,
    });
    expect(f.browser).not.toHaveBeenCalled();
    expect(
      await runtime.session.signIn({ operatorStarted: false })
    ).toMatchObject({ code: "operator_required" });
    expect(f.browser).not.toHaveBeenCalled();
    f.network.enqueue(TOKEN_ENDPOINT, () => {
      const auth = f.browser.mock.calls.at(-1)?.[0];
      const nonce = auth ? new URL(auth).searchParams.get("nonce") : undefined;
      return json(tokenPayload({ id_token: signedIdToken({ nonce }) }));
    });
    f.network.enqueueJwks();
    const connected = await runtime.session.signIn(ACTION);
    expect(connected).toMatchObject({
      state: "connected",
      hasConnection: true,
      planScopeGranted: true,
      persistedConnectionLoaded: false,
    });
    expect(f.browser).toHaveBeenCalledTimes(1);
    const hostUri = createCompanionStorage(h.deps).store.ensureHostId();
    expect(hostUri).toMatch(
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(
      new URL(f.browser.mock.calls[0]?.[0] ?? "").searchParams.getAll(
        "ext_agent_host_id"
      )
    ).toEqual([hostUri]);
    noSecrets(connected);
    expect(JSON.stringify(connected)).not.toContain(hostUri);
    expect(await runtime.session.refresh(ACTION)).toMatchObject({
      code: "restart_required",
    });
    const saved = createCompanionStorage(h.deps).store.loadSelectedConnection();
    expect(saved?.accessToken).toBe(ACCESS);
    await runtime.shutdown();
    const restarted = await readyRuntime(h, { seed: false, pid: 789 });
    expect(restarted.runtime.session.snapshot()).toMatchObject({
      hasConnection: true,
      persistedConnectionLoaded: true,
      refreshVerified: false,
    });
    expect(restarted.browser).not.toHaveBeenCalled();
    expect(restarted.runtime.status().preflight?.storage).toMatchObject({
      outcome: "pass",
      restartVerified: true,
    });
    expect(await restarted.runtime.session.loadModels(ACTION)).toMatchObject({
      code: "refresh_required",
    });
    expect(restarted.network.calls).toHaveLength(2);
    await restarted.runtime.shutdown();
    transportClean(f);
    transportClean(restarted);
  });
  it("shutdown cancels a pending mocked refresh and late response cannot change stored identity", async () => {
    const h = home();
    const f = await readyRuntime(h);
    const started = Promise.withResolvers<void>();
    const late = Promise.withResolvers<Response>();
    f.network.enqueue(TOKEN_ENDPOINT, () => {
      started.resolve();
      return late.promise;
    });
    const work = f.runtime.session.refresh(ACTION);
    await started.promise;
    const shutdown = f.runtime.shutdown();
    expect(await shutdown).toEqual({
      cleanup: "complete",
      credentials: "not_cleared_by_shutdown",
    });
    expect(await work).toMatchObject({
      state: "cancelled",
      refreshVerified: false,
    });
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
    expect(
      createCompanionStorage(h.deps).store.loadSelectedConnection()
    ).toEqual(makeConnection());
    expect(
      f.network.calls.filter((row) => row.url === TOKEN_ENDPOINT)
    ).toHaveLength(1);
    expect(f.network.calls.some((row) => row.url === RESPONSES_ENDPOINT)).toBe(
      false
    );
    expect(f.browser).not.toHaveBeenCalled();
    expect(f.runtime.shutdown()).toBe(shutdown);
    transportClean(f);
    noSecrets(f.runtime.session.snapshot());
  });
  it("explicit sign-out during a pending mocked refresh clears credentials durably and ignores late completion", async () => {
    const h = home();
    const f = await readyRuntime(h);
    const started = Promise.withResolvers<void>();
    const late = Promise.withResolvers<Response>();
    f.network.enqueue(TOKEN_ENDPOINT, () => {
      started.resolve();
      return late.promise;
    });
    const refreshing = f.runtime.session.refresh(ACTION);
    await started.promise;
    f.network.enqueue(REVOKE, new Response(null, { status: 204 }));
    const signedOut = await f.runtime.session.signOut(ACTION);
    await refreshing;
    expect(signedOut).toMatchObject({
      state: "signed_out",
      hasConnection: false,
      revocation: { localCleared: true },
    });
    late.resolve(
      json(
        tokenPayload({
          access_token: "synthetic-late-rotated-access",
          id_token: undefined,
        })
      )
    );
    await Promise.resolve();
    await Promise.resolve();
    const restarted = createCompanionStorage(h.deps);
    expect(restarted.store.loadSelectedConnection()).toBeUndefined();
    expect(restarted.store.getBudget().attempts).toBe(0);
    expect(f.runtime.session.snapshot()).toMatchObject({
      state: "signed_out",
      hasConnection: false,
    });
    expect(
      f.network.calls.filter((row) => row.url === TOKEN_ENDPOINT)
    ).toHaveLength(1);
    expect(f.network.calls.some((row) => row.url === RESPONSES_ENDPOINT)).toBe(
      false
    );
    noSecrets(signedOut);
    await f.runtime.shutdown();
  });

  it("composes model and plan gates, three durable synthetic attempts and no fourth after restart", async () => {
    const h = home();
    const f = await readyRuntime(h);
    f.network.enqueue(
      TOKEN_ENDPOINT,
      json(tokenPayload({ id_token: undefined }))
    );
    expect(await f.runtime.session.refresh(ACTION)).toMatchObject({
      refreshVerified: true,
    });
    f.network.enqueue(MODELS_ENDPOINT, json(MODELS));
    expect(await f.runtime.session.loadModels(ACTION)).toMatchObject({
      code: "models_loaded",
    });
    expect(
      f.runtime.session.selectModel("synthetic-model", ACTION)
    ).toMatchObject({ code: "model_selected" });
    expect(await f.runtime.session.runRoundTrip(ACTION)).toMatchObject({
      code: "plan_only_required",
      attempts: 0,
    });
    expect(
      f.runtime.session.confirmPlanOnly({
        ...PLAN,
        creditFallbackDisabled: false,
      })
    ).toMatchObject({ code: "plan_only_required" });
    expect(f.runtime.session.confirmPlanOnly(PLAN)).toMatchObject({
      code: "plan_only_confirmed",
    });
    const first = eventFrame("response.completed", {
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
    });
    const second = eventFrame("response.completed", {
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
    });
    f.network.enqueue(RESPONSES_ENDPOINT, () => {
      expect(createCompanionStorage(h.deps).store.getBudget().attempts).toBe(1);
      return sseText(first);
    });
    f.network.enqueue(RESPONSES_ENDPOINT, () => {
      expect(createCompanionStorage(h.deps).store.getBudget().attempts).toBe(2);
      return sseText(second);
    });
    expect(await f.runtime.session.runRoundTrip(ACTION)).toMatchObject({
      state: "roundtrip_complete",
      attempts: 2,
    });
    f.network.enqueue(RESPONSES_ENDPOINT, (init) => {
      expect(createCompanionStorage(h.deps).store.getBudget().attempts).toBe(3);
      if (!init?.signal) throw Error("Missing synthetic signal");
      return pendingSse(
        init.signal,
        eventFrame("response.output_text.delta", { delta: "Synthetic text" })
      ).response;
    });
    const done = await f.runtime.session.runCancellation(ACTION);
    expect(done).toMatchObject({
      state: "finished",
      attempts: 3,
      cancellation: { outcome: "pass" },
    });
    expect(await f.runtime.session.runCancellation(ACTION)).toMatchObject({
      code: "budget_exhausted",
    });
    expect(
      f.network.calls.filter((row) => row.url === RESPONSES_ENDPOINT)
    ).toHaveLength(3);
    noSecrets(done);
    await f.runtime.shutdown();
    const restarted = createCompanionStorage(h.deps);
    expect(restarted.store.getBudget().attempts).toBe(3);
    expect(() => restarted.store.reserveInferenceAttempt()).toThrow(
      "budget_exhausted"
    );
  });
  it("does not dispatch after a durable reservation's directory-sync failure", async () => {
    const h = home();
    const s = createCompanionStorage(h.deps);
    s.probeDurability(123);
    s.probeDurability(456);
    s.store.saveConnection(makeConnection());
    const f = runtimeFixture(h, 789);
    let deny = false,
      renamed = false;
    f.deps.storage = {
      ...h.deps,
      fs: {
        ...fs,
        renameSync: (from, to) => {
          fs.renameSync(from, to);
          if (deny && String(to) === h.file("run-budget.json")) renamed = true;
        },
        fsyncSync: (fd) => {
          if (renamed && fs.fstatSync(fd).isDirectory())
            throw Object.assign(new Error(DETAIL), { code: "EACCES" });
          fs.fsyncSync(fd);
        },
      },
    };
    const runtime = createCompanionRuntime(f.deps);
    f.network.enqueueDiscovery();
    f.network.enqueueJwks();
    await runtime.session.preflight(ACTION);
    f.network.enqueue(
      TOKEN_ENDPOINT,
      json(tokenPayload({ id_token: undefined }))
    );
    await runtime.session.refresh(ACTION);
    f.network.enqueue(MODELS_ENDPOINT, json(MODELS));
    await runtime.session.loadModels(ACTION);
    runtime.session.selectModel("synthetic-model", ACTION);
    runtime.session.confirmPlanOnly(PLAN);
    deny = true;
    const result = await runtime.session.runRoundTrip(ACTION);
    expect(result).toMatchObject({
      state: "blocked",
      code: "storage_failed",
      attempts: null,
    });
    expect(runtime.status().storage).toEqual({
      state: "uncertain_commit",
      issue: "permission_denied",
    });
    expect(
      f.network.calls.filter((row) => row.url === RESPONSES_ENDPOINT)
    ).toHaveLength(0);
    expect(createCompanionStorage(h.deps).store.getBudget().attempts).toBe(1);
    noSecrets(result);
    await runtime.shutdown();
  });
});

describe("F3C foreground exclusive singleton lifecycle", () => {
  function foreground(
    options: {
      interactive?: boolean;
      bindError?: string;
      pendingShutdown?: boolean;
    } = {}
  ) {
    const f = fakeSingleton(options.bindError);
    const h = home();
    const actual = runtimeFixture(h);
    const shutdown = vi.fn(() =>
      Promise.resolve({
        cleanup: options.pendingShutdown
          ? ("pending" as const)
          : ("complete" as const),
        credentials: "not_cleared_by_shutdown" as const,
      })
    );
    const createRuntime = vi.fn(() => {
      const runtime = createCompanionRuntime(actual.deps);
      return {
        session: runtime.session,
        status: () => runtime.status(),
        shutdown,
      };
    });
    const signals = new Map<string, () => void>();
    const deps: ForegroundDependencies = {
      interactive: options.interactive ?? true,
      http: f.http,
      clock: f.clock,
      createRuntime,
      signals: {
        on: (name, handler) => {
          signals.set(name, handler);
        },
        off: (name, handler) => {
          if (signals.get(name) === handler) signals.delete(name);
        },
      },
    };
    let context: CompanionControlContext | undefined;
    const handler: RequestListener = (_req, res) => {
      res.writeHead(200).end("synthetic");
    };
    const close = vi.fn();
    const start = vi.fn();
    const factory = vi.fn((ctx: CompanionControlContext) => {
      context = ctx;
      return { handler, start, close };
    });
    return {
      ...f,
      deps,
      createRuntime,
      signals,
      shutdown,
      factory,
      close,
      start,
      getContext: () => context,
      actual,
      h,
    };
  }
  it("rejects noninteractive startup before any singleton or runtime access", async () => {
    const f = foreground({ interactive: false });
    await expect(
      startForegroundCompanion(f.factory, f.deps)
    ).rejects.toMatchObject({ code: "interactive_required" });
    expect(f.createServer).not.toHaveBeenCalled();
    expect(f.createRuntime).not.toHaveBeenCalled();
    expect(f.factory).not.toHaveBeenCalled();
    expect(fs.existsSync(f.h.root)).toBe(false);
  });
  it.each([
    ["EADDRINUSE", "port_occupied"],
    ["EACCES", "permission_denied"],
  ] as const)(
    "fails exclusive bind %s before runtime or browser access",
    async (bindError, code) => {
      const f = foreground({ bindError });
      await expect(
        startForegroundCompanion(f.factory, f.deps)
      ).rejects.toMatchObject({ code, message: code });
      expect(f.createRuntime).not.toHaveBeenCalled();
      expect(f.factory).not.toHaveBeenCalled();
      expect(f.servers[0]?.listen).toHaveBeenCalledTimes(1);
      expect(f.servers[0]?.listenerCount("error")).toBe(0);
      expect(f.actual.fetch).not.toHaveBeenCalled();
      expect(f.actual.browser).not.toHaveBeenCalled();
      expect(fs.existsSync(f.h.root)).toBe(false);
    }
  );
  it("only binds exact fixed port and handler remains 503 until controls installed", async () => {
    const f = fakeSingleton();
    const singleton = await acquireCompanionSingleton(f);
    expect(singleton.origin).toBe(COMPANION_CONTROL_ORIGIN);
    expect(f.servers[0]?.listen).toHaveBeenCalledTimes(1);
    expect(f.servers[0]?.response("GET", "/").status).toBe(503);
    singleton.setHandler((_req, res) => {
      res.writeHead(200).end("synthetic");
    });
    expect(f.servers[0]?.response("GET", "/").status).toBe(200);
    expect(await singleton.close()).toBe(true);
    expect(await singleton.close()).toBe(true);
    expect(f.servers[0]?.close).toHaveBeenCalledTimes(1);
  });
  it("idle timeout is refreshed only by explicit control touch and stops once, without implied credential deletion", async () => {
    vi.useFakeTimers();
    const f = foreground();
    const running = await startForegroundCompanion(f.factory, f.deps);
    expect(f.actual.fetch).not.toHaveBeenCalled();
    expect(f.actual.browser).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(COMPANION_IDLE_MS - 1);
    expect(f.shutdown).not.toHaveBeenCalled();
    f.getContext()?.touch();
    await vi.advanceTimersByTimeAsync(COMPANION_IDLE_MS - 1);
    expect(f.shutdown).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await running.stopped).toEqual({
      reason: "idle_timeout",
      listenerClosed: true,
      cleanup: "complete",
      credentials: "not_cleared_by_shutdown",
    });
    expect(f.shutdown).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.signals.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("signal stop is idempotent and pending runtime cleanup keeps exclusive listener held and inert", async () => {
    const f = foreground({ pendingShutdown: true });
    const running = await startForegroundCompanion(f.factory, f.deps);
    f.signals.get("SIGTERM")?.();
    expect(await running.stopped).toEqual({
      reason: "signal",
      listenerClosed: false,
      cleanup: "pending",
      credentials: "not_cleared_by_shutdown",
    });
    expect(f.servers[0]?.listening).toBe(true);
    expect(f.servers[0]?.response("POST", "/").status).toBe(503);
    expect(await running.stop()).toEqual(await running.stopped);
    expect(f.shutdown).toHaveBeenCalledTimes(1);
  });
});
