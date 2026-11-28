import type {
  CompletedTurnBlock,
  LocalToolResultPayload,
  ToolDefinition,
} from "./provider.js";
import { isToolName, TOOL_BY_NAME } from "./tools.js";

export const COMPANION_CHANNEL_VERSION = 1;
export const COMPANION_CHANNEL_LIMITS = Object.freeze({
  snapshotChars: 8000,
  textChars: 32000,
  resultChars: 64000,
  summaryChars: 1024,
  toolDefinitions: 17,
  blocks: 128,
  calls: 64,
  messageChars: 262144,
  messages: 2048,
  queue: 4,
  timeoutMs: 30000,
  jsonDepth: 32,
  jsonNodes: 50000,
});

export interface ChannelBinding {
  pairSessionId: string;
  epoch: number;
  conversationId: string;
  accountRevision: number;
}

export interface ChannelSelection extends ChannelBinding {
  model: string;
}

export type ChannelState =
  | "unopened"
  | "ready"
  | "request_ready"
  | "running"
  | "completed"
  | "awaiting_results"
  | "invalid"
  | "closed";

export type ChannelFaultCode =
  | "invalid_message"
  | "binding_mismatch"
  | "sequence_mismatch"
  | "duplicate_request"
  | "invalid_state"
  | "invalid_continuation"
  | "invalid_results"
  | "limit_exceeded"
  | "provider_failed"
  | "aborted"
  | "disconnected"
  | "timeout";

export class ChannelFault extends Error {
  constructor(readonly code: ChannelFaultCode) {
    super(code);
    this.name = "ChannelFault";
  }
}

export type ChannelClientBody =
  | { type: "open"; model: string }
  | { type: "append_user_text"; text: string }
  | { type: "run_turn"; tools: ToolDefinition[]; snapshot?: string }
  | { type: "commit_assistant"; continuationId: string }
  | { type: "append_tool_results"; results: LocalToolResultPayload[] }
  | { type: "cancel"; targetRequestId: string }
  | { type: "status" }
  | { type: "close" };

export type ChannelAckOperation = Exclude<
  ChannelClientBody["type"],
  "run_turn" | "status"
>;

export type ChannelServerBody =
  | { type: "ack"; operation: ChannelAckOperation }
  | { type: "delta"; text: string }
  | {
      type: "completed";
      continuationId: string;
      stopReason: "end_turn" | "tool_use";
      blocks: CompletedTurnBlock[];
    }
  | { type: "failure"; code: ChannelFaultCode }
  | { type: "status"; state: ChannelState };

export interface ChannelEnvelope<Body> extends ChannelBinding {
  version: typeof COMPANION_CHANNEL_VERSION;
  requestId: string;
  sequence: number;
  body: Body;
}

export type ChannelClientMessage = ChannelEnvelope<ChannelClientBody>;
export type ChannelServerMessage = ChannelEnvelope<ChannelServerBody>;
export type ChannelMessage = ChannelClientMessage | ChannelServerMessage;

/** Trusted synthetic transport seam. No pairing, authentication, or I/O is
 * implemented here. A disconnect is terminal for both bound state machines. */
export interface CompanionChannelEndpoint {
  send(message: ChannelMessage): void;
  subscribe(
    receive: (message: unknown) => void,
    disconnected: () => void
  ): () => void;
  disconnect(): void;
}

const states: readonly ChannelState[] = [
  "unopened",
  "ready",
  "request_ready",
  "running",
  "completed",
  "awaiting_results",
  "invalid",
  "closed",
];
const faults: readonly ChannelFaultCode[] = [
  "invalid_message",
  "binding_mismatch",
  "sequence_mismatch",
  "duplicate_request",
  "invalid_state",
  "invalid_continuation",
  "invalid_results",
  "limit_exceeded",
  "provider_failed",
  "aborted",
  "disconnected",
  "timeout",
];
const ackOperations: readonly ChannelAckOperation[] = [
  "open",
  "append_user_text",
  "commit_assistant",
  "append_tool_results",
  "cancel",
  "close",
];

function reject(): never {
  throw new ChannelFault("invalid_message");
}

function row(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null
    ? (value as Record<string, unknown>)
    : undefined;
}

function exact(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> {
  const record = row(value);
  if (
    !record ||
    !required.every((key) => Object.hasOwn(record, key)) ||
    Object.keys(record).some(
      (key) => !required.includes(key) && !optional.includes(key)
    )
  )
    reject();
  return record;
}

function string(value: unknown, max: number, min = 0): value is string {
  return (
    typeof value === "string" && value.length >= min && value.length <= max
  );
}

function id(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function model(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value);
}

function toolId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/\s/u.test(value) &&
    [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
  );
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function list(value: unknown, max: number): value is unknown[] {
  return Array.isArray(value) && value.length <= max;
}

/** Bound plain JSON before serialization, rejecting accessors, sparse arrays,
 * non-JSON values, cycles, symbols and excessive nesting or aggregate size.
 * The character cap is conservative for the in-memory lane; C2 must apply
 * its own byte/frame cap before decoding any network input. */
function boundedJson(value: unknown): string {
  let nodes = 0;
  let chars = 0;
  const active = new Set<object>();
  const add = (amount: number): void => {
    chars += amount;
    if (chars > COMPANION_CHANNEL_LIMITS.messageChars)
      throw new ChannelFault("limit_exceeded");
  };
  function visit(item: unknown, depth: number): void {
    if (
      ++nodes > COMPANION_CHANNEL_LIMITS.jsonNodes ||
      depth > COMPANION_CHANNEL_LIMITS.jsonDepth
    )
      throw new ChannelFault("limit_exceeded");
    add(1);
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item === "string") {
      add(item.length);
      return;
    }
    if (typeof item !== "object" || active.has(item)) reject();
    if (
      Array.isArray(item)
        ? Object.getPrototypeOf(item) !== Array.prototype
        : !row(item)
    )
      reject();
    active.add(item);
    const keys = Reflect.ownKeys(item);
    if (Array.isArray(item)) {
      if (
        item.length > COMPANION_CHANNEL_LIMITS.jsonNodes ||
        keys.length !== item.length + 1
      )
        reject();
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
          reject();
        visit(descriptor.value, depth + 1);
      }
    } else {
      for (const key of keys) {
        if (typeof key !== "string") reject();
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
          reject();
        add(key.length);
        visit(descriptor.value, depth + 1);
      }
    }
    active.delete(item);
  }
  visit(value, 0);
  const serialized = JSON.stringify(value);
  if (serialized.length > COMPANION_CHANNEL_LIMITS.messageChars)
    throw new ChannelFault("limit_exceeded");
  return serialized;
}

function equalJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a))
    return (
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => equalJson(item, b[index]))
    );
  const left = row(a);
  const right = row(b);
  return (
    !!left &&
    !!right &&
    Object.keys(left).length === Object.keys(right).length &&
    Object.keys(left).every(
      (key) => Object.hasOwn(right, key) && equalJson(left[key], right[key])
    )
  );
}

function validateBinding(value: Record<string, unknown>): void {
  if (
    !id(value.pairSessionId) ||
    !integer(value.epoch) ||
    !id(value.conversationId) ||
    !integer(value.accountRevision)
  )
    reject();
}

/** Verify and copy the server-selected pairing/conversation/model tuple. */
export function validateChannelSelection(value: unknown): ChannelSelection {
  const copy: unknown = JSON.parse(boundedJson(value));
  const record = exact(copy, [
    "pairSessionId",
    "epoch",
    "conversationId",
    "accountRevision",
    "model",
  ]);
  validateBinding(record);
  if (!model(record.model)) reject();
  return Object.freeze({
    pairSessionId: record.pairSessionId as string,
    epoch: record.epoch as number,
    conversationId: record.conversationId as string,
    accountRevision: record.accountRevision as number,
    model: record.model,
  });
}

/** Compare the wire binding to the fixed pairing selection (not request data). */
export function sameChannelBinding(
  a: ChannelBinding,
  b: ChannelBinding
): boolean {
  return (
    a.pairSessionId === b.pairSessionId &&
    a.epoch === b.epoch &&
    a.conversationId === b.conversationId &&
    a.accountRevision === b.accountRevision
  );
}

/** Construct a directional envelope without accidentally serializing the model
 * or private provider state as part of its binding. */
export function channelEnvelope<
  Body extends ChannelClientBody | ChannelServerBody,
>(
  binding: ChannelBinding,
  requestId: string,
  sequence: number,
  body: Body
): ChannelEnvelope<Body> {
  return {
    version: COMPANION_CHANNEL_VERSION,
    pairSessionId: binding.pairSessionId,
    epoch: binding.epoch,
    conversationId: binding.conversationId,
    accountRevision: binding.accountRevision,
    requestId,
    sequence,
    body,
  };
}

function validateTools(value: unknown): void {
  if (!list(value, COMPANION_CHANNEL_LIMITS.toolDefinitions)) reject();
  const seen = new Set<string>();
  for (const candidate of value) {
    const tool = row(candidate);
    if (
      !tool ||
      typeof tool.name !== "string" ||
      !isToolName(tool.name) ||
      seen.has(tool.name) ||
      !equalJson(tool, TOOL_BY_NAME[tool.name])
    )
      reject();
    seen.add(tool.name);
  }
}

function validateResults(value: unknown): void {
  if (!list(value, COMPANION_CHANNEL_LIMITS.calls) || value.length === 0)
    reject();
  const seen = new Set<string>();
  for (const candidate of value) {
    const result = exact(
      candidate,
      ["toolUseId", "content"],
      ["isError", "summary"]
    );
    if (
      !toolId(result.toolUseId) ||
      seen.has(result.toolUseId) ||
      !string(result.content, COMPANION_CHANNEL_LIMITS.resultChars) ||
      (Object.hasOwn(result, "isError") &&
        typeof result.isError !== "boolean") ||
      (Object.hasOwn(result, "summary") &&
        !string(result.summary, COMPANION_CHANNEL_LIMITS.summaryChars))
    )
      reject();
    seen.add(result.toolUseId);
  }
}

function validateCompleted(body: Record<string, unknown>): void {
  if (
    !id(body.continuationId) ||
    !list(body.blocks, COMPANION_CHANNEL_LIMITS.blocks)
  )
    reject();
  const seen = new Set<string>();
  for (const candidate of body.blocks) {
    const block = row(candidate);
    if (block?.type === "text") {
      exact(block, ["type", "text"]);
      if (!string(block.text, COMPANION_CHANNEL_LIMITS.textChars)) reject();
    } else if (block?.type === "tool_call") {
      exact(block, ["type", "call"]);
      const call = exact(block.call, ["id", "name", "input"]);
      if (
        !toolId(call.id) ||
        seen.has(call.id) ||
        typeof call.name !== "string" ||
        !isToolName(call.name) ||
        !row(call.input)
      )
        reject();
      seen.add(call.id);
    } else reject();
  }
  if (
    seen.size > COMPANION_CHANNEL_LIMITS.calls ||
    body.stopReason !== (seen.size ? "tool_use" : "end_turn")
  )
    reject();
}

function decode(value: unknown): Record<string, unknown> {
  try {
    const copy: unknown = JSON.parse(boundedJson(value));
    const message = exact(copy, [
      "version",
      "pairSessionId",
      "epoch",
      "conversationId",
      "accountRevision",
      "requestId",
      "sequence",
      "body",
    ]);
    validateBinding(message);
    if (
      message.version !== COMPANION_CHANNEL_VERSION ||
      !id(message.requestId) ||
      !integer(message.sequence) ||
      message.sequence > COMPANION_CHANNEL_LIMITS.messages
    )
      reject();
    return message;
  } catch (error) {
    if (error instanceof ChannelFault) throw error;
    return reject();
  }
}

/** Validate and detach a client message, enforcing an exact allowlisted schema. */
export function decodeClientMessage(value: unknown): ChannelClientMessage {
  const message = decode(value);
  const body = row(message.body);
  switch (body?.type) {
    case "open":
      exact(body, ["type", "model"]);
      if (!model(body.model)) reject();
      break;
    case "append_user_text":
      exact(body, ["type", "text"]);
      if (!string(body.text, COMPANION_CHANNEL_LIMITS.textChars, 1)) reject();
      break;
    case "run_turn":
      exact(body, ["type", "tools"], ["snapshot"]);
      validateTools(body.tools);
      if (
        Object.hasOwn(body, "snapshot") &&
        !string(body.snapshot, COMPANION_CHANNEL_LIMITS.snapshotChars)
      )
        reject();
      break;
    case "commit_assistant":
      exact(body, ["type", "continuationId"]);
      if (!id(body.continuationId)) reject();
      break;
    case "append_tool_results":
      exact(body, ["type", "results"]);
      validateResults(body.results);
      break;
    case "cancel":
      exact(body, ["type", "targetRequestId"]);
      if (!id(body.targetRequestId)) reject();
      break;
    case "status":
    case "close":
      exact(body, ["type"]);
      break;
    default:
      reject();
  }
  return message as unknown as ChannelClientMessage;
}

/** Validate and detach a server message; no raw provider continuation can cross. */
export function decodeServerMessage(value: unknown): ChannelServerMessage {
  const message = decode(value);
  const body = row(message.body);
  switch (body?.type) {
    case "ack":
      exact(body, ["type", "operation"]);
      if (!ackOperations.includes(body.operation as ChannelAckOperation))
        reject();
      break;
    case "delta":
      exact(body, ["type", "text"]);
      if (!string(body.text, COMPANION_CHANNEL_LIMITS.textChars)) reject();
      break;
    case "completed":
      exact(body, ["type", "continuationId", "stopReason", "blocks"]);
      validateCompleted(body);
      break;
    case "failure":
      exact(body, ["type", "code"]);
      if (!faults.includes(body.code as ChannelFaultCode)) reject();
      break;
    case "status":
      exact(body, ["type", "state"]);
      if (!states.includes(body.state as ChannelState)) reject();
      break;
    default:
      reject();
  }
  return message as unknown as ChannelServerMessage;
}

/** Deep-freeze a detached validated JSON projection for identity-sensitive use. */
export function freezeChannelValue<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeChannelValue(child);
    Object.freeze(value);
  }
  return value;
}

/** Only known fixed error codes can be exported, never arbitrary exception text. */
export function channelFaultCode(error: unknown): ChannelFaultCode {
  return error instanceof ChannelFault && faults.includes(error.code)
    ? error.code
    : "provider_failed";
}
