import type { ProbeCancellation } from "./contracts.js";
import type { OfficialBody, OfficialHttpClient } from "./official-http.js";
import {
  ResponseDiagnostics,
  type ResponseDiagnosticSnapshot,
} from "./response-diagnostics.js";
import {
  PLAN_SCOPE,
  systemSigninClock,
  SigninFault,
  boundedString,
  errorCode,
  record,
  validToken,
  type SigninClock,
  type SigninCode,
  type SigninPersistence,
  type StoredConnection,
  type RequestBudget,
} from "./signin-contracts.js";

const MARKER = "p15_3";
const NAMESPACE = "feasibility";
const FUNCTION = "echo";
const MAX_TOTAL = 1024 * 1024;
const MAX_EVENT = 128 * 1024;
const MAX_EVENTS = 10000;
const MAX_ITEMS = 128;
const MAX_MODELS = 256;
const OUTPUT = '{"ok":true,"value":"p15_3"}';

export type ResponsesCode =
  | SigninCode
  | "catalog_invalid"
  | "catalog_required"
  | "model_not_selected"
  | "plan_only_required"
  | "attempt_order_invalid"
  | "roundtrip_required"
  | "malformed_sse"
  | "premature_eof"
  | "response_failed"
  | "response_incomplete"
  | "invalid_function_call"
  | "duplicate_call"
  | "argument_mismatch"
  | "unexpected_function_call"
  | "missing_acknowledgement"
  | "response_completed"
  | "roundtrip_complete"
  | "cancellation_demonstrated"
  | "cancellation_not_demonstrated";
export class ResponsesFault extends Error {
  constructor(readonly code: ResponsesCode) {
    super(code);
    this.name = "ResponsesFault";
  }
}
export function responsesErrorCode(error: unknown): ResponsesCode {
  return error instanceof ResponsesFault ? error.code : errorCode(error);
}

export interface ModelChoice {
  slug: string;
  displayName: string;
}
export interface OperatorAuthorization {
  eligible: boolean;
  operatorStarted: boolean;
}
export interface InferenceAuthorization extends OperatorAuthorization {
  planOnlyConfirmed: boolean;
  creditFallbackDisabled: boolean;
}
export interface CatalogContext {
  connection: StoredConnection;
  authorization: OperatorAuthorization;
  cancellation?: ProbeCancellation;
}
export interface InferenceContext {
  connection: StoredConnection;
  modelSlug: string;
  authorization: InferenceAuthorization;
  cancellation?: ProbeCancellation;
}
export interface ResponsesDependencies {
  http: OfficialHttpClient;
  store: Pick<
    SigninPersistence,
    "getBudget" | "reserveInferenceAttempt" | "loadSelectedConnection"
  >;
  TextDecoder: typeof globalThis.TextDecoder;
  clock: SigninClock;
}
export interface UsageCounts {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
}
export type EvidenceTerminal =
  | "completed"
  | "failed"
  | "incomplete"
  | "interrupted"
  | "malformed"
  | "cancelled"
  | "not_observed";
export interface ResponseEvidence {
  terminal: EvidenceTerminal;
  code: ResponsesCode;
  events: number | null;
  bytes: number | null;
  usage?: UsageCounts;
  diagnostics?: ResponseDiagnosticSnapshot;
}
export interface RoundTripResult {
  outcome: "pass" | "blocked" | "failed";
  code: ResponsesCode;
  attempts: number | null;
  first?: ResponseEvidence;
  second?: ResponseEvidence;
  functionEchoValidated: boolean;
  finalMarkerAcknowledged: boolean;
}
export interface CancellationResult {
  outcome: "pass" | "blocked" | "failed";
  code: ResponsesCode;
  attempts: number | null;
  evidence?: ResponseEvidence;
  textDeltaObserved: boolean;
  abortRequested: boolean;
  pendingReadRejected: boolean;
  cleanupVerified: boolean;
}

/** Only visible, ordered, display-safe models. No defaults or hidden entries. */
export function parseModelCatalog(
  payload: unknown,
  forbidden: readonly string[] = []
): ModelChoice[] {
  const root = record(payload);
  if (
    !root ||
    !Array.isArray(root.models) ||
    root.models.length < 1 ||
    root.models.length > MAX_MODELS
  )
    throw new ResponsesFault("catalog_invalid");
  const visible: ModelChoice[] = [];
  const seen = new Set<string>();
  const privateValue = (value: string) =>
    forbidden.some(
      (secret) =>
        secret.length > 0 &&
        (value === secret || (secret.length >= 8 && value.includes(secret)))
    );
  for (const value of root.models as unknown[]) {
    const model = record(value);
    if (!model || !boundedString(model.visibility, 32))
      throw new ResponsesFault("catalog_invalid");
    if (model.visibility !== "list") continue;
    if (
      !boundedString(model.slug, 128) ||
      /\s/.test(model.slug) ||
      !boundedString(model.display_name, 128) ||
      !model.display_name.trim() ||
      seen.has(model.slug) ||
      privateValue(model.slug) ||
      privateValue(model.display_name)
    )
      throw new ResponsesFault("catalog_invalid");
    seen.add(model.slug);
    visible.push({ slug: model.slug, displayName: model.display_name });
  }
  if (!visible.length) throw new ResponsesFault("catalog_invalid");
  return visible;
}

/** A bounded SSE decoder: byte-based limits, UTF-8 split across chunks, LF/CRLF/CR,
 * multiline data, and no dispatch of an unfinished event at EOF. */
export interface SseEvent {
  type: string;
  payload?: Record<string, unknown>;
}
export class SseFramer {
  private readonly decoder: InstanceType<typeof globalThis.TextDecoder>;
  private line: number[] = [];
  private eventBytes = 0;
  private eventName: string | undefined;
  private data: string[] = [];
  private skipLf = false;
  private total = 0;
  private count = 0;
  constructor(
    TextDecoderCtor: typeof globalThis.TextDecoder,
    private readonly diagnostics?: ResponseDiagnostics
  ) {
    diagnostics?.start("decoding");
    this.decoder = new TextDecoderCtor("utf-8", { fatal: true });
    diagnostics?.pass("decoding");
    diagnostics?.parser(0, 0);
  }
  get bytes(): number {
    return this.total;
  }
  get events(): number {
    return this.count;
  }
  push(chunk: Uint8Array): SseEvent[] {
    this.diagnostics?.start("framing");
    if (!ArrayBuffer.isView(chunk) || typeof chunk.length !== "number")
      throw new ResponsesFault("malformed_sse");
    if (this.total + chunk.byteLength > MAX_TOTAL) {
      this.total = MAX_TOTAL + 1;
      this.diagnostics?.parser(this.total, this.count);
      throw new ResponsesFault("response_limit");
    }
    this.total += chunk.byteLength;
    this.diagnostics?.parser(this.total, this.count);
    const events: SseEvent[] = [];
    for (const byte of chunk) {
      if (this.skipLf) {
        this.skipLf = false;
        if (byte === 10) continue;
      }
      // Reserve both CRLF bytes conservatively even when the next byte is LF.
      this.eventBytes += byte === 13 ? 2 : 1;
      if (this.eventBytes > MAX_EVENT)
        throw new ResponsesFault("response_limit");
      if (byte === 10 || byte === 13) {
        if (byte === 13) this.skipLf = true;
        const event = this.consumeLine();
        if (event) events.push(event);
      } else this.line.push(byte);
    }
    this.diagnostics?.pass("framing");
    return events;
  }
  finish(): void {
    this.diagnostics?.start("framing");
    if (this.line.length || this.data.length || this.eventName !== undefined)
      throw new ResponsesFault("premature_eof");
    this.diagnostics?.pass("framing");
  }
  private consumeLine(): SseEvent | undefined {
    let line: string;
    this.diagnostics?.start("decoding");
    try {
      line = this.decoder.decode(new Uint8Array(this.line));
    } catch {
      throw new ResponsesFault("malformed_sse");
    }
    this.diagnostics?.pass("decoding");
    this.diagnostics?.start("framing");
    this.line = [];
    if (line === "") {
      const data = this.data.join("\n");
      const eventName = this.eventName;
      const present = this.data.length > 0;
      this.data = [];
      this.eventName = undefined;
      this.eventBytes = 0;
      if (!present) return undefined;
      this.count++;
      this.diagnostics?.parser(this.total, this.count);
      if (this.count > MAX_EVENTS) throw new ResponsesFault("response_limit");
      if (data.trim() === "[DONE]") {
        if (eventName && eventName !== "message")
          throw new ResponsesFault("malformed_sse");
        this.diagnostics?.observeEvent("[DONE]");
        return { type: "[DONE]" };
      }
      let payload: Record<string, unknown> | undefined;
      this.diagnostics?.start("decoding");
      try {
        payload = record(JSON.parse(data) as unknown);
      } catch {
        throw new ResponsesFault("malformed_sse");
      }
      if (
        !payload ||
        !boundedString(payload.type, 128) ||
        payload.type === "[DONE]" ||
        (eventName !== undefined &&
          eventName !== "message" &&
          eventName !== payload.type)
      )
        throw new ResponsesFault("malformed_sse");
      this.diagnostics?.pass("decoding");
      this.diagnostics?.start("framing");
      this.diagnostics?.observeEvent(payload.type);
      return { type: payload.type, payload };
    }
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "data") this.data.push(value);
    else if (field === "event") {
      if (this.eventName !== undefined || !boundedString(value, 128))
        throw new ResponsesFault("malformed_sse");
      this.eventName = value;
    }
    return undefined;
  }
}

interface CallIdentity {
  id: string;
  callId: string;
  name: string;
  namespace: string;
}
interface ObservedItem {
  id: string;
  type: string;
  call?: CallIdentity;
  argumentsText: string;
  sawDelta: boolean;
  finalArguments?: string;
  itemDone: boolean;
}
function functionIdentity(item: Record<string, unknown>): CallIdentity {
  if (
    item.type !== "function_call" ||
    !boundedString(item.id, 256) ||
    !boundedString(item.call_id, 256) ||
    item.name !== FUNCTION ||
    item.namespace !== NAMESPACE
  )
    throw new ResponsesFault("invalid_function_call");
  return {
    id: item.id,
    callId: item.call_id,
    name: FUNCTION,
    namespace: NAMESPACE,
  };
}
function sameCall(a: CallIdentity, b: CallIdentity): boolean {
  return (
    a.id === b.id &&
    a.callId === b.callId &&
    a.name === b.name &&
    a.namespace === b.namespace
  );
}
function validArguments(value: unknown): boolean {
  if (!boundedString(value, MAX_EVENT) && typeof value !== "string")
    return false;
  if (typeof value !== "string" || value.length > MAX_EVENT) return false;
  // Require exactly one JSON string key/value (including escaped forms), so
  // duplicate keys cannot be hidden by JSON.parse's last-key-wins behavior.
  const match =
    /^\s*\{\s*("(?:[^"\\]|\\.)*")\s*:\s*("(?:[^"\\]|\\.)*")\s*\}\s*$/s.exec(
      value
    );
  if (!match) return false;
  try {
    return JSON.parse(match[1]) === "value" && JSON.parse(match[2]) === MARKER;
  } catch {
    return false;
  }
}
function index(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < MAX_ITEMS
    ? value
    : undefined;
}
function knownItem(item: Record<string, unknown>): boolean {
  return (
    item.type === "reasoning" ||
    item.type === "message" ||
    item.type === "function_call"
  );
}

/** Track streamed item IDs and argument fragments; terminal output is only
 * accepted if it is complete and consistent with all observed call events. */
class CallAssembly {
  private readonly items = new Map<number, ObservedItem>();
  constructor(private readonly allowCall: boolean) {}
  observe(event: SseEvent): void {
    const p = event.payload;
    if (!p) return;
    if (
      event.type === "response.output_item.added" ||
      event.type === "response.output_item.done"
    ) {
      const at = index(p.output_index);
      const item = record(p.item);
      if (
        at === undefined ||
        !item ||
        !knownItem(item) ||
        !boundedString(item.id, 256)
      )
        throw new ResponsesFault("invalid_response");
      const done = event.type === "response.output_item.done";
      let call: CallIdentity | undefined;
      if (item.type === "function_call") {
        if (!this.allowCall)
          throw new ResponsesFault("unexpected_function_call");
        call = functionIdentity(item);
        if (
          typeof item.arguments !== "string" ||
          item.arguments.length > MAX_EVENT
        )
          throw new ResponsesFault("invalid_function_call");
        if (done && !validArguments(item.arguments))
          throw new ResponsesFault("argument_mismatch");
      }
      const old = this.items.get(at);
      if ((!done && old) || (done && old?.itemDone))
        throw new ResponsesFault("duplicate_call");
      if (
        [...this.items.entries()].some(
          ([i, row]) =>
            i !== at &&
            (row.id === item.id || (call && row.call?.callId === call.callId))
        )
      )
        throw new ResponsesFault("duplicate_call");
      if (
        call &&
        [...this.items.entries()].some(
          ([i, row]) => i !== at && row.call !== undefined
        )
      )
        throw new ResponsesFault("duplicate_call");
      if (old) {
        if (
          old.id !== item.id ||
          old.type !== item.type ||
          !!old.call !== !!call ||
          (old.call && call && !sameCall(old.call, call))
        )
          throw new ResponsesFault("invalid_function_call");
        if (call && done) {
          if (
            ((old.sawDelta || old.argumentsText !== "") &&
              old.argumentsText !== item.arguments) ||
            (old.finalArguments !== undefined &&
              old.finalArguments !== item.arguments)
          )
            throw new ResponsesFault("argument_mismatch");
          old.finalArguments = item.arguments as string;
        }
        old.itemDone = done;
      } else {
        this.items.set(at, {
          id: item.id,
          type: item.type as string,
          call,
          argumentsText: !done && call ? (item.arguments as string) : "",
          sawDelta: false,
          finalArguments: done && call ? (item.arguments as string) : undefined,
          itemDone: done,
        });
      }
      return;
    }
    if (
      event.type === "response.function_call_arguments.delta" ||
      event.type === "response.function_call_arguments.done"
    ) {
      if (!this.allowCall) throw new ResponsesFault("unexpected_function_call");
      const at = index(p.output_index);
      const item =
        at === undefined
          ? [...this.items.values()].find((row) => row.id === p.item_id)
          : this.items.get(at);
      if (
        !item?.call ||
        p.item_id !== item.id ||
        item.itemDone ||
        (p.output_index !== undefined && at === undefined) ||
        (p.name !== undefined && p.name !== FUNCTION) ||
        (p.namespace !== undefined && p.namespace !== NAMESPACE) ||
        (p.call_id !== undefined && p.call_id !== item.call.callId)
      )
        throw new ResponsesFault("invalid_function_call");
      if (item.finalArguments !== undefined)
        throw new ResponsesFault("duplicate_call");
      if (event.type.endsWith(".delta")) {
        if (
          typeof p.delta !== "string" ||
          item.argumentsText.length + p.delta.length > MAX_EVENT
        )
          throw new ResponsesFault("response_limit");
        item.argumentsText += p.delta;
        item.sawDelta = true;
      } else {
        if (
          typeof p.arguments !== "string" ||
          !validArguments(p.arguments) ||
          ((item.sawDelta || item.argumentsText !== "") &&
            p.arguments !== item.argumentsText)
        )
          throw new ResponsesFault("argument_mismatch");
        item.finalArguments = p.arguments;
      }
      return;
    }
    if (event.type.startsWith("response.function_call"))
      throw new ResponsesFault("invalid_function_call");
    if (
      event.type === "response.output_text.delta" &&
      typeof p.delta !== "string"
    )
      throw new ResponsesFault("invalid_response");
  }
  complete(output: unknown): {
    items: Record<string, unknown>[];
    call?: CallIdentity;
    acknowledgement: boolean;
  } {
    if (
      !Array.isArray(output) ||
      output.length < 1 ||
      output.length > MAX_ITEMS
    )
      throw new ResponsesFault("invalid_response");
    const items: Record<string, unknown>[] = [];
    const ids = new Set<string>();
    let call: CallIdentity | undefined;
    let acknowledgementText = "";
    for (const [at, raw] of (output as unknown[]).entries()) {
      const item = record(raw);
      if (
        !item ||
        !knownItem(item) ||
        !boundedString(item.id, 256) ||
        (item.status !== undefined && item.status !== "completed")
      )
        throw new ResponsesFault("invalid_response");
      if (ids.has(item.id)) throw new ResponsesFault("duplicate_call");
      ids.add(item.id);
      const observed = this.items.get(at);
      if (observed && (observed.id !== item.id || observed.type !== item.type))
        throw new ResponsesFault("invalid_response");
      if (item.type === "function_call") {
        if (!this.allowCall)
          throw new ResponsesFault("unexpected_function_call");
        if (call) throw new ResponsesFault("duplicate_call");
        call = functionIdentity(item);
        if (!validArguments(item.arguments))
          throw new ResponsesFault("argument_mismatch");
        if (
          observed &&
          (!observed.call ||
            !sameCall(observed.call, call) ||
            ((observed.sawDelta || observed.argumentsText !== "") &&
              observed.argumentsText !== item.arguments) ||
            (observed.finalArguments !== undefined &&
              observed.finalArguments !== item.arguments))
        )
          throw new ResponsesFault("argument_mismatch");
      } else if (item.type === "message") {
        if (
          item.role !== "assistant" ||
          !Array.isArray(item.content) ||
          item.content.length > MAX_ITEMS
        )
          throw new ResponsesFault("invalid_response");
        for (const rawContent of item.content as unknown[]) {
          const content = record(rawContent);
          if (
            !content ||
            content.type !== "output_text" ||
            typeof content.text !== "string" ||
            content.text.length > MAX_TOTAL
          )
            throw new ResponsesFault("invalid_response");
          acknowledgementText += content.text;
          if (acknowledgementText.length > MAX_TOTAL)
            throw new ResponsesFault("response_limit");
        }
      }
      // Preserve the complete original returned output item incl. reasoning fields.
      items.push(item);
    }
    if ([...this.items.keys()].some((at) => at >= items.length))
      throw new ResponsesFault("invalid_response");
    if (this.allowCall && !call)
      throw new ResponsesFault("invalid_function_call");
    const acknowledgement = acknowledgementText.trim() === MARKER;
    if (!this.allowCall && !acknowledgement)
      throw new ResponsesFault("missing_acknowledgement");
    return { items, call, acknowledgement };
  }
}

function usageCounts(value: unknown): UsageCounts | undefined {
  const row = record(value);
  if (!row) return undefined;
  const number = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
  const inputTokens = number(row.input_tokens);
  const outputTokens = number(row.output_tokens);
  const totalTokens = number(row.total_tokens);
  const cached = number(record(row.input_tokens_details)?.cached_tokens);
  const cachedInputTokens =
    cached !== undefined && inputTokens !== undefined && cached <= inputTokens
      ? cached
      : undefined;
  const result: UsageCounts = {};
  if (inputTokens !== undefined) result.inputTokens = inputTokens;
  if (outputTokens !== undefined) result.outputTokens = outputTokens;
  if (totalTokens !== undefined) result.totalTokens = totalTokens;
  if (cachedInputTokens !== undefined)
    result.cachedInputTokens = cachedInputTokens;
  return Object.keys(result).length ? result : undefined;
}
function terminalFor(code: ResponsesCode): EvidenceTerminal {
  if (code === "response_failed") return "failed";
  if (code === "response_incomplete") return "incomplete";
  if (code === "cancelled") return "cancelled";
  if (
    code === "premature_eof" ||
    code === "network_failed" ||
    code === "timeout" ||
    code === "native_abort"
  )
    return "interrupted";
  if (
    [
      "malformed_sse",
      "invalid_response",
      "response_limit",
      "invalid_function_call",
      "duplicate_call",
      "argument_mismatch",
      "unexpected_function_call",
      "missing_acknowledgement",
    ].includes(code)
  )
    return "malformed";
  return "not_observed";
}
function evidence(
  framer: SseFramer | undefined,
  terminal: EvidenceTerminal,
  code: ResponsesCode,
  usage?: UsageCounts,
  diagnostics?: ResponseDiagnostics
): ResponseEvidence {
  const snapshot = diagnostics?.snapshot();
  return {
    terminal,
    code,
    events: framer
      ? Math.min(framer.events, MAX_EVENTS + 1)
      : (snapshot?.framedEvents ?? null),
    bytes: framer
      ? Math.min(framer.bytes, MAX_TOTAL + 1)
      : (snapshot?.parserBytes ?? null),
    ...(usage ? { usage } : {}),
    ...(snapshot ? { diagnostics: snapshot } : {}),
  };
}
/** Attach final transport/cleanup observations after requestStream settles. */
export function finalizeResponseEvidence(
  value: ResponseEvidence,
  diagnostics: ResponseDiagnostics
): ResponseEvidence {
  const snapshot = diagnostics.snapshot();
  return {
    ...value,
    events: snapshot.framedEvents ?? value.events,
    bytes: snapshot.parserBytes ?? value.bytes,
    diagnostics: snapshot,
  };
}

/** Keep the request's observations if the outer wrapper throws after consumption. */
export function failedResponseEvidence(
  code: ResponsesCode,
  diagnostics: ResponseDiagnostics,
  prior?: ResponseEvidence
): ResponseEvidence {
  if (code !== "cleanup_failed" || !diagnostics.snapshot().cleanupFailureCode)
    diagnostics.fail(code);
  return evidence(
    undefined,
    terminalFor(code),
    code,
    prior?.usage,
    diagnostics
  );
}
export interface CapturedResponse {
  evidence: ResponseEvidence;
  /** Host-only synthetic returned items. A caller must never project these. */
  output?: Record<string, unknown>[];
  callId?: string;
  acknowledgement: boolean;
}
/** Preserve the actual failed stream terminal. Recognize only fixed codes,
 * including the documented sharing usage failures; never classify message
 * text or infer a refresh/retry policy from an unknown provider error. */
function structuredStreamFailure(
  event: SseEvent,
  diagnostics?: ResponseDiagnostics
): ResponsesCode {
  const responseError = record(event.payload?.response)?.error;
  const topError = event.payload?.error;
  const value = (error: unknown): unknown =>
    typeof error === "string" ? error : record(error)?.code;
  const codes = [
    value(responseError),
    value(topError),
    event.payload?.code,
  ].filter((code): code is string => typeof code === "string");
  if (new Set(codes).size !== 1) return "response_failed";
  const code = codes[0];
  diagnostics?.providerCode(code);
  if (code === "subscription_sharing_usage_limit_exceeded")
    return "usage_limited";
  if (code === "subscription_sharing_usage_unavailable")
    return "temporary_failure";
  if (code === "invalid_scope" || code === "insufficient_scope")
    return "plan_disabled";
  if (code === "temporarily_unavailable") return "temporary_failure";
  return "response_failed";
}
function failedCapture(
  code: ResponsesCode,
  framer?: SseFramer,
  usage?: UsageCounts,
  terminal = terminalFor(code),
  diagnostics?: ResponseDiagnostics
): CapturedResponse {
  diagnostics?.fail(code);
  return {
    evidence: evidence(framer, terminal, code, usage, diagnostics),
    acknowledgement: false,
  };
}
function cancelled(cancellation?: ProbeCancellation): void {
  if (cancellation?.cancelled) throw new SigninFault("cancelled");
}

/** Parse a full stream without exposing partial calls. Only a clean EOF after
 * one response.completed can produce output/call ID for the fixed round trip. */
export async function collectCompletedResponse(
  body: OfficialBody,
  TextDecoderCtor: typeof globalThis.TextDecoder,
  mode: "call" | "acknowledgement",
  cancellation?: ProbeCancellation,
  diagnostics = new ResponseDiagnostics()
): Promise<CapturedResponse> {
  let framer: SseFramer | undefined;
  let terminal:
    | {
        output: Record<string, unknown>[];
        callId?: string;
        acknowledgement: boolean;
        usage?: UsageCounts;
      }
    | undefined;
  let sawDone = false;
  const assembler = new CallAssembly(mode === "call");
  try {
    diagnostics.start("consumer");
    diagnostics.initConsumer();
    framer = new SseFramer(TextDecoderCtor, diagnostics);
    while (true) {
      cancelled(cancellation);
      const row = await body.read();
      cancelled(cancellation);
      if (row.done) break;
      for (const event of framer.push(row.value)) {
        diagnostics.event(event.type);
        diagnostics.start("semantic");
        if (event.type === "[DONE]") {
          if (!terminal || sawDone) throw new ResponsesFault("premature_eof");
          sawDone = true;
          diagnostics.pass("semantic");
          continue;
        }
        if (terminal || sawDone) throw new ResponsesFault("malformed_sse");
        if (event.type === "response.failed" || event.type === "error") {
          diagnostics.start("terminal");
          return failedCapture(
            structuredStreamFailure(event, diagnostics),
            framer,
            usageCounts(record(event.payload?.response)?.usage),
            "failed",
            diagnostics
          );
        }
        if (event.type === "response.incomplete") {
          diagnostics.start("terminal");
          return failedCapture(
            "response_incomplete",
            framer,
            usageCounts(record(event.payload?.response)?.usage),
            "incomplete",
            diagnostics
          );
        }
        if (event.type === "response.completed") {
          diagnostics.start("terminal");
          const response = record(event.payload?.response);
          if (!response || response.status !== "completed")
            throw new ResponsesFault("invalid_response");
          const done = assembler.complete(response.output);
          terminal = {
            output: done.items,
            callId: done.call?.callId,
            acknowledgement: done.acknowledgement,
            usage: usageCounts(response.usage),
          };
          diagnostics.pass("terminal");
        } else assembler.observe(event);
        diagnostics.pass("semantic");
      }
    }
    framer.finish();
    if (!terminal)
      return failedCapture(
        "premature_eof",
        framer,
        undefined,
        "interrupted",
        diagnostics
      );
    diagnostics.pass("consumer");
    return {
      evidence: evidence(
        framer,
        "completed",
        "response_completed",
        terminal.usage,
        diagnostics
      ),
      output: terminal.output,
      callId: terminal.callId,
      acknowledgement: terminal.acknowledgement,
    };
  } catch (error) {
    return failedCapture(
      cancellation?.cancelled ? "cancelled" : responsesErrorCode(error),
      framer,
      undefined,
      undefined,
      diagnostics
    );
  }
}

export interface CancellationCapture {
  evidence: ResponseEvidence;
  textDeltaObserved: boolean;
  abortRequested: boolean;
  pendingReadRejected: boolean;
}
function expectedAbort(error: unknown): boolean {
  if (errorCode(error) === "native_abort") return true;
  if (typeof error !== "object" || error === null) return false;
  try {
    return (
      ("name" in error && error.name === "AbortError") ||
      ("code" in error && error.code === "ABORT_ERR")
    );
  } catch {
    return false;
  }
}
/** Abort at the first nonempty text delta and independently observe the pending
 * native read reject. A buffered completion or unrelated failure cannot pass. */
export async function collectCancellation(
  body: OfficialBody,
  TextDecoderCtor: typeof globalThis.TextDecoder,
  cancellation?: ProbeCancellation,
  onProgress?: (value: CancellationCapture) => void,
  clock: SigninClock = systemSigninClock,
  diagnostics = new ResponseDiagnostics()
): Promise<CancellationCapture> {
  let framer: SseFramer | undefined;
  let textDeltaObserved = false;
  let abortRequested = false;
  let pendingReadRejected = false;
  const capture = (
    terminal: EvidenceTerminal,
    code: ResponsesCode,
    usage?: UsageCounts
  ): CancellationCapture => {
    if (
      terminal !== "not_observed" &&
      terminal !== "completed" &&
      code !== "cancellation_demonstrated"
    )
      diagnostics.fail(code);
    return {
      evidence: evidence(framer, terminal, code, usage, diagnostics),
      textDeltaObserved,
      abortRequested,
      pendingReadRejected,
    };
  };
  const assembler = new CallAssembly(false);
  try {
    diagnostics.start("consumer");
    diagnostics.initConsumer();
    framer = new SseFramer(TextDecoderCtor, diagnostics);
    while (true) {
      cancelled(cancellation);
      const row = await body.read();
      cancelled(cancellation);
      if (row.done) {
        framer.finish();
        return capture("interrupted", "premature_eof");
      }
      const events = framer.push(row.value);
      // Inspect the complete already-buffered batch before abort. Completion in
      // that batch is not evidence of a meaningful cancellation.
      for (const event of events) {
        diagnostics.event(event.type);
        diagnostics.start("semantic");
        if (event.type === "response.failed" || event.type === "error")
          return capture(
            "failed",
            structuredStreamFailure(event, diagnostics),
            usageCounts(record(event.payload?.response)?.usage)
          );
        if (event.type === "response.incomplete")
          return capture(
            "incomplete",
            "response_incomplete",
            usageCounts(record(event.payload?.response)?.usage)
          );
        if (event.type === "[DONE]")
          return capture("interrupted", "premature_eof");
        if (event.type === "response.completed") {
          diagnostics.start("terminal");
          const response = record(event.payload?.response);
          if (
            !response ||
            response.status !== "completed" ||
            !Array.isArray(response.output) ||
            (response.output as unknown[]).some(
              (item) => record(item)?.type === "function_call"
            )
          )
            throw new ResponsesFault("invalid_response");
          diagnostics.pass("terminal");
          return capture(
            "completed",
            "cancellation_not_demonstrated",
            usageCounts(response.usage)
          );
        }
        assembler.observe(event);
        diagnostics.pass("semantic");
        if (
          event.type === "response.output_text.delta" &&
          typeof event.payload?.delta === "string" &&
          event.payload.delta.length > 0
        )
          textDeltaObserved = true;
      }
      if (!textDeltaObserved) continue;
      onProgress?.(capture("not_observed", "cancellation_not_demonstrated"));
      cancelled(cancellation);
      let settledBeforeAbort = false;
      const pending = body.read().then(
        (value) => {
          settledBeforeAbort = true;
          return { ok: true as const, value };
        },
        (error: unknown) => {
          settledBeforeAbort = true;
          return { ok: false as const, error };
        }
      );
      // Observe one event-loop turn to distinguish an already settled read
      // (including a wrapped native read) from a genuinely outstanding one.
      let timer: ReturnType<typeof setTimeout> | undefined;
      let remove: (() => void) | undefined;
      try {
        await new Promise<void>((resolve) => {
          timer = clock.setTimeout(resolve, 0);
          remove = cancellation?.onCancel(resolve);
        });
      } finally {
        if (timer !== undefined) clock.clearTimeout(timer);
        remove?.();
      }
      cancelled(cancellation);
      const wasPending = !settledBeforeAbort;
      body.abort();
      abortRequested = body.aborted;
      onProgress?.(capture("not_observed", "cancellation_not_demonstrated"));
      const result = await pending;
      cancelled(cancellation);
      if (
        wasPending &&
        abortRequested &&
        !result.ok &&
        expectedAbort(result.error)
      ) {
        pendingReadRejected = true;
        return capture("cancelled", "cancellation_demonstrated");
      }
      if (result.ok && !result.value.done) {
        // A completed response already buffered in the reader is not cancelled.
        for (const event of framer.push(result.value.value)) {
          diagnostics.event(event.type);
          diagnostics.start("semantic");
          if (
            event.type === "response.completed" &&
            record(event.payload?.response)?.status === "completed"
          )
            return capture(
              "completed",
              "cancellation_not_demonstrated",
              usageCounts(record(event.payload?.response)?.usage)
            );
          if (event.type === "response.failed" || event.type === "error")
            return capture(
              "failed",
              structuredStreamFailure(event, diagnostics),
              usageCounts(record(event.payload?.response)?.usage)
            );
          if (event.type === "response.incomplete")
            return capture(
              "incomplete",
              "response_incomplete",
              usageCounts(record(event.payload?.response)?.usage)
            );
        }
      }
      return capture("interrupted", "cancellation_not_demonstrated");
    }
  } catch (error) {
    const code = cancellation?.cancelled
      ? "cancelled"
      : responsesErrorCode(error);
    return capture(terminalFor(code), code);
  }
}

function fixedTools(): object[] {
  return [
    {
      type: "namespace",
      name: NAMESPACE,
      description: "Synthetic feasibility function only.",
      tools: [
        {
          type: "function",
          name: FUNCTION,
          description: "Return the fixed in-memory marker.",
          strict: true,
          parameters: {
            type: "object",
            properties: { value: { type: "string", enum: [MARKER] } },
            required: ["value"],
            additionalProperties: false,
          },
        },
      ],
    },
  ];
}
function firstInput(): object[] {
  return [
    {
      role: "developer",
      content:
        "This is a fixed synthetic feasibility probe. Call feasibility.echo exactly once with value p15_3. After receiving its output, reply with exactly p15_3 and do not call any function again.",
    },
    {
      role: "user",
      content:
        "Call feasibility.echo with value p15_3, then acknowledge its result.",
    },
  ];
}
function requestBody(model: string, input: object[], tools: object[]): object {
  return { model, store: false, stream: true, input, tools };
}
function cancellationInput(): object[] {
  return [
    {
      role: "developer",
      content:
        "This is a fixed synthetic cancellation probe. No tools. Provide a short response in plain text.",
    },
    {
      role: "user",
      content: "Write three brief sentences about a fictional paper star.",
    },
  ];
}
function blocked(code: ResponsesCode): boolean {
  return [
    "eligibility_pending",
    "operator_required",
    "plan_only_required",
    "operation_busy",
    "catalog_required",
    "model_not_selected",
    "attempt_order_invalid",
    "roundtrip_required",
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
  ].includes(code);
}
function gate(
  authorization: OperatorAuthorization,
  cancellation?: ProbeCancellation
): void {
  if (authorization.eligible !== true)
    throw new SigninFault("eligibility_pending");
  if (authorization.operatorStarted !== true)
    throw new SigninFault("operator_required");
  cancelled(cancellation);
}
function inferenceGate(
  authorization: InferenceAuthorization,
  cancellation?: ProbeCancellation
): void {
  gate(authorization, cancellation);
  if (
    authorization.planOnlyConfirmed !== true ||
    authorization.creditFallbackDisabled !== true
  )
    throw new ResponsesFault("plan_only_required");
}
function sameIdentity(a: StoredConnection, b: StoredConnection): boolean {
  return (
    a.localId === b.localId &&
    a.clientId === b.clientId &&
    a.issuer === b.issuer &&
    a.subject === b.subject
  );
}
interface ConnectionBinding {
  localId: string;
  clientId: string;
  issuer: string;
  subject: string;
  accessToken: string;
}
function binding(connection: StoredConnection): ConnectionBinding {
  return {
    localId: connection.localId,
    clientId: connection.clientId,
    issuer: connection.issuer,
    subject: connection.subject,
    accessToken: connection.accessToken,
  };
}
function sameBinding(a: ConnectionBinding, b: StoredConnection): boolean {
  return (
    a.localId === b.localId &&
    a.clientId === b.clientId &&
    a.issuer === b.issuer &&
    a.subject === b.subject &&
    a.accessToken === b.accessToken
  );
}
interface CatalogBinding {
  connection: ConnectionBinding;
  models: ModelChoice[];
}
interface RoundTripProof {
  connection: ConnectionBinding;
  modelSlug: string;
  runId: string;
}

/** Host-only, account-bound synthetic inference; no arbitrary prompts, tools,
 * destinations, retries, or reset of the durable three-attempt budget. */
export class SyntheticResponses {
  private catalog?: CatalogBinding;
  private proof?: RoundTripProof;
  private generation = 0;
  private busy = false;
  constructor(private readonly deps: ResponsesDependencies) {}

  /** Drop in-memory catalog/proof/history and invalidate late results. Budget is untouched. */
  clearTransient(): void {
    this.generation++;
    this.catalog = undefined;
    this.proof = undefined;
  }

  async loadCatalog(context: CatalogContext): Promise<ModelChoice[]> {
    if (this.busy) throw new SigninFault("operation_busy");
    gate(context.authorization, context.cancellation);
    const generation = this.generation;
    this.busy = true;
    this.catalog = undefined;
    this.proof = undefined;
    try {
      const connection = this.currentConnection(context.connection);
      const payload = await this.deps.http.requestJson("models", {
        bearer: connection.accessToken,
        cancellation: context.cancellation,
      });
      this.active(generation, context.cancellation);
      this.currentConnection(connection);
      const models = parseModelCatalog(payload, [
        connection.accessToken,
        connection.refreshToken,
        connection.clientId,
        connection.subject,
        connection.localId,
      ]);
      this.catalog = {
        connection: binding(connection),
        models: models.map((model) => ({ ...model })),
      };
      return models.map((model) => ({ ...model }));
    } finally {
      this.busy = false;
    }
  }

  /** Exactly attempts one and two. Failure or uncertain send is never replayed. */
  async runRoundTrip(context: InferenceContext): Promise<RoundTripResult> {
    let attempts: number | null = null;
    let first: ResponseEvidence | undefined;
    let second: ResponseEvidence | undefined;
    let functionEchoValidated = false;
    let finalMarkerAcknowledged = false;
    const result = (
      outcome: RoundTripResult["outcome"],
      code: ResponsesCode
    ): RoundTripResult => ({
      outcome,
      code,
      attempts,
      ...(first ? { first } : {}),
      ...(second ? { second } : {}),
      functionEchoValidated,
      finalMarkerAcknowledged,
    });
    if (this.busy) return result("blocked", "operation_busy");
    const generation = this.generation;
    this.busy = true;
    try {
      inferenceGate(context.authorization, context.cancellation);
      const connection = this.requireCatalog(context);
      const budget = this.getBudget();
      attempts = budget.attempts;
      if (budget.attempts !== 0)
        throw new ResponsesFault(
          budget.attempts >= 3 ? "budget_exhausted" : "attempt_order_invalid"
        );
      this.proof = undefined;
      const input = firstInput();
      this.active(generation, context.cancellation);
      this.currentConnection(connection);
      // A failed atomic reservation may have committed: report unknown until reread.
      attempts = null;
      const one = this.reserve(budget, 1);
      attempts = one.attempts;
      this.active(generation, context.cancellation);
      const firstDiagnostics = new ResponseDiagnostics();
      let firstCapture: CapturedResponse | undefined;
      try {
        firstCapture = await this.deps.http.requestStream(
          {
            bearer: connection.accessToken,
            cancellation: context.cancellation,
            json: requestBody(context.modelSlug, input, fixedTools()),
          },
          async (body) => {
            firstCapture = await collectCompletedResponse(
              body,
              this.deps.TextDecoder,
              "call",
              context.cancellation,
              firstDiagnostics
            );
            return firstCapture;
          },
          firstDiagnostics
        );
      } catch (error) {
        const code = responsesErrorCode(error);
        first = failedResponseEvidence(
          code,
          firstDiagnostics,
          firstCapture?.evidence
        );
        throw error;
      }
      first = finalizeResponseEvidence(firstCapture.evidence, firstDiagnostics);
      this.active(generation, context.cancellation);
      if (first.code !== "response_completed")
        return result(blocked(first.code) ? "blocked" : "failed", first.code);
      if (
        first.terminal !== "completed" ||
        !firstCapture.output ||
        !boundedString(firstCapture.callId, 256)
      )
        return result("failed", "invalid_response");
      functionEchoValidated = true;
      // Only now, after complete validated response and exactly one known call,
      // perform the in-memory constant function and append the matching output.
      const secondInput = [
        ...input,
        ...firstCapture.output,
        {
          type: "function_call_output",
          call_id: firstCapture.callId,
          output: OUTPUT,
        },
      ];
      this.currentConnection(connection);
      // A failed atomic reservation may have committed: report unknown until reread.
      attempts = null;
      const two = this.reserve(one, 2);
      attempts = two.attempts;
      this.active(generation, context.cancellation);
      const secondDiagnostics = new ResponseDiagnostics();
      let secondCapture: CapturedResponse | undefined;
      try {
        secondCapture = await this.deps.http.requestStream(
          {
            bearer: connection.accessToken,
            cancellation: context.cancellation,
            json: requestBody(context.modelSlug, secondInput, fixedTools()),
          },
          async (body) => {
            secondCapture = await collectCompletedResponse(
              body,
              this.deps.TextDecoder,
              "acknowledgement",
              context.cancellation,
              secondDiagnostics
            );
            return secondCapture;
          },
          secondDiagnostics
        );
      } catch (error) {
        const code = responsesErrorCode(error);
        second = failedResponseEvidence(
          code,
          secondDiagnostics,
          secondCapture?.evidence
        );
        throw error;
      }
      second = finalizeResponseEvidence(
        secondCapture.evidence,
        secondDiagnostics
      );
      this.active(generation, context.cancellation);
      if (second.code !== "response_completed")
        return result(blocked(second.code) ? "blocked" : "failed", second.code);
      if (second.terminal !== "completed" || !secondCapture.acknowledgement)
        return result("failed", "invalid_response");
      finalMarkerAcknowledged = true;
      this.currentConnection(connection);
      this.proof = {
        connection: binding(connection),
        modelSlug: context.modelSlug,
        runId: two.runId,
      };
      return result("pass", "roundtrip_complete");
    } catch (error) {
      const code =
        context.cancellation?.cancelled || generation !== this.generation
          ? "cancelled"
          : responsesErrorCode(error);
      return result(blocked(code) ? "blocked" : "failed", code);
    } finally {
      this.busy = false;
    }
  }

  /** Only the third durable slot, after a successful in-memory round trip on
   * the same account/model. No fourth attempt even if abort is not demonstrated. */
  async runCancellation(
    context: InferenceContext
  ): Promise<CancellationResult> {
    let attempts: number | null = null;
    let captured: CancellationCapture | undefined;
    let diagnostics: ResponseDiagnostics | undefined;
    let cleanupVerified = false;
    const result = (
      outcome: CancellationResult["outcome"],
      code: ResponsesCode
    ): CancellationResult => ({
      outcome,
      code,
      attempts,
      ...(captured
        ? {
            evidence: diagnostics
              ? finalizeResponseEvidence(captured.evidence, diagnostics)
              : captured.evidence,
          }
        : diagnostics
          ? {
              evidence: evidence(
                undefined,
                terminalFor(code),
                code,
                undefined,
                diagnostics
              ),
            }
          : {}),
      textDeltaObserved: captured?.textDeltaObserved ?? false,
      abortRequested: captured?.abortRequested ?? false,
      pendingReadRejected: captured?.pendingReadRejected ?? false,
      cleanupVerified,
    });
    if (this.busy) return result("blocked", "operation_busy");
    const generation = this.generation;
    this.busy = true;
    try {
      inferenceGate(context.authorization, context.cancellation);
      const connection = this.requireCatalog(context);
      const budget = this.getBudget();
      attempts = budget.attempts;
      if (budget.attempts >= 3) throw new SigninFault("budget_exhausted");
      if (
        !this.proof ||
        !sameBinding(this.proof.connection, connection) ||
        this.proof.modelSlug !== context.modelSlug ||
        this.proof.runId !== budget.runId ||
        budget.attempts !== 2
      )
        throw new ResponsesFault("roundtrip_required");
      this.active(generation, context.cancellation);
      this.proof = undefined;
      // A failed atomic reservation may have committed: report unknown until reread.
      attempts = null;
      const three = this.reserve(budget, 3);
      attempts = three.attempts;
      this.active(generation, context.cancellation);
      // Preserve bounded evidence even if transport cleanup subsequently fails.
      const requestDiagnostics = new ResponseDiagnostics();
      diagnostics = requestDiagnostics;
      await this.deps.http.requestStream(
        {
          bearer: connection.accessToken,
          cancellation: context.cancellation,
          json: requestBody(context.modelSlug, cancellationInput(), []),
        },
        async (body) => {
          captured = await collectCancellation(
            body,
            this.deps.TextDecoder,
            context.cancellation,
            (progress) => {
              captured = progress;
            },
            this.deps.clock,
            requestDiagnostics
          );
          return captured;
        },
        requestDiagnostics
      );
      cleanupVerified = true;
      this.active(generation, context.cancellation);
      const code = captured?.evidence.code ?? "cancellation_not_demonstrated";
      return result(
        code === "cancellation_demonstrated" &&
          captured?.pendingReadRejected &&
          captured.abortRequested
          ? "pass"
          : blocked(code)
            ? "blocked"
            : "failed",
        code
      );
    } catch (error) {
      const code =
        context.cancellation?.cancelled || generation !== this.generation
          ? "cancelled"
          : responsesErrorCode(error);
      if (
        diagnostics &&
        (code !== "cleanup_failed" ||
          !diagnostics.snapshot().cleanupFailureCode)
      )
        diagnostics.fail(code);
      return result(blocked(code) ? "blocked" : "failed", code);
    } finally {
      this.busy = false;
    }
  }

  private active(generation: number, cancellation?: ProbeCancellation): void {
    if (generation !== this.generation) throw new SigninFault("cancelled");
    cancelled(cancellation);
  }
  private currentConnection(expected: StoredConnection): StoredConnection {
    const connection = this.deps.store.loadSelectedConnection();
    if (
      !connection ||
      !sameIdentity(connection, expected) ||
      connection.accessToken !== expected.accessToken ||
      !validToken(connection.accessToken) ||
      !Number.isSafeInteger(connection.expiresAt) ||
      connection.expiresAt <= this.deps.clock.now()
    )
      throw new SigninFault("reconnect_required");
    if (
      !connection.scopes.includes(PLAN_SCOPE) ||
      !connection.scopes.includes("resource.invoke")
    )
      throw new SigninFault("plan_disabled");
    return connection;
  }
  private requireCatalog(context: InferenceContext): StoredConnection {
    const connection = this.currentConnection(context.connection);
    if (!this.catalog || !sameBinding(this.catalog.connection, connection))
      throw new ResponsesFault("catalog_required");
    if (!this.catalog.models.some((model) => model.slug === context.modelSlug))
      throw new ResponsesFault("model_not_selected");
    return connection;
  }
  private getBudget(): RequestBudget {
    const budget = this.deps.store.getBudget();
    if (
      budget.version !== 1 ||
      !boundedString(budget.runId, 256) ||
      !Number.isInteger(budget.attempts) ||
      budget.attempts < 0 ||
      budget.attempts > 3
    )
      throw new SigninFault("storage_invalid");
    return budget;
  }
  private reserve(before: RequestBudget, expected: number): RequestBudget {
    const current = this.getBudget();
    if (
      current.runId !== before.runId ||
      current.attempts !== expected - 1 ||
      before.attempts !== expected - 1
    )
      throw new ResponsesFault("attempt_order_invalid");
    const reserved = this.deps.store.reserveInferenceAttempt();
    if (
      reserved.version !== 1 ||
      reserved.runId !== before.runId ||
      reserved.attempts !== expected
    )
      throw new SigninFault("storage_failed");
    return reserved;
  }
}
