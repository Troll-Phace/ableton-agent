import * as http from "node:http";
import { TextDecoder } from "node:util";
import { URL } from "node:url";
import { ReadableStream } from "node:stream/web";
import { runInNewContext } from "node:vm";

import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CompatibilityStage,
  CompatibilityTransportResult,
  NativeCompatibilityReport,
} from "../src/extension/feasibility/contracts.js";
import {
  classifyCompatibilityError,
  nativeCompatibilityDependencies,
  runNativeCompatibility,
} from "../src/extension/feasibility/native-compatibility.js";
import {
  descriptors,
  DETAIL,
  errorCode,
  makeCompatibilityFixture,
  listenerSnapshot,
  NAMES,
  observeResponse,
  stageErrorResponse,
  trackedCancellation,
  type NativeObservation,
} from "./fixtures/chatgpt-native-compatibility.js";

function local(report: NativeCompatibilityReport) {
  const lane = report.lanes[0];
  expect(lane?.lane).toBe("local");
  if (!lane) throw new Error("Missing local lane");
  return lane;
}
function supplemental(report: NativeCompatibilityReport) {
  const lane = report.lanes[1];
  expect(lane?.lane).toBe("supplemented");
  if (!lane) throw new Error("Missing supplemental lane");
  return lane;
}
function stage(
  result: CompatibilityTransportResult,
  name: CompatibilityStage,
  code: string
) {
  expect(result.stages).toContainEqual(
    expect.objectContaining({ stage: name, code })
  );
}
function clean(fixture: ReturnType<typeof makeCompatibilityFixture>) {
  expect(
    fixture.servers.every(
      (server) => !server.listening && server.address() === null
    )
  ).toBe(true);
  expect(fixture.sockets.every((socket) => socket.destroyed)).toBe(true);
  fixture.servers.forEach((server, i) => {
    expect(listenerSnapshot(server)).toEqual(fixture.baselineListeners[i]);
  });
  expect(fixture.signals.every((signal) => signal.aborted)).toBe(true);
}
function noSecrets(report: NativeCompatibilityReport) {
  expect(JSON.stringify(report)).not.toMatch(
    /synthetic-private-detail|127\.0\.0\.1|data:|p15_3|stack|message/
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("F2C constructor sources and local-only lane", () => {
  it("uses native constructors without loading builtins and preserves the ambient descriptors", async () => {
    const fixture = makeCompatibilityFixture({ observe: true });
    const before = descriptors(fixture.globals);
    const report = await runNativeCompatibility({}, fixture.deps);
    expect(report).toMatchObject({
      outcome: "pass",
      code: "transport_verified",
      restored: true,
      raw: {
        TextDecoder: true,
        URL: true,
        ReadableStream: true,
        fetch: true,
        AbortController: true,
      },
    });
    expect(report.constructors).toEqual(
      NAMES.map((constructor) => ({
        constructor,
        source: "native",
        outcome: "pass",
        code: "constructor_functional",
      }))
    );
    expect(report.lanes).toHaveLength(1);
    expect(local(report).supplementation).toEqual([]);
    expect(fixture.deps.util).not.toHaveBeenCalled();
    expect(fixture.deps.url).not.toHaveBeenCalled();
    expect(fixture.deps.streamWeb).not.toHaveBeenCalled();
    expect(descriptors(fixture.globals)).toEqual(before);
    clean(fixture);
  });

  it("loads each missing builtin locally, proves stream + abort before supplementation, and restores nothing", async () => {
    const fixture = makeCompatibilityFixture({
      missing: [...NAMES],
      observe: true,
    });
    const before = descriptors(fixture.globals);
    const report = await runNativeCompatibility({}, fixture.deps);
    expect(report.raw).toEqual({
      TextDecoder: false,
      URL: false,
      ReadableStream: false,
      fetch: true,
      AbortController: true,
    });
    expect(report.constructors).toEqual(
      NAMES.map((constructor) => ({
        constructor,
        source: "node_builtin",
        outcome: "pass",
        code: "constructor_functional",
      }))
    );
    expect(report.outcome).toBe("pass");
    expect(report.lanes).toHaveLength(1);
    expect(local(report).stream).toMatchObject({
      outcome: "pass",
      code: "synthetic_sse_completed",
      measurements: {
        preEofRead: true,
        cleanup: true,
        bytes: Buffer.byteLength('data: {"marker":"p15_3","text":"€"}\n\n'),
      },
    });
    expect(local(report).abort).toMatchObject({
      outcome: "pass",
      code: "pending_read_aborted_and_closed",
      measurements: {
        preEofRead: true,
        pendingRead: true,
        abortRequested: true,
        serverClosedBeforeTeardown: true,
        cleanup: true,
      },
    });
    const expectedStreamStages = [
      "listen",
      "fetch_started",
      "headers_received",
      "reader_acquired",
      "first_chunk",
      "read_settled",
      "cleanup",
    ];
    const expectedAbortStages = [
      "listen",
      "fetch_started",
      "headers_received",
      "reader_acquired",
      "first_chunk",
      "pending_read",
      "abort_requested",
      "read_settled",
      "server_closed",
      "cleanup",
    ];
    expect(local(report).stream.stages.map((row) => row.stage)).toEqual(
      expectedStreamStages
    );
    expect(local(report).abort.stages.map((row) => row.stage)).toEqual(
      expectedAbortStages
    );
    expect(fixture.requests).toEqual(["/compat-stream", "/compat-abort"]);
    expect(fixture.servers).toHaveLength(2);
    expect(fixture.observations).toHaveLength(2);
    const [stream, abort] = fixture.observations;
    expect(stream?.reads[0]).toMatchObject({ open: true, done: false });
    expect(
      stream?.reads.filter((row) => !row.done).length
    ).toBeGreaterThanOrEqual(2);
    expect(stream?.reads.at(-1)?.done).toBe(true);
    expect(abort?.reads[0]).toMatchObject({ open: true, done: false });
    expect(fixture.sockets.length).toBeGreaterThanOrEqual(2);
    for (const observation of fixture.observations) {
      expect(observation.cancel).toHaveBeenCalledTimes(1);
      expect(observation.release).toHaveBeenCalledTimes(1);
      expect(observation.body?.locked).toBe(false);
    }
    expect(descriptors(fixture.globals)).toEqual(before);
    noSecrets(report);
    clean(fixture);
  });

  it.each([
    ["TextDecoder", "util"],
    ["URL", "url"],
    ["ReadableStream", "streamWeb"],
  ] as const)(
    "independently reports denied %s builtin",
    async (name, loader) => {
      const fixture = makeCompatibilityFixture({ missing: [name] });
      fixture.deps[loader] = vi.fn(() =>
        Promise.reject(errorCode("ERR_ACCESS_DENIED"))
      );
      fixture.deps.nodeVersion = DETAIL;
      const report = await runNativeCompatibility({}, fixture.deps);
      expect(
        report.constructors.find((row) => row.constructor === name)
      ).toEqual({
        constructor: name,
        source: "unavailable",
        outcome: "blocked",
        code: "permission_denied",
      });
      expect(
        report.constructors.filter((row) => row.outcome === "pass")
      ).toHaveLength(2);
      expect(report.nodeVersion).toBe("unknown");
      expect(local(report).abort.outcome).toBe("pass");
      expect(local(report).stream.code).toBe(
        name === "TextDecoder"
          ? "text_decoder_unavailable"
          : "synthetic_sse_completed"
      );
      expect(report.lanes).toHaveLength(1);
      expect(fixture.globals[name]).toBeUndefined();
      noSecrets(report);
      clean(fixture);
    }
  );

  it("reports unavailable module distinctly and does not make optional constructor absence a transport failure", async () => {
    const fixture = makeCompatibilityFixture({
      missing: ["URL", "ReadableStream"],
    });
    fixture.deps.url = vi.fn(() =>
      Promise.reject(errorCode("MODULE_NOT_FOUND"))
    );
    fixture.deps.streamWeb = vi.fn(() =>
      Promise.resolve({ ReadableStream: undefined } as unknown as {
        ReadableStream: typeof ReadableStream;
      })
    );
    const report = await runNativeCompatibility({}, fixture.deps);
    expect(report.constructors).toContainEqual({
      constructor: "URL",
      source: "unavailable",
      outcome: "blocked",
      code: "module_unavailable",
    });
    expect(report.constructors).toContainEqual({
      constructor: "ReadableStream",
      source: "unavailable",
      outcome: "blocked",
      code: "constructor_unavailable",
    });
    expect(report.outcome).toBe("pass");
    clean(fixture);
  });

  it("tests functional constructor behavior rather than existence", async () => {
    const fixture = makeCompatibilityFixture();
    class BadDecoder extends TextDecoder {
      override decode() {
        return "bad";
      }
    }
    class BadUrl extends URL {
      constructor(input: string | URL, base?: string | URL) {
        super(input, base);
        this.pathname = "/wrong";
      }
    }
    class BadStream<R> extends ReadableStream<R> {
      constructor() {
        super({
          start(controller) {
            controller.close();
          },
        });
      }
    }
    fixture.globals.TextDecoder = BadDecoder;
    fixture.globals.URL = BadUrl;
    fixture.globals.ReadableStream = BadStream;
    const before = descriptors(fixture.globals);
    const report = await runNativeCompatibility({}, fixture.deps);
    expect(report.constructors).toEqual(
      NAMES.map((constructor) => ({
        constructor,
        source: "native",
        outcome: "failed",
        code: "constructor_mismatch",
      }))
    );
    expect(local(report).stream.code).toBe("text_decoder_unavailable");
    expect(local(report).abort.outcome).toBe("pass");
    expect(descriptors(fixture.globals)).toEqual(before);
    expect(report.lanes).toHaveLength(1);
    clean(fixture);
  });

  it("fresh module import has no ambient global effects", async () => {
    const before = descriptors(globalThis);
    vi.resetModules();
    const module =
      await import("../src/extension/feasibility/native-compatibility.js");
    expect(module.nativeCompatibilityDependencies().globals).toBe(globalThis);
    expect(descriptors(globalThis)).toEqual(before);
    expect(nativeCompatibilityDependencies().globals).toBe(globalThis);
  });
});

describe("F2C supplemental lane and exact restoration", () => {
  it("supplements absent, accessor and nonconfigurable writable undefined descriptors then restores all exactly", async () => {
    const fixture = makeCompatibilityFixture({
      missing: [...NAMES],
      hook: async (_input, _init, next) => {
        if (NAMES.some((name) => fixture.globals[name] === undefined))
          throw errorCode("UNSUPPORTED");
        return await next();
      },
    });
    const getter = () => undefined;
    Object.defineProperty(fixture.globals, "URL", {
      get: getter,
      configurable: true,
      enumerable: true,
    });
    Object.defineProperty(fixture.globals, "ReadableStream", {
      value: undefined,
      configurable: false,
      writable: true,
      enumerable: false,
    });
    const before = descriptors(fixture.globals);
    const report = await runNativeCompatibility({}, fixture.deps);
    expect(report.raw).toMatchObject({
      TextDecoder: false,
      URL: false,
      ReadableStream: false,
    });
    expect(report.lanes).toHaveLength(2);
    expect(local(report).outcome).toBe("failed");
    expect(supplemental(report)).toMatchObject({
      outcome: "pass",
      restored: true,
    });
    expect(supplemental(report).supplementation).toEqual(
      NAMES.map((constructor) => ({
        constructor,
        installed: true,
        outcome: "pass",
        code: "temporarily_supplemented",
      }))
    );
    expect(descriptors(fixture.globals)).toEqual(before);
    expect(report.restored).toBe(true);
    expect(fixture.requests).toEqual(["/compat-stream", "/compat-abort"]);
    clean(fixture);
    const repeated = await runNativeCompatibility({}, fixture.deps);
    expect(repeated.outcome).toBe("pass");
    expect(descriptors(fixture.globals)).toEqual(before);
    clean(fixture);
  });

  it("never overwrites defined constructors or an unwritable nonconfigurable descriptor", async () => {
    const fixture = makeCompatibilityFixture({
      missing: ["TextDecoder", "ReadableStream"],
      hook: async (_input, _init, next) => {
        if (!fixture.globals.TextDecoder) throw errorCode("UNSUPPORTED");
        return await next();
      },
    });
    Object.defineProperty(fixture.globals, "ReadableStream", {
      value: undefined,
      configurable: false,
      writable: false,
      enumerable: true,
    });
    const before = descriptors(fixture.globals);
    const report = await runNativeCompatibility({}, fixture.deps);
    const lane = supplemental(report);
    expect(lane.outcome).toBe("pass");
    expect(lane.supplementation).toEqual([
      {
        constructor: "TextDecoder",
        installed: true,
        outcome: "pass",
        code: "temporarily_supplemented",
      },
      {
        constructor: "URL",
        installed: false,
        outcome: "pass",
        code: "native_preserved",
      },
      {
        constructor: "ReadableStream",
        installed: false,
        outcome: "blocked",
        code: "supplement_unavailable",
      },
    ]);
    expect(descriptors(fixture.globals)).toEqual(before);
    expect(fixture.deps.url).not.toHaveBeenCalled();
    clean(fixture);
  });

  it("preserves a defined nonfunctional value, even when another constructor is supplemented", async () => {
    const fixture = makeCompatibilityFixture({
      missing: ["TextDecoder"],
      hook: async (_input, _init, next) => {
        if (!fixture.globals.TextDecoder) throw errorCode("UNSUPPORTED");
        return await next();
      },
    });
    Object.defineProperty(fixture.globals, "URL", {
      value: 42,
      configurable: true,
      writable: false,
    });
    const before = descriptors(fixture.globals);
    const report = await runNativeCompatibility({}, fixture.deps);
    expect(report.constructors).toContainEqual({
      constructor: "URL",
      source: "native",
      outcome: "blocked",
      code: "constructor_unavailable",
    });
    expect(supplemental(report).supplementation).toContainEqual({
      constructor: "URL",
      installed: false,
      outcome: "pass",
      code: "native_preserved",
    });
    expect(descriptors(fixture.globals)).toEqual(before);
    clean(fixture);
  });

  it("does not supplement when native Fetch explicitly denies permission", async () => {
    const fixture = makeCompatibilityFixture({
      missing: [...NAMES],
      hook: () => Promise.reject(errorCode("ERR_ACCESS_DENIED")),
    });
    const before = descriptors(fixture.globals);
    const report = await runNativeCompatibility({}, fixture.deps);
    expect(report.lanes).toHaveLength(1);
    expect(report.outcome).toBe("blocked");
    stage(local(report).stream, "fetch_started", "permission_denied");
    stage(local(report).abort, "fetch_started", "permission_denied");
    expect(descriptors(fixture.globals)).toEqual(before);
    noSecrets(report);
    clean(fixture);
  });

  it("blocks and requires a restart if the test-owned ambient object cannot be restored", async () => {
    const fixture = makeCompatibilityFixture({
      missing: ["TextDecoder"],
      hook: async (_input, _init, next) => {
        if (!fixture.globals.TextDecoder) throw errorCode("UNSUPPORTED");
        Object.defineProperty(fixture.globals, "TextDecoder", {
          configurable: false,
          writable: false,
        });
        return await next();
      },
    });
    const report = await runNativeCompatibility({}, fixture.deps);
    expect(report).toMatchObject({
      outcome: "blocked",
      code: "restoration_failed",
      restored: false,
    });
    expect(supplemental(report)).toMatchObject({
      restored: false,
      code: "restoration_failed",
    });
    const calls = fixture.createServer.mock.calls.length;
    expect(await runNativeCompatibility({}, fixture.deps)).toMatchObject({
      outcome: "blocked",
      code: "restart_required",
      restored: false,
      lanes: [],
    });
    expect(fixture.createServer).toHaveBeenCalledTimes(calls);
    clean(fixture);
  });
});

describe("F2C stage classification and fail-closed streaming", () => {
  it.each(["fetch", "AbortController"] as const)(
    "blocks missing %s, with no bind or fallback",
    async (name) => {
      const fixture = makeCompatibilityFixture({ missing: [...NAMES] });
      delete fixture.globals[name];
      const before = descriptors(fixture.globals);
      const report = await runNativeCompatibility({}, fixture.deps);
      expect(report.lanes).toHaveLength(1);
      const code =
        name === "fetch" ? "fetch_unavailable" : "abort_controller_unavailable";
      stage(local(report).stream, "fetch_started", code);
      stage(local(report).abort, "fetch_started", code);
      expect(fixture.createServer).not.toHaveBeenCalled();
      expect(descriptors(fixture.globals)).toEqual(before);
    }
  );

  it.each([
    ["headers", "headers_received", "invalid_response"],
    ["body", "reader_acquired", "body_unavailable"],
    ["reader", "reader_acquired", "body_unavailable"],
    ["eof", "first_chunk", "premature_eof"],
    ["read", "first_chunk", "permission_denied"],
    ["limit", "first_chunk", "stream_limit"],
    ["handshake", "first_chunk", "pre_eof_handshake_failed"],
  ] as const)(
    "classifies synthetic %s failure at its actual stage",
    async (scenario, at, code) => {
      const fixture = makeCompatibilityFixture({
        hook: async (input, _init, next) =>
          input.endsWith("/compat-stream")
            ? stageErrorResponse(scenario)
            : await next(),
      });
      const report = await runNativeCompatibility({}, fixture.deps);
      expect(local(report).stream.code).toBe(code);
      stage(local(report).stream, at, code);
      expect(local(report).abort.outcome).toBe("pass");
      expect(local(report).stream.measurements.cleanup).toBe(true);
      if (scenario === "limit")
        expect(local(report).stream.measurements.bytes).toBe(129);
      noSecrets(report);
      clean(fixture);
    }
  );

  it("rejects a malformed tail after a real pre-EOF handshake and releases the reader", async () => {
    const observations: NativeObservation[] = [];
    const fixture = makeCompatibilityFixture({
      hook: async (input, _init, next) => {
        const response = await next();
        if (!input.endsWith("/compat-stream")) return response;
        return observeResponse(
          response,
          "/compat-stream",
          () => fixture.responses.at(-1),
          observations,
          async (reader, index) => {
            const part = await reader.read();
            if (index === 1 && !part.done)
              return { done: false, value: new Uint8Array([0x82, 0xac, 0x21]) };
            return part;
          }
        );
      },
    });
    const report = await runNativeCompatibility({}, fixture.deps);
    stage(local(report).stream, "read_settled", "payload_mismatch");
    expect(local(report).stream.measurements.preEofRead).toBe(true);
    expect(local(report).abort.outcome).toBe("pass");
    expect(observations[0]?.release).toHaveBeenCalledTimes(1);
    expect(observations[0]?.body?.locked).toBe(false);
    clean(fixture);
  });

  it("reports a missing returned reader independently of the body and cleans it", async () => {
    const bodyCancel = vi.fn(() => Promise.resolve());
    const fixture = makeCompatibilityFixture({
      hook: async (input, _init, next) => {
        if (!input.endsWith("/compat-stream")) return await next();
        return {
          status: 200,
          headers: { get: () => "text/event-stream" },
          body: { getReader: () => undefined, cancel: bodyCancel },
        } as unknown as Response;
      },
    });
    const report = await runNativeCompatibility({}, fixture.deps);
    stage(local(report).stream, "reader_acquired", "reader_unavailable");
    expect(local(report).stream.measurements.cleanup).toBe(true);
    expect(bodyCancel).toHaveBeenCalledTimes(1);
    expect(local(report).abort.outcome).toBe("pass");
    clean(fixture);
  });

  it("bounds empty-chunk count after a real streaming handshake", async () => {
    const observations: NativeObservation[] = [];
    const fixture = makeCompatibilityFixture({
      hook: async (input, _init, next) => {
        const res = await next();
        if (!input.endsWith("/compat-stream")) return res;
        return observeResponse(
          res,
          "/compat-stream",
          () => fixture.responses.at(-1),
          observations,
          async (reader, index) =>
            index === 0
              ? await reader.read()
              : { done: false, value: new Uint8Array(0) }
        );
      },
    });
    const report = await runNativeCompatibility({}, fixture.deps);
    stage(local(report).stream, "read_settled", "stream_limit");
    expect(local(report).stream.measurements).toMatchObject({
      chunks: 129,
      preEofRead: true,
      cleanup: true,
    });
    expect(observations[0]?.body?.locked).toBe(false);
    expect(local(report).abort.outcome).toBe("pass");
    clean(fixture);
  });

  it("rejects cleanup failure and skips abort and supplemental lane", async () => {
    const observations: NativeObservation[] = [];
    const fixture = makeCompatibilityFixture({
      missing: ["URL"],
      hook: async (_input, _init, next) =>
        observeResponse(
          await next(),
          "/compat-stream",
          () => fixture.responses.at(-1),
          observations,
          undefined,
          () => {
            throw errorCode("EACCES");
          }
        ),
    });
    const report = await runNativeCompatibility({}, fixture.deps);
    expect(local(report).stream).toMatchObject({
      outcome: "blocked",
      code: "cleanup_failed",
    });
    expect(local(report).abort.code).toBe("previous_cleanup_failed");
    expect(report.lanes).toHaveLength(1);
    expect(fixture.createServer).toHaveBeenCalledTimes(1);
    expect(observations[0]?.body?.locked).toBe(false);
    clean(fixture);
  });

  it.each(["sync", "async"] as const)(
    "cleans listen denial (%s) without starting fetch",
    async (kind) => {
      const fixture = makeCompatibilityFixture();
      const boundServers: http.Server[] = [];
      const baselines: ReturnType<typeof listenerSnapshot>[] = [];
      fixture.deps.http = vi.fn(() =>
        Promise.resolve({
          createServer: ((listener: http.RequestListener) => {
            const server = http.createServer(listener);
            boundServers.push(server);
            baselines.push(listenerSnapshot(server));
            vi.spyOn(server, "listen").mockImplementation(() => {
              if (kind === "sync") throw errorCode("ERR_ACCESS_DENIED");
              queueMicrotask(() => server.emit("error", errorCode("EACCES")));
              return server;
            });
            return server;
          }) as unknown as typeof http.createServer,
        })
      );
      const report = await runNativeCompatibility({}, fixture.deps);
      stage(local(report).stream, "listen", "permission_denied");
      stage(local(report).abort, "listen", "permission_denied");
      expect(fixture.guardedFetch).not.toHaveBeenCalled();
      expect(boundServers).toHaveLength(2);
      boundServers.forEach((server, i) => {
        expect(listenerSnapshot(server)).toEqual(baselines[i]);
        expect(server.listening).toBe(false);
      });
    }
  );

  it.each([
    ["ERR_ACCESS_DENIED", "blocked", "permission_denied"],
    ["EACCES", "blocked", "permission_denied"],
    ["EPERM", "blocked", "permission_denied"],
    ["MODULE_NOT_FOUND", "blocked", "module_unavailable"],
    ["ERR_UNKNOWN_BUILTIN_MODULE", "blocked", "module_unavailable"],
    ["ETIMEDOUT", "blocked", "timeout"],
    ["EADDRINUSE", "failed", "address_in_use"],
    ["ABORT_ERR", "failed", "abort_error"],
    [DETAIL, "failed", "operation_failed"],
  ] as const)(
    "sanitizes %s without leaking details",
    (code, outcome, sanitized) => {
      expect(classifyCompatibilityError(errorCode(code))).toEqual({
        outcome,
        code: sanitized,
      });
      expect(classifyCompatibilityError(DETAIL)).toEqual({
        outcome: "failed",
        code: "operation_failed",
      });
    }
  );
  it("handles inaccessible error properties without throwing raw errors", () => {
    const error = Object.defineProperties(
      {},
      {
        name: {
          get() {
            throw new Error(DETAIL);
          },
        },
        code: {
          get() {
            throw new Error(DETAIL);
          },
        },
      }
    );
    expect(classifyCompatibilityError(error)).toEqual({
      outcome: "failed",
      code: "operation_failed",
    });
  });
});

describe("F2C actual pending-read abort discrimination", () => {
  it.each(["cross_realm", "unrelated", "ignored"] as const)(
    "classifies pending read settling via %s after real native abort",
    async (kind) => {
      const observations: NativeObservation[] = [];
      const foreignError: unknown = runInNewContext(
        'Object.assign(new Error("synthetic-private-detail"), {name: "AbortError"})'
      );
      expect(foreignError instanceof Error).toBe(false);
      const fixture = makeCompatibilityFixture({
        hook: async (input, _init, next) => {
          const response = await next();
          if (!input.endsWith("/compat-abort")) return response;
          return observeResponse(
            response,
            "/compat-abort",
            () => fixture.responses.at(-1),
            observations,
            async (reader) => {
              try {
                return await reader.read();
              } catch {
                if (kind === "ignored") return { done: true, value: undefined };
                throw kind === "cross_realm"
                  ? foreignError
                  : errorCode("UNRELATED");
              }
            }
          );
        },
      });
      const report = await runNativeCompatibility({}, fixture.deps);
      const probe = local(report).abort;
      expect(local(report).stream.outcome).toBe("pass");
      expect(probe.measurements).toMatchObject({
        pendingRead: true,
        abortRequested: true,
        cleanup: true,
      });
      if (kind === "cross_realm") {
        expect(probe).toMatchObject({
          outcome: "pass",
          code: "pending_read_aborted_and_closed",
          measurements: { serverClosedBeforeTeardown: true },
        });
      } else {
        expect(probe.outcome).toBe("failed");
        stage(
          probe,
          "read_settled",
          kind === "ignored" ? "abort_did_not_reject" : "operation_failed"
        );
      }
      expect(observations[0]?.body?.locked).toBe(false);
      noSecrets(report);
      clean(fixture);
    }
  );

  it.each(["read_never_settles", "server_stays_open"] as const)(
    "does not count an ignored abort (%s) as a pass even after a native signal",
    async (mode) => {
      vi.useFakeTimers();
      const pendingReady = Promise.withResolvers<void>();
      const abortSeen = Promise.withResolvers<void>();
      const observations: NativeObservation[] = [];
      const fixture = makeCompatibilityFixture({
        hook: async (input, init, next) => {
          if (!input.endsWith("/compat-abort")) return await next();
          const res = await next({ ignoreAbort: mode === "server_stays_open" });
          const signal = init?.signal;
          if (!signal) throw new Error("Missing fixture signal");
          return observeResponse(
            res,
            "/compat-abort",
            () => fixture.responses.at(-1),
            observations,
            async (reader, index) => {
              if (index === 0) return await reader.read();
              return await new Promise((_, reject) => {
                signal.addEventListener(
                  "abort",
                  () => {
                    abortSeen.resolve();
                    if (mode === "server_stays_open")
                      reject(new DOMException(DETAIL, "AbortError"));
                  },
                  { once: true }
                );
                pendingReady.resolve();
              });
            }
          );
        },
      });
      const run = runNativeCompatibility({}, fixture.deps);
      await pendingReady.promise;
      await vi.advanceTimersByTimeAsync(1);
      await abortSeen.promise;
      await vi.advanceTimersByTimeAsync(5000);
      const report = await run;
      const probe = local(report).abort;
      expect(local(report).stream.outcome).toBe("pass");
      expect(probe).toMatchObject({
        outcome: "blocked",
        code: "timeout",
        measurements: {
          pendingRead: true,
          abortRequested: true,
          serverClosedBeforeTeardown: false,
          cleanup: true,
        },
      });
      stage(
        probe,
        mode === "server_stays_open" ? "server_closed" : "read_settled",
        "timeout"
      );
      expect(observations[0]?.body?.locked).toBe(false);
      noSecrets(report);
      clean(fixture);
    }
  );

  it("does not accept an already-settled read as pending", async () => {
    const observations: NativeObservation[] = [];
    const fixture = makeCompatibilityFixture({
      hook: async (input, _init, next) => {
        const res = await next();
        if (!input.endsWith("/compat-abort")) return res;
        return observeResponse(
          res,
          "/compat-abort",
          () => fixture.responses.at(-1),
          observations,
          async (reader, index) =>
            index === 0 ? await reader.read() : { done: true, value: undefined }
        );
      },
    });
    const report = await runNativeCompatibility({}, fixture.deps);
    stage(local(report).abort, "pending_read", "read_not_pending");
    expect(local(report).abort.measurements).toMatchObject({
      pendingRead: false,
      abortRequested: false,
      serverClosedBeforeTeardown: false,
    });
    clean(fixture);
  });
});

describe("F2C bounded cancellation and mutual exclusion", () => {
  it("pre-cancel avoids modules, bind and fetch", async () => {
    const fixture = makeCompatibilityFixture({ missing: [...NAMES] });
    const cancellation = trackedCancellation();
    cancellation.cancel();
    expect(
      await runNativeCompatibility({ cancellation }, fixture.deps)
    ).toMatchObject({
      outcome: "blocked",
      code: "cancelled",
      constructors: [],
      lanes: [],
    });
    for (const loader of [
      fixture.deps.http,
      fixture.deps.util,
      fixture.deps.url,
      fixture.deps.streamWeb,
    ])
      expect(loader).not.toHaveBeenCalled();
    expect(fixture.guardedFetch).not.toHaveBeenCalled();
    expect(cancellation.active.size).toBe(0);
  });

  it("cancels an outstanding builtin load and blocks concurrent lanes on the same ambient object", async () => {
    const fixture = makeCompatibilityFixture({ missing: [...NAMES] });
    const cancellation = trackedCancellation();
    const started = Promise.withResolvers<void>();
    fixture.deps.util = vi.fn(() => {
      started.resolve();
      return new Promise<Pick<typeof import("node:util"), "TextDecoder">>(
        () => undefined
      );
    });
    const run = runNativeCompatibility({ cancellation }, fixture.deps);
    await started.promise;
    expect(await runNativeCompatibility({}, fixture.deps)).toMatchObject({
      code: "already_running",
      outcome: "blocked",
      lanes: [],
    });
    cancellation.cancel();
    expect(await run).toMatchObject({
      outcome: "blocked",
      code: "cancelled",
      lanes: [],
    });
    expect(fixture.deps.url).not.toHaveBeenCalled();
    expect(fixture.createServer).not.toHaveBeenCalled();
    expect(cancellation.active.size).toBe(0);
  });

  it("cancels transport before a nonsettling fetch and avoids later lane", async () => {
    const cancellation = trackedCancellation();
    const fixture = makeCompatibilityFixture({
      missing: [...NAMES],
      hook: () => {
        queueMicrotask(() => cancellation.cancel());
        return new Promise(() => undefined);
      },
    });
    const before = descriptors(fixture.globals);
    const report = await runNativeCompatibility({ cancellation }, fixture.deps);
    expect(report).toMatchObject({
      outcome: "blocked",
      code: "cancelled",
      restored: true,
    });
    expect(report.lanes).toHaveLength(1);
    stage(local(report).stream, "fetch_started", "cancelled");
    expect(local(report).abort.code).toBe("cancelled");
    expect(cancellation.active.size).toBe(0);
    expect(descriptors(fixture.globals)).toEqual(before);
    clean(fixture);
  });

  it("times out a nonsettling fetch using fake time, with no dangling timers or listeners", async () => {
    vi.useFakeTimers();
    const started = Promise.withResolvers<void>();
    const cancellation = trackedCancellation();
    const fixture = makeCompatibilityFixture({
      hook: (input) => {
        if (input.endsWith("/compat-stream")) {
          started.resolve();
          return new Promise(() => undefined);
        }
        return Promise.reject(errorCode("EACCES"));
      },
    });
    const run = runNativeCompatibility({ cancellation }, fixture.deps);
    await started.promise;
    await vi.advanceTimersByTimeAsync(5000);
    const report = await run;
    stage(local(report).stream, "fetch_started", "timeout");
    expect(local(report).stream.code).toBe("timeout");
    expect(local(report).abort.code).toBe("permission_denied");
    expect(vi.getTimerCount()).toBe(0);
    expect(cancellation.active.size).toBe(0);
    clean(fixture);
  });

  it("cancels while a real synthetic response reader is held and releases the lock", async () => {
    const cancellation = trackedCancellation();
    const observations: NativeObservation[] = [];
    const fixture = makeCompatibilityFixture({
      hook: async (_input, _init, next) => {
        return observeResponse(
          await next(),
          "/compat-stream",
          () => fixture.responses.at(-1),
          observations,
          async (reader) => {
            const part = await reader.read();
            cancellation.cancel();
            return part;
          }
        );
      },
    });
    const report = await runNativeCompatibility({ cancellation }, fixture.deps);
    expect(report.code).toBe("cancelled");
    stage(local(report).stream, "first_chunk", "cancelled");
    expect(local(report).abort.code).toBe("cancelled");
    expect(observations[0]?.cancel).toHaveBeenCalledTimes(1);
    expect(observations[0]?.release).toHaveBeenCalledTimes(1);
    expect(observations[0]?.body?.locked).toBe(false);
    expect(cancellation.active.size).toBe(0);
    clean(fixture);
  });

  it("restores descriptors after cancellation in supplemented lane", async () => {
    const cancellation = trackedCancellation();
    const fixture = makeCompatibilityFixture({
      missing: [...NAMES],
      hook: () => {
        if (!fixture.globals.TextDecoder)
          return Promise.reject(errorCode("UNSUPPORTED"));
        queueMicrotask(() => cancellation.cancel());
        return new Promise(() => undefined);
      },
    });
    const before = descriptors(fixture.globals);
    const report = await runNativeCompatibility({ cancellation }, fixture.deps);
    expect(report).toMatchObject({
      outcome: "blocked",
      code: "cancelled",
      restored: true,
    });
    expect(supplemental(report)).toMatchObject({
      outcome: "blocked",
      code: "cancelled",
      restored: true,
    });
    expect(descriptors(fixture.globals)).toEqual(before);
    expect(cancellation.active.size).toBe(0);
    clean(fixture);
  });
});

describe("F2C isolated build graph", () => {
  it("uses only the approved builtin imports in the compatibility module, and no production/provider dependencies", async () => {
    const graph = await build({
      entryPoints: ["src/extension/feasibility/native-compatibility.ts"],
      bundle: true,
      platform: "node",
      format: "cjs",
      write: false,
      metafile: true,
    });
    const inputs = Object.keys(graph.metafile.inputs);
    expect(inputs).toEqual([
      "src/extension/feasibility/native-compatibility.ts",
    ]);
    const imports = Object.values(graph.metafile.inputs)
      .flatMap((input) => input.imports.map((entry) => entry.path))
      .sort();
    expect(imports).toEqual([
      "node:http",
      "node:stream/web",
      "node:url",
      "node:util",
    ]);
    const fixture = await build({
      entryPoints: ["src/extension/feasibility/index.ts"],
      bundle: true,
      platform: "node",
      format: "cjs",
      supported: { "dynamic-import": false },
      write: false,
      metafile: true,
      define: {
        __FEASIBILITY_WEBVIEW__: JSON.stringify("<html>fixture</html>"),
        __FEASIBILITY_BUILD_ID__: JSON.stringify("f2c-test"),
      },
    });
    const fixtureInputs = Object.keys(fixture.metafile.inputs);
    expect(fixtureInputs).toContain(
      "src/extension/feasibility/native-compatibility.ts"
    );
    expect(
      fixtureInputs.some((path) =>
        path.includes("node_modules/@ableton-extensions/sdk/")
      )
    ).toBe(true);
    expect(
      fixtureInputs.filter(
        (path) =>
          !path.startsWith("src/extension/feasibility/") &&
          !path.includes("node_modules/@ableton-extensions/sdk/")
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
      Object.keys(production.metafile.inputs).some((path) =>
        path.startsWith("src/extension/executors/")
      )
    ).toBe(true);
    expect(
      Object.keys(production.metafile.inputs).filter((path) =>
        path.includes("/feasibility/")
      )
    ).toEqual([]);
  });
});
