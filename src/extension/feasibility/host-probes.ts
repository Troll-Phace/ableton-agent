import type * as Http from "node:http";
import type * as Fs from "node:fs";
import type * as Path from "node:path";
import type * as Crypto from "node:crypto";
import type * as ChildProcess from "node:child_process";

import type {
  HostProbeOptions,
  ProbeCancellation,
  ProbeName,
  ProbeOutcome,
  ProbeResult,
} from "./contracts.js";

const HOST = "127.0.0.1";
const DEADLINE_MS = 5000;
const BROWSER_DEADLINE_MS = 10000;
const MARKER = "p15_3-private-storage-probe.json";
const STREAM_FRAME = 'data: {"marker":"p15_3"}\n\n';

/** Injectable loaders allow independent failures to be exercised without a host. */
export interface HostProbeDependencies {
  http: () => Promise<typeof Http>;
  fs: () => Promise<typeof Fs>;
  path: () => Promise<typeof Path>;
  crypto: () => Promise<typeof Crypto>;
  childProcess: () => Promise<typeof ChildProcess>;
  fetch: typeof globalThis.fetch | undefined;
  AbortController: typeof globalThis.AbortController | undefined;
  TextDecoder: typeof globalThis.TextDecoder | undefined;
  URL: typeof globalThis.URL | undefined;
  ReadableStream: typeof globalThis.ReadableStream | undefined;
  nodeVersion: string | undefined;
  platform: string | undefined;
  pid: number | undefined;
  uid: number | undefined;
}

/** Resolve Node primitives only on demand: one denied module must not hide others. */
export function nativeProbeDependencies(): HostProbeDependencies {
  return {
    http: () => import("node:http"),
    fs: () => import("node:fs"),
    path: () => import("node:path"),
    crypto: () => import("node:crypto"),
    childProcess: () => import("node:child_process"),
    fetch: globalThis.fetch,
    AbortController: globalThis.AbortController,
    TextDecoder: globalThis.TextDecoder,
    URL: globalThis.URL,
    ReadableStream: globalThis.ReadableStream,
    nodeVersion:
      typeof process === "object" ? process.versions?.node : undefined,
    platform: typeof process === "object" ? process.platform : undefined,
    pid: typeof process === "object" ? process.pid : undefined,
    uid:
      typeof process === "object" && typeof process.getuid === "function"
        ? process.getuid()
        : undefined,
  };
}

/** Error messages can contain paths; classify only allowlisted machine codes. */
export function sanitizedFailure(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    switch (error.code) {
      case "ERR_ACCESS_DENIED":
      case "EACCES":
      case "EPERM":
        return "permission_denied";
      case "ENOENT":
        return "not_found";
      case "ERR_UNKNOWN_BUILTIN_MODULE":
      case "MODULE_NOT_FOUND":
        return "module_unavailable";
      case "EADDRINUSE":
        return "address_in_use";
      case "ETIMEDOUT":
        return "timeout";
    }
  }
  return "operation_failed";
}

/** Build a fixed-schema status; callers must never supply raw error messages. */
export function result(
  probe: ProbeName,
  outcome: ProbeOutcome,
  code: string,
  measurements?: ProbeResult["measurements"]
): ProbeResult {
  return measurements
    ? { probe, outcome, code, measurements }
    : { probe, outcome, code };
}

function failure(probe: ProbeName, error: unknown): ProbeResult {
  const code = sanitizedFailure(error);
  return result(
    probe,
    ["permission_denied", "module_unavailable", "not_found"].includes(code)
      ? "blocked"
      : "failed",
    code
  );
}

/** Measure native globals directly, without installing a polyfill or shim. */
export function probeNativeGlobals(deps: HostProbeDependencies): ProbeResult {
  const measurements = {
    fetch: typeof deps.fetch === "function",
    abortController: typeof deps.AbortController === "function",
    textDecoder: typeof deps.TextDecoder === "function",
    url: typeof deps.URL === "function",
    readableStream: typeof deps.ReadableStream === "function",
    nodeVersion: /^\d+\.\d+\.\d+$/.test(deps.nodeVersion ?? "")
      ? (deps.nodeVersion ?? "unknown")
      : "unknown",
    sdkVersion: "1.0.0-beta.0",
  };
  const ok =
    measurements.fetch &&
    measurements.abortController &&
    measurements.textDecoder &&
    measurements.url &&
    measurements.readableStream;
  return result(
    "native_globals",
    ok ? "pass" : "blocked",
    ok ? "available" : "missing_native_globals",
    measurements
  );
}

function privateFile(fs: typeof Fs, path: string, uid: number): boolean {
  const stat = fs.lstatSync(path);
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.nlink === 1 &&
    stat.uid === uid &&
    (stat.mode & 0o777) === 0o600 &&
    stat.size <= 128
  );
}

function missing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/** Perform the two-stage persistence test in SDK storage, never another directory.
 * A first run leaves only a private synthetic marker. A different host PID must
 * validate and remove it; a same-process rerun is not restart evidence.
 */
export async function probeStorage(
  storageDirectory: string | undefined,
  deps = nativeProbeDependencies()
): Promise<ProbeResult> {
  if (!storageDirectory || deps.pid === undefined || deps.uid === undefined)
    return result("storage", "blocked", "storage_or_identity_unavailable");
  let cleanup: (() => void) | undefined;
  try {
    const [fs, path] = await Promise.all([deps.fs(), deps.path()]);
    if (!path.isAbsolute(storageDirectory))
      return result("storage", "blocked", "invalid_storage_directory");
    const file = path.join(storageDirectory, MARKER);
    const uid = deps.uid;
    const pid = deps.pid;
    // Do not follow a symlink or overwrite unknown files, even in SDK storage.
    let exists = false;
    try {
      fs.lstatSync(file);
      exists = true;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    if (exists) {
      if (!privateFile(fs, file, uid))
        return result("storage", "blocked", "unsafe_marker");
      const prior = fs.readFileSync(file, "utf8");
      const match = /^p15_3:replacement:([1-9][0-9]{0,15})\n$/.exec(prior);
      if (!match) return result("storage", "blocked", "unknown_marker");
      if (Number(match[1]) === pid)
        return result("storage", "blocked", "restart_required", {
          privateMode: true,
          atomicReplacement: true,
          restartVerified: false,
        });
      fs.unlinkSync(file);
      return result("storage", "pass", "restart_verified_and_deleted", {
        privateMode: true,
        atomicReplacement: true,
        restartVerified: true,
        deleted: true,
      });
    }
    const { randomBytes } = await deps.crypto();
    const temp = path.join(
      storageDirectory,
      `${MARKER}.${randomBytes(16).toString("hex")}.tmp`
    );
    let ownsFile = false;
    let ownsTemp = false;
    cleanup = () => {
      try {
        if (ownsTemp) fs.unlinkSync(temp);
      } finally {
        if (ownsFile) fs.unlinkSync(file);
      }
    };
    const initialFd = fs.openSync(file, "wx", 0o600);
    ownsFile = true;
    try {
      fs.writeFileSync(initialFd, `p15_3:initial:${pid}\n`);
    } finally {
      fs.closeSync(initialFd);
    }
    if (!privateFile(fs, file, uid))
      return result("storage", "blocked", "unsafe_initial_mode");
    const replacement = `p15_3:replacement:${pid}\n`;
    const replacementFd = fs.openSync(temp, "wx", 0o600);
    ownsTemp = true;
    try {
      fs.writeFileSync(replacementFd, replacement);
    } finally {
      fs.closeSync(replacementFd);
    }
    if (!privateFile(fs, temp, uid))
      return result("storage", "blocked", "unsafe_replacement_mode");
    fs.renameSync(temp, file);
    ownsTemp = false;
    if (
      !privateFile(fs, file, uid) ||
      fs.readFileSync(file, "utf8") !== replacement
    )
      return result("storage", "failed", "replacement_mismatch");
    ownsFile = false; // Deliberately retain the synthetic restart marker.
    return result("storage", "blocked", "restart_required", {
      privateMode: true,
      atomicReplacement: true,
      restartVerified: false,
    });
  } catch (error) {
    return failure("storage", error);
  } finally {
    try {
      cleanup?.();
    } catch {
      console.warn("[p15.3] storage_cleanup_failed");
    }
  }
}

/** Listen on an ephemeral IPv4 loopback port with bounded setup. */
export async function listenLoopback(server: Http.Server): Promise<number> {
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      finish();
      server.close();
      reject(Object.assign(new Error("deadline"), { code: "ETIMEDOUT" }));
    }, DEADLINE_MS);
    const onError = (err: Error) => {
      finish();
      reject(err);
    };
    function finish() {
      clearTimeout(timer);
      server.off("error", onError);
      server.off("listening", onListening);
    }
    function onListening() {
      finish();
      const address = server.address();
      if (address && typeof address !== "string") resolve(address.port);
      else reject(new Error("invalid_listener"));
    }
    server.once("error", onError);
    try {
      server.listen(0, HOST, onListening);
    } catch (error) {
      // A host permission denial can throw before emitting an error event.
      // Clear setup resources and preserve the original denial for classification.
      finish();
      if (error instanceof Error) reject(error);
      else {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? error.code
            : undefined;
        reject(Object.assign(new Error("listen_failed"), { code }));
      }
    }
  });
  return port;
}

/** Destroy active sockets and stop accepting requests, including aborted streams. */
export async function closeLoopback(server: Http.Server): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const closed = new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(Object.assign(new Error("deadline"), { code: "ETIMEDOUT" })),
        DEADLINE_MS
      );
      server.close(() => resolve());
    });
    server.closeAllConnections();
    await closed;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probeStream(
  url: string,
  deps: HostProbeDependencies,
  cancellation?: ProbeCancellation
): Promise<ProbeResult> {
  if (!deps.fetch || !deps.AbortController || !deps.TextDecoder)
    return result("native_stream", "blocked", "missing_native_globals");
  const controller = new deps.AbortController();
  let rejectDeadline: (reason: unknown) => void = () => undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const interrupt = () => {
    controller.abort();
    rejectDeadline(Object.assign(new Error("deadline"), { code: "ETIMEDOUT" }));
  };
  const timer = setTimeout(interrupt, DEADLINE_MS);
  const remove = cancellation?.onCancel(interrupt);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await Promise.race([
      deps.fetch(`${url}/stream`, {
        signal: controller.signal,
        redirect: "error",
      }),
      deadline,
    ]);
    if (
      response.status !== 200 ||
      !response.body ||
      response.headers.get("content-type") !== "text/event-stream"
    )
      return result("native_stream", "failed", "invalid_stream_response");
    reader = response.body.getReader();
    const decoder = new deps.TextDecoder();
    let text = "";
    let chunks = 0;
    while (true) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) break;
      chunks++;
      text += decoder.decode(next.value, { stream: true });
      if (text.length > 128 || chunks > 128)
        return result("native_stream", "failed", "stream_limit");
    }
    text += decoder.decode();
    return text === STREAM_FRAME
      ? result("native_stream", "pass", "synthetic_sse_completed", {
          chunks,
          bytes: text.length,
        })
      : result("native_stream", "failed", "synthetic_sse_mismatch");
  } catch (error) {
    return controller.signal.aborted
      ? result(
          "native_stream",
          "blocked",
          cancellation?.cancelled ? "cancelled" : "timeout"
        )
      : failure("native_stream", error);
  } finally {
    clearTimeout(timer);
    remove?.();
    controller.abort();
    if (reader) {
      // Initiate cancellation, but a broken native implementation must not hold
      // teardown indefinitely. Closing the loopback server also closes its socket.
      try {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      } catch {
        /* aborted read is expected */
      }
    }
  }
}

async function probeAbort(
  url: string,
  deps: HostProbeDependencies,
  cancellation?: ProbeCancellation
): Promise<ProbeResult> {
  if (!deps.fetch || !deps.AbortController)
    return result("native_abort", "blocked", "missing_native_globals");
  const controller = new deps.AbortController();
  let timedOut = false;
  let rejectDeadline: (reason: unknown) => void = () => undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const interrupt = () => {
    controller.abort();
    rejectDeadline(Object.assign(new Error("deadline"), { code: "ETIMEDOUT" }));
  };
  const timer = setTimeout(() => {
    timedOut = true;
    interrupt();
  }, DEADLINE_MS);
  const remove = cancellation?.onCancel(interrupt);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let firstChunk = false;
  try {
    const response = await Promise.race([
      deps.fetch(`${url}/abort`, {
        signal: controller.signal,
        redirect: "error",
      }),
      deadline,
    ]);
    if (response.status !== 200 || !response.body)
      return result("native_abort", "failed", "invalid_abort_response");
    reader = response.body.getReader();
    const first = await Promise.race([reader.read(), deadline]);
    firstChunk = !first.done && first.value.length > 0;
    if (!firstChunk)
      return result("native_abort", "failed", "missing_initial_chunk");
    controller.abort();
    await Promise.race([reader.read(), deadline]);
    return result("native_abort", "failed", "abort_did_not_reject");
  } catch (error) {
    if (timedOut || cancellation?.cancelled)
      return result(
        "native_abort",
        "blocked",
        timedOut ? "timeout" : "cancelled"
      );
    if (
      firstChunk &&
      controller.signal.aborted &&
      error instanceof Error &&
      error.name === "AbortError"
    )
      return result("native_abort", "pass", "aborted_stream_read");
    return failure("native_abort", error);
  } finally {
    clearTimeout(timer);
    remove?.();
    controller.abort();
    if (reader) {
      // Initiate cancellation, but a broken native implementation must not hold
      // teardown indefinitely. Closing the loopback server also closes its socket.
      try {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      } catch {
        /* aborted read is expected */
      }
    }
  }
}

async function probeBrowser(
  url: string,
  receipt: Promise<void>,
  deps: HostProbeDependencies,
  cancellation?: ProbeCancellation
): Promise<ProbeResult> {
  if (deps.platform !== "darwin")
    return result("system_browser", "blocked", "unsupported_platform");
  if (cancellation?.cancelled)
    return result("system_browser", "blocked", "cancelled");
  try {
    const { execFile } = await deps.childProcess();
    return await new Promise<ProbeResult>((resolve) => {
      let child: ChildProcess.ChildProcess | undefined;

      let done = false;
      const cleanup = { remove: () => undefined as void };
      let launched = false;
      let visited = false;
      const finish = (value: ProbeResult) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        cleanup.remove();
        if (child && !launched) {
          try {
            child.kill();
          } catch {
            /* no alternate launcher */
          }
        }
        resolve(value);
      };
      const check = () => {
        if (launched && visited)
          finish(
            result("system_browser", "pass", "fixed_loopback_page_visited")
          );
      };
      const timer = setTimeout(
        () =>
          finish(
            result("system_browser", "blocked", "browser_receipt_timeout")
          ),
        BROWSER_DEADLINE_MS
      );
      cleanup.remove =
        cancellation?.onCancel(() =>
          finish(result("system_browser", "blocked", "cancelled"))
        ) ?? cleanup.remove;
      if (done) return;
      // This is deliberately the only process invocation: no shell, operator input,
      // external destination, arguments other than the fixture's own ephemeral URL,
      // or alternate launch method on denial.
      try {
        child = execFile(
          "/usr/bin/open",
          [`${url}/browser`],
          { shell: false, timeout: BROWSER_DEADLINE_MS, maxBuffer: 4096 },
          (error) => {
            if (error) finish(failure("system_browser", error));
            else {
              launched = true;
              check();
            }
          }
        );
      } catch (error) {
        finish(failure("system_browser", error));
      }
      void receipt.then(() => {
        visited = true;
        check();
      });
    });
  } catch (error) {
    return failure("system_browser", error);
  }
}

/** Read-only capability checks plus owned, synthetic storage and loopback traffic.
 * The browser is disabled unless explicitly requested. Every result is independent
 * of the production extension and there is no external destination.
 */
export async function runHostProbes(
  options: HostProbeOptions,
  deps = nativeProbeDependencies()
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [probeNativeGlobals(deps)];
  const cancelled = () => options.cancellation?.cancelled === true;
  const builtinStatus = { http: false, fs: false, path: false, crypto: false };
  for (const name of ["http", "fs", "path", "crypto"] as const) {
    try {
      await deps[name]();
      builtinStatus[name] = true;
    } catch {
      /* fixed module availability only */
    }
  }
  const allBuiltins = Object.values(builtinStatus).every(Boolean);
  results.push(
    result(
      "node_builtins",
      allBuiltins ? "pass" : "blocked",
      allBuiltins ? "available" : "required_builtin_unavailable",
      builtinStatus
    )
  );
  try {
    const { randomBytes } = await deps.crypto();
    const first = randomBytes(32);
    const second = randomBytes(32);
    const ok =
      first.length === 32 && second.length === 32 && !first.equals(second);
    results.push(
      result(
        "randomness",
        ok ? "pass" : "failed",
        ok ? "distinct_32_byte_samples" : "invalid_random_samples"
      )
    );
  } catch (error) {
    results.push(failure("randomness", error));
  }
  if (cancelled()) results.push(result("storage", "blocked", "cancelled"));
  else results.push(await probeStorage(options.storageDirectory, deps));
  if (cancelled())
    return [
      ...results,
      ...(
        ["loopback", "native_stream", "native_abort", "system_browser"] as const
      ).map((probe) => result(probe, "blocked", "cancelled")),
    ];
  let server: Http.Server | undefined;
  let browserVisited: () => void = () => undefined;
  const receipt = new Promise<void>((resolve) => {
    browserVisited = resolve;
  });
  try {
    const { createServer } = await deps.http();
    const activeTimers = new Set<ReturnType<typeof setTimeout>>();
    server = createServer((req, res) => {
      if (req.method !== "GET") {
        res.writeHead(405).end();
        return;
      }
      if (req.url === "/stream") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
        });
        res.write(STREAM_FRAME.slice(0, 9));
        const timer = setTimeout(() => {
          activeTimers.delete(timer);
          res.end(STREAM_FRAME.slice(9));
        }, 25);
        activeTimers.add(timer);
        res.once("close", () => {
          clearTimeout(timer);
          activeTimers.delete(timer);
        });
      } else if (req.url === "/abort") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
        });
        res.write(STREAM_FRAME);
        // Intentionally never completes; caller must abort, then teardown closes it.
      } else if (req.url === "/browser" && options.includeBrowser) {
        res
          .writeHead(200, {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          })
          .end(
            "Ableton feasibility fixture: harmless loopback browser check. You may close this tab."
          );
        browserVisited();
      } else res.writeHead(404).end();
    });
    server.on("close", () => {
      for (const timer of activeTimers) clearTimeout(timer);
      activeTimers.clear();
    });
    const port = await listenLoopback(server);
    results.push(result("loopback", "pass", "ephemeral_listener_bound"));
    const url = `http://${HOST}:${port}`;
    results.push(await probeStream(url, deps, options.cancellation));
    results.push(
      cancelled()
        ? result("native_abort", "blocked", "cancelled")
        : await probeAbort(url, deps, options.cancellation)
    );
    results.push(
      options.includeBrowser
        ? await probeBrowser(url, receipt, deps, options.cancellation)
        : result("system_browser", "blocked", "operator_action_required")
    );
  } catch (error) {
    if (!results.some((r) => r.probe === "loopback"))
      results.push(failure("loopback", error));
    for (const probe of [
      "native_stream",
      "native_abort",
      "system_browser",
    ] as const) {
      if (!results.some((r) => r.probe === probe))
        results.push(result(probe, "blocked", "loopback_unavailable"));
    }
  } finally {
    if (server) {
      try {
        await closeLoopback(server);
      } catch {
        results.push(result("loopback", "failed", "cleanup_failed"));
      }
    }
  }
  return results;
}
