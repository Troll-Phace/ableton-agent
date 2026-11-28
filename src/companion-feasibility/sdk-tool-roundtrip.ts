import type OpenAI from "openai";
import {
  ResponsesFault,
  type InferenceContext,
  type ResponsesCode,
} from "../extension/feasibility/responses.js";
import {
  SigninFault,
  boundedString,
  record,
  type StoredConnection,
} from "../extension/feasibility/signin-contracts.js";
import {
  consumeSdkStream,
  emptySdkEvidence,
  requireTextOnlyEvent,
  sdkBlocked,
  sdkFailure,
  sdkTextMarker,
  verifySdkConnection,
  type SdkConnectionDependencies,
  type SdkDiagnosticEvidence,
  type SdkStreamDependencies,
  type SdkStreamPayload,
} from "./sdk-stream.js";

export const SDK_TOOL_EXPERIMENT = "p15_3_official_sdk_tool_roundtrip" as const;
const MARKER = "p15_3";
const NAMESPACE = "feasibility";
const FUNCTION = "echo";
const OUTPUT = '{"ok":true,"value":"p15_3"}';
const MAX_ITEMS = 128;
const MAX_ARGUMENTS = 4096;
const MAX_REQUEST_BYTES = 1024 * 1024;

export interface SdkToolRoundtripAuthorization {
  isAuthorized(): boolean;
  reserve(step: 1 | 2): boolean;
}
export interface SdkToolRoundtripDependencies
  extends SdkStreamDependencies, SdkConnectionDependencies {
  /** Test seam only; the native package has no authorization or reservation. */
  authorization?: SdkToolRoundtripAuthorization;
}
export interface SdkToolRoundtripResult {
  outcome: "pass" | "blocked" | "failed";
  code: ResponsesCode;
  attempts: 0 | 1 | 2 | null;
  functionEchoValidated: boolean;
  finalMarkerAcknowledged: boolean;
  first?: Readonly<SdkDiagnosticEvidence>;
  second?: Readonly<SdkDiagnosticEvidence>;
}
export interface SdkToolRoundtripStatus {
  experiment: typeof SDK_TOOL_EXPERIMENT;
  mode: "offline_only";
  allowanceAvailable: boolean;
  result?: SdkToolRoundtripResult;
}

type InputItem = OpenAI.Responses.ResponseInputItem;
function fixedTools(): OpenAI.Responses.NamespaceTool[] {
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
function firstInput(): InputItem[] {
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
function payload(model: string, input: InputItem[]): SdkStreamPayload {
  return { model, store: false, stream: true, input, tools: fixedTools() };
}
function validId(value: unknown): value is string {
  return boundedString(value, 256) && !/\s/.test(value);
}
function validArguments(value: unknown): boolean {
  if (typeof value !== "string" || value.length > MAX_ARGUMENTS) return false;
  // Exactly one string key/value, including escaped forms; JSON.parse alone
  // would silently accept duplicate keys. Never execute parsed arguments.
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
function outputIndex(value: unknown): number | undefined {
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
function toolEvent(type: unknown): boolean {
  return (
    typeof type === "string" &&
    /^response\.[a-z0-9_]*_call(?:[._]|$)/.test(type)
  );
}
function requireFinalTextEvent(event: Record<string, unknown>): void {
  requireTextOnlyEvent(event);
  if (toolEvent(event.type))
    throw new ResponsesFault("unexpected_function_call");
  if (
    event.type === "response.output_item.added" ||
    event.type === "response.output_item.done"
  ) {
    const item = record(event.item);
    if (!item) throw new ResponsesFault("invalid_response");
    if (item.type !== "message" && item.type !== "reasoning")
      throw new ResponsesFault("unexpected_function_call");
  }
}
interface CallIdentity {
  id: string;
  callId: string;
}
function callIdentity(item: Record<string, unknown>): CallIdentity {
  if (
    item.type !== "function_call" ||
    !validId(item.id) ||
    !validId(item.call_id) ||
    item.id === item.call_id ||
    item.name !== FUNCTION ||
    item.namespace !== NAMESPACE ||
    item.async === true ||
    (item.caller != null && record(item.caller)?.type !== "direct")
  )
    throw new ResponsesFault("invalid_function_call");
  return { id: item.id, callId: item.call_id };
}
function sameCall(a: CallIdentity, b: CallIdentity): boolean {
  return a.id === b.id && a.callId === b.callId;
}
interface ObservedItem {
  id: string;
  type: string;
  call?: CallIdentity;
  argumentsText: string;
  sawDelta: boolean;
  finalArguments?: string;
  itemDone: boolean;
  doneReasoning?: Record<string, unknown>;
}
interface ValidatedCall {
  history: InputItem[];
  callId: string;
}

/** SDK events only: correlate streamed identities/fragments, but never execute
 * from them. Only validated completed terminal output may produce the echo. */
class EchoAssembly {
  private readonly items = new Map<number, ObservedItem>();
  clear(): void {
    this.items.clear();
  }
  observe(event: Record<string, unknown>): void {
    const type = event.type;
    if (
      type === "response.output_item.added" ||
      type === "response.output_item.done"
    ) {
      const at = outputIndex(event.output_index);
      const item = record(event.item);
      if (at === undefined || !item || !knownItem(item) || !validId(item.id))
        throw new ResponsesFault("invalid_response");
      const done = type === "response.output_item.done";
      let call: CallIdentity | undefined;
      if (item.type === "function_call") {
        call = callIdentity(item);
        if (
          typeof item.arguments !== "string" ||
          item.arguments.length > MAX_ARGUMENTS
        )
          throw new ResponsesFault("invalid_function_call");
        if (
          done &&
          ((item.status !== undefined && item.status !== "completed") ||
            !validArguments(item.arguments))
        )
          throw new ResponsesFault("argument_mismatch");
      }
      const old = this.items.get(at);
      if ((!done && old) || (done && old?.itemDone))
        throw new ResponsesFault("duplicate_call");
      if (
        [...this.items.entries()].some(
          ([i, row]) =>
            i !== at &&
            (row.id === item.id ||
              row.call?.callId === item.id ||
              (call && (row.call !== undefined || row.id === call.callId)))
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
        if (done && item.type === "reasoning") old.doneReasoning = item;
      } else {
        this.items.set(at, {
          id: item.id,
          type: item.type as string,
          call,
          argumentsText: !done && call ? (item.arguments as string) : "",
          sawDelta: false,
          finalArguments: done && call ? (item.arguments as string) : undefined,
          itemDone: done,
          ...(done && item.type === "reasoning" ? { doneReasoning: item } : {}),
        });
      }
      return;
    }
    if (
      type === "response.function_call_arguments.delta" ||
      type === "response.function_call_arguments.done"
    ) {
      const at = outputIndex(event.output_index);
      const row =
        at === undefined
          ? [...this.items.values()].find((item) => item.id === event.item_id)
          : this.items.get(at);
      if (
        !row?.call ||
        event.item_id !== row.id ||
        row.itemDone ||
        (event.output_index !== undefined && at === undefined) ||
        (event.name !== undefined && event.name !== FUNCTION) ||
        (event.namespace !== undefined && event.namespace !== NAMESPACE) ||
        (event.call_id !== undefined && event.call_id !== row.call.callId)
      )
        throw new ResponsesFault("invalid_function_call");
      if (row.finalArguments !== undefined)
        throw new ResponsesFault("duplicate_call");
      if (type.endsWith(".delta")) {
        if (
          typeof event.delta !== "string" ||
          row.argumentsText.length + event.delta.length > MAX_ARGUMENTS
        )
          throw new ResponsesFault("response_limit");
        row.argumentsText += event.delta;
        row.sawDelta = true;
      } else {
        if (
          typeof event.arguments !== "string" ||
          !validArguments(event.arguments) ||
          ((row.sawDelta || row.argumentsText !== "") &&
            event.arguments !== row.argumentsText)
        )
          throw new ResponsesFault("argument_mismatch");
        row.finalArguments = event.arguments;
      }
      return;
    }
    if (toolEvent(type)) throw new ResponsesFault("invalid_function_call");
    if (
      type === "response.output_text.delta" &&
      typeof event.delta !== "string"
    )
      throw new ResponsesFault("invalid_response");
  }

  complete(output: unknown): ValidatedCall {
    if (
      !Array.isArray(output) ||
      output.length < 1 ||
      output.length > MAX_ITEMS
    )
      throw new ResponsesFault("invalid_response");
    const history: InputItem[] = [];
    const ids = new Set<string>();
    let call: CallIdentity | undefined;
    for (const [at, value] of (output as unknown[]).entries()) {
      const item = record(value);
      if (
        !item ||
        !knownItem(item) ||
        !validId(item.id) ||
        (item.status !== undefined && item.status !== "completed")
      )
        throw new ResponsesFault("invalid_response");
      if (ids.has(item.id) || item.id === call?.callId)
        throw new ResponsesFault("duplicate_call");
      ids.add(item.id);
      const observed = this.items.get(at);
      if (observed && (observed.id !== item.id || observed.type !== item.type))
        throw new ResponsesFault("invalid_response");
      let returned = item;
      if (item.type === "function_call") {
        if (call) throw new ResponsesFault("duplicate_call");
        call = callIdentity(item);
        if (ids.has(call.callId)) throw new ResponsesFault("duplicate_call");
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
        for (const raw of item.content as unknown[]) {
          const content = record(raw);
          if (
            !content ||
            content.type !== "output_text" ||
            typeof content.text !== "string"
          )
            throw new ResponsesFault("invalid_response");
        }
      } else {
        // For store:false, the SDK documents the completed reasoning item from
        // output_item.done as the source of encrypted continuation context.
        const done = observed?.doneReasoning;
        if (
          done &&
          typeof done.encrypted_content === "string" &&
          done.encrypted_content !== ""
        ) {
          if (
            typeof item.encrypted_content === "string" &&
            item.encrypted_content !== done.encrypted_content
          )
            throw new ResponsesFault("invalid_response");
          returned = done;
        }
        if (
          (returned.status !== undefined && returned.status !== "completed") ||
          !Array.isArray(returned.summary) ||
          returned.summary.length > MAX_ITEMS
        )
          throw new ResponsesFault("invalid_response");
      }
      // Exact returned item, including reasoning and assistant phase/context;
      // validated known type and identity, never projected or persisted.
      history.push(returned as unknown as InputItem);
    }
    if ([...this.items.keys()].some((at) => at >= history.length))
      throw new ResponsesFault("invalid_response");
    if (!call) throw new ResponsesFault("invalid_function_call");
    return { history, callId: call.callId };
  }
}

function sameConnection(a: StoredConnection, b: StoredConnection): boolean {
  return (
    a.localId === b.localId &&
    a.clientId === b.clientId &&
    a.issuer === b.issuer &&
    a.subject === b.subject &&
    a.accessToken === b.accessToken
  );
}

/** Exactly two fixed requests with synthetic reservation injection only;
 * the sole local operation is the constant echo, never a tool dispatcher. */
export class SdkToolRoundtrip {
  private busy = false;
  private attempted = false;
  private candidate?: SdkToolRoundtripResult;
  private result?: SdkToolRoundtripResult;
  constructor(private readonly deps: SdkToolRoundtripDependencies) {}
  status(): SdkToolRoundtripStatus {
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
      experiment: SDK_TOOL_EXPERIMENT,
      mode: "offline_only",
      allowanceAvailable,
      ...(this.result ? { result: structuredClone(this.result) } : {}),
    };
  }
  publish(result: SdkToolRoundtripResult): void {
    if (result === this.candidate && !this.result)
      this.result = structuredClone(result);
  }

  async run(
    context: InferenceContext,
    ownerAuthorized: boolean
  ): Promise<SdkToolRoundtripResult> {
    let attempts: 0 | 1 | 2 | null = 0;
    let first: SdkDiagnosticEvidence | undefined;
    let second: SdkDiagnosticEvidence | undefined;
    let functionEchoValidated = false;
    let finalMarkerAcknowledged = false;
    const result = (code: ResponsesCode): SdkToolRoundtripResult => {
      const snapshot: SdkToolRoundtripResult = Object.freeze({
        outcome:
          code === "roundtrip_complete" &&
          functionEchoValidated &&
          finalMarkerAcknowledged
            ? "pass"
            : sdkBlocked(code)
              ? "blocked"
              : "failed",
        code,
        attempts,
        functionEchoValidated,
        finalMarkerAcknowledged,
        ...(first ? { first: Object.freeze({ ...first }) } : {}),
        ...(second ? { second: Object.freeze({ ...second }) } : {}),
      });
      if (
        first?.reservation !== undefined &&
        first.reservation !== "not_started" &&
        !this.candidate
      )
        this.candidate = snapshot;
      return snapshot;
    };
    if (ownerAuthorized !== true) return result("operator_required");
    if (this.busy) return result("operation_busy");
    const authorization = this.deps.authorization;
    if (this.attempted || !authorization) return result("budget_exhausted");
    this.busy = true;
    const echo = new EchoAssembly();
    try {
      const saved = verifySdkConnection(this.deps, context);
      const connection = { ...saved, scopes: [...saved.scopes] };
      const model = context.modelSlug;
      const check = () => {
        const current = verifySdkConnection(this.deps, context);
        if (context.modelSlug !== model)
          throw new ResponsesFault("model_not_selected");
        if (!sameConnection(connection, current))
          throw new SigninFault("reconnect_required");
      };
      const reserve = (step: 1 | 2, evidence: SdkDiagnosticEvidence) => {
        check();
        if (authorization.isAuthorized() !== true)
          throw new SigninFault("budget_exhausted");
        this.attempted = true;
        evidence.reservation = "uncertain";
        attempts = null;
        if (authorization.reserve(step) !== true)
          throw new SigninFault("budget_exhausted");
        evidence.reservation = "reserved";
        attempts = step;
        check();
      };
      const input = firstInput();
      first = emptySdkEvidence();
      reserve(1, first);
      const firstCapture = await consumeSdkStream(
        this.deps,
        context,
        connection,
        first,
        payload(model, input),
        check,
        {
          observe: (event) => echo.observe(event),
          complete: (output) => echo.complete(output),
        }
      );
      echo.clear();
      if (firstCapture.code !== "response_completed")
        return result(firstCapture.code);
      const validated = firstCapture.value;
      if (!validated) return result("invalid_response");
      check();
      // The only local echo is a constant. No dynamic call, dispatcher, raw
      // arguments or external effects; the continuation carries exact IDs.
      const next = payload(model, [
        ...input,
        ...validated.history,
        {
          type: "function_call_output",
          call_id: validated.callId,
          output: OUTPUT,
        },
      ]);
      if (Buffer.byteLength(JSON.stringify(next), "utf8") > MAX_REQUEST_BYTES)
        throw new ResponsesFault("response_limit");
      functionEchoValidated = true;
      second = emptySdkEvidence();
      reserve(2, second);
      const final = await consumeSdkStream(
        this.deps,
        context,
        connection,
        second,
        next,
        check,
        {
          observe: requireFinalTextEvent,
          complete: (output) => {
            if (!sdkTextMarker(output))
              throw new ResponsesFault("missing_acknowledgement");
            return true;
          },
        }
      );
      if (final.code !== "response_completed") return result(final.code);
      check();
      finalMarkerAcknowledged = final.value === true;
      return result(
        finalMarkerAcknowledged ? "roundtrip_complete" : "invalid_response"
      );
    } catch (error) {
      const code = context.cancellation?.cancelled
        ? "cancelled"
        : sdkFailure(error);
      const evidence = second ?? first;
      if (evidence) evidence.primaryFailureCode ??= code;
      return result(code);
    } finally {
      echo.clear();
      this.busy = false;
    }
  }
}
