import * as http from "node:http";
import type { Socket } from "node:net";
import { TextDecoder } from "node:util";
import { URL } from "node:url";
import { ReadableStream } from "node:stream/web";

import { vi } from "vitest";

import type { ProbeCancellation } from "../../src/extension/feasibility/contracts.js";
import type {
  CompatibilityGlobals,
  NativeCompatibilityDependencies,
} from "../../src/extension/feasibility/native-compatibility.js";

export const DETAIL = "synthetic-private-detail";
export const NAMES = ["TextDecoder", "URL", "ReadableStream"] as const;
export const WEB_NAMES = [
  ...NAMES,
  "fetch",
  "AbortController",
  "AbortSignal",
  "Headers",
  "Request",
  "Response",
] as const;
export type NativeReader = ReadableStreamDefaultReader<Uint8Array>;
export type ReadResult = Awaited<ReturnType<NativeReader["read"]>>;
export type FetchHook = (
  input: string,
  init: Parameters<typeof fetch>[1],
  next: (options?: { ignoreAbort?: boolean }) => Promise<Response>
) => Promise<Response>;

export function errorCode(code: string) {
  return Object.assign(new Error(DETAIL), { code });
}

export function descriptors(object: object) {
  return WEB_NAMES.map((name) => [
    name,
    Object.getOwnPropertyDescriptor(object, name),
  ]);
}

/** Tracks actual active listeners including synchronous cancellation. */
export function trackedCancellation(): ProbeCancellation & {
  cancel(): void;
  active: Set<() => void>;
} {
  let cancelled = false;
  const active = new Set<() => void>();
  return {
    get cancelled() {
      return cancelled;
    },
    onCancel(listener) {
      if (cancelled) listener();
      else active.add(listener);
      return () => {
        active.delete(listener);
      };
    },
    cancel() {
      cancelled = true;
      for (const listener of active) listener();
      active.clear();
    },
    active,
  };
}

export interface NativeObservation {
  path: string;
  response: Response;
  body: ReadableStream<Uint8Array> | null;
  reads: { open: boolean; bytes: number; done: boolean }[];
  cancel: ReturnType<typeof vi.fn<NativeReader["cancel"]>>;
  release: ReturnType<typeof vi.fn<NativeReader["releaseLock"]>>;
}

/** Tracks read/reader lifecycle without changing the native transport or body. */
export function observeResponse(
  response: Response,
  path: string,
  serverResponse: () => http.ServerResponse | undefined,
  observations: NativeObservation[],
  readHook?: (reader: NativeReader, index: number) => Promise<ReadResult>,
  releaseHook?: () => void
): Response {
  const body = response.body;
  if (!body) throw new Error("Expected synthetic response body");
  const reader = body.getReader();
  let index = 0;
  const reads: NativeObservation["reads"] = [];
  const cancel = vi.fn<NativeReader["cancel"]>(
    async () => await reader.cancel()
  );
  const release = vi.fn<NativeReader["releaseLock"]>(() => {
    reader.releaseLock();
    releaseHook?.();
  });
  const read = vi.fn<NativeReader["read"]>(async () => {
    const result = await (readHook ? readHook(reader, index++) : reader.read());
    const value: unknown = result.value;
    reads.push({
      open: serverResponse()?.writableEnded === false,
      done: result.done,
      bytes: value instanceof Uint8Array ? value.length : 0,
    });
    return result;
  });
  observations.push({ path, response, body, reads, cancel, release });
  return {
    status: response.status,
    headers: response.headers,
    body: { getReader: () => ({ read, cancel, releaseLock: release }) },
  } as unknown as Response;
}

/** Real network is restricted to the current fixture's ephemeral IPv4 listener
 * and fixed paths. No actual global changes and no external network calls. */
export function makeCompatibilityFixture(
  options: {
    missing?: (typeof NAMES)[number][];
    hook?: FetchHook;
    observe?: boolean;
  } = {}
) {
  const servers: http.Server[] = [];
  const sockets: Socket[] = [];
  const responses: http.ServerResponse[] = [];
  const observations: NativeObservation[] = [];
  const requests: string[] = [];
  const signals: AbortSignal[] = [];
  const baselineListeners: ReturnType<typeof listenerSnapshot>[] = [];
  const nativeFetch = globalThis.fetch;
  const createServer = vi.fn((listener: http.RequestListener) => {
    const server = http.createServer((req, res) => {
      responses.push(res);
      requests.push(req.url ?? "");
      listener(req, res);
    });
    server.on("connection", (socket) => sockets.push(socket));
    baselineListeners.push(listenerSnapshot(server));
    servers.push(server);
    return server;
  });
  const guardedFetch = vi.fn<typeof fetch>(async (input, init) => {
    if (typeof input !== "string")
      throw new Error("Expected fixed fixture URL");
    const url = new URL(input);
    const bound = servers.at(-1)?.address();
    if (
      !bound ||
      typeof bound === "string" ||
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.port !== String(bound.port) ||
      bound.address !== "127.0.0.1" ||
      !["/compat-stream", "/compat-abort"].includes(url.pathname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      init?.redirect !== "error" ||
      !init.signal
    ) {
      throw new Error("Unexpected fixture destination");
    }
    signals.push(init.signal);
    const next = async (overrides?: { ignoreAbort?: boolean }) => {
      const response = await nativeFetch(input, {
        ...init,
        signal: overrides?.ignoreAbort ? undefined : init.signal,
        redirect: "error",
      });
      return options.observe
        ? observeResponse(
            response,
            url.pathname,
            () => responses.at(-1),
            observations
          )
        : response;
    };
    return await (options.hook ? options.hook(input, init, next) : next());
  });
  const globals: CompatibilityGlobals = {
    TextDecoder,
    URL,
    ReadableStream,
    fetch: guardedFetch,
    AbortController: globalThis.AbortController,
  };
  for (const name of options.missing ?? []) delete globals[name];
  const deps: NativeCompatibilityDependencies = {
    globals,
    nodeVersion: "24.16.0",
    http: vi.fn(() =>
      Promise.resolve({
        createServer: createServer as unknown as typeof http.createServer,
      })
    ),
    util: vi.fn(() => Promise.resolve({ TextDecoder })),
    url: vi.fn(() => Promise.resolve({ URL })),
    streamWeb: vi.fn(() => Promise.resolve({ ReadableStream })),
  };
  return {
    deps,
    globals,
    guardedFetch,
    createServer,
    servers,
    sockets,
    responses,
    observations,
    requests,
    signals,
    baselineListeners,
  };
}

/** Compare source-owned listeners against the HTTP server's original listeners. */
export function listenerSnapshot(server: http.Server) {
  return ["error", "listening", "connection"].map((event) =>
    server.listeners(event)
  );
}

export function stageErrorResponse(
  kind: "headers" | "body" | "reader" | "eof" | "read" | "limit" | "handshake"
): Response {
  const headers = { get: () => "text/event-stream" };
  if (kind === "headers") return new Response("synthetic", { status: 503 });
  if (kind === "body")
    return { status: 200, headers, body: null } as unknown as Response;
  if (kind === "reader")
    return {
      status: 200,
      headers,
      body: { cancel: async () => {} },
    } as unknown as Response;
  const read = (): Promise<ReadResult> => {
    switch (kind) {
      case "eof":
        return Promise.resolve({ done: true, value: undefined });
      case "read":
        return Promise.reject(errorCode("EACCES"));
      case "limit":
        return Promise.resolve({ done: false, value: new Uint8Array(129) });
      default:
        return Promise.resolve({ done: false, value: new Uint8Array([100]) });
    }
  };
  return {
    status: 200,
    headers,
    body: {
      getReader: () => ({ read, cancel: async () => {}, releaseLock() {} }),
    },
  } as unknown as Response;
}
