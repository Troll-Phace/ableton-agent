import type * as Http from "node:http";
import type { Socket } from "node:net";
import type {
  CompatibilityConstructor,
  CompatibilityConstructorResult,
  CompatibilityLane,
  CompatibilityLaneResult,
  CompatibilitySource,
  CompatibilityStage,
  CompatibilityStageResult,
  CompatibilityStatus,
  CompatibilitySupplementResult,
  CompatibilityTransportResult,
  NativeCompatibilityOptions,
  NativeCompatibilityReport,
  ProbeCancellation,
  ProbeOutcome,
} from "./contracts.js";

/** The ambient object is injectable so tests never need to change actual globals. */
export interface CompatibilityGlobals {
  TextDecoder?: typeof globalThis.TextDecoder;
  URL?: typeof globalThis.URL;
  ReadableStream?: typeof globalThis.ReadableStream;
  fetch?: typeof globalThis.fetch;
  AbortController?: typeof globalThis.AbortController;
}

/** Load only documented, permitted builtins, independently and lazily. */
export interface NativeCompatibilityDependencies {
  globals: CompatibilityGlobals;
  nodeVersion?: string;
  http: () => Promise<Pick<typeof Http, "createServer">>;
  util: () => Promise<Pick<typeof import("node:util"), "TextDecoder">>;
  url: () => Promise<Pick<typeof import("node:url"), "URL">>;
  streamWeb: () => Promise<
    Pick<typeof import("node:stream/web"), "ReadableStream">
  >;
}

/** Native Fetch and controller are never supplemented or replaced. */
export function nativeCompatibilityDependencies(): NativeCompatibilityDependencies {
  return {
    globals: globalThis,
    nodeVersion:
      typeof process === "object" ? process.versions?.node : undefined,
    http: () => import("node:http"),
    util: () => import("node:util"),
    url: () => import("node:url"),
    streamWeb: () => import("node:stream/web"),
  };
}

const NAMES = ["TextDecoder", "URL", "ReadableStream"] as const;
const HOST = "127.0.0.1";
const TIME_LIMIT = 5000;
const BYTE_LIMIT = 128;
const CHUNK_LIMIT = 128;
const PREFIX = 'data: {"marker":"p15_3","text":"';
const SUFFIX = '"}\n\n';
const EXPECTED_TEXT = `${PREFIX}€${SUFFIX}`;
function ascii(value: string): number[] {
  return Array.from(value, (char) => char.charCodeAt(0));
}
const FIRST = new Uint8Array([...ascii(PREFIX), 0xe2]);
const LAST = new Uint8Array([0x82, 0xac, ...ascii(SUFFIX)]);
const EXPECTED_BYTES = [...FIRST, ...LAST];
const ABORT_BYTES = new Uint8Array(ascii("data: p15_3\n\n"));
const ACTIVE = new WeakSet<CompatibilityGlobals>();
const TAINTED = new WeakSet<CompatibilityGlobals>();

function status(outcome: ProbeOutcome, code: string): CompatibilityStatus {
  return { outcome, code };
}
function getField(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    return Reflect.get(value, name);
  } catch {
    return undefined;
  }
}
/** Structural error classification also accepts exceptions from another realm. */
export function classifyCompatibilityError(
  error: unknown
): CompatibilityStatus {
  if (error instanceof ProbeStop) return status(error.outcome, error.code);
  if (
    getField(error, "name") === "AbortError" ||
    getField(error, "code") === "ABORT_ERR"
  )
    return status("failed", "abort_error");
  switch (getField(error, "code")) {
    case "ERR_ACCESS_DENIED":
    case "EACCES":
    case "EPERM":
      return status("blocked", "permission_denied");
    case "ERR_UNKNOWN_BUILTIN_MODULE":
    case "MODULE_NOT_FOUND":
      return status("blocked", "module_unavailable");
    case "ETIMEDOUT":
      return status("blocked", "timeout");
    case "EADDRINUSE":
      return status("failed", "address_in_use");
    default:
      return status("failed", "operation_failed");
  }
}
class ProbeStop extends Error {
  constructor(
    readonly outcome: ProbeOutcome,
    readonly code: string
  ) {
    super(code);
  }
}
function stop(outcome: ProbeOutcome, code: string): never {
  throw new ProbeStop(outcome, code);
}

/** One cancellable deadline for each operation, independent of native AbortSignal. */
class Deadline {
  private timer: ReturnType<typeof setTimeout>;
  private remove?: () => void;
  private interruption?: ProbeStop;
  private signal: Promise<never>;
  constructor(cancellation?: ProbeCancellation) {
    let rejectSignal: (reason: Error) => void = () => undefined;
    this.signal = new Promise<never>((_resolve, reject) => {
      rejectSignal = reject;
    });
    // Cancellation can happen synchronously, before the first operation attaches.
    void this.signal.catch(() => undefined);
    const interrupt = (code: string) => {
      if (this.interruption) return;
      this.interruption = new ProbeStop("blocked", code);
      rejectSignal(this.interruption);
    };
    this.timer = setTimeout(() => interrupt("timeout"), TIME_LIMIT);
    this.remove = cancellation?.onCancel(() => interrupt("cancelled"));
  }
  check(): void {
    if (this.interruption) throw this.interruption;
  }
  async wait<T>(task: PromiseLike<T>): Promise<T> {
    return await Promise.race([task, this.signal]);
  }
  close(): void {
    clearTimeout(this.timer);
    this.remove?.();
  }
}

/** Constructors may be native, privately loaded, or unavailable independently. */
interface Constructors {
  TextDecoder?: typeof globalThis.TextDecoder;
  URL?: typeof globalThis.URL;
  ReadableStream?: typeof globalThis.ReadableStream;
}
interface ConstructorCandidates {
  values: Constructors;
  evidence: CompatibilityConstructorResult[];
}

async function functionalConstructor(
  name: CompatibilityConstructor,
  values: Constructors,
  deadline: Deadline
): Promise<void> {
  switch (name) {
    case "TextDecoder": {
      const Ctor = values.TextDecoder;
      if (!Ctor) stop("blocked", "constructor_unavailable");
      const decoder = new Ctor("utf-8", { fatal: true });
      const part = decoder.decode(new Uint8Array([0xe2]), { stream: true });
      const tail = decoder.decode(new Uint8Array([0x82, 0xac]), {
        stream: true,
      });
      if (part !== "" || tail + decoder.decode() !== "€")
        stop("failed", "constructor_mismatch");
      break;
    }
    case "URL": {
      const Ctor = values.URL;
      if (!Ctor) stop("blocked", "constructor_unavailable");
      const url = new Ctor("http://127.0.0.1:12345/fixture?check=1");
      if (
        url.protocol !== "http:" ||
        url.hostname !== HOST ||
        url.port !== "12345" ||
        url.pathname !== "/fixture" ||
        url.search !== "?check=1"
      )
        stop("failed", "constructor_mismatch");
      break;
    }
    case "ReadableStream": {
      const Ctor = values.ReadableStream;
      if (!Ctor) stop("blocked", "constructor_unavailable");
      let cancelled = false;
      const stream = new Ctor<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([37]));
        },
        cancel() {
          cancelled = true;
        },
      });
      const reader = stream.getReader();
      let cancelIssued = false;
      try {
        const read = await deadline.wait(reader.read());
        if (read.done || read.value.length !== 1 || read.value[0] !== 37)
          stop("failed", "constructor_mismatch");
        cancelIssued = true;
        await deadline.wait(reader.cancel());
        if (!cancelled) stop("failed", "constructor_mismatch");
      } finally {
        // Release even if a broken implementation ignores cancellation.
        try {
          if (!cancelIssued) void reader.cancel().catch(() => undefined);
        } finally {
          reader.releaseLock();
        }
      }
      break;
    }
  }
}

async function getConstructors(
  deps: NativeCompatibilityDependencies,
  cancellation?: ProbeCancellation
): Promise<ConstructorCandidates> {
  const values: Constructors = {};
  const evidence: CompatibilityConstructorResult[] = [];
  for (const name of NAMES) {
    if (cancellation?.cancelled) break;
    const deadline = new Deadline(cancellation);
    let source: CompatibilitySource = "unavailable";
    try {
      deadline.check();
      // A defined, malformed native value is evidence, not authority to overwrite it.
      switch (name) {
        case "TextDecoder": {
          const native = deps.globals.TextDecoder;
          if (native !== undefined) {
            source = "native";
            values.TextDecoder = native;
          } else {
            values.TextDecoder = (await deadline.wait(deps.util())).TextDecoder;
            if (typeof values.TextDecoder === "function")
              source = "node_builtin";
          }
          break;
        }
        case "URL": {
          const native = deps.globals.URL;
          if (native !== undefined) {
            source = "native";
            values.URL = native;
          } else {
            values.URL = (await deadline.wait(deps.url())).URL;
            if (typeof values.URL === "function") source = "node_builtin";
          }
          break;
        }
        case "ReadableStream": {
          const native = deps.globals.ReadableStream;
          if (native !== undefined) {
            source = "native";
            values.ReadableStream = native;
          } else {
            values.ReadableStream = (
              await deadline.wait(deps.streamWeb())
            ).ReadableStream;
            if (typeof values.ReadableStream === "function")
              source = "node_builtin";
          }
          break;
        }
      }
      if (typeof values[name] !== "function")
        stop("blocked", "constructor_unavailable");
      await functionalConstructor(name, values, deadline);
      evidence.push({
        constructor: name,
        source,
        ...status("pass", "constructor_functional"),
      });
    } catch (error) {
      evidence.push({
        constructor: name,
        source,
        ...classifyCompatibilityError(error),
      });
      delete values[name];
    } finally {
      deadline.close();
    }
  }
  return { values, evidence };
}

interface Supplementation {
  evidence: CompatibilitySupplementResult[];
  restore(): boolean;
}
function equalDescriptor(
  left: PropertyDescriptor | undefined,
  right: PropertyDescriptor | undefined
): boolean {
  if (!left || !right) return left === right;
  return (
    left.configurable === right.configurable &&
    left.enumerable === right.enumerable &&
    left.writable === right.writable &&
    left.value === right.value &&
    left.get === right.get &&
    left.set === right.set &&
    "value" in left === "value" in right
  );
}
function supplement(
  globals: CompatibilityGlobals,
  values: Constructors
): Supplementation {
  const evidence: CompatibilitySupplementResult[] = [];
  const originals = NAMES.map((name) => ({
    name,
    descriptor: Object.getOwnPropertyDescriptor(globals, name),
  }));
  const altered = new Set<CompatibilityConstructor>();
  for (const { name, descriptor } of originals) {
    let installed = false;
    let row: CompatibilityStatus;
    try {
      if (globals[name] !== undefined) row = status("pass", "native_preserved");
      else if (typeof values[name] !== "function")
        row = status("blocked", "constructor_unavailable");
      else {
        // A missing global may be an own undefined data property, an accessor,
        // or absent/inherited. Respect nonconfigurable/unwritable descriptors.
        altered.add(name);
        if (descriptor && !descriptor.configurable)
          Object.defineProperty(globals, name, { value: values[name] });
        else
          Object.defineProperty(globals, name, {
            value: values[name],
            configurable: true,
            writable: true,
            enumerable: descriptor?.enumerable ?? false,
          });
        installed = globals[name] === values[name];
        row = installed
          ? status("pass", "temporarily_supplemented")
          : status("blocked", "supplement_unavailable");
      }
    } catch {
      row = status("blocked", "supplement_unavailable");
    }
    evidence.push({ constructor: name, installed, ...row });
  }
  return {
    evidence,
    restore() {
      let restored = true;
      for (const { name, descriptor } of originals.reverse()) {
        try {
          if (
            altered.has(name) &&
            !equalDescriptor(
              Object.getOwnPropertyDescriptor(globals, name),
              descriptor
            )
          ) {
            if (descriptor) Object.defineProperty(globals, name, descriptor);
            else if (!Reflect.deleteProperty(globals, name)) restored = false;
          }
          if (
            !equalDescriptor(
              Object.getOwnPropertyDescriptor(globals, name),
              descriptor
            )
          )
            restored = false;
        } catch {
          restored = false;
        }
      }
      return restored;
    },
  };
}

async function listen(
  server: Http.Server,
  deadline: Deadline
): Promise<number> {
  let onListening: () => void = () => undefined;
  let onError: (error: Error) => void = () => undefined;
  try {
    deadline.check();
    const binding = new Promise<number>((resolve, reject) => {
      onListening = () => {
        const address = server.address();
        if (
          address &&
          typeof address !== "string" &&
          address.address === HOST &&
          address.port > 0
        )
          resolve(address.port);
        else reject(new ProbeStop("failed", "invalid_listener"));
      };
      onError = reject;
      server.once("error", onError);
      server.listen(0, HOST, onListening);
    });
    return await deadline.wait(binding);
  } finally {
    server.off("error", onError);
    server.off("listening", onListening);
  }
}

type Kind = "stream" | "abort";
type NativeReader = ReadableStreamDefaultReader<Uint8Array>;
interface TransportResources {
  server?: Http.Server;
  sockets: Set<Socket>;
  response?: Http.ServerResponse;
  onResponseClose?: () => void;
  onSocket?: (socket: Socket) => void;
  onServerError?: (error: Error) => void;
  controller?: AbortController;
  body?: ReadableStream<Uint8Array>;
  reader?: NativeReader;
}
async function cleanupTransport(
  resources: TransportResources
): Promise<boolean> {
  const deadline = new Deadline();
  let ok = true;
  const pending: Promise<unknown>[] = [];
  try {
    if (resources.controller) {
      try {
        if (!resources.controller.signal.aborted) resources.controller.abort();
      } catch {
        ok = false;
      }
    }
    if (resources.reader) {
      try {
        pending.push(
          Promise.resolve(resources.reader.cancel()).catch((error: unknown) => {
            if (classifyCompatibilityError(error).code !== "abort_error")
              ok = false;
          })
        );
      } catch (error) {
        if (classifyCompatibilityError(error).code !== "abort_error")
          ok = false;
      }
      try {
        resources.reader.releaseLock();
      } catch {
        ok = false;
      }
    } else if (resources.body && typeof resources.body.cancel === "function") {
      try {
        pending.push(
          Promise.resolve(resources.body.cancel()).catch((error: unknown) => {
            if (classifyCompatibilityError(error).code !== "abort_error")
              ok = false;
          })
        );
      } catch (error) {
        if (classifyCompatibilityError(error).code !== "abort_error")
          ok = false;
      }
    }
    if (resources.server) {
      const server = resources.server;
      const close = new Promise<void>((resolve) => {
        try {
          server.close((error?: Error) => {
            if (error && getField(error, "code") !== "ERR_SERVER_NOT_RUNNING")
              ok = false;
            resolve();
          });
        } catch (error) {
          if (getField(error, "code") !== "ERR_SERVER_NOT_RUNNING") ok = false;
          resolve();
        }
      });
      pending.push(close);
      try {
        server.closeAllConnections();
      } catch {
        ok = false;
      }
      for (const socket of resources.sockets) {
        try {
          socket.destroy();
        } catch {
          ok = false;
        }
      }
    }
    try {
      await deadline.wait(Promise.all(pending));
    } catch {
      ok = false;
    }
    if (resources.server?.listening) ok = false;
  } finally {
    try {
      if (resources.response && resources.onResponseClose)
        resources.response.off("close", resources.onResponseClose);
    } catch {
      ok = false;
    }
    try {
      if (resources.server && resources.onSocket)
        resources.server.off("connection", resources.onSocket);
    } catch {
      ok = false;
    }
    try {
      if (resources.server && resources.onServerError)
        resources.server.off("error", resources.onServerError);
    } catch {
      ok = false;
    }
    resources.sockets.clear();
    deadline.close();
  }
  return ok;
}

function cancelledTransport(): CompatibilityTransportResult {
  return { ...status("blocked", "cancelled"), stages: [], measurements: {} };
}
function unavailableTransport(code: string): CompatibilityTransportResult {
  return { ...status("blocked", code), stages: [], measurements: {} };
}

async function probeTransport(
  kind: Kind,
  deps: NativeCompatibilityDependencies,
  decoderCtor: Constructors["TextDecoder"],
  nativeFetch: CompatibilityGlobals["fetch"],
  NativeController: CompatibilityGlobals["AbortController"],
  cancellation?: ProbeCancellation
): Promise<CompatibilityTransportResult> {
  if (cancellation?.cancelled) return cancelledTransport();
  const stages: CompatibilityStageResult[] = [];
  const measurements: Record<string, boolean | number> = {
    chunks: 0,
    bytes: 0,
    preEofRead: false,
    pendingRead: false,
    abortRequested: false,
    serverClosedBeforeTeardown: false,
    cleanup: false,
  };
  let stage: CompatibilityStage = "listen";
  const mark = (code: string) =>
    stages.push({ stage, ...status("pass", code) });
  const deadline = new Deadline(cancellation);
  const resources: TransportResources = { sockets: new Set() };
  let result: CompatibilityStatus = status("failed", "operation_failed");
  let serverSeen = false;
  let serverClosed = false;
  let serverClosedAfterAbort = false;
  let abortRequested = false;
  let resolveClose: () => void = () => undefined;
  const receipt = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  let serverError: unknown;
  let cleanupStarted = false;
  const path = kind === "stream" ? "/compat-stream" : "/compat-abort";
  try {
    deadline.check();
    if (typeof nativeFetch !== "function") {
      stage = "fetch_started";
      stop("blocked", "fetch_unavailable");
    }
    if (typeof NativeController !== "function") {
      stage = "fetch_started";
      stop("blocked", "abort_controller_unavailable");
    }
    const { createServer } = await deadline.wait(deps.http());
    deadline.check();
    const server = createServer((req, res) => {
      if (req.method !== "GET" || req.url !== path || serverSeen) {
        res.writeHead(404).end();
        return;
      }
      serverSeen = true;
      resources.response = res;
      resources.onResponseClose = () => {
        serverClosed = true;
        serverClosedAfterAbort = abortRequested && !res.writableEnded;
        resolveClose();
      };
      res.once("close", resources.onResponseClose);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
      });
      res.write(kind === "stream" ? FIRST : ABORT_BYTES);
      // No EOF before the client proves it has read the first bytes. Abort stays
      // open until the original native controller actually cancels the read.
    });
    resources.server = server;
    resources.onSocket = (socket) => {
      resources.sockets.add(socket);
    };
    resources.onServerError = (error) => {
      serverError = error;
    };
    server.on("connection", resources.onSocket);
    server.on("error", resources.onServerError);
    const port = await listen(server, deadline);
    mark("listener_bound");
    stage = "fetch_started";
    deadline.check();
    const controller = new NativeController();
    resources.controller = controller;
    const fetchPromise = nativeFetch.call(
      deps.globals,
      `http://${HOST}:${port}${path}`,
      { signal: controller.signal, redirect: "error" }
    );
    // If an implementation ignores abort and only returns after the deadline,
    // cancel its eventual body without keeping the experiment alive.
    void fetchPromise
      .then(
        (response) => {
          if (
            cleanupStarted &&
            response?.body &&
            typeof response.body.cancel === "function"
          ) {
            try {
              void Promise.resolve(response.body.cancel()).catch(
                () => undefined
              );
            } catch {
              /* classified by the operation deadline */
            }
          }
        },
        () => undefined
      )
      .catch(() => undefined);
    const response = await deadline.wait(fetchPromise);
    mark("fetch_returned");
    stage = "headers_received";
    resources.body = response?.body ?? undefined;
    if (
      !response ||
      response.status !== 200 ||
      typeof response.headers?.get !== "function" ||
      response.headers.get("content-type") !== "text/event-stream"
    )
      stop("failed", "invalid_response");
    mark("sse_headers");
    stage = "reader_acquired";
    if (!resources.body || typeof resources.body.getReader !== "function")
      stop("blocked", "body_unavailable");
    const reader = resources.body.getReader();
    resources.reader = reader;
    if (
      !reader ||
      typeof reader.read !== "function" ||
      typeof reader.cancel !== "function" ||
      typeof reader.releaseLock !== "function"
    )
      stop("blocked", "reader_unavailable");
    mark("reader_acquired");
    stage = "first_chunk";
    const received: number[] = [];
    let chunks = 0;
    let decoder:
      | InstanceType<NonNullable<Constructors["TextDecoder"]>>
      | undefined;
    let decoded = "";
    if (kind === "stream" && decoderCtor) {
      try {
        decoder = new decoderCtor("utf-8", { fatal: true });
      } catch {
        /* independent transport remains observable */
      }
    }
    const accumulate = (bytes: Uint8Array) => {
      if (!ArrayBuffer.isView(bytes) || typeof bytes.length !== "number")
        stop("failed", "invalid_chunk");
      chunks++;
      measurements.chunks = Math.min(chunks, CHUNK_LIMIT + 1);
      measurements.bytes = Math.min(
        received.length + bytes.length,
        BYTE_LIMIT + 1
      );
      if (received.length + bytes.length > BYTE_LIMIT || chunks > CHUNK_LIMIT)
        stop("failed", "stream_limit");
      received.push(...bytes);
      if (decoder) decoded += decoder.decode(bytes, { stream: true });
    };
    let first = await deadline.wait(reader.read());
    while (!first.done && first.value.length === 0) {
      accumulate(first.value);
      first = await deadline.wait(reader.read());
    }
    if (first.done) stop("failed", "premature_eof");
    accumulate(first.value);
    const responseOpen = () =>
      serverSeen &&
      !serverClosed &&
      resources.response !== undefined &&
      !resources.response.writableEnded;
    const initial = kind === "stream" ? FIRST : ABORT_BYTES;
    if (
      !responseOpen() ||
      received.length > initial.length ||
      received.some((byte, i) => byte !== initial[i])
    )
      stop("failed", "pre_eof_handshake_failed");
    measurements.preEofRead = true;
    mark("read_before_eof");
    if (kind === "stream") {
      stage = "read_settled";
      resources.response?.end(LAST);
      while (true) {
        const next = await deadline.wait(reader.read());
        if (next.done) break;
        accumulate(next.value);
      }
      if (
        received.length !== EXPECTED_BYTES.length ||
        received.some((byte, i) => byte !== EXPECTED_BYTES[i])
      )
        stop("failed", "payload_mismatch");
      if (!decoder) stop("blocked", "text_decoder_unavailable");
      decoded += decoder.decode();
      if (decoded !== EXPECTED_TEXT) stop("failed", "decode_mismatch");
      mark("fixed_sse_completed");
      result = status("pass", "synthetic_sse_completed");
    } else {
      stage = "pending_read";
      // Drain exactly the initial fixed frame if fragmented; the server emits no
      // more bytes. The next read must be outstanding before requesting abort.
      while (received.length < ABORT_BYTES.length) {
        const next = await deadline.wait(reader.read());
        if (next.done) stop("failed", "premature_eof");
        accumulate(next.value);
        if (
          received.length > ABORT_BYTES.length ||
          received.some((byte, i) => byte !== ABORT_BYTES[i])
        )
          stop("failed", "payload_mismatch");
      }
      let settled = false;
      const pending = reader.read().then(
        (value) => {
          settled = true;
          return { ok: true as const, value };
        },
        (error: unknown) => {
          settled = true;
          return { ok: false as const, error };
        }
      );
      let turnTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await deadline.wait(
          new Promise<void>((resolve) => {
            turnTimer = setTimeout(resolve, 0);
          })
        );
      } finally {
        if (turnTimer) clearTimeout(turnTimer);
      }
      if (settled || !responseOpen()) stop("failed", "read_not_pending");
      measurements.pendingRead = true;
      mark("read_pending");
      stage = "abort_requested";
      deadline.check();
      abortRequested = true;
      controller.abort();
      if (!controller.signal.aborted) stop("failed", "abort_signal_not_set");
      measurements.abortRequested = true;
      mark("native_abort_requested");
      stage = "read_settled";
      const settledRead = await deadline.wait(pending);
      deadline.check();
      if (settledRead.ok) stop("failed", "abort_did_not_reject");
      const error = classifyCompatibilityError(settledRead.error);
      if (error.code !== "abort_error") stop(error.outcome, error.code);
      mark("pending_read_rejected_abort");
      stage = "server_closed";
      await deadline.wait(receipt);
      if (!serverClosedAfterAbort)
        stop("failed", "response_not_closed_by_abort");
      measurements.serverClosedBeforeTeardown = true;
      mark("response_closed_before_teardown");
      result = status("pass", "pending_read_aborted_and_closed");
    }
    if (serverError !== undefined) {
      const failure = classifyCompatibilityError(serverError);
      stop(failure.outcome, failure.code);
    }
    deadline.check();
  } catch (error) {
    result = cancellation?.cancelled
      ? status("blocked", "cancelled")
      : classifyCompatibilityError(error);
    stages.push({ stage, ...result });
  } finally {
    deadline.close();
    cleanupStarted = true;
    measurements.cleanup = await cleanupTransport(resources);
    stages.push({
      stage: "cleanup",
      ...status(
        measurements.cleanup ? "pass" : "blocked",
        measurements.cleanup ? "resources_closed" : "cleanup_failed"
      ),
    });
    if (!measurements.cleanup) result = status("blocked", "cleanup_failed");
    else if (cancellation?.cancelled) result = status("blocked", "cancelled");
  }
  return { ...result, stages, measurements };
}

async function runLane(
  lane: CompatibilityLane,
  deps: NativeCompatibilityDependencies,
  values: Constructors,
  nativeFetch: CompatibilityGlobals["fetch"],
  nativeController: CompatibilityGlobals["AbortController"],
  cancellation?: ProbeCancellation
): Promise<CompatibilityLaneResult> {
  let supplementation: Supplementation | undefined;
  let stream = unavailableTransport("not_run");
  let abort = unavailableTransport("not_run");
  let restored = true;
  try {
    if (lane === "supplemented" && !cancellation?.cancelled)
      supplementation = supplement(deps.globals, values);
    stream = await probeTransport(
      "stream",
      deps,
      values.TextDecoder,
      nativeFetch,
      nativeController,
      cancellation
    );
    abort =
      stream.code === "cleanup_failed"
        ? unavailableTransport("previous_cleanup_failed")
        : await probeTransport(
            "abort",
            deps,
            undefined,
            nativeFetch,
            nativeController,
            cancellation
          );
  } finally {
    if (supplementation) restored = supplementation.restore();
  }
  const passed = stream.outcome === "pass" && abort.outcome === "pass";
  const outcome =
    !restored || cancellation?.cancelled
      ? "blocked"
      : passed
        ? "pass"
        : stream.outcome === "failed" || abort.outcome === "failed"
          ? "failed"
          : "blocked";
  const code = !restored
    ? "restoration_failed"
    : cancellation?.cancelled
      ? "cancelled"
      : passed
        ? "transport_verified"
        : "transport_unproven";
  return {
    lane,
    supplementation: supplementation?.evidence ?? [],
    stream,
    abort,
    restored,
    ...status(outcome, code),
  };
}

/** Execute local-first compatibility lanes, conditionally supplementing exactly
 * the three missing constructors. No provider, storage, browser or SDK access.
 */
export async function runNativeCompatibility(
  options: NativeCompatibilityOptions = {},
  deps = nativeCompatibilityDependencies()
): Promise<NativeCompatibilityReport> {
  const { cancellation } = options;
  const globals = deps.globals;
  const raw = {
    TextDecoder: typeof globals.TextDecoder === "function",
    URL: typeof globals.URL === "function",
    ReadableStream: typeof globals.ReadableStream === "function",
    fetch: typeof globals.fetch === "function",
    AbortController: typeof globals.AbortController === "function",
  };
  const report = (
    outcome: ProbeOutcome,
    code: string,
    constructors: CompatibilityConstructorResult[] = [],
    lanes: CompatibilityLaneResult[] = [],
    restored = true
  ): NativeCompatibilityReport => ({
    raw,
    nodeVersion:
      (deps.nodeVersion?.length ?? 0) <= 32 &&
      /^\d+\.\d+\.\d+$/.test(deps.nodeVersion ?? "")
        ? (deps.nodeVersion ?? "unknown")
        : "unknown",
    constructors,
    lanes,
    restored,
    ...status(outcome, code),
  });
  if (cancellation?.cancelled) return report("blocked", "cancelled");
  if (TAINTED.has(globals))
    return report("blocked", "restart_required", [], [], false);
  if (ACTIVE.has(globals)) return report("blocked", "already_running");
  ACTIVE.add(globals);
  try {
    const nativeFetch = globals.fetch;
    const nativeController = globals.AbortController;
    const { values, evidence } = await getConstructors(deps, cancellation);
    if (cancellation?.cancelled)
      return report("blocked", "cancelled", evidence);
    const local = await runLane(
      "local",
      deps,
      values,
      nativeFetch,
      nativeController,
      cancellation
    );
    const lanes = [local];
    // Never supplement after local success, cleanup failure or cancellation.
    // Only a genuinely undefined constructor with a functional documented
    // builtin is eligible; there is no fallback primitive or overwrite.
    const eligible = NAMES.some(
      (name) =>
        globals[name] === undefined && typeof values[name] === "function"
    );
    const denied = [local.stream, local.abort].some((transport) =>
      transport.stages.some((row) => row.code === "permission_denied")
    );
    if (
      local.outcome !== "pass" &&
      eligible &&
      typeof nativeFetch === "function" &&
      typeof nativeController === "function" &&
      !denied &&
      !cancellation?.cancelled &&
      local.stream.code !== "cleanup_failed" &&
      local.abort.code !== "cleanup_failed"
    ) {
      const supplemented = await runLane(
        "supplemented",
        deps,
        values,
        nativeFetch,
        nativeController,
        cancellation
      );
      lanes.push(supplemented);
      if (!supplemented.restored) TAINTED.add(globals);
    }
    if (TAINTED.has(globals))
      return report("blocked", "restoration_failed", evidence, lanes, false);
    if (cancellation?.cancelled)
      return report("blocked", "cancelled", evidence, lanes);
    if (lanes.some((lane) => lane.outcome === "pass"))
      return report("pass", "transport_verified", evidence, lanes);
    return report(
      lanes.some((lane) => lane.outcome === "failed") ? "failed" : "blocked",
      "transport_unproven",
      evidence,
      lanes
    );
  } finally {
    ACTIVE.delete(globals);
  }
}
