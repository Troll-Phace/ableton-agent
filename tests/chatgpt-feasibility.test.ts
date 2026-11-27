import * as fs from "node:fs";
import * as http from "node:http";
import * as crypto from "node:crypto";
import { join } from "node:path";

import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProbeCancellation } from "../src/extension/feasibility/contracts.js";
import {
  listenLoopback,
  nativeProbeDependencies,
  probeNativeGlobals,
  probeStorage,
  runHostProbes,
  sanitizedFailure,
} from "../src/extension/feasibility/host-probes.js";
import {
  codedError,
  fakeBrowserModule,
  makeProbeFixture,
  makeStorage,
  onlyProbe,
  PRIVATE_PID,
  SYNTHETIC_DETAIL,
} from "./fixtures/chatgpt-feasibility.js";

const disposals: (() => void)[] = [];
function storage() {
  const fixture = makeStorage();
  disposals.push(fixture.dispose);
  return fixture;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dispose of disposals.splice(0)) dispose();
});

describe("P15.3 F2 offline capability reporting", () => {
  it("reports every native global and a bounded version without changing globals", () => {
    const deps = nativeProbeDependencies();
    expect(probeNativeGlobals(deps)).toEqual({
      probe: "native_globals",
      outcome: "pass",
      code: "available",
      measurements: {
        fetch: true,
        abortController: true,
        textDecoder: true,
        url: true,
        readableStream: true,
        nodeVersion: process.versions.node,
        sdkVersion: "1.0.0-beta.0",
      },
    });
    for (const key of [
      "fetch",
      "AbortController",
      "TextDecoder",
      "URL",
      "ReadableStream",
    ] as const) {
      const missing = probeNativeGlobals({
        ...deps,
        [key]: undefined,
        nodeVersion: SYNTHETIC_DETAIL,
      });
      expect(missing).toMatchObject({
        outcome: "blocked",
        code: "missing_native_globals",
        measurements: { nodeVersion: "unknown" },
      });
      expect(
        Object.values(missing.measurements ?? {}).filter((v) => v === false)
      ).toHaveLength(1);
    }
    expect(nativeProbeDependencies().fetch).toBe(globalThis.fetch);
  });

  it("reports independent builtin failures and retains randomness and storage evidence", async () => {
    const fixture = storage();
    const { deps, childLoader } = makeProbeFixture({
      http: () => Promise.reject(codedError("ERR_ACCESS_DENIED")),
    });
    const rows = await runHostProbes(
      { storageDirectory: fixture.directory },
      deps
    );
    expect(onlyProbe(rows, "node_builtins")).toMatchObject({
      outcome: "blocked",
      code: "required_builtin_unavailable",
      measurements: { http: false, fs: true, path: true, crypto: true },
    });
    expect(onlyProbe(rows, "randomness")).toMatchObject({ outcome: "pass" });
    expect(onlyProbe(rows, "storage")).toMatchObject({
      code: "restart_required",
    });
    expect(onlyProbe(rows, "loopback")).toMatchObject({
      outcome: "blocked",
      code: "permission_denied",
    });
    for (const name of [
      "native_stream",
      "native_abort",
      "system_browser",
    ] as const) {
      expect(onlyProbe(rows, name)).toMatchObject({
        outcome: "blocked",
        code: "loopback_unavailable",
      });
    }
    expect(childLoader).not.toHaveBeenCalled();
    expect(JSON.stringify(rows)).not.toContain(SYNTHETIC_DETAIL);
  });

  it("fails indistinguishable random samples independently", async () => {
    const { deps } = makeProbeFixture({
      http: () => Promise.reject(codedError("MODULE_NOT_FOUND")),
      crypto: () =>
        Promise.resolve({
          ...crypto,
          randomBytes: (size: number) => Buffer.alloc(size),
        }),
    });
    const rows = await runHostProbes({ storageDirectory: undefined }, deps);
    expect(onlyProbe(rows, "randomness")).toMatchObject({
      outcome: "failed",
      code: "invalid_random_samples",
    });
    expect(onlyProbe(rows, "storage")).toMatchObject({
      outcome: "blocked",
      code: "storage_or_identity_unavailable",
    });
  });

  it.each([
    ["ERR_ACCESS_DENIED", "permission_denied"],
    ["EACCES", "permission_denied"],
    ["EPERM", "permission_denied"],
    ["ENOENT", "not_found"],
    ["ERR_UNKNOWN_BUILTIN_MODULE", "module_unavailable"],
    ["MODULE_NOT_FOUND", "module_unavailable"],
    ["EADDRINUSE", "address_in_use"],
    ["ETIMEDOUT", "timeout"],
    [SYNTHETIC_DETAIL, "operation_failed"],
  ])("maps %s to fixed sanitized code %s", (code, expected) => {
    expect(sanitizedFailure(codedError(code))).toBe(expected);
    expect(sanitizedFailure(SYNTHETIC_DETAIL)).toBe("operation_failed");
    expect(sanitizedFailure(null)).toBe("operation_failed");
  });
});

describe("P15.3 F2 offline synthetic streaming and cancellation", () => {
  it("binds ephemeral IPv4 loopback, finishes SSE, aborts an active read, and closes sockets", async () => {
    const { deps, fetch, requests, servers, sockets, childLoader } =
      makeProbeFixture();
    const rows = await runHostProbes({ storageDirectory: undefined }, deps);
    expect(rows).toHaveLength(8);
    expect(onlyProbe(rows, "loopback")).toMatchObject({
      outcome: "pass",
      code: "ephemeral_listener_bound",
    });
    const stream = onlyProbe(rows, "native_stream");
    expect(stream).toMatchObject({
      outcome: "pass",
      code: "synthetic_sse_completed",
      measurements: { bytes: 'data: {"marker":"p15_3"}\n\n'.length },
    });
    expect(stream.measurements?.chunks).toBeGreaterThanOrEqual(1);
    expect(onlyProbe(rows, "native_abort")).toMatchObject({
      outcome: "pass",
      code: "aborted_stream_read",
    });
    expect(onlyProbe(rows, "system_browser")).toMatchObject({
      outcome: "blocked",
      code: "operator_action_required",
    });
    expect(childLoader).not.toHaveBeenCalled();
    expect(requests).toEqual(["/stream", "/abort"]);
    expect(
      fetch.mock.calls.every(
        ([, options]) =>
          options?.signal?.aborted && options.redirect === "error"
      )
    ).toBe(true);
    expect(servers).toHaveLength(1);
    expect(sockets.length).toBeGreaterThan(0);
    expect(sockets.every((socket) => socket.destroyed)).toBe(true);
    for (const server of servers) {
      expect(server.listening).toBe(false);
      expect(server.address()).toBeNull();
      expect(server.listenerCount("error")).toBe(0);
    }
  });

  it("blocks native stream and abort when fetch is absent, retaining loopback evidence", async () => {
    const { deps, servers } = makeProbeFixture({ fetch: undefined });
    const rows = await runHostProbes({ storageDirectory: undefined }, deps);
    expect(onlyProbe(rows, "native_globals")).toMatchObject({
      outcome: "blocked",
    });
    expect(onlyProbe(rows, "loopback")).toMatchObject({ outcome: "pass" });
    for (const name of ["native_stream", "native_abort"] as const) {
      expect(onlyProbe(rows, name)).toMatchObject({
        outcome: "blocked",
        code: "missing_native_globals",
      });
    }
    expect(servers[0]?.listening).toBe(false);
  });

  it("rejects an incorrect SSE body and an abort-insensitive stream", async () => {
    const { deps, servers } = makeProbeFixture({
      fetch: vi.fn<typeof globalThis.fetch>((input) =>
        Promise.resolve(
          new Response(
            typeof input === "string" && input.endsWith("/stream")
              ? "invalid"
              : "finite",
            {
              headers: { "Content-Type": "text/event-stream" },
            }
          )
        )
      ),
    });
    const rows = await runHostProbes({ storageDirectory: undefined }, deps);
    expect(onlyProbe(rows, "native_stream")).toMatchObject({
      outcome: "failed",
      code: "synthetic_sse_mismatch",
    });
    expect(onlyProbe(rows, "native_abort")).toMatchObject({
      outcome: "failed",
      code: "abort_did_not_reject",
    });
    expect(servers[0]?.listening).toBe(false);
  });

  it("sanitizes fetch denial while continuing independent abort checks", async () => {
    const fixture = makeProbeFixture();
    const fetch = vi.fn<typeof globalThis.fetch>((input, options) => {
      if (typeof input === "string" && input.endsWith("/stream"))
        return Promise.reject(codedError("EACCES"));
      return fixture.fetch(input, options);
    });
    const rows = await runHostProbes(
      { storageDirectory: undefined },
      { ...fixture.deps, fetch }
    );
    expect(onlyProbe(rows, "native_stream")).toMatchObject({
      outcome: "blocked",
      code: "permission_denied",
    });
    expect(onlyProbe(rows, "native_abort")).toMatchObject({ outcome: "pass" });
    expect(JSON.stringify(rows)).not.toContain(SYNTHETIC_DETAIL);
    expect(fixture.servers[0]?.listening).toBe(false);
  });

  it("cancellation listeners are one-shot, removable, and immediate for late registration", () => {
    const cancellation = createProbeCancellation();
    const removed = vi.fn();
    const active = vi.fn();
    cancellation.onCancel(removed)();
    cancellation.onCancel(active);
    cancellation.cancel();
    cancellation.cancel();
    expect(cancellation.cancelled).toBe(true);
    expect(removed).not.toHaveBeenCalled();
    expect(active).toHaveBeenCalledTimes(1);
    const late = vi.fn();
    cancellation.onCancel(late)();
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("does not write storage, bind a server, or launch on pre-cancel", async () => {
    const fixture = storage();
    const cancellation = createProbeCancellation();
    cancellation.cancel();
    const { deps, createServer, childLoader, fetch } = makeProbeFixture();
    const rows = await runHostProbes(
      {
        storageDirectory: fixture.directory,
        includeBrowser: true,
        cancellation,
      },
      deps
    );
    for (const name of [
      "storage",
      "loopback",
      "native_stream",
      "native_abort",
      "system_browser",
    ] as const) {
      expect(onlyProbe(rows, name)).toMatchObject({
        outcome: "blocked",
        code: "cancelled",
      });
    }
    expect(fs.readdirSync(fixture.directory)).toEqual([]);
    expect(createServer).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(childLoader).not.toHaveBeenCalled();
  });

  it("cancels an in-flight stream read, releases the reader and skips later operations", async () => {
    const cancellation = createProbeCancellation();
    const cancelReader = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          cancellation.cancel();
        },
        cancel: cancelReader,
      },
      { highWaterMark: 0 }
    );
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(body, { headers: { "Content-Type": "text/event-stream" } })
      )
    );
    const { deps, childLoader, servers } = makeProbeFixture({ fetch });
    const rows = await runHostProbes(
      {
        storageDirectory: undefined,
        includeBrowser: true,
        cancellation,
      },
      deps
    );
    expect(onlyProbe(rows, "native_stream")).toMatchObject({
      outcome: "blocked",
      code: "cancelled",
    });
    expect(onlyProbe(rows, "native_abort")).toMatchObject({
      outcome: "blocked",
      code: "cancelled",
    });
    expect(onlyProbe(rows, "system_browser")).toMatchObject({
      outcome: "blocked",
      code: "cancelled",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(body.locked).toBe(false);
    expect(cancelReader).toHaveBeenCalledTimes(1);
    expect(childLoader).not.toHaveBeenCalled();
    expect(servers[0]?.listening).toBe(false);
  });

  it("cleans setup listener and timer after an asynchronous listen denial", async () => {
    vi.useFakeTimers();
    const server = http.createServer();
    vi.spyOn(server, "listen").mockImplementation(() => {
      queueMicrotask(() => server.emit("error", codedError("EACCES")));
      return server;
    });
    await expect(listenLoopback(server)).rejects.toMatchObject({
      code: "EACCES",
    });
    expect(server.listenerCount("error")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a nonsettling synthetic fetch and clears its deadline", async () => {
    vi.useFakeTimers();
    const started = Promise.withResolvers<void>();
    const fetch = vi.fn<typeof globalThis.fetch>((input) => {
      if (typeof input === "string" && input.endsWith("/stream")) {
        started.resolve();
        return new Promise<Response>(() => undefined);
      }
      return Promise.reject(codedError("EACCES"));
    });
    const { deps, servers } = makeProbeFixture({ fetch });
    const pending = runHostProbes({ storageDirectory: undefined }, deps);
    await started.promise;
    await vi.advanceTimersByTimeAsync(5000);
    const rows = await pending;
    expect(onlyProbe(rows, "native_stream")).toMatchObject({
      outcome: "blocked",
      code: "timeout",
    });
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(onlyProbe(rows, "native_abort")).toMatchObject({
      outcome: "blocked",
      code: "permission_denied",
    });
    expect(servers[0]?.listening).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans setup listener and timer after a synchronous listen denial", async () => {
    vi.useFakeTimers();
    const server = http.createServer();
    vi.spyOn(server, "listen").mockImplementation(() => {
      throw codedError("ERR_ACCESS_DENIED");
    });
    await expect(listenLoopback(server)).rejects.toMatchObject({
      code: "ERR_ACCESS_DENIED",
    });
    try {
      expect({
        listeners: server.listenerCount("error"),
        timers: vi.getTimerCount(),
      }).toEqual({
        listeners: 0,
        timers: 0,
      });
    } finally {
      vi.clearAllTimers();
      server.removeAllListeners("error");
    }
  });
});

describe("P15.3 F2 offline private storage", () => {
  it("atomically replaces its private marker, retains same-PID marker, and deletes on a distinct PID", async () => {
    const fixture = storage();
    const renameSync = vi.fn<typeof fs.renameSync>((from, to) => {
      expect(to).toBe(fixture.marker);
      expect(fs.readFileSync(to, "utf8")).toBe(
        `p15_3:initial:${PRIVATE_PID}\n`
      );
      expect(fs.readFileSync(from, "utf8")).toBe(
        `p15_3:replacement:${PRIVATE_PID}\n`
      );
      expect(fs.statSync(from).mode & 0o777).toBe(0o600);
      expect(fs.statSync(to).mode & 0o777).toBe(0o600);
      fs.renameSync(from, to);
    });
    const { deps } = makeProbeFixture({
      fs: () => Promise.resolve({ ...fs, renameSync }),
    });
    expect(await probeStorage(fixture.directory, deps)).toEqual({
      probe: "storage",
      outcome: "blocked",
      code: "restart_required",
      measurements: {
        privateMode: true,
        atomicReplacement: true,
        restartVerified: false,
      },
    });
    expect(renameSync).toHaveBeenCalledTimes(1);
    const stat = fs.lstatSync(fixture.marker);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(stat.nlink).toBe(1);
    expect(stat.uid).toBe(deps.uid);
    expect(fs.readdirSync(fixture.directory)).toEqual([
      fixture.marker.split("/").at(-1),
    ]);
    expect(await probeStorage(fixture.directory, deps)).toMatchObject({
      code: "restart_required",
    });
    expect(renameSync).toHaveBeenCalledTimes(1);
    expect(
      await probeStorage(fixture.directory, { ...deps, pid: PRIVATE_PID + 1 })
    ).toEqual({
      probe: "storage",
      outcome: "pass",
      code: "restart_verified_and_deleted",
      measurements: {
        privateMode: true,
        atomicReplacement: true,
        restartVerified: true,
        deleted: true,
      },
    });
    expect(fs.readdirSync(fixture.directory)).toEqual([]);
  });

  it("rejects a relative directory and unavailable SDK identity", async () => {
    const { deps } = makeProbeFixture();
    expect(await probeStorage("relative-test-only", deps)).toMatchObject({
      outcome: "blocked",
      code: "invalid_storage_directory",
    });
    expect(await probeStorage(undefined, deps)).toMatchObject({
      outcome: "blocked",
      code: "storage_or_identity_unavailable",
    });
    const fixture = storage();
    expect(
      await probeStorage(fixture.directory, { ...deps, uid: undefined })
    ).toMatchObject({
      outcome: "blocked",
      code: "storage_or_identity_unavailable",
    });
    expect(fs.readdirSync(fixture.directory)).toEqual([]);
  });

  it.each([
    "mode",
    "symlink",
    "hardlink",
    "directory",
    "owner",
    "oversize",
    "unknown",
  ] as const)(
    "does not overwrite or remove an unsafe %s marker",
    async (scenario) => {
      const fixture = storage();
      const sibling = join(fixture.directory, "test-owned-sibling");
      const content =
        scenario === "unknown" ? SYNTHETIC_DETAIL : "p15_3:replacement:12344\n";
      const { deps } = makeProbeFixture();
      if (scenario === "directory") fs.mkdirSync(fixture.marker);
      else if (scenario === "symlink" || scenario === "hardlink") {
        fs.writeFileSync(sibling, content, { mode: 0o600 });
        if (scenario === "symlink") fs.symlinkSync(sibling, fixture.marker);
        else fs.linkSync(sibling, fixture.marker);
      } else {
        fs.writeFileSync(
          fixture.marker,
          scenario === "oversize" ? "x".repeat(129) : content,
          {
            mode: scenario === "mode" ? 0o644 : 0o600,
          }
        );
      }
      const prior = fs.lstatSync(fixture.marker);
      const rows = await probeStorage(fixture.directory, {
        ...deps,
        uid: scenario === "owner" ? prior.uid + 1 : deps.uid,
      });
      expect(rows).toMatchObject({
        outcome: "blocked",
        code: scenario === "unknown" ? "unknown_marker" : "unsafe_marker",
      });
      expect(fs.lstatSync(fixture.marker)).toMatchObject({
        ino: prior.ino,
        mode: prior.mode,
        nlink: prior.nlink,
        size: prior.size,
      });
      expect(JSON.stringify(rows)).not.toContain(SYNTHETIC_DETAIL);
      if (scenario === "symlink" || scenario === "hardlink")
        expect(fs.readFileSync(sibling, "utf8")).toBe(content);
      else if (scenario !== "directory")
        expect(fs.readFileSync(fixture.marker, "utf8")).toBe(
          scenario === "oversize" ? "x".repeat(129) : content
        );
    }
  );

  it("cleans both owned files after failed atomic replacement with fixed error output", async () => {
    const fixture = storage();
    const renameSync = vi.fn<typeof fs.renameSync>(() => {
      throw codedError("EPERM");
    });
    const { deps } = makeProbeFixture({
      fs: () => Promise.resolve({ ...fs, renameSync }),
    });
    expect(await probeStorage(fixture.directory, deps)).toEqual({
      probe: "storage",
      outcome: "blocked",
      code: "permission_denied",
    });
    expect(renameSync).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(fixture.directory)).toEqual([]);
  });
});

describe("P15.3 F2 fixed browser seam (never launches a browser)", () => {
  it("requires both a successful fixed invocation and actual synthetic loopback receipt", async () => {
    const fixture = makeProbeFixture();
    const fake = fakeBrowserModule((_file, args, _options, callback) => {
      callback(null);
      void (async () => {
        try {
          const response = await fixture.fetch(args[0] ?? "");
          await response.text();
        } catch {
          // Probe must not pass without the receipt.
        }
      })();
    });
    const rows = await runHostProbes(
      { storageDirectory: undefined, includeBrowser: true },
      {
        ...fixture.deps,
        childProcess: fake.loader,
      }
    );
    expect(onlyProbe(rows, "system_browser")).toMatchObject({
      outcome: "pass",
      code: "fixed_loopback_page_visited",
    });
    expect(fake.execFile).toHaveBeenCalledExactlyOnceWith(
      "/usr/bin/open",
      [expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/browser$/)],
      { shell: false, timeout: 10000, maxBuffer: 4096 },
      expect.any(Function)
    );
    expect(fake.kill).not.toHaveBeenCalled();
    expect(fixture.requests).toEqual(["/stream", "/abort", "/browser"]);
    expect(fixture.servers[0]?.listening).toBe(false);
  });

  it("classifies launcher denial without fallback invocation or raw error", async () => {
    const fixture = makeProbeFixture();
    const fake = fakeBrowserModule((_file, _args, _options, callback) =>
      callback(codedError("ERR_ACCESS_DENIED"))
    );
    const rows = await runHostProbes(
      { storageDirectory: undefined, includeBrowser: true },
      {
        ...fixture.deps,
        childProcess: fake.loader,
      }
    );
    expect(onlyProbe(rows, "system_browser")).toEqual({
      probe: "system_browser",
      outcome: "blocked",
      code: "permission_denied",
    });
    expect(fake.loader).toHaveBeenCalledTimes(1);
    expect(fake.execFile).toHaveBeenCalledTimes(1);
    expect(fixture.requests).toEqual(["/stream", "/abort"]);
    expect(JSON.stringify(rows)).not.toContain(SYNTHETIC_DETAIL);
    expect(fixture.servers[0]?.listening).toBe(false);
  });

  it("blocks a denied child-process loader without any alternate invocation", async () => {
    const { deps, childLoader, requests } = makeProbeFixture();
    const rows = await runHostProbes(
      { storageDirectory: undefined, includeBrowser: true },
      deps
    );
    expect(onlyProbe(rows, "system_browser")).toMatchObject({
      outcome: "blocked",
      code: "permission_denied",
    });
    expect(childLoader).toHaveBeenCalledTimes(1);
    expect(requests).toEqual(["/stream", "/abort"]);
    expect(JSON.stringify(rows)).not.toContain(SYNTHETIC_DETAIL);
  });

  it("does not count launch success alone as a receipt, and cancels waiting for one", async () => {
    const cancellation = createProbeCancellation();
    const fixture = makeProbeFixture();
    const fake = fakeBrowserModule((_file, _args, _options, callback) => {
      callback(null);
      queueMicrotask(() => cancellation.cancel());
    });
    const rows = await runHostProbes(
      { storageDirectory: undefined, includeBrowser: true, cancellation },
      {
        ...fixture.deps,
        childProcess: fake.loader,
      }
    );
    expect(onlyProbe(rows, "system_browser")).toMatchObject({
      outcome: "blocked",
      code: "cancelled",
    });
    expect(fake.execFile).toHaveBeenCalledTimes(1);
    expect(fixture.requests).toEqual(["/stream", "/abort"]);
    expect(fixture.servers[0]?.listening).toBe(false);
  });

  it("does not load child process on a non-macOS platform", async () => {
    const { deps, childLoader } = makeProbeFixture({ platform: "linux" });
    const rows = await runHostProbes(
      { storageDirectory: undefined, includeBrowser: true },
      deps
    );
    expect(onlyProbe(rows, "system_browser")).toMatchObject({
      outcome: "blocked",
      code: "unsupported_platform",
    });
    expect(childLoader).not.toHaveBeenCalled();
  });
});

describe("P15.3 F2 offline dependency isolation", () => {
  it("bundles only the feasibility modules and pinned SDK, never production or executors", async () => {
    const graph = await build({
      entryPoints: ["src/extension/feasibility/index.ts"],
      bundle: true,
      platform: "node",
      format: "cjs",
      supported: { "dynamic-import": false },
      define: {
        __FEASIBILITY_WEBVIEW__: JSON.stringify(
          "<html>synthetic fixture</html>"
        ),
      },
      write: false,
      metafile: true,
    });
    const inputs = Object.keys(graph.metafile.inputs);
    for (const path of ["index.ts", "host-probes.ts", "contracts.ts"])
      expect(inputs).toContain("src/extension/feasibility/" + path);
    expect(
      inputs.some((path) =>
        path.includes("node_modules/@ableton-extensions/sdk/")
      )
    ).toBe(true);
    expect(
      inputs.filter(
        (path) =>
          !path.startsWith("src/extension/feasibility/") &&
          !path.includes("node_modules/@ableton-extensions/sdk/")
      )
    ).toEqual([]);
    expect(graph.outputFiles[0]?.text).not.toMatch(
      /live_delete|live_edit_midi_notes|@anthropic-ai\/sdk|undici|transcript-store/
    );
  });

  it("keeps the production bundle independent of feasibility modules", async () => {
    const graph = await build({
      entryPoints: ["src/extension/index.ts"],
      bundle: true,
      platform: "node",
      format: "cjs",
      loader: { ".html": "text" },
      write: false,
      metafile: true,
    });
    const inputs = Object.keys(graph.metafile.inputs);
    expect(inputs).toContain("src/extension/index.ts");
    expect(
      inputs.some((path) => path.startsWith("src/extension/executors/"))
    ).toBe(true);
    expect(inputs.filter((path) => path.includes("/feasibility/"))).toEqual([]);
  });
});
