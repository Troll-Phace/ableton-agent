import * as http from "node:http";
import type { Socket } from "node:net";

import { SigninDeadline } from "../extension/feasibility/official-http.js";
import {
  errorCode,
  systemSigninClock,
  type SigninClock,
} from "../extension/feasibility/signin-contracts.js";
import {
  createCompanionRuntime,
  type CompanionRuntime,
  type CompanionRuntimeShutdown,
} from "./runtime.js";

import {
  CompanionStorageFault,
  type CompanionStorageIssue,
} from "./storage.js";

export const COMPANION_CONTROL_HOST = "127.0.0.1";
export const COMPANION_CONTROL_PORT = 17863;
export const COMPANION_CONTROL_ORIGIN = "http://127.0.0.1:17863";
export const COMPANION_IDLE_MS = 15 * 60 * 1000;
const CLEANUP_MS = 5000;

export type CompanionStartupCode =
  | "interactive_required"
  | "port_occupied"
  | "permission_denied"
  | "listener_unavailable"
  | "storage_blocked"
  | "startup_failed";
export class CompanionStartupFault extends Error {
  constructor(
    readonly code: CompanionStartupCode,
    readonly storageIssue?: CompanionStorageIssue
  ) {
    super(code);
    this.name = "CompanionStartupFault";
  }
}

export interface SingletonDependencies {
  http: Pick<typeof http, "createServer">;
  clock: SigninClock;
}
export interface CompanionSingleton {
  readonly origin: typeof COMPANION_CONTROL_ORIGIN;
  setHandler(handler: http.RequestListener): void;
  onFailure(handler: () => void): void;
  close(): Promise<boolean>;
}
function bindCode(error: unknown): CompanionStartupCode {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EADDRINUSE"
  )
    return "port_occupied";
  return errorCode(error) === "permission_denied"
    ? "permission_denied"
    : "listener_unavailable";
}

/** Acquire exactly the designated loopback port, before any storage access. */
export async function acquireCompanionSingleton(
  deps: SingletonDependencies
): Promise<CompanionSingleton> {
  const sockets = new Set<Socket>();
  let handler: http.RequestListener = (_req, res) => {
    res
      .writeHead(503, { "Cache-Control": "no-store", Connection: "close" })
      .end();
  };
  let failure: () => void = () => undefined;
  let closed = false;
  let bound = false;
  let closeTask: Promise<boolean> | undefined;
  let server: http.Server;
  try {
    server = deps.http.createServer((req, res) => handler(req, res));
  } catch (error) {
    throw new CompanionStartupFault(bindCode(error));
  }
  const onSocket = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  const onError = () => {
    if (bound && !closed) failure();
  };
  const onClose = () => {
    if (bound && !closed) failure();
  };
  server.on("connection", onSocket);
  server.on("error", onError);
  server.on("close", onClose);
  function close(): Promise<boolean> {
    if (closeTask) return closeTask;
    closed = true;
    handler = (_req, res) => {
      res
        .writeHead(503, { Connection: "close", "Cache-Control": "no-store" })
        .end();
    };
    closeTask = (async () => {
      const deadline = new SigninDeadline(deps.clock, CLEANUP_MS);
      try {
        const done = new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (
              error &&
              !("code" in error && error.code === "ERR_SERVER_NOT_RUNNING")
            )
              reject(error);
            else resolve();
          });
        });
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
        await deadline.wait(done);
        return !server.listening;
      } catch {
        return false;
      } finally {
        deadline.close();
        server.off("connection", onSocket);
        server.off("error", onError);
        server.off("close", onClose);
        sockets.clear();
      }
    })();
    return closeTask;
  }
  const deadline = new SigninDeadline(deps.clock, CLEANUP_MS);
  let onListening: () => void = () => undefined;
  let onBindError: (error: Error) => void = () => undefined;
  try {
    await deadline.wait(
      new Promise<void>((resolve, reject) => {
        onListening = () => {
          const address = server.address();
          if (
            address &&
            typeof address !== "string" &&
            address.address === COMPANION_CONTROL_HOST &&
            address.port === COMPANION_CONTROL_PORT
          ) {
            bound = true;
            resolve();
          } else reject(new CompanionStartupFault("listener_unavailable"));
        };
        onBindError = reject;
        server.once("error", onBindError);
        server.listen(
          {
            host: COMPANION_CONTROL_HOST,
            port: COMPANION_CONTROL_PORT,
            exclusive: true,
          },
          onListening
        );
      })
    );
  } catch (error) {
    await close();
    throw new CompanionStartupFault(bindCode(error));
  } finally {
    deadline.close();
    server.off("error", onBindError);
    server.off("listening", onListening);
  }
  return {
    origin: COMPANION_CONTROL_ORIGIN,
    setHandler(next) {
      if (closed || !server.listening)
        throw new CompanionStartupFault("listener_unavailable");
      handler = next;
    },
    onFailure(next) {
      failure = next;
      if (!server.listening) failure();
    },
    close,
  };
}

export type CompanionStopReason =
  | "quit"
  | "idle_timeout"
  | "signal"
  | "listener_failed"
  | "startup_failed";
export type CompanionRuntimeHandle = Pick<
  CompanionRuntime,
  "session" | "status" | "shutdown"
> &
  Partial<
    Pick<CompanionRuntime, "authorizeTextDiagnostic" | "runTextDiagnostic">
  >;
export interface CompanionControlContext {
  runtime: Pick<
    CompanionRuntimeHandle,
    "session" | "status" | "authorizeTextDiagnostic" | "runTextDiagnostic"
  >;
  origin: typeof COMPANION_CONTROL_ORIGIN;
  /** Invoke only for authenticated operator activity, not background polling. */
  touch(): void;
  requestQuit(): void;
}
export interface CompanionControl {
  handler: http.RequestListener;
  start?(): Promise<void> | void;
  close?(): Promise<void> | void;
}
export type CompanionControlFactory = (
  context: CompanionControlContext
) => CompanionControl;
type StopSignal = "SIGINT" | "SIGTERM";
export interface ForegroundDependencies extends SingletonDependencies {
  interactive: boolean;
  createRuntime(): CompanionRuntimeHandle;
  signals: {
    on(signal: StopSignal, handler: () => void): void;
    off(signal: StopSignal, handler: () => void): void;
  };
}
export interface CompanionStopResult {
  reason: CompanionStopReason;
  listenerClosed: boolean;
  cleanup: "complete" | "pending";
  credentials: CompanionRuntimeShutdown["credentials"];
}
export interface RunningCompanion {
  origin: typeof COMPANION_CONTROL_ORIGIN;
  stopped: Promise<CompanionStopResult>;
  stop(reason?: CompanionStopReason): Promise<CompanionStopResult>;
}

export function nativeForegroundDependencies(): ForegroundDependencies {
  return {
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    http,
    clock: systemSigninClock,
    createRuntime: () => createCompanionRuntime(),
    signals: {
      on: (signal, handler) => {
        process.on(signal, handler);
      },
      off: (signal, handler) => {
        process.off(signal, handler);
      },
    },
  };
}

/** C3 provides the authenticated control factory; importing this file is inert. */
export async function startForegroundCompanion(
  createControl: CompanionControlFactory,
  deps = nativeForegroundDependencies()
): Promise<RunningCompanion> {
  if (!deps.interactive)
    throw new CompanionStartupFault("interactive_required");
  const singleton = await acquireCompanionSingleton(deps);
  let runtime: CompanionRuntimeHandle | undefined;
  let control: CompanionControl | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let stopTask: Promise<CompanionStopResult> | undefined;
  let resolveStopped: (result: CompanionStopResult) => void = () => undefined;
  const stopped = new Promise<CompanionStopResult>((resolve) => {
    resolveStopped = resolve;
  });
  const signal = () => {
    void stop("signal");
  };
  function touch(): void {
    if (stopTask) return;
    if (idle !== undefined) deps.clock.clearTimeout(idle);
    idle = deps.clock.setTimeout(() => {
      void stop("idle_timeout");
    }, COMPANION_IDLE_MS);
  }
  function stop(
    reason: CompanionStopReason = "quit"
  ): Promise<CompanionStopResult> {
    if (stopTask) return stopTask;
    // Assign promise before callbacks run, to make stop idempotent.
    stopTask = Promise.resolve().then(async () => {
      if (idle !== undefined) deps.clock.clearTimeout(idle);
      deps.signals.off("SIGINT", signal);
      deps.signals.off("SIGTERM", signal);
      const deadline = new SigninDeadline(deps.clock, CLEANUP_MS);
      let controlClosed = false;
      let runtimeClosed = false;
      let listenerClosed = false;
      const runtimeTask = Promise.resolve()
        .then(() => runtime?.shutdown())
        .then((result) => {
          runtimeClosed = !result || result.cleanup === "complete";
        });
      const controlTask = Promise.resolve()
        .then(() => control?.close?.())
        .then(() => {
          controlClosed = true;
        });
      // Disable actions immediately, but retain the singleton until the
      // runtime and control have stopped. A pending cleanup must not allow
      // a second process to write the same store until process exit.
      try {
        singleton.setHandler((_req, res) => {
          res
            .writeHead(503, {
              Connection: "close",
              "Cache-Control": "no-store",
            })
            .end();
        });
      } catch {
        /* listener already failed */
      }
      try {
        await deadline.wait(Promise.allSettled([runtimeTask, controlTask]));
        if (runtimeClosed && controlClosed)
          listenerClosed = await deadline.wait(singleton.close());
      } catch {
        /* report bounded cleanup honestly */
      } finally {
        deadline.close();
      }
      const result: CompanionStopResult = {
        reason,
        listenerClosed,
        cleanup:
          runtimeClosed && controlClosed && listenerClosed
            ? "complete"
            : "pending",
        credentials: "not_cleared_by_shutdown",
      };
      resolveStopped(result);
      return result;
    });
    return stopTask;
  }
  try {
    // No runtime/storage construction until the exclusive bind succeeds.
    runtime = deps.createRuntime();
    control = createControl({
      runtime,
      origin: singleton.origin,
      touch,
      requestQuit: () => {
        void stop("quit");
      },
    });
    if (stopTask) throw new CompanionStartupFault("startup_failed");
    singleton.setHandler(control.handler);
    singleton.onFailure(() => {
      void stop("listener_failed");
    });
    deps.signals.on("SIGINT", signal);
    deps.signals.on("SIGTERM", signal);
    touch();
    await control.start?.();
    if (stopTask) throw new CompanionStartupFault("startup_failed");
    return { origin: singleton.origin, stopped, stop };
  } catch (error) {
    await stop("startup_failed");
    // Preserve only fixed classified errors, never exception messages/paths.
    if (error instanceof CompanionStartupFault) throw error;
    if (error instanceof CompanionStorageFault)
      throw new CompanionStartupFault("storage_blocked", error.issue);
    throw new CompanionStartupFault("startup_failed");
  }
}
