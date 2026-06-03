/**
 * WebSocket protocol contract for the extension ⇄ webview channel (pure module).
 *
 * Implements the §13 Socket Protocol of docs/ARCHITECTURE.md for Spike R3
 * **Outcome D** (localhost full-duplex WebSocket): the extension is the server,
 * the webview is the client, and every frame is a JSON envelope
 * `{ v, id, type, payload }`. This module owns ONLY the wire *shapes* and the
 * pure (de)serialization + validation helpers — it wires no transport, touches
 * no SDK/DOM/Node, and stays importable from both `src/extension` and
 * `src/webview` across the socket boundary.
 *
 * Envelope (§13):
 * ```
 * { "v": 1, "id": "<uuid>", "type": "...", "payload": {...} }
 * ```
 *
 * Message table (§13):
 * - webview → ext  ({@link ClientMessage}):
 *     `ready`, `user_message`, `confirm_response`, `cancel`, `set_config`
 * - ext → webview  ({@link ServerMessage}):
 *     `config_state`, `assistant_delta`, `assistant_done`, `tool_activity`,
 *     `confirm_request`, `refs_updated`, `error`
 *
 * Phase 7 wires only the `ready` / `user_message` / `cancel` inbound subset and
 * the `assistant_delta` / `assistant_done` / `tool_activity` / `refs_updated` /
 * `error` outbound subset; `set_config` / `config_state` / `confirm_*` are
 * defined-but-unwired here for Phases 9/10. They are all defined regardless.
 */

import { PROTOCOL_VERSION } from "./index.js";

/**
 * Status of a single tool execution as narrated to the webview.
 *
 * Mirrors the literal used by the extension's agent loop
 * (`AgentEvents.toolActivity`); duplicated here rather than imported because
 * `src/shared` must not depend on `src/extension`.
 */
export type ToolActivityStatus = "started" | "ok" | "error";

/* -------------------------------------------------------------------------- */
/* Per-type payloads                                                          */
/* -------------------------------------------------------------------------- */

/** Empty payload, used by envelope-only messages (`ready`, `cancel`). */
export type EmptyPayload = Record<string, never>;

/** `user_message` payload: the user's chat input text. */
export interface UserMessagePayload {
  /** Raw text the user typed into the chat. */
  text: string;
}

/** `confirm_response` payload: the user's answer to a destructive-action plan. */
export interface ConfirmResponsePayload {
  /** Id of the plan being answered (matches a prior `confirm_request`). */
  planId: string;
  /** Whether the user approved the plan. */
  approved: boolean;
}

/** `set_config` payload: optional config updates from the settings UI. */
export interface SetConfigPayload {
  /** New Anthropic API key, if the user is (re)entering one. */
  apiKey?: string;
  /** New model id, if the user is changing it. */
  model?: string;
}

/** `config_state` payload: non-secret config the webview may render. */
export interface ConfigStatePayload {
  /** Whether an API key is present in the host (never the key itself). */
  hasKey: boolean;
  /** The active model id. */
  model: string;
}

/** `assistant_delta` payload: one streamed chunk of assistant text. */
export interface AssistantDeltaPayload {
  /** The incremental text token(s) to append in the UI. */
  text: string;
}

/** `assistant_done` payload: the turn ended. */
export interface AssistantDonePayload {
  /** Terminal `stop_reason` from the Messages API (e.g. `end_turn`). */
  stopReason: string;
}

/** `tool_activity` payload: progress narration around a tool execution. */
export interface ToolActivityPayload {
  /** Tool name (e.g. `live_update_track`). */
  tool: string;
  /** Human-readable one-line summary of the call. */
  summary: string;
  /** Lifecycle status of this tool execution. */
  status: ToolActivityStatus;
}

/** `confirm_request` payload: a destructive batch awaiting approval. */
export interface ConfirmRequestPayload {
  /** Id the webview echoes back in `confirm_response`. */
  planId: string;
  /** Human-readable summary of what will happen. */
  summary: string;
  /** Per-action descriptions to render in the confirm card. */
  actions: string[];
}

/** `refs_updated` payload: fresh/affected refs after a mutation. */
export interface RefsUpdatedPayload {
  /** Serialized semantic refs the agent should re-ground against. */
  refs: string[];
}

/** `error` payload: a loop- or transport-level failure to surface. */
export interface ErrorPayload {
  /** Human-readable failure message. */
  message: string;
}

/* -------------------------------------------------------------------------- */
/* Envelope + message unions                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The protocol-version literal carried by every envelope. Aliases the shared
 * {@link PROTOCOL_VERSION} constant (`1`) at the type level.
 */
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/**
 * Generic envelope shape shared by every message: a versioned, id-tagged,
 * `type`-discriminated frame carrying a per-type `payload`.
 *
 * @typeParam TType - the message's discriminant string literal.
 * @typeParam TPayload - the payload shape for that message type.
 */
export interface Envelope<TType extends string, TPayload> {
  /** Protocol version; always {@link PROTOCOL_VERSION}. */
  v: ProtocolVersion;
  /** Caller-supplied unique id (see {@link message} — ids are NOT minted here). */
  id: string;
  /** Discriminant identifying the message type. */
  type: TType;
  /** Per-type payload. */
  payload: TPayload;
}

/* webview → ext ------------------------------------------------------------ */

/** `ready`: the webview has connected and is ready to receive. */
export type ReadyMessage = Envelope<"ready", EmptyPayload>;
/** `user_message`: the user submitted chat input. */
export type UserMessageMessage = Envelope<"user_message", UserMessagePayload>;
/** `confirm_response`: the user answered a destructive-action plan. */
export type ConfirmResponseMessage = Envelope<
  "confirm_response",
  ConfirmResponsePayload
>;
/** `cancel`: the user requested cancellation of the in-flight turn. */
export type CancelMessage = Envelope<"cancel", EmptyPayload>;
/** `set_config`: the user updated API key and/or model. */
export type SetConfigMessage = Envelope<"set_config", SetConfigPayload>;

/* ext → webview ------------------------------------------------------------ */

/** `config_state`: non-secret config snapshot for the UI. */
export type ConfigStateMessage = Envelope<"config_state", ConfigStatePayload>;
/** `assistant_delta`: a streamed assistant text chunk. */
export type AssistantDeltaMessage = Envelope<
  "assistant_delta",
  AssistantDeltaPayload
>;
/** `assistant_done`: the assistant turn ended. */
export type AssistantDoneMessage = Envelope<
  "assistant_done",
  AssistantDonePayload
>;
/** `tool_activity`: progress narration around a tool call. */
export type ToolActivityMessage = Envelope<
  "tool_activity",
  ToolActivityPayload
>;
/** `confirm_request`: a destructive batch awaiting approval. */
export type ConfirmRequestMessage = Envelope<
  "confirm_request",
  ConfirmRequestPayload
>;
/** `refs_updated`: fresh/affected refs after a mutation. */
export type RefsUpdatedMessage = Envelope<"refs_updated", RefsUpdatedPayload>;
/** `error`: a failure to surface in the UI. */
export type ErrorMessage = Envelope<"error", ErrorPayload>;

/** Discriminated union of every webview → extension message. */
export type ClientMessage =
  | ReadyMessage
  | UserMessageMessage
  | ConfirmResponseMessage
  | CancelMessage
  | SetConfigMessage;

/** Discriminated union of every extension → webview message. */
export type ServerMessage =
  | ConfigStateMessage
  | AssistantDeltaMessage
  | AssistantDoneMessage
  | ToolActivityMessage
  | ConfirmRequestMessage
  | RefsUpdatedMessage
  | ErrorMessage;

/** Discriminated union of every protocol message, either direction. */
export type ProtocolMessage = ClientMessage | ServerMessage;

/** Every legal `type` discriminant across all messages. */
export type MessageType = ProtocolMessage["type"];

/**
 * Maps each {@link MessageType} to its full message shape, for ergonomic
 * generic narrowing (used by {@link message} and {@link isMessageOfType}).
 */
export interface MessageByType {
  ready: ReadyMessage;
  user_message: UserMessageMessage;
  confirm_response: ConfirmResponseMessage;
  cancel: CancelMessage;
  set_config: SetConfigMessage;
  config_state: ConfigStateMessage;
  assistant_delta: AssistantDeltaMessage;
  assistant_done: AssistantDoneMessage;
  tool_activity: ToolActivityMessage;
  confirm_request: ConfirmRequestMessage;
  refs_updated: RefsUpdatedMessage;
  error: ErrorMessage;
}

/** The set of webview → ext discriminants, for runtime classification. */
const CLIENT_TYPES: ReadonlySet<MessageType> = new Set<MessageType>([
  "ready",
  "user_message",
  "confirm_response",
  "cancel",
  "set_config",
]);

/** The set of ext → webview discriminants, for runtime classification. */
const SERVER_TYPES: ReadonlySet<MessageType> = new Set<MessageType>([
  "config_state",
  "assistant_delta",
  "assistant_done",
  "tool_activity",
  "confirm_request",
  "refs_updated",
  "error",
]);

/* -------------------------------------------------------------------------- */
/* Construction & serialization                                               */
/* -------------------------------------------------------------------------- */

/**
 * Mint a protocol envelope for a given `type` and `payload`.
 *
 * **Id generation is deliberately the caller's responsibility.** `src/shared`
 * must stay pure and deterministic — no Node `crypto`, and `Math.random` /
 * `Date.now` are discouraged — so the unique `id` is passed in. The extension
 * and webview supply ids (e.g. via `crypto.randomUUID()` on their side).
 *
 * The payload type is keyed to the message type via {@link MessageByType}, so
 * callers get a compile-time check that the payload matches the discriminant.
 *
 * @typeParam T - the message type discriminant.
 * @param type - the message `type`.
 * @param payload - the payload matching `type`.
 * @param id - caller-supplied unique id for this envelope.
 * @returns a fully-formed {@link ProtocolMessage} of the requested type.
 */
export function message<T extends MessageType>(
  type: T,
  payload: MessageByType[T]["payload"],
  id: string
): MessageByType[T] {
  // Build the generic envelope, then assert to the concrete member. Over a free
  // type parameter `T`, `MessageByType[T]` collapses to the (impossible)
  // intersection of all members, so a direct cast is rejected; we route through
  // `unknown`. The discriminant + payload are guaranteed correct by the
  // signature above, so this localized assertion is sound.
  const envelope: Envelope<T, MessageByType[T]["payload"]> = {
    v: PROTOCOL_VERSION,
    id,
    type,
    payload,
  };
  return envelope as unknown as MessageByType[T];
}

/**
 * Serialize a protocol message to a JSON wire string.
 *
 * Pure and total — `JSON.stringify` of a well-formed message never throws.
 *
 * @param msg - the message to serialize.
 * @returns the JSON string to send over the socket.
 */
export function serialize(msg: ProtocolMessage): string {
  return JSON.stringify(msg);
}

/* -------------------------------------------------------------------------- */
/* Parsing & validation                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Result of {@link parseEnvelope}: a discriminated success/failure with a
 * structured (never-thrown) error string on failure.
 */
export type ParseResult =
  | { ok: true; message: ProtocolMessage }
  | { ok: false; error: string };

/** True if `value` is a non-`null` plain object (record). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True if `value` is a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** True if `value` is an array whose every element is a string. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** True if `value` is a known {@link MessageType} discriminant. */
function isKnownType(value: unknown): value is MessageType {
  return (
    typeof value === "string" &&
    (CLIENT_TYPES.has(value as MessageType) ||
      SERVER_TYPES.has(value as MessageType))
  );
}

/**
 * Validate the `payload` for a known message `type`.
 *
 * @param type - the (already-validated) message discriminant.
 * @param payload - the raw, untrusted payload value.
 * @returns `null` if valid, otherwise a human-readable error reason.
 */
function validatePayload(type: MessageType, payload: unknown): string | null {
  if (!isRecord(payload)) {
    return `payload for "${type}" must be an object`;
  }

  switch (type) {
    case "ready":
    case "cancel":
      // Empty-payload messages: presence of extra keys is tolerated but not
      // required; an object payload is sufficient.
      return null;

    case "user_message":
      return isNonEmptyString(payload.text)
        ? null
        : `"user_message" requires a non-empty string "text"`;

    case "confirm_response":
      if (!isNonEmptyString(payload.planId)) {
        return `"confirm_response" requires a non-empty string "planId"`;
      }
      return typeof payload.approved === "boolean"
        ? null
        : `"confirm_response" requires a boolean "approved"`;

    case "set_config":
      if (payload.apiKey !== undefined && typeof payload.apiKey !== "string") {
        return `"set_config" "apiKey" must be a string when present`;
      }
      return payload.model === undefined || typeof payload.model === "string"
        ? null
        : `"set_config" "model" must be a string when present`;

    case "config_state":
      if (typeof payload.hasKey !== "boolean") {
        return `"config_state" requires a boolean "hasKey"`;
      }
      return typeof payload.model === "string"
        ? null
        : `"config_state" requires a string "model"`;

    case "assistant_delta":
      return typeof payload.text === "string"
        ? null
        : `"assistant_delta" requires a string "text"`;

    case "assistant_done":
      return typeof payload.stopReason === "string"
        ? null
        : `"assistant_done" requires a string "stopReason"`;

    case "tool_activity":
      if (typeof payload.tool !== "string") {
        return `"tool_activity" requires a string "tool"`;
      }
      if (typeof payload.summary !== "string") {
        return `"tool_activity" requires a string "summary"`;
      }
      return payload.status === "started" ||
        payload.status === "ok" ||
        payload.status === "error"
        ? null
        : `"tool_activity" "status" must be "started" | "ok" | "error"`;

    case "confirm_request":
      if (!isNonEmptyString(payload.planId)) {
        return `"confirm_request" requires a non-empty string "planId"`;
      }
      if (typeof payload.summary !== "string") {
        return `"confirm_request" requires a string "summary"`;
      }
      return isStringArray(payload.actions)
        ? null
        : `"confirm_request" requires a string[] "actions"`;

    case "refs_updated":
      return isStringArray(payload.refs)
        ? null
        : `"refs_updated" requires a string[] "refs"`;

    case "error":
      return typeof payload.message === "string"
        ? null
        : `"error" requires a string "message"`;

    default: {
      // Exhaustiveness guard: every MessageType must be handled above.
      const _exhaustive: never = type;
      return `unhandled message type: ${String(_exhaustive)}`;
    }
  }
}

/**
 * Safely parse and structurally validate a raw wire string into a typed
 * {@link ProtocolMessage}.
 *
 * Validates, in order: JSON-parseability, `v === PROTOCOL_VERSION`, `id` is a
 * non-empty string, `type` is a known discriminant, and the `payload` has the
 * required fields of the correct types for that `type`. **Never throws** — all
 * failures return `{ ok: false, error }`.
 *
 * @param raw - the JSON wire string received over the socket.
 * @returns a {@link ParseResult} discriminating success from a structured error.
 */
export function parseEnvelope(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid JSON" };
  }

  if (!isRecord(parsed)) {
    return { ok: false, error: "envelope must be an object" };
  }

  if (parsed.v !== PROTOCOL_VERSION) {
    return {
      ok: false,
      error: `unsupported protocol version: expected ${String(
        PROTOCOL_VERSION
      )}, got ${String(parsed.v)}`,
    };
  }

  if (!isNonEmptyString(parsed.id)) {
    return { ok: false, error: 'envelope requires a non-empty string "id"' };
  }

  if (!isKnownType(parsed.type)) {
    return { ok: false, error: `unknown message type: ${String(parsed.type)}` };
  }

  const payloadError = validatePayload(parsed.type, parsed.payload);
  if (payloadError !== null) {
    return { ok: false, error: payloadError };
  }

  // All structural checks passed; the value conforms to ProtocolMessage.
  return { ok: true, message: parsed as unknown as ProtocolMessage };
}

/* -------------------------------------------------------------------------- */
/* Type guards                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Narrow a {@link ProtocolMessage} to a {@link ClientMessage} (webview → ext).
 *
 * @param msg - the message to classify.
 * @returns `true` if `msg` is a client (inbound) message.
 */
export function isClientMessage(msg: ProtocolMessage): msg is ClientMessage {
  return CLIENT_TYPES.has(msg.type);
}

/**
 * Narrow a {@link ProtocolMessage} to a {@link ServerMessage} (ext → webview).
 *
 * @param msg - the message to classify.
 * @returns `true` if `msg` is a server (outbound) message.
 */
export function isServerMessage(msg: ProtocolMessage): msg is ServerMessage {
  return SERVER_TYPES.has(msg.type);
}

/**
 * Narrow a {@link ProtocolMessage} to a specific message `type`.
 *
 * @typeParam T - the target message type discriminant.
 * @param msg - the message to classify.
 * @param type - the discriminant to match against.
 * @returns `true` if `msg.type === type`, narrowing `msg` to that member.
 */
export function isMessageOfType<T extends MessageType>(
  msg: ProtocolMessage,
  type: T
): msg is MessageByType[T] {
  return msg.type === type;
}
