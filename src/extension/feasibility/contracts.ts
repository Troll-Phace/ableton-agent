/** The standalone fixture's redacted, machine-readable result envelope. */
export type ProbeOutcome = "pass" | "blocked" | "failed";

export type ProbeName =
  | "activation"
  | "native_globals"
  | "node_builtins"
  | "randomness"
  | "loopback"
  | "native_stream"
  | "native_abort"
  | "storage"
  | "system_browser"
  | "modal_ipc";

/** Only fixed status codes and bounded, non-identifying measurements cross IPC. */
export interface ProbeResult {
  probe: ProbeName;
  outcome: ProbeOutcome;
  code: string;
  measurements?: Readonly<Record<string, boolean | number | string>>;
}

/** A separate control seam: cancellation remains available without web globals. */
export interface ProbeCancellation {
  readonly cancelled: boolean;
  onCancel(listener: () => void): () => void;
}

/** No provider credentials, arbitrary destinations or commands are accepted. */
export interface HostProbeOptions {
  storageDirectory: string | undefined;
  /** Explicit operator action only; defaults to false for headless use. */
  includeBrowser?: boolean;
  cancellation?: ProbeCancellation;
}

/** Creates a single-session cancellation handle without Node/web dependencies. */
export function createProbeCancellation(): ProbeCancellation & {
  cancel(): void;
} {
  let cancelled = false;
  const listeners = new Set<() => void>();
  return {
    get cancelled() {
      return cancelled;
    },
    onCancel(listener) {
      if (cancelled) listener();
      else listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      for (const listener of listeners) listener();
      listeners.clear();
    },
  };
}

/** Three optional standard constructors, independently measured and sourced. */
export type CompatibilityConstructor = "TextDecoder" | "URL" | "ReadableStream";
export type CompatibilitySource = "native" | "node_builtin" | "unavailable";
export type CompatibilityLane = "local" | "supplemented";
export type CompatibilityStage =
  | "listen"
  | "fetch_started"
  | "headers_received"
  | "reader_acquired"
  | "first_chunk"
  | "pending_read"
  | "abort_requested"
  | "read_settled"
  | "server_closed"
  | "cleanup";

/** Fixed statuses only; no exception messages, URLs or payload text. */
export interface CompatibilityStatus {
  outcome: ProbeOutcome;
  code: string;
}
export interface CompatibilityConstructorResult extends CompatibilityStatus {
  constructor: CompatibilityConstructor;
  source: CompatibilitySource;
}
export interface CompatibilityStageResult extends CompatibilityStatus {
  stage: CompatibilityStage;
}
export interface CompatibilityTransportResult extends CompatibilityStatus {
  stages: CompatibilityStageResult[];
  measurements: Readonly<Record<string, boolean | number>>;
}
export interface CompatibilitySupplementResult extends CompatibilityStatus {
  constructor: CompatibilityConstructor;
  installed: boolean;
}
export interface CompatibilityLaneResult extends CompatibilityStatus {
  lane: CompatibilityLane;
  supplementation: CompatibilitySupplementResult[];
  stream: CompatibilityTransportResult;
  abort: CompatibilityTransportResult;
  restored: boolean;
}
export interface NativeCompatibilityReport extends CompatibilityStatus {
  raw: Readonly<
    Record<CompatibilityConstructor | "fetch" | "AbortController", boolean>
  >;
  nodeVersion: string;
  constructors: CompatibilityConstructorResult[];
  lanes: CompatibilityLaneResult[];
  /** Exact descriptor restoration is required before another run. */
  restored: boolean;
}
export interface NativeCompatibilityOptions {
  cancellation?: ProbeCancellation;
}
