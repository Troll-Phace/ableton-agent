import OpenAI from "openai";
import { SigninDeadline } from "../extension/feasibility/official-http.js";
import {
  ResponsesFault,
  type InferenceContext,
  type ResponsesCode,
} from "../extension/feasibility/responses.js";
import {
  PLAN_SCOPE,
  REQUESTED_SCOPES,
  RESPONSES_ENDPOINT,
  SigninFault,
  boundedString,
  record,
  validToken,
  type SigninClock,
  type StoredConnection,
} from "../extension/feasibility/signin-contracts.js";

export const SDK_EXPERIMENT = "p15_3_official_sdk_diagnostic" as const;
const STREAM_TIMEOUT = 60_000;
const CLEANUP_TIMEOUT = 5_000;
const MAX_BYTES = 1024 * 1024;
const MAX_CHUNKS = 10_000;
const MAX_EVENTS = 10_000;
const MAX_MARKER_CHARS = 128;

/** Only an explicitly injected synthetic test reservation can enable this checkpoint. */
export interface SdkDiagnosticAuthorization {
  isAuthorized(): boolean;
  reserve(): boolean;
}
export interface SdkResponsesDependencies {
  fetch: typeof globalThis.fetch;
  AbortController: typeof globalThis.AbortController;
  clock: SigninClock;
  loadConnection(): StoredConnection | undefined;
  assertFrozenBudgets(): void;
  authorization?: SdkDiagnosticAuthorization;
}
export interface SdkDiagnosticEvidence {
  reservation: "not_started" | "reserved" | "uncertain";
  fetchInvoked: boolean;
  httpStatus: number | null;
  bodyPresent: boolean | null;
  mimeCategory: "sse" | "json" | "missing" | "other" | "unobserved";
  transportBytes: number | null;
  transportChunks: number | null;
  consumerEvents: number | null;
  observedTerminal:
    | "not_observed"
    | "completed"
    | "failed"
    | "incomplete"
    | "error";
  streamSettled: boolean;
  cleanup: "not_started" | "complete" | "failed" | "pending";
  primaryFailureCode: ResponsesCode | null;
  cleanupFailureCode: "cleanup_failed" | null;
}
export interface SdkDiagnosticResult {
  outcome: "pass" | "blocked" | "failed";
  code: ResponsesCode;
  markerAcknowledged: boolean;
  evidence: Readonly<SdkDiagnosticEvidence>;
}
export interface SdkDiagnosticStatus {
  experiment: typeof SDK_EXPERIMENT;
  mode: "offline_only";
  allowanceAvailable: boolean;
  result?: SdkDiagnosticResult;
}

function emptyEvidence(): SdkDiagnosticEvidence {
  return {
    reservation: "not_started",
    fetchInvoked: false,
    httpStatus: null,
    bodyPresent: null,
    mimeCategory: "unobserved",
    transportBytes: null,
    transportChunks: null,
    consumerEvents: null,
    observedTerminal: "not_observed",
    streamSettled: false,
    cleanup: "not_started",
    primaryFailureCode: null,
    cleanupFailureCode: null,
  };
}
function blocked(code: ResponsesCode): boolean {
  return (
    [
      "eligibility_pending",
      "operator_required",
      "operation_busy",
      "plan_only_required",
      "budget_exhausted",
      "plan_disabled",
      "reconnect_required",
      "cancelled",
      "permission_denied",
      "native_unavailable",
      "cleanup_failed",
      "storage_unavailable",
      "storage_unsafe",
      "storage_invalid",
      "storage_failed",
      "usage_limited",
      "temporary_failure",
      "timeout",
    ] as readonly ResponsesCode[]
  ).includes(code);
}
function providerFailure(value: unknown): ResponsesCode {
  if (value === "subscription_sharing_usage_limit_exceeded")
    return "usage_limited";
  if (
    value === "subscription_sharing_usage_unavailable" ||
    value === "temporarily_unavailable"
  )
    return "temporary_failure";
  if (value === "invalid_scope" || value === "insufficient_scope")
    return "plan_disabled";
  return "response_failed";
}
function sdkFailure(error: unknown): ResponsesCode {
  if (error instanceof SigninFault || error instanceof ResponsesFault)
    return error.code;
  if (error instanceof OpenAI.APIConnectionTimeoutError) return "timeout";
  if (error instanceof OpenAI.APIUserAbortError) return "cancelled";
  if (error instanceof SyntaxError) return "malformed_sse";
  if (error instanceof OpenAI.APIError) {
    const recognized = providerFailure(error.code);
    if (recognized !== "response_failed") return recognized;
    if (error.status === 429) return "usage_limited";
    if (error.status === 401) return "reconnect_required";
    if (error.status === 403) return "plan_disabled";
    if (typeof error.status === "number" && error.status >= 500)
      return "temporary_failure";
    if (typeof error.status === "number") return "http_rejected";
    return error instanceof OpenAI.APIConnectionError
      ? "network_failed"
      : "response_failed";
  }
  return "network_failed";
}
function mime(response: Response): SdkDiagnosticEvidence["mimeCategory"] {
  const media = response.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (!media) return "missing";
  if (media === "text/event-stream") return "sse";
  if (media === "application/json" || media.endsWith("+json")) return "json";
  return "other";
}
/** Validate only the terminal marker; never retain deltas, output items or provider content. */
function marker(output: unknown): boolean {
  if (!Array.isArray(output) || output.length > 128)
    throw new ResponsesFault("invalid_response");
  let text = "";
  for (const value of output as unknown[]) {
    const item = record(value);
    if (!item) throw new ResponsesFault("invalid_response");
    if (item.type === "reasoning") continue;
    if (item.type === "function_call")
      throw new ResponsesFault("unexpected_function_call");
    if (
      item.type !== "message" ||
      item.role !== "assistant" ||
      !Array.isArray(item.content) ||
      item.content.length > 128
    )
      throw new ResponsesFault("invalid_response");
    for (const value of item.content as unknown[]) {
      const content = record(value);
      if (
        !content ||
        content.type !== "output_text" ||
        typeof content.text !== "string"
      )
        throw new ResponsesFault("invalid_response");
      if (text.length + content.text.length > MAX_MARKER_CHARS)
        throw new ResponsesFault("response_limit");
      text += content.text;
    }
  }
  return text.trim() === "p15_3";
}

/** Official SDK streaming, with an app-owned single-dispatch gate and bounded
 * transport, deadline, terminal semantics and sanitized result. No live allowance. */
export class SdkResponses {
  private busy = false;
  private attempted = false;
  private candidate?: SdkDiagnosticResult;
  private result?: SdkDiagnosticResult;
  constructor(private readonly deps: SdkResponsesDependencies) {}

  status(): SdkDiagnosticStatus {
    let allowanceAvailable = false;
    try {
      allowanceAvailable =
        !this.attempted &&
        !this.busy &&
        this.deps.authorization?.isAuthorized() === true;
    } catch {
      /* fail closed */
    }
    return {
      experiment: SDK_EXPERIMENT,
      mode: "offline_only",
      allowanceAvailable,
      ...(this.result ? { result: structuredClone(this.result) } : {}),
    };
  }

  private current(context: InferenceContext): StoredConnection {
    this.deps.assertFrozenBudgets();
    if (context.cancellation?.cancelled) throw new SigninFault("cancelled");
    if (context.authorization.eligible !== true)
      throw new SigninFault("eligibility_pending");
    if (context.authorization.operatorStarted !== true)
      throw new SigninFault("operator_required");
    if (
      context.authorization.planOnlyConfirmed !== true ||
      context.authorization.creditFallbackDisabled !== true
    )
      throw new ResponsesFault("plan_only_required");
    if (!boundedString(context.modelSlug, 128) || /\s/.test(context.modelSlug))
      throw new ResponsesFault("model_not_selected");
    const saved = this.deps.loadConnection();
    const expected = context.connection;
    if (
      !saved ||
      saved.localId !== expected.localId ||
      saved.clientId !== expected.clientId ||
      saved.issuer !== expected.issuer ||
      saved.subject !== expected.subject ||
      saved.accessToken !== expected.accessToken ||
      !validToken(saved.accessToken) ||
      !Number.isSafeInteger(saved.expiresAt) ||
      saved.expiresAt <= this.deps.clock.now()
    )
      throw new SigninFault("reconnect_required");
    if (
      !saved.scopes.includes(PLAN_SCOPE) ||
      !REQUESTED_SCOPES.every((scope) => saved.scopes.includes(scope))
    )
      throw new SigninFault("plan_disabled");
    return saved;
  }

  /** Called only after the session verifies that the operation generation survived. */
  publish(result: SdkDiagnosticResult): void {
    if (result === this.candidate && !this.result)
      this.result = structuredClone(result);
  }

  async run(
    context: InferenceContext,
    ownerAuthorized: boolean
  ): Promise<SdkDiagnosticResult> {
    const evidence = emptyEvidence();
    const result = (
      code: ResponsesCode,
      markerAcknowledged = false
    ): SdkDiagnosticResult => {
      const snapshot: SdkDiagnosticResult = Object.freeze({
        outcome:
          markerAcknowledged && code === "response_completed"
            ? "pass"
            : blocked(code)
              ? "blocked"
              : "failed",
        code,
        markerAcknowledged,
        evidence: Object.freeze({ ...evidence }),
      });
      if (evidence.reservation !== "not_started" && !this.candidate)
        this.candidate = snapshot;
      return snapshot;
    };
    if (ownerAuthorized !== true) return result("operator_required");
    if (this.busy) return result("operation_busy");
    if (this.attempted || !this.deps.authorization)
      return result("budget_exhausted");
    this.busy = true;
    try {
      const connection = this.current(context);
      if (this.deps.authorization.isAuthorized() !== true)
        return result("budget_exhausted");
      this.attempted = true;
      evidence.reservation = "uncertain";
      if (this.deps.authorization.reserve() !== true)
        throw new SigninFault("budget_exhausted");
      evidence.reservation = "reserved";
      this.current(context);
      const code = await this.consume(context, connection, evidence);
      if (context.cancellation?.cancelled) {
        evidence.primaryFailureCode ??= "cancelled";
        return result("cancelled");
      }
      return result(code, code === "response_completed");
    } catch (error) {
      const code = context.cancellation?.cancelled
        ? "cancelled"
        : sdkFailure(error);
      evidence.primaryFailureCode = code;
      return result(code);
    } finally {
      this.busy = false;
    }
  }

  private async consume(
    context: InferenceContext,
    connection: StoredConnection,
    evidence: SdkDiagnosticEvidence
  ): Promise<ResponsesCode> {
    const controller = new this.deps.AbortController();
    const deadline = new SigninDeadline(
      this.deps.clock,
      STREAM_TIMEOUT,
      context.cancellation,
      () => controller.abort()
    );
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let rawBody: ReadableStream<Uint8Array> | null | undefined;
    let cleanupTask: Promise<void> | undefined;
    let transportFailure: ResponsesCode | undefined;
    let ended = false;
    let cleanupFailed = false;
    const closeReader = (): Promise<void> => {
      if (cleanupTask) return cleanupTask;
      const owned = reader;
      if (!owned && !rawBody) return Promise.resolve();
      cleanupTask = (async () => {
        let pending: Promise<void> | undefined;
        try {
          pending = owned ? owned.cancel() : rawBody?.cancel();
        } catch (error) {
          if (!(error instanceof Error && error.name === "AbortError"))
            cleanupFailed = true;
        }
        try {
          owned?.releaseLock();
        } catch {
          cleanupFailed = true;
        }
        try {
          await pending;
        } catch (error) {
          if (!(error instanceof Error && error.name === "AbortError"))
            cleanupFailed = true;
        }
      })();
      return cleanupTask;
    };
    const payload = {
      model: context.modelSlug,
      store: false as const,
      stream: true as const,
      input: [
        {
          role: "developer" as const,
          content:
            "This is a fixed synthetic text-only feasibility diagnostic. Reply with exactly p15_3.",
        },
        { role: "user" as const, content: "Reply with p15_3." },
      ],
    };
    const guardedFetch: typeof globalThis.fetch = async (url, init) => {
      try {
        deadline.check();
        const destination =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : undefined;
        if (
          ended ||
          evidence.fetchInvoked ||
          destination !== RESPONSES_ENDPOINT ||
          init?.method !== "POST" ||
          typeof init.body !== "string" ||
          JSON.stringify(JSON.parse(init.body) as unknown) !==
            JSON.stringify(payload) ||
          new Headers(init.headers).get("authorization") !==
            `Bearer ${connection.accessToken}`
        )
          throw new SigninFault("invalid_response");
        this.current(context);
      } catch (error) {
        transportFailure =
          error instanceof SyntaxError ? "invalid_response" : sdkFailure(error);
        throw new ResponsesFault(transportFailure);
      }
      evidence.fetchInvoked = true;
      // Reconstruct the complete allowlisted request. No environment-derived
      // SDK headers, ambient project/organization, or alternate credential travel.
      const response = await this.deps.fetch(RESPONSES_ENDPOINT, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${connection.accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      rawBody = response.body;
      if (ended || controller.signal.aborted) {
        await closeReader();
        throw new SigninFault("cancelled");
      }
      if (
        Number.isInteger(response.status) &&
        response.status >= 100 &&
        response.status <= 599
      )
        evidence.httpStatus = response.status;
      evidence.bodyPresent = rawBody !== null;
      evidence.mimeCategory = mime(response);
      if (
        response.redirected ||
        (response.url && response.url !== RESPONSES_ENDPOINT) ||
        (response.status >= 300 && response.status < 400)
      ) {
        transportFailure = "redirect_rejected";
        await closeReader();
        throw new SigninFault(transportFailure);
      }
      if (!rawBody) return response;
      reader = rawBody.getReader();
      evidence.transportBytes = 0;
      evidence.transportChunks = 0;
      const owned = reader;
      // Bound bytes before the SDK receives them; the SDK alone decodes SSE,
      // MIME and UTF-8. No custom parser, tee, retained bytes or extra reads.
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(sink) {
            try {
              deadline.check();
              const row = await deadline.wait(owned.read());
              deadline.check();
              if (row.done) {
                sink.close();
                return;
              }
              if (!(row.value instanceof Uint8Array))
                throw new SigninFault("invalid_response");
              evidence.transportBytes = Math.min(
                (evidence.transportBytes ?? 0) + row.value.byteLength,
                MAX_BYTES + 1
              );
              evidence.transportChunks = Math.min(
                (evidence.transportChunks ?? 0) + 1,
                MAX_CHUNKS + 1
              );
              if (
                evidence.transportBytes > MAX_BYTES ||
                evidence.transportChunks > MAX_CHUNKS
              )
                throw new SigninFault("response_limit");
              sink.enqueue(row.value);
            } catch (error) {
              transportFailure ??= sdkFailure(error);
              sink.error(new ResponsesFault(transportFailure));
            }
          },
          cancel() {
            return closeReader();
          },
        },
        { highWaterMark: 0 }
      );
      return new Response(body, {
        status: response.status,
        headers: response.headers,
      });
    };

    const work = (async (): Promise<ResponsesCode> => {
      const client = new OpenAI({
        apiKey: connection.accessToken,
        adminAPIKey: null,
        organization: null,
        project: null,
        webhookSecret: null,
        baseURL: "https://api.openai.com/v1",
        maxRetries: 0,
        timeout: STREAM_TIMEOUT,
        logLevel: "off",
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        fetchOptions: { redirect: "error" },
        fetch: guardedFetch,
      });
      const stream = await client.responses.create(payload, {
        signal: controller.signal,
        maxRetries: 0,
      });
      evidence.consumerEvents = 0;
      let complete = false;
      for await (const value of stream) {
        deadline.check();
        evidence.consumerEvents = Math.min(
          evidence.consumerEvents + 1,
          MAX_EVENTS + 1
        );
        if (evidence.consumerEvents > MAX_EVENTS)
          throw new ResponsesFault("response_limit");
        const event = record(value);
        if (!event || typeof event.type !== "string" || complete)
          throw new ResponsesFault("invalid_response");
        if (
          event.type === "response.function_call_arguments.delta" ||
          event.type === "response.function_call_arguments.done" ||
          ((event.type === "response.output_item.added" ||
            event.type === "response.output_item.done") &&
            record(event.item)?.type === "function_call")
        )
          throw new ResponsesFault("unexpected_function_call");
        if (event.type === "response.failed" || event.type === "error") {
          evidence.observedTerminal =
            event.type === "error" ? "error" : "failed";
          const error =
            record(record(event.response)?.error) ?? record(event.error);
          throw new ResponsesFault(providerFailure(error?.code ?? event.code));
        }
        if (event.type === "response.incomplete") {
          evidence.observedTerminal = "incomplete";
          throw new ResponsesFault("response_incomplete");
        }
        if (event.type === "response.completed") {
          evidence.observedTerminal = "completed";
          const terminal = record(event.response);
          if (!terminal || terminal.status !== "completed")
            throw new ResponsesFault("invalid_response");
          if (!marker(terminal.output))
            throw new ResponsesFault("missing_acknowledgement");
          complete = true;
        }
      }
      deadline.check();
      if (transportFailure) throw new ResponsesFault(transportFailure);
      if (controller.signal.aborted || stream.controller.signal.aborted)
        throw new SigninFault("cancelled");
      if (!complete) throw new ResponsesFault("premature_eof");
      this.current(context);
      return "response_completed";
    })();
    const settled = work.then(
      () => {
        evidence.streamSettled = true;
      },
      () => {
        evidence.streamSettled = true;
      }
    );
    let code: ResponsesCode;
    try {
      code = await deadline.wait(work);
      deadline.check();
    } catch (error) {
      if (
        error instanceof OpenAI.APIError &&
        !(error instanceof OpenAI.APIConnectionError) &&
        error.status === undefined &&
        evidence.httpStatus !== null &&
        evidence.httpStatus >= 200 &&
        evidence.httpStatus < 300
      )
        evidence.observedTerminal = "error";
      code = transportFailure ?? sdkFailure(error);
      try {
        deadline.check();
      } catch (interruption) {
        code = sdkFailure(interruption);
      }
      evidence.primaryFailureCode = code;
    } finally {
      ended = true;
      deadline.close();
      try {
        controller.abort();
      } catch {
        cleanupFailed = true;
      }
      const cleanup = new SigninDeadline(this.deps.clock, CLEANUP_TIMEOUT);
      try {
        await cleanup.wait(Promise.all([settled, closeReader()]));
        evidence.cleanup = cleanupFailed ? "failed" : "complete";
      } catch {
        evidence.cleanup = "pending";
      } finally {
        cleanup.close();
      }
      if (evidence.cleanup !== "complete")
        evidence.cleanupFailureCode = "cleanup_failed";
    }
    if (context.cancellation?.cancelled) {
      evidence.primaryFailureCode ??= "cancelled";
      return "cancelled";
    }
    return evidence.cleanupFailureCode ? "cleanup_failed" : code;
  }
}
