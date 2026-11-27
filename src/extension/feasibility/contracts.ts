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
