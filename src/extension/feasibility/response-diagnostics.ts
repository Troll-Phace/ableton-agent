/** Fixed, bounded, host-only evidence for one Responses request. No wire data. */
const STAGES = [
  "requestPreparation",
  "fetch",
  "status",
  "headers",
  "body",
  "reader",
  "consumer",
  "read",
  "framing",
  "decoding",
  "semantic",
  "terminal",
  "abort",
  "readerCancel",
  "readerRelease",
  "cleanup",
  "settlement",
] as const;
export type DiagnosticStage = (typeof STAGES)[number];
const STATES = ["not_started", "started", "passed", "failed"] as const;
type StageState = (typeof STATES)[number];
const MIME = [
  "sse",
  "json",
  "other",
  "missing",
  "invalid",
  "unobserved",
] as const;
const EVENT = [
  "response.created",
  "response.in_progress",
  "response.output_item.added",
  "response.output_item.done",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  "response.output_text.delta",
  "response.completed",
  "response.failed",
  "response.incomplete",
  "error",
  "[DONE]",
  "other",
] as const;
const TERMINALS = [
  "completed",
  "failed",
  "incomplete",
  "error",
  "not_observed",
] as const;
const READ = [
  "not_started",
  "started",
  "rejected",
  "eof",
  "bytes",
  "invalid",
] as const;
const ERROR_SHAPES = [
  "unobserved",
  "error",
  "detail",
  "other",
  "unreadable",
] as const;
const PROVIDER_CODES = [
  "subscription_sharing_usage_limit_exceeded",
  "subscription_sharing_usage_unavailable",
] as const;
const FAILURE_CODES = [
  "eligibility_pending",
  "operator_required",
  "operation_busy",
  "cancelled",
  "native_abort",
  "timeout",
  "native_unavailable",
  "permission_denied",
  "network_failed",
  "cleanup_failed",
  "invalid_endpoint",
  "redirect_rejected",
  "invalid_response",
  "response_limit",
  "http_rejected",
  "usage_limited",
  "temporary_failure",
  "invalid_grant",
  "access_denied",
  "plan_disabled",
  "reconnect_required",
  "malformed_sse",
  "premature_eof",
  "response_failed",
  "response_incomplete",
  "invalid_function_call",
  "duplicate_call",
  "argument_mismatch",
  "unexpected_function_call",
  "missing_acknowledgement",
  "cancellation_not_demonstrated",
] as const;

export interface ResponseDiagnosticSnapshot {
  readonly stages: Readonly<Record<DiagnosticStage, StageState>>;
  readonly responseReceived: boolean;
  readonly httpStatus: number | null;
  readonly mimeCategory: (typeof MIME)[number];
  readonly bodyPresent: boolean | null;
  readonly transportBytes: number | null;
  readonly transportChunks: number | null;
  readonly parserBytes: number | null;
  readonly framedEvents: number | null;
  readonly consumerEvents: number | null;
  readonly firstRead: (typeof READ)[number];
  readonly firstReadSettled: boolean;
  readonly lastEventCategory: (typeof EVENT)[number] | null;
  readonly observedTerminal: (typeof TERMINALS)[number];
  readonly errorBodyShape: (typeof ERROR_SHAPES)[number];
  readonly providerErrorCode: (typeof PROVIDER_CODES)[number] | null;
  readonly primaryFailureStage: DiagnosticStage | null;
  readonly primaryFailureCode: (typeof FAILURE_CODES)[number] | null;
  readonly cleanupFailureCode: "cleanup_failed" | null;
}

function member<T extends string>(
  values: readonly T[],
  value: unknown
): T | undefined {
  return typeof value === "string" && values.includes(value as T)
    ? (value as T)
    : undefined;
}
function count(value: unknown, cap: number): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= cap
    ? value
    : null;
}
function stageMap(): Record<DiagnosticStage, StageState> {
  return Object.fromEntries(
    STAGES.map((stage) => [stage, "not_started"])
  ) as Record<DiagnosticStage, StageState>;
}

/** Reconstruct only allowlisted values, including when the caller is a test seam. */
export function safeResponseDiagnostics(
  value: ResponseDiagnosticSnapshot
): ResponseDiagnosticSnapshot {
  const stages = stageMap();
  for (const stage of STAGES)
    stages[stage] = member(STATES, value.stages?.[stage]) ?? "not_started";
  const status = count(value.httpStatus, 599);
  return Object.freeze({
    stages: Object.freeze(stages),
    responseReceived: value.responseReceived === true,
    httpStatus: status !== null && status >= 100 ? status : null,
    mimeCategory: member(MIME, value.mimeCategory) ?? "unobserved",
    bodyPresent:
      typeof value.bodyPresent === "boolean" ? value.bodyPresent : null,
    transportBytes: count(value.transportBytes, 1048577),
    transportChunks: count(value.transportChunks, 10001),
    parserBytes: count(value.parserBytes, 1048577),
    framedEvents: count(value.framedEvents, 10001),
    consumerEvents: count(value.consumerEvents, 10001),
    firstRead: member(READ, value.firstRead) ?? "not_started",
    firstReadSettled: value.firstReadSettled === true,
    lastEventCategory: member(EVENT, value.lastEventCategory) ?? null,
    observedTerminal:
      member(TERMINALS, value.observedTerminal) ?? "not_observed",
    errorBodyShape: member(ERROR_SHAPES, value.errorBodyShape) ?? "unobserved",
    providerErrorCode: member(PROVIDER_CODES, value.providerErrorCode) ?? null,
    primaryFailureStage: member(STAGES, value.primaryFailureStage) ?? null,
    primaryFailureCode: member(FAILURE_CODES, value.primaryFailureCode) ?? null,
    cleanupFailureCode:
      value.cleanupFailureCode === "cleanup_failed" ? "cleanup_failed" : null,
  });
}

/** A fresh accumulator per request; callers take a new immutable snapshot after cleanup. */
export class ResponseDiagnostics {
  private readonly stages = stageMap();
  private active: DiagnosticStage = "requestPreparation";
  private state: Omit<
    {
      -readonly [K in keyof ResponseDiagnosticSnapshot]: ResponseDiagnosticSnapshot[K];
    },
    "stages"
  > = {
    responseReceived: false,
    httpStatus: null,
    mimeCategory: "unobserved",
    bodyPresent: null,
    transportBytes: null,
    transportChunks: null,
    parserBytes: null,
    framedEvents: null,
    consumerEvents: null,
    firstRead: "not_started",
    firstReadSettled: false,
    lastEventCategory: null,
    observedTerminal: "not_observed",
    errorBodyShape: "unobserved",
    providerErrorCode: null,
    primaryFailureStage: null,
    primaryFailureCode: null,
    cleanupFailureCode: null,
  };
  start(stage: DiagnosticStage): void {
    this.active = stage;
    this.stages[stage] = "started";
  }
  pass(stage: DiagnosticStage): void {
    this.active = stage;
    this.stages[stage] = "passed";
  }
  fail(code: unknown, stage = this.active): void {
    if (this.state.primaryFailureCode === null) {
      this.stages[stage] = "failed";
      this.state.primaryFailureStage = stage;
      this.state.primaryFailureCode =
        member(FAILURE_CODES, code) ?? "invalid_response";
    }
  }
  cleanupFailed(stage: DiagnosticStage = "cleanup"): void {
    this.stages[stage] = "failed";
    this.state.cleanupFailureCode = "cleanup_failed";
  }
  received(): void {
    this.state.responseReceived = true;
  }
  status(value: unknown): void {
    const n = count(value, 599);
    this.state.httpStatus = n !== null && n >= 100 ? n : null;
  }
  mime(value: unknown): void {
    if (value === undefined || value === null)
      this.state.mimeCategory = "missing";
    else if (typeof value !== "string") this.state.mimeCategory = "invalid";
    else {
      const mime = value.split(";")[0]?.trim().toLowerCase() ?? "";
      this.state.mimeCategory =
        mime === "text/event-stream"
          ? "sse"
          : !/^[!#$%&'*+.^_\x60|~0-9a-z-]+\/[!#$%&'*+.^_\x60|~0-9a-z-]+$/.test(
                mime
              )
            ? "invalid"
            : /(?:^application\/json$|\+json$)/.test(mime)
              ? "json"
              : "other";
    }
  }
  body(present: boolean): void {
    this.state.bodyPresent = present;
  }
  initTransport(): void {
    this.state.transportBytes = 0;
    this.state.transportChunks = 0;
  }
  transport(bytes: number, chunks: number): void {
    this.state.transportBytes = Math.min(bytes, 1048577);
    this.state.transportChunks = Math.min(chunks, 10001);
  }
  readStarted(): void {
    this.start("read");
    if (this.state.firstRead === "not_started")
      this.state.firstRead = "started";
  }
  readSettled(
    outcome: Exclude<(typeof READ)[number], "not_started" | "started">
  ): void {
    if (this.state.firstRead === "started") {
      this.state.firstRead = outcome;
      this.state.firstReadSettled = true;
    }
  }
  parser(bytes: number, events: number): void {
    this.state.parserBytes = Math.min(bytes, 1048577);
    this.state.framedEvents = Math.min(events, 10001);
  }
  initConsumer(): void {
    this.state.consumerEvents = 0;
  }
  event(type: unknown): void {
    this.state.consumerEvents = Math.min(
      (this.state.consumerEvents ?? 0) + 1,
      10001
    );
    this.observeEvent(type);
  }
  observeEvent(type: unknown): void {
    const category = member(EVENT, type) ?? "other";
    this.state.lastEventCategory = category;
    if (this.state.observedTerminal === "not_observed") {
      if (category === "response.completed")
        this.state.observedTerminal = "completed";
      else if (category === "response.failed")
        this.state.observedTerminal = "failed";
      else if (category === "response.incomplete")
        this.state.observedTerminal = "incomplete";
      else if (category === "error") this.state.observedTerminal = "error";
    }
  }
  errorShape(shape: (typeof ERROR_SHAPES)[number]): void {
    this.state.errorBodyShape = shape;
  }
  providerCode(code: unknown): void {
    this.state.providerErrorCode = member(PROVIDER_CODES, code) ?? null;
  }
  snapshot(): ResponseDiagnosticSnapshot {
    return safeResponseDiagnostics({ ...this.state, stages: this.stages });
  }
}
