import * as fs from "node:fs";
import * as http from "node:http";
import { createRequire } from "node:module";
import { TextDecoder } from "node:util";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { EventEmitter } from "node:events";
import type {
  IncomingMessage,
  ServerResponse,
  RequestListener,
} from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCompanionControl } from "../src/companion-feasibility/control-server.js";
import { createCompanionRuntime } from "../src/companion-feasibility/runtime.js";
import { createCompanionStorage } from "../src/companion-feasibility/storage.js";
import {
  COMPANION_CONTROL_ORIGIN,
  type RunningCompanion,
} from "../src/companion-feasibility/main.js";
import {
  ACTION_PATH,
  CONTROL_BODY_LIMIT,
  CSRF_HEADER,
  PAIR_PATH,
  PAIRING_MAX_FAILURES,
  PAIRING_TTL_MS,
  SESSION_COOKIE,
  SESSION_PATH,
  SESSION_TTL_MS,
  parseControlAction,
} from "../src/companion-feasibility/contracts.js";
import {
  companionHome,
  runtimeFixture,
  FakeSingletonServer,
} from "./fixtures/chatgpt-companion.js";
import {
  ACCESS,
  REFRESH,
  CLIENT,
  SUBJECT,
  CODE,
  LOCAL_ID,
  DETAIL,
  NOW,
} from "./fixtures/chatgpt-signin.js";

const disposals: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dispose of disposals.splice(0)) dispose();
});

type Reply = { status: number; headers: Record<string, string>; body: string };
function request(
  handler: RequestListener,
  path: string,
  body?: unknown,
  options: {
    method?: string;
    headers?: Record<string, string | undefined>;
    raw?: string;
    noEnd?: boolean;
  } = {}
) {
  const req = new EventEmitter();
  const method = options.method ?? "POST";
  const headers: Record<string, string | undefined> = {
    host: "127.0.0.1:17863",
    origin: COMPANION_CONTROL_ORIGIN,
    "content-type": "application/json",
    ...options.headers,
  };
  const payload =
    options.raw ?? (body === undefined ? "" : JSON.stringify(body));
  const request = req as unknown as IncomingMessage;
  Object.assign(request, {
    method,
    url: path,
    headers,
    rawHeaders: Object.entries(headers).flatMap(([key, value]) =>
      value === undefined ? [] : [key, value]
    ),
    resume: vi.fn(),
    destroy: vi.fn(),
  });
  const pending = Promise.withResolvers<Reply>();
  const reply: Reply = { status: 0, headers: {}, body: "" };
  const response = new EventEmitter() as unknown as ServerResponse;
  Object.assign(response, {
    destroyed: false,
    writableEnded: false,
    setHeader: (name: string, value: string) => {
      reply.headers[name.toLowerCase()] = value;
      return response;
    },
    writeHead: (status: number, fields?: Record<string, string>) => {
      reply.status = status;
      for (const [key, value] of Object.entries(fields ?? {}))
        reply.headers[key.toLowerCase()] = value;
      return response;
    },
    end: (text?: string) => {
      reply.body = text ?? "";
      Object.assign(response, { writableEnded: true });
      response.emit("finish");
      pending.resolve(reply);
      return response;
    },
  });
  handler(request, response);
  queueMicrotask(() => {
    if (payload) req.emit("data", Buffer.from(payload));
    if (!options.noEnd) req.emit("end");
  });
  return { reply: pending.promise, request };
}
function body(reply: Reply): Record<string, unknown> {
  return JSON.parse(reply.body) as Record<string, unknown>;
}
function assertError(reply: Reply, status: number, code: string) {
  expect(reply.status).toBe(status);
  expect(body(reply)).toEqual({ ok: false, code });
  expect(reply.headers["access-control-allow-origin"]).toBeUndefined();
  expect(reply.body).not.toContain(DETAIL);
}
function fixture() {
  const home = companionHome();
  disposals.push(home.dispose);
  const f = runtimeFixture(home);
  const runtime = createCompanionRuntime(f.deps);
  let now = NOW,
    serial = 0;
  const showPairingCode = vi.fn<(code: string) => void>();
  const openControlPanel = vi.fn(() => Promise.resolve());
  const touch = vi.fn();
  const requestQuit = vi.fn();
  const view = fs.readFileSync(
    "src/companion-feasibility/control-view.html",
    "utf8"
  );
  const control = createCompanionControl(
    { runtime, origin: COMPANION_CONTROL_ORIGIN, touch, requestQuit },
    {
      view,
      dependencies: {
        clock: {
          now: () => now,
          setTimeout: (callback, delay) => setTimeout(callback, delay),
          clearTimeout: (timer) => clearTimeout(timer),
        },
        randomBytes: (size) => Buffer.alloc(size, ++serial),
        showPairingCode,
        openControlPanel,
      },
    }
  );
  const send = async (
    path: string,
    body?: unknown,
    options?: Parameters<typeof request>[3]
  ) => await request(control.handler, path, body, options).reply;
  const start = async () => {
    await control.start?.();
    const code = showPairingCode.mock.calls[0]?.[0];
    if (!code) throw Error("Expected synthetic terminal code");
    return code;
  };
  const pair = async (code: string) => {
    const reply = await send(PAIR_PATH, { code });
    expect(reply.status).toBe(200);
    const cookie = reply.headers["set-cookie"];
    const csrf = body(reply).csrf;
    if (!cookie || typeof csrf !== "string")
      throw Error("Missing synthetic session");
    return { reply, cookie: cookie.split(";")[0] ?? "", csrf };
  };
  const action = async (
    auth: { cookie: string; csrf: string },
    payload: unknown,
    headers?: Record<string, string | undefined>
  ) =>
    await send(ACTION_PATH, payload, {
      headers: { cookie: auth.cookie, [CSRF_HEADER]: auth.csrf, ...headers },
    });
  return {
    ...f,
    home,
    runtime,
    control,
    send,
    start,
    pair,
    action,
    showPairingCode,
    openControlPanel,
    touch,
    requestQuit,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
describe("F3C owner-paired local control (in process only)", () => {
  it("starts only the fixed panel and pairs once with HttpOnly Strict cookie, ephemeral CSRF and no provider activity", async () => {
    const f = fixture();
    const code = await f.start();
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(f.openControlPanel).toHaveBeenCalledTimes(1);
    expect(f.showPairingCode).toHaveBeenCalledTimes(1);
    expect(f.network.calls).toHaveLength(0);
    expect(f.browser).not.toHaveBeenCalled();
    const page = await f.send("/", undefined, { method: "GET" });
    expect(page.status).toBe(200);
    expect(page.headers["cache-control"]).toContain("no-store");
    expect(page.headers["content-security-policy"]).toContain(
      "connect-src 'self'"
    );
    expect(page.body).not.toContain("{{CSP_NONCE}}");
    expect(page.body).not.toContain(code);
    const auth = await f.pair(code);
    expect(auth.reply.headers["set-cookie"]).toContain("HttpOnly");
    expect(auth.reply.headers["set-cookie"]).toContain("SameSite=Strict");
    expect(auth.reply.headers["set-cookie"]).toContain("Path=/");
    expect(auth.cookie.startsWith(SESSION_COOKIE + "=")).toBe(true);
    expect(auth.reply.body).not.toContain(code);
    expect(auth.reply.body).not.toContain(auth.cookie.split("=")[1] ?? "");
    assertError(await f.send(PAIR_PATH, { code }), 403, "pairing_unavailable");
    expect(f.touch).toHaveBeenCalledTimes(1);
    const reload = await f.send(
      SESSION_PATH,
      {},
      { headers: { cookie: auth.cookie } }
    );
    expect(body(reload)).toEqual({ ok: true, csrf: auth.csrf });
    const status = await f.action(auth, { action: "status" });
    expect(status.status).toBe(200);
    expect(body(status)).toMatchObject({
      ok: true,
      snapshot: { state: "idle", hasConnection: false },
      runtime: { storage: { state: "ready" } },
    });
    expect(f.touch).toHaveBeenCalledTimes(1); // status and bootstrap are read-only, don't keep idle alive
    for (const value of [
      code,
      auth.csrf,
      auth.cookie.split("=")[1] ?? "",
      ACCESS,
      REFRESH,
      CLIENT,
      SUBJECT,
      CODE,
      LOCAL_ID,
      DETAIL,
    ])
      expect(status.body).not.toContain(value);
    expect(f.network.calls).toHaveLength(0);
    expect(f.browser).not.toHaveBeenCalled();
  });
  it("expires pairing and does not open consent at or after its deadline", async () => {
    const f = fixture();
    const code = await f.start();
    f.advance(PAIRING_TTL_MS);
    assertError(await f.send(PAIR_PATH, { code }), 403, "pairing_unavailable");
    expect(f.touch).not.toHaveBeenCalled();
    expect(f.network.calls).toHaveLength(0);
    expect(f.browser).not.toHaveBeenCalled();
  });
  it("stops pairing after the bounded failed-attempt count, without consuming a valid account action", async () => {
    const f = fixture();
    const code = await f.start();
    const wrong = "z".repeat(43);
    for (let i = 0; i < PAIRING_MAX_FAILURES; i++)
      assertError(
        await f.send(PAIR_PATH, { code: wrong }),
        403,
        "pairing_failed"
      );
    assertError(await f.send(PAIR_PATH, { code }), 403, "pairing_unavailable");
    expect(f.touch).not.toHaveBeenCalled();
    expect(f.network.calls).toHaveLength(0);
  });
  it("expires a paired session without treating reload/status as activity", async () => {
    const f = fixture();
    const auth = await f.pair(await f.start());
    f.advance(SESSION_TTL_MS - 1);
    expect((await f.action(auth, { action: "status" })).status).toBe(200);
    f.advance(1);
    assertError(
      await f.action(auth, { action: "status" }),
      401,
      "session_required"
    );
    assertError(
      await f.send(SESSION_PATH, {}, { headers: { cookie: auth.cookie } }),
      401,
      "session_required"
    );
    expect(f.touch).toHaveBeenCalledTimes(1);
    expect(f.network.calls).toHaveLength(0);
  });
  it("rejects ordinary invalid Host/Origin, unauthenticated action, absent CSRF and invalid owner action before dispatch", async () => {
    const f = fixture();
    const auth = await f.pair(await f.start());
    const spy = vi.spyOn(f.runtime.session, "signIn");
    const action = { action: "sign_in", operatorStarted: true };
    assertError(
      await f.action(auth, action, { host: "localhost:17863" }),
      403,
      "request_rejected"
    );
    assertError(
      await f.action(auth, action, { origin: "http://127.0.0.1:17864" }),
      403,
      "request_rejected"
    );
    assertError(
      await f.action(auth, action, { origin: undefined }),
      403,
      "request_rejected"
    );
    assertError(await f.send(ACTION_PATH, action), 401, "session_required");
    assertError(
      await f.action(auth, action, { [CSRF_HEADER]: undefined }),
      403,
      "csrf_rejected"
    );
    assertError(
      await f.action(auth, { action: "sign_in", operatorStarted: false }),
      400,
      "invalid_request"
    );
    assertError(
      await f.action(auth, {
        action: "sign_in",
        operatorStarted: true,
        eligible: true,
      }),
      400,
      "invalid_request"
    );
    assertError(
      await f.action(auth, { action: "unknown", operatorStarted: true }),
      400,
      "invalid_request"
    );
    expect(spy).not.toHaveBeenCalled();
    expect(f.touch).toHaveBeenCalledTimes(1);
    expect(f.network.calls).toHaveLength(0);
    expect(f.browser).not.toHaveBeenCalled();
    const valid = await f.action(auth, action);
    expect(body(valid)).toMatchObject({
      ok: true,
      snapshot: { state: "blocked", code: "preflight_required" },
    });
    expect(spy).toHaveBeenCalledExactlyOnceWith({
      operatorStarted: true,
      newRegistration: undefined,
    });
    expect(f.network.calls).toHaveLength(0);
    expect(f.browser).not.toHaveBeenCalled();
  });
  it("bounds declared and streamed request bodies and enforces JSON, without invoking operator actions", async () => {
    const f = fixture();
    const auth = await f.pair(await f.start());
    const spy = vi.spyOn(f.runtime.session, "preflight");
    const action = { action: "preflight", operatorStarted: true };
    assertError(
      await f.action(auth, action, { "content-type": "text/plain" }),
      415,
      "unsupported_media_type"
    );
    assertError(
      await f.action(auth, action, {
        "content-length": String(CONTROL_BODY_LIMIT + 1),
      }),
      413,
      "body_too_large"
    );
    assertError(
      await f.send(ACTION_PATH, undefined, {
        raw: "x".repeat(CONTROL_BODY_LIMIT + 1),
        headers: { cookie: auth.cookie, [CSRF_HEADER]: auth.csrf },
      }),
      413,
      "body_too_large"
    );
    assertError(
      await f.send(ACTION_PATH, undefined, {
        raw: "{",
        headers: { cookie: auth.cookie, [CSRF_HEADER]: auth.csrf },
      }),
      400,
      "invalid_request"
    );
    expect(spy).not.toHaveBeenCalled();
    expect(f.network.calls).toHaveLength(0);
  });
  it("requires both plan confirmations in the fixed contract; never infers without real model gate", async () => {
    const f = fixture();
    const auth = await f.pair(await f.start());
    const select = vi.spyOn(f.runtime.session, "selectModel");
    const confirm = vi.spyOn(f.runtime.session, "confirmPlanOnly");
    assertError(
      await f.action(auth, {
        action: "confirm_plan_only",
        operatorStarted: true,
        planOnlyConfirmed: true,
        creditFallbackDisabled: false,
      }),
      400,
      "invalid_request"
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(
      parseControlAction({
        action: "select_model",
        operatorStarted: true,
        modelSlug: "synthetic-model",
        extra: true,
      })
    ).toBeUndefined();
    const selected = await f.action(auth, {
      action: "select_model",
      operatorStarted: true,
      modelSlug: "synthetic-model",
    });
    expect(body(selected)).toMatchObject({
      snapshot: { code: "preflight_required" },
    });
    expect(select).toHaveBeenCalledExactlyOnceWith("synthetic-model", {
      operatorStarted: true,
    });
    const confirmed = await f.action(auth, {
      action: "confirm_plan_only",
      operatorStarted: true,
      planOnlyConfirmed: true,
      creditFallbackDisabled: true,
    });
    expect(body(confirmed)).toMatchObject({
      snapshot: { code: "preflight_required", planOnlyConfirmed: false },
    });
    expect(confirm).toHaveBeenCalledExactlyOnceWith({
      operatorStarted: true,
      planOnlyConfirmed: true,
      creditFallbackDisabled: true,
    });
    expect(
      body(
        await f.action(auth, { action: "run_roundtrip", operatorStarted: true })
      )
    ).toMatchObject({ snapshot: { code: "preflight_required" } });
    expect(f.network.calls).toHaveLength(0);
  });
  it("closes authenticated control on quit, clears cookie and notifies foreground once", async () => {
    const f = fixture();
    const auth = await f.pair(await f.start());
    const reply = await f.action(auth, {
      action: "quit",
      operatorStarted: true,
    });
    expect(body(reply)).toEqual({ ok: true, stopping: true });
    expect(reply.headers["set-cookie"]).toContain("Max-Age=0");
    expect(f.requestQuit).toHaveBeenCalledTimes(1);
    assertError(
      await f.action(auth, { action: "status" }),
      503,
      "control_closed"
    );
    expect(f.requestQuit).toHaveBeenCalledTimes(1);
    expect(f.network.calls).toHaveLength(0);
    expect(f.browser).not.toHaveBeenCalled();
  });
});

async function actualPackageEntry() {
  const root = process.cwd();
  const script = fs.readFileSync("scripts/build-chatgpt-companion.ts", "utf8");
  expect(/const version = "([^"]+)";/.exec(script)?.[1]).toBe("0.0.4");
  const adapter = /const adapterEntry = `([\s\S]*?)`;/u.exec(script)?.[1];
  if (!adapter) throw Error("Missing companion entry adapter");
  const view = fs
    .readFileSync("src/companion-feasibility/control-view.html", "utf8")
    .replaceAll("{{COMPANION_VERSION}}", "0.0.4")
    .replaceAll("{{BUILD_ID}}", "f3c-offline-test");
  return await build({
    absWorkingDir: root,
    stdin: {
      contents: adapter,
      resolveDir: root,
      sourcefile: "chatgpt-companion-entry.ts",
      loader: "ts",
    },
    outfile: "companion.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    supported: { "dynamic-import": false },
    define: {
      __COMPANION_VERSION__: JSON.stringify("0.0.4"),
      __COMPANION_BUILD_ID__: JSON.stringify("f3c-offline-test"),
      __COMPANION_NODE__: JSON.stringify(">=24.14.1"),
      __COMPANION_VIEW__: JSON.stringify(view),
    },
    sourcemap: false,
    legalComments: "eof",
    metafile: true,
    write: false,
    logLevel: "silent",
  });
}
describe("F3C actual package entry, isolation and credential-free smoke", () => {
  it("bundles only reviewed standalone and SDK-free shared modules plus pinned JWT closure, no production inclusion", async () => {
    const graph = await actualPackageEntry();
    const paths = Object.keys(graph.metafile.inputs);
    const modules = paths.filter((p) => !p.startsWith("node_modules/")).sort();
    expect(modules).toEqual(
      [
        "chatgpt-companion-entry.ts",
        ...[
          "main",
          "runtime",
          "storage",
          "preflight",
          "contracts",
          "control-server",
          "diagnostic-budget",
          "response-diagnostic",
        ].map((x) => "src/companion-feasibility/" + x + ".ts"),
        ...[
          "contracts",
          "signin-contracts",
          "official-http",
          "credential-store",
          "oauth",
          "id-token",
          "responses",
          "response-diagnostics",
          "signin-session",
        ].map((x) => "src/extension/feasibility/" + x + ".ts"),
      ].sort()
    );
    const packages = [
      ...new Set(
        paths
          .filter((p) => p.startsWith("node_modules/"))
          .map((p) => p.split("/")[1])
      ),
    ].sort();
    expect(packages).toEqual(
      [
        "jsonwebtoken",
        "jws",
        "jwa",
        "lodash.includes",
        "lodash.isboolean",
        "lodash.isinteger",
        "lodash.isnumber",
        "lodash.isplainobject",
        "lodash.isstring",
        "lodash.once",
        "ms",
        "semver",
        "safe-buffer",
        "buffer-equal-constant-time",
        "ecdsa-sig-formatter",
      ].sort()
    );
    const externals = [
      ...new Set(
        Object.values(graph.metafile.inputs).flatMap((input) =>
          input.imports.filter((i) => i.external).map((i) => i.path)
        )
      ),
    ];
    expect(
      externals.filter(
        (name) =>
          ![
            "node:http",
            "node:crypto",
            "node:fs",
            "node:path",
            "node:util",
            "node:url",
            "node:os",
            "node:stream/web",
            "node:child_process",
            "buffer",
            "crypto",
            "stream",
            "util",
          ].includes(name)
      )
    ).toEqual([]);
    const production = await build({
      entryPoints: ["src/extension/index.ts"],
      bundle: true,
      platform: "node",
      format: "cjs",
      loader: { ".html": "text" },
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    expect(
      Object.keys(production.metafile.inputs).filter(
        (p) =>
          p.includes("/companion-feasibility/") ||
          p.includes("/feasibility/") ||
          p.includes("/jsonwebtoken/")
      )
    ).toEqual([]);
  });
  it("loads actual CJS inertly, starts a mocked foreground, runs actual bundled local preflight, and quits without any provider or authorization", async () => {
    const home = companionHome();
    disposals.push(home.dispose);
    const library = home.home + "/Library";
    const legacy = library + "/Application Support";
    fs.mkdirSync(library, { mode: 0o700 });
    fs.mkdirSync(legacy, { mode: 0o700 });
    fs.writeFileSync(legacy + "/unrelated.txt", "synthetic unrelated", {
      mode: 0o600,
    });
    fs.chmodSync(legacy, 0o707);
    const priorLegacy = fs.lstatSync(legacy);
    const compiled = await actualPackageEntry();
    const code = compiled.outputFiles[0]?.text;
    if (!code) throw Error("Missing package output");
    const module = { exports: {} as unknown };
    let singleton: FakeSingletonServer | undefined;
    const ephemeral: http.Server[] = [];
    const calls: string[] = [];
    const external: string[] = [];
    const terminal: string[] = [];
    const signals = new Map<string, () => void>();
    const originalFetch = globalThis.fetch;
    const fakeFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (typeof input !== "string") throw Error("Expected synthetic loopback");
      const url = new URL(input);
      if (
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !["/companion-stream", "/companion-abort"].includes(url.pathname) ||
        !ephemeral.some((server) => {
          const address = server.address();
          return (
            address !== null &&
            typeof address !== "string" &&
            address.address === "127.0.0.1" &&
            String(address.port) === url.port
          );
        })
      ) {
        external.push("unexpected");
        throw Error("No external requests in packaged smoke");
      }
      calls.push(url.pathname);
      return await originalFetch(input, { ...init, redirect: "error" });
    });
    const panel = vi.fn(
      (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null) => void
      ) => {
        callback(null);
        return {};
      }
    );
    const loadBuiltin = createRequire(import.meta.url);
    const allowed = new Set([
      "node:crypto",
      "node:fs",
      "node:path",
      "node:util",
      "node:url",
      "node:stream/web",
      "buffer",
      "crypto",
      "stream",
      "util",
    ]);
    const require = (name: string): unknown => {
      if (name === "node:http")
        return {
          ...http,
          createServer: (listener: http.RequestListener) => {
            if (!singleton) {
              singleton = new FakeSingletonServer(listener);
              return singleton;
            }
            const server = http.createServer(listener);
            ephemeral.push(server);
            return server;
          },
        };
      if (name === "node:os") return { homedir: () => home.home };
      if (name === "node:child_process") return { execFile: panel };
      if (!allowed.has(name)) throw Error("Unexpected package import");
      return loadBuiltin(name) as unknown;
    };
    const logs = vi.fn();
    runInNewContext(code, {
      module,
      exports: module.exports,
      require,
      console: { log: logs, info: logs, warn: logs, error: logs },
      Buffer,
      AbortController,
      TextDecoder,
      URL,
      ReadableStream,
      fetch: fakeFetch,
      process: {
        getuid: () => home.deps.uid,
        pid: 12345,
        platform: "darwin",
        versions: { node: process.versions.node },
        version: process.version,
        stdin: { isTTY: true },
        stdout: {
          isTTY: true,
          write: (value: string) => {
            terminal.push(value);
            return true;
          },
        },
        on: (name: string, callback: () => void) => signals.set(name, callback),
        off: (name: string, callback: () => void) => {
          if (signals.get(name) === callback) signals.delete(name);
        },
      },
      setTimeout,
      clearTimeout,
      queueMicrotask,
      structuredClone,
    });
    expect(fs.existsSync(home.root)).toBe(false);
    expect(fakeFetch).not.toHaveBeenCalled();
    expect(panel).not.toHaveBeenCalled();
    expect(terminal).toEqual([]);
    const entry = module.exports;
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("launchCompanion" in entry) ||
      typeof entry.launchCompanion !== "function"
    )
      throw Error("Missing launch export");
    expect(entry).toMatchObject({
      version: "0.0.4",
      buildId: "f3c-offline-test",
      requiredNode: ">=24.14.1",
    });
    const launch = entry.launchCompanion as () => Promise<RunningCompanion>;
    // Version 0.0.4 is a checkpoint for a frozen original 1/3 budget only.
    // Seed that one synthetic accounting record; still no credentials/consent.
    const storage = createCompanionStorage(home.deps);
    expect(storage.store.reserveInferenceAttempt().attempts).toBe(1);
    const originalBudget = fs.readFileSync(home.file("run-budget.json"));
    const running = await launch();
    try {
      expect(panel).toHaveBeenCalledTimes(1);
      expect(fakeFetch).not.toHaveBeenCalled();
      expect(external).toEqual([]);
      expect(fs.readdirSync(home.directory)).toEqual(["run-budget.json"]);
      expect(terminal).toHaveLength(1);
      const pairing = /([A-Za-z0-9_-]{43})\s*$/u.exec(terminal[0] ?? "")?.[1];
      if (!pairing || !singleton)
        throw Error("Missing synthetic foreground pairing");
      const handler = singleton.listener;
      const paired = await request(handler, PAIR_PATH, { code: pairing }).reply;
      const cookie = paired.headers["set-cookie"]?.split(";")[0];
      const csrf = body(paired).csrf;
      if (!cookie || typeof csrf !== "string")
        throw Error("Missing synthetic paired session");
      const action = (payload: unknown) =>
        request(handler, ACTION_PATH, payload, {
          headers: { cookie, [CSRF_HEADER]: csrf },
        }).reply;
      const initial = await action({ action: "status" });
      expect(body(initial)).toMatchObject({
        ok: true,
        snapshot: { state: "idle", preflightReady: false },
        runtime: {
          storage: { state: "ready" },
          diagnostic: {
            originalAttempts: 1,
            budget: { state: "not_authorized", attempts: null, cap: 1 },
          },
        },
      });
      const checked = await action({
        action: "preflight",
        operatorStarted: true,
      });
      expect(body(checked)).toMatchObject({
        ok: true,
        snapshot: {
          state: "blocked",
          code: "host_preflight_failed",
          preflightReady: false,
          hostPreflight: {
            nativeTransport: true,
            callbackBinding: true,
            privateStorage: false,
            bundledVerifier: true,
          },
        },
        runtime: {
          preflight: {
            storage: { code: "restart_required" },
            verifier: { outcome: "pass" },
            transport: { outcome: "pass" },
          },
        },
      });
      expect(calls).toEqual(["/companion-stream", "/companion-abort"]);
      expect(external).toEqual([]);
      expect(panel).toHaveBeenCalledTimes(1);
      expect(checked.body).not.toContain(pairing);
      expect(checked.body).not.toContain(csrf);
      expect(checked.body).not.toContain(home.home);
      const quit = await action({ action: "quit", operatorStarted: true });
      expect(body(quit)).toEqual({ ok: true, stopping: true });
      expect(await running.stopped).toEqual({
        reason: "quit",
        listenerClosed: true,
        cleanup: "complete",
        credentials: "not_cleared_by_shutdown",
      });
      expect(signals.size).toBe(0);
      expect(ephemeral.every((server) => !server.listening)).toBe(true);
      expect(logs.mock.calls).toEqual([]);
      expect(fs.readFileSync(home.file("run-budget.json"))).toEqual(
        originalBudget
      );
      expect(fs.lstatSync(legacy)).toMatchObject({
        ino: priorLegacy.ino,
        mode: priorLegacy.mode,
        ctimeMs: priorLegacy.ctimeMs,
        mtimeMs: priorLegacy.mtimeMs,
      });
      expect(fs.readFileSync(legacy + "/unrelated.txt", "utf8")).toBe(
        "synthetic unrelated"
      );
    } finally {
      await running.stop();
    }
  });
});
