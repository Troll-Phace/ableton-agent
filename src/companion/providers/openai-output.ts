import { isDeepStrictEqual } from "node:util";

import type { CompletedTurnBlock } from "../../shared/provider.js";
import type { OpenAiHistoryOutputItem } from "./openai-history.js";
import type { OpenAiToolSet } from "./openai-tools.js";

export const OPENAI_MAX_OUTPUT_ITEMS = 128;
export const OPENAI_MAX_ARGUMENT_BYTES = 128 * 1024;

export class OpenAiOutputFault extends Error {
  constructor(
    readonly code: "invalid_response" | "invalid_arguments" | "response_limit"
  ) {
    super(code);
    this.name = "OpenAiOutputFault";
  }
}

export function responseRecord(
  value: unknown
): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function invalid(): never {
  throw new OpenAiOutputFault("invalid_response");
}

function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/\s/u.test(value) &&
    [...value].every(
      (char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127
    )
  );
}

function index(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < OPENAI_MAX_OUTPUT_ITEMS
    ? value
    : undefined;
}

function argumentString(value: unknown): string {
  if (typeof value !== "string")
    throw new OpenAiOutputFault("invalid_arguments");
  if (
    value.length > OPENAI_MAX_ARGUMENT_BYTES ||
    Buffer.byteLength(value, "utf8") > OPENAI_MAX_ARGUMENT_BYTES
  )
    throw new OpenAiOutputFault("response_limit");
  return value;
}

/** JSON.parse alone silently accepts duplicate members. Scan the bounded
 * valid JSON grammar, decoding each key as JSON to detect escaped equivalents
 * in every nested object. The original provider argument string is retained. */
export function parseUniqueArguments(value: unknown): Record<string, unknown> {
  const text = argumentString(value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new OpenAiOutputFault("invalid_arguments");
  }
  const object = responseRecord(parsed);
  if (!object) throw new OpenAiOutputFault("invalid_arguments");
  let at = 0;
  let nodes = 0;
  const white = () => {
    while (at < text.length && /[ \t\r\n]/.test(text[at])) at++;
  };
  function scanString(): string {
    const start = at++;
    while (at < text.length) {
      const char = text[at++];
      if (char === "\\") at++;
      else if (char === '"') return JSON.parse(text.slice(start, at)) as string;
    }
    throw new OpenAiOutputFault("invalid_arguments");
  }
  function scan(depth: number): void {
    if (++nodes > 25_000 || depth > 64)
      throw new OpenAiOutputFault("response_limit");
    white();
    const char = text[at];
    if (char === "{") {
      at++;
      white();
      const keys = new Set<string>();
      if (text[at] !== "}") {
        for (;;) {
          const key = scanString();
          if (keys.has(key)) throw new OpenAiOutputFault("invalid_arguments");
          keys.add(key);
          white();
          at++; // JSON.parse already verified the colon.
          scan(depth + 1);
          white();
          if (text[at] !== ",") break;
          at++;
          white();
        }
      }
      at++;
    } else if (char === "[") {
      at++;
      white();
      if (text[at] !== "]") {
        for (;;) {
          scan(depth + 1);
          white();
          if (text[at] !== ",") break;
          at++;
        }
      }
      at++;
    } else if (char === '"') {
      scanString();
    } else {
      const start = at;
      while (at < text.length && !/[\s,\]}]/.test(text[at])) at++;
      if (
        (char === "-" || (char >= "0" && char <= "9")) &&
        !Number.isFinite(Number(text.slice(start, at)))
      )
        throw new OpenAiOutputFault("invalid_arguments");
    }
  }
  scan(0);
  white();
  if (at !== text.length) throw new OpenAiOutputFault("invalid_arguments");
  return object;
}

type OutputKind = "message" | "reasoning" | "function_call";
interface CallIdentity {
  id: string;
  callId: string;
  name: string;
}
interface Observation {
  id: string;
  kind: OutputKind;
  call?: CallIdentity;
  argumentsText: string;
  sawDelta: boolean;
  finalArguments?: string;
  done?: Record<string, unknown>;
}

export interface ValidatedOpenAiOutput {
  output: OpenAiHistoryOutputItem[];
  blocks: CompletedTurnBlock[];
}

function kind(item: Record<string, unknown>): OutputKind {
  if (
    item.type === "message" ||
    item.type === "reasoning" ||
    item.type === "function_call"
  )
    return item.type;
  return invalid();
}

function sameCall(
  a: CallIdentity | undefined,
  b: CallIdentity | undefined
): boolean {
  return a === undefined
    ? b === undefined
    : b !== undefined &&
        a.id === b.id &&
        a.callId === b.callId &&
        a.name === b.name;
}

const passiveEvents = new Set([
  "response.created",
  "response.queued",
  "response.in_progress",
  "response.content_part.added",
  "response.content_part.done",
  "response.output_text.annotation.added",
  "response.reasoning_summary_part.added",
  "response.reasoning_summary_part.done",
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_text.done",
  "response.reasoning_text.delta",
  "response.reasoning_text.done",
]);

/** Correlate item/argument evidence without ever yielding executable calls
 * from stream fragments. Only the completed terminal produces canonical blocks. */
export class OpenAiOutputValidator {
  readonly #items = new Map<number, Observation>();
  constructor(private readonly tools: OpenAiToolSet) {}

  private call(item: Record<string, unknown>): CallIdentity {
    const name = this.tools.resolveLocalToolName(item.namespace, item.name);
    if (
      !name ||
      !validId(item.id) ||
      !validId(item.call_id) ||
      item.id === item.call_id ||
      (item.async !== undefined && item.async !== false) ||
      (item.caller != null && responseRecord(item.caller)?.type !== "direct")
    )
      return invalid();
    return { id: item.id, callId: item.call_id, name };
  }

  private observeItem(event: Record<string, unknown>): void {
    const at = index(event.output_index);
    const item = responseRecord(event.item);
    if (at === undefined || !item || !validId(item.id)) return invalid();
    const type = kind(item);
    const done = event.type === "response.output_item.done";
    if (
      item.status !== undefined &&
      item.status !== "completed" &&
      (done || item.status !== "in_progress")
    )
      return invalid();
    const call = type === "function_call" ? this.call(item) : undefined;
    const args = call ? argumentString(item.arguments) : "";
    if (call && done) parseUniqueArguments(args);
    const old = this.#items.get(at);
    if ((!done && old) || (done && old?.done)) return invalid();
    for (const [otherIndex, other] of this.#items) {
      if (
        at !== otherIndex &&
        (other.id === item.id ||
          other.call?.callId === item.id ||
          (call &&
            (other.id === call.callId || other.call?.callId === call.callId)))
      )
        return invalid();
    }
    if (old) {
      if (old.id !== item.id || old.kind !== type || !sameCall(old.call, call))
        return invalid();
      if (
        done &&
        call &&
        (((old.sawDelta || old.argumentsText !== "") &&
          old.argumentsText !== args) ||
          (old.finalArguments !== undefined && old.finalArguments !== args))
      )
        throw new OpenAiOutputFault("invalid_arguments");
      if (done) {
        old.done = item;
        if (call) old.finalArguments = args;
      }
      return;
    }
    this.#items.set(at, {
      id: item.id,
      kind: type,
      call,
      argumentsText: done ? "" : args,
      sawDelta: false,
      ...(done
        ? { done: item, ...(call ? { finalArguments: args } : {}) }
        : {}),
    });
  }

  private observeArguments(event: Record<string, unknown>): void {
    const at = index(event.output_index);
    const found =
      at === undefined
        ? [...this.#items.values()].find((item) => item.id === event.item_id)
        : this.#items.get(at);
    if (
      !found?.call ||
      found.id !== event.item_id ||
      found.done ||
      (event.output_index !== undefined && at === undefined) ||
      (event.call_id !== undefined && event.call_id !== found.call.callId) ||
      (event.name !== undefined && event.name !== found.call.name) ||
      (event.namespace !== undefined &&
        this.tools.resolveLocalToolName(event.namespace, found.call.name) !==
          found.call.name) ||
      found.finalArguments !== undefined
    )
      return invalid();
    if (event.type === "response.function_call_arguments.delta") {
      const fragment = argumentString(event.delta);
      found.argumentsText = argumentString(found.argumentsText + fragment);
      found.sawDelta = true;
    } else {
      const args = argumentString(event.arguments);
      parseUniqueArguments(args);
      if (
        (found.sawDelta || found.argumentsText !== "") &&
        found.argumentsText !== args
      )
        throw new OpenAiOutputFault("invalid_arguments");
      found.finalArguments = args;
    }
  }

  /** Return only displayable text/refusal deltas. Never project reasoning,
   * tool arguments, IDs or provider metadata through the display sink. */
  observe(event: Record<string, unknown>): string | undefined {
    switch (event.type) {
      case "response.output_item.added":
      case "response.output_item.done":
        this.observeItem(event);
        return undefined;
      case "response.function_call_arguments.delta":
      case "response.function_call_arguments.done":
        this.observeArguments(event);
        return undefined;
      case "response.output_text.delta":
      case "response.refusal.delta":
        if (typeof event.delta !== "string") return invalid();
        return event.delta;
      case "response.output_text.done":
        if (typeof event.text !== "string") return invalid();
        return undefined;
      case "response.refusal.done":
        if (typeof event.refusal !== "string") return invalid();
        return undefined;
      default:
        if (typeof event.type === "string" && passiveEvents.has(event.type))
          return undefined;
        return invalid();
    }
  }

  private reasoning(
    terminal: Record<string, unknown>,
    done: Record<string, unknown> | undefined
  ): Record<string, unknown> {
    let item = terminal;
    if (done) {
      const {
        encrypted_content: terminalEncrypted,
        status: terminalStatus,
        ...terminalRest
      } = terminal;
      const {
        encrypted_content: doneEncrypted,
        status: doneStatus,
        ...doneRest
      } = done;
      if (
        !isDeepStrictEqual(terminalRest, doneRest) ||
        (terminalStatus !== undefined &&
          doneStatus !== undefined &&
          terminalStatus !== doneStatus) ||
        (typeof terminalEncrypted === "string" &&
          terminalEncrypted !== "" &&
          typeof doneEncrypted === "string" &&
          doneEncrypted !== "" &&
          terminalEncrypted !== doneEncrypted)
      )
        return invalid();
      // The SDK documents output_item.done as the source of complete encrypted
      // reasoning with store:false. Use matching provider data, never synthesize.
      if (
        (terminalEncrypted === undefined ||
          terminalEncrypted === null ||
          terminalEncrypted === "") &&
        typeof doneEncrypted === "string" &&
        doneEncrypted !== ""
      )
        item = done;
    }
    if (
      typeof item.encrypted_content !== "string" ||
      item.encrypted_content === "" ||
      !Array.isArray(item.summary) ||
      !(item.summary as unknown[]).every((raw) => {
        const part = responseRecord(raw);
        return part?.type === "summary_text" && typeof part.text === "string";
      }) ||
      (item.content !== undefined &&
        (!Array.isArray(item.content) ||
          !(item.content as unknown[]).every((raw) => {
            const part = responseRecord(raw);
            return (
              part?.type === "reasoning_text" && typeof part.text === "string"
            );
          })))
    )
      return invalid();
    return item;
  }

  /** Validate the whole ordered terminal, including exact IDs, namespace,
   * names, fully assembled inputs and the required opaque reasoning history. */
  complete(value: unknown): ValidatedOpenAiOutput {
    if (!Array.isArray(value) || value.length === 0) return invalid();
    if (value.length > OPENAI_MAX_OUTPUT_ITEMS)
      throw new OpenAiOutputFault("response_limit");
    const output: OpenAiHistoryOutputItem[] = [];
    const blocks: CompletedTurnBlock[] = [];
    const ids = new Set<string>();
    let refusal = false;
    let calls = 0;
    for (const [at, raw] of (value as unknown[]).entries()) {
      let item = responseRecord(raw);
      if (
        !item ||
        !validId(item.id) ||
        ids.has(item.id) ||
        (item.status !== undefined && item.status !== "completed")
      )
        return invalid();
      const type = kind(item);
      ids.add(item.id);
      const observed = this.#items.get(at);
      if (observed && (observed.id !== item.id || observed.kind !== type))
        return invalid();
      if (type === "function_call") {
        const call = this.call(item);
        const args = argumentString(item.arguments);
        const input = parseUniqueArguments(args);
        if (
          ids.has(call.callId) ||
          (observed &&
            (!sameCall(observed.call, call) ||
              ((observed.sawDelta || observed.argumentsText !== "") &&
                observed.argumentsText !== args) ||
              (observed.finalArguments !== undefined &&
                observed.finalArguments !== args)))
        )
          return invalid();
        ids.add(call.callId);
        calls++;
        blocks.push({
          type: "tool_call",
          call: { id: call.callId, name: call.name, input },
        });
      } else if (type === "message") {
        if (
          item.role !== "assistant" ||
          item.status !== "completed" ||
          !Array.isArray(item.content)
        )
          return invalid();
        for (const content of item.content as unknown[]) {
          const part = responseRecord(content);
          if (
            part?.type === "output_text" &&
            typeof part.text === "string" &&
            Array.isArray(part.annotations)
          )
            blocks.push({ type: "text", text: part.text });
          else if (
            part?.type === "refusal" &&
            typeof part.refusal === "string"
          ) {
            refusal = true;
            blocks.push({ type: "text", text: part.refusal });
          } else return invalid();
        }
      } else item = this.reasoning(item, observed?.done);
      if (
        type !== "reasoning" &&
        observed?.done &&
        !isDeepStrictEqual(item, observed.done)
      )
        return invalid();
      // SDK parsed a JSON item. Its supported type, terminal status and
      // executable fields were validated above; retain all provider metadata.
      output.push(item as unknown as OpenAiHistoryOutputItem);
    }
    if (
      [...this.#items.keys()].some((at) => at >= output.length) ||
      blocks.length === 0 ||
      (refusal && calls > 0)
    )
      return invalid();
    return { output, blocks };
  }

  clear(): void {
    this.#items.clear();
  }
}
