import { isDeepStrictEqual } from "node:util";
import type OpenAI from "openai";

import type {
  CompletedTurn,
  CompletedTurnBlock,
  ToolResultPayload,
} from "../../shared/provider.js";
import { isToolName } from "../../shared/tools.js";
import { OPENAI_TOOL_NAMESPACE } from "./openai-tools.js";

export const OPENAI_PROVIDER = "openai_responses" as const;
export const OPENAI_HISTORY_MAX_BYTES = 1024 * 1024;
export const OPENAI_HISTORY_MAX_ITEMS = 256;
export const OPENAI_SNAPSHOT_MAX_CHARS = 8000;

export interface OpenAiHistoryBinding {
  provider: typeof OPENAI_PROVIDER;
  /** A host-generated opaque account handle, never a token or email. */
  accountBinding: string;
  conversationId: string;
  model: string;
}

export interface OpenAiHistoryLimits {
  maxBytes: number;
  maxItems: number;
  maxSnapshotChars: number;
}

export type OpenAiHistoryState =
  | "ready"
  | "request_in_flight"
  | "completed_pending_append"
  | "awaiting_results"
  | "disposed";

export type OpenAiHistoryFaultCode =
  | "invalid_binding"
  | "binding_mismatch"
  | "invalid_state"
  | "invalid_request"
  | "invalid_snapshot"
  | "invalid_output"
  | "invalid_continuation"
  | "invalid_results"
  | "history_limit";

/** Fixed codes only; never expose history, account handles or provider data. */
export class OpenAiHistoryFault extends Error {
  constructor(readonly code: OpenAiHistoryFaultCode) {
    super(code);
    this.name = "OpenAiHistoryFault";
  }
}

type InputItem = OpenAI.Responses.ResponseInputItem;
export type OpenAiHistoryOutputItem =
  | OpenAI.Responses.ResponseOutputMessage
  | OpenAI.Responses.ResponseReasoningItem
  | OpenAI.Responses.ResponseFunctionToolCall;

/** A one-use request handle. Input is a detached, immutable provider payload;
 * it is for the companion adapter only, not a public conversation export. */
export interface OpenAiHistoryRequest {
  readonly input: InputItem[];
}

/** Keep provider input out of incidental JSON/status serialization. Once a
 * request settles, its handle cannot be used to retrieve private history. */
class IssuedRequest implements OpenAiHistoryRequest {
  #input?: InputItem[];
  constructor(input: InputItem[]) {
    this.#input = input;
    Object.freeze(this);
  }
  get input(): InputItem[] {
    if (!this.#input) throw new OpenAiHistoryFault("invalid_request");
    return this.#input;
  }
  release(): void {
    this.#input = undefined;
  }
}

export interface OpenAiHistoryStatus {
  state: OpenAiHistoryState;
  items: number;
  bytes: number;
  expectedResults: number;
  requestReady: boolean;
}

interface ActiveRequest {
  handle: IssuedRequest;
  input: InputItem[];
  completion?: {
    turn: CompletedTurn;
    history: InputItem[];
    callIds: string[];
  };
}

const defaults: OpenAiHistoryLimits = {
  maxBytes: OPENAI_HISTORY_MAX_BYTES,
  maxItems: OPENAI_HISTORY_MAX_ITEMS,
  maxSnapshotChars: OPENAI_SNAPSHOT_MAX_CHARS,
};

function opaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function validModel(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value);
}

function validItemId(value: unknown): value is string {
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

function row(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Runtime array check without widening an already typed readonly array. */
function isArrayValue(value: unknown): boolean {
  return Array.isArray(value);
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

/** Accept only bounded, JSON-shaped provider data. Detect cycles and unusual
 * objects before cloning; no lossy projection or JSON stringify/parse copy. */
function jsonBytes(value: unknown, maxBytes: number): number {
  const active = new Set<object>();
  let nodes = 0;
  let lowerBound = 0;
  function account(bytes: number): void {
    lowerBound += bytes;
    if (lowerBound > maxBytes) throw new OpenAiHistoryFault("history_limit");
  }
  function check(item: unknown, depth: number): void {
    if (++nodes > 100_000 || depth > 64)
      throw new OpenAiHistoryFault("history_limit");
    if (item === null || typeof item === "boolean" || item === undefined)
      return;
    if (typeof item === "string") {
      if (item.length > maxBytes) throw new OpenAiHistoryFault("history_limit");
      account(Buffer.byteLength(item, "utf8"));
      return;
    }
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (
      typeof item !== "object" ||
      (!Array.isArray(item) && !row(item)) ||
      active.has(item)
    )
      throw new OpenAiHistoryFault("invalid_output");
    active.add(item);
    if (Array.isArray(item)) {
      // Even a sparse array requires at least one serialized byte per entry.
      account(item.length);
      for (const child of item as unknown[]) check(child, depth + 1);
    } else {
      for (const [key, child] of Object.entries(item)) {
        if (child !== undefined) account(Buffer.byteLength(key, "utf8"));
        check(child, depth + 1);
      }
    }
    active.delete(item);
  }
  check(value, 0);
  const json = JSON.stringify(value);
  if (typeof json !== "string") throw new OpenAiHistoryFault("invalid_output");
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > maxBytes) throw new OpenAiHistoryFault("history_limit");
  return bytes;
}

/** Maintain a single private, explicitly bound Responses history. Transport
 * and streamed-terminal validation belong to the later adapter. This module
 * never sends a request, opens storage, imports legacy conversations or retries. */
export class OpenAiHistory {
  readonly #binding: Readonly<OpenAiHistoryBinding>;
  readonly #limits: Readonly<OpenAiHistoryLimits>;
  #state: OpenAiHistoryState = "ready";
  #history: InputItem[] = [];
  #bytes = 2;
  #nextRequest?: "user" | "results";
  #active?: ActiveRequest;
  #expected: string[] = [];

  constructor(
    binding: OpenAiHistoryBinding,
    limits: Partial<OpenAiHistoryLimits> = {}
  ) {
    if (
      !row(binding) ||
      binding.provider !== OPENAI_PROVIDER ||
      !opaqueId(binding.accountBinding) ||
      !opaqueId(binding.conversationId) ||
      !validModel(binding.model)
    )
      throw new OpenAiHistoryFault("invalid_binding");
    this.#binding = Object.freeze({
      provider: OPENAI_PROVIDER,
      accountBinding: binding.accountBinding,
      conversationId: binding.conversationId,
      model: binding.model,
    });
    const chosen = {
      maxBytes: limits.maxBytes ?? defaults.maxBytes,
      maxItems: limits.maxItems ?? defaults.maxItems,
      maxSnapshotChars: limits.maxSnapshotChars ?? defaults.maxSnapshotChars,
    };
    for (const key of ["maxBytes", "maxItems", "maxSnapshotChars"] as const) {
      if (
        !Number.isSafeInteger(chosen[key]) ||
        chosen[key] < (key === "maxBytes" ? 2 : 1) ||
        chosen[key] > defaults[key]
      )
        throw new OpenAiHistoryFault("history_limit");
    }
    this.#limits = Object.freeze(chosen);
  }

  /** Check the selected account/conversation/model for each adapter request. */
  assertBinding(binding: OpenAiHistoryBinding): void {
    this.requireLive();
    if (
      !row(binding) ||
      binding.provider !== this.#binding.provider ||
      binding.accountBinding !== this.#binding.accountBinding ||
      binding.conversationId !== this.#binding.conversationId ||
      binding.model !== this.#binding.model
    )
      throw new OpenAiHistoryFault("binding_mismatch");
  }

  /** Sanitized counts only; neither history nor binding is exposed here. */
  status(): OpenAiHistoryStatus {
    return {
      state: this.#state,
      items: this.#history.length,
      bytes: this.#bytes,
      expectedResults: this.#expected.length,
      requestReady: this.#state === "ready" && this.#nextRequest !== undefined,
    };
  }

  private requireLive(): void {
    if (this.#state === "disposed")
      throw new OpenAiHistoryFault("invalid_state");
  }

  private measure(items: InputItem[]): number {
    if (items.length > this.#limits.maxItems)
      throw new OpenAiHistoryFault("history_limit");
    return jsonBytes(items, this.#limits.maxBytes);
  }

  private commit(items: InputItem[]): void {
    const bytes = this.measure(items);
    this.#history = items;
    this.#bytes = bytes;
  }

  /** Commit one explicit new user message. No silent replay of failed input. */
  appendUserText(text: string): void {
    if (this.#state !== "ready" || this.#nextRequest !== undefined)
      throw new OpenAiHistoryFault("invalid_state");
    if (typeof text !== "string" || text.length === 0)
      throw new OpenAiHistoryFault("invalid_request");
    this.commit([
      ...this.#history,
      { type: "message", role: "user", content: text },
    ]);
    this.#nextRequest = "user";
  }

  /** Stage a request without committing an assistant or its snapshot. A fresh
   * snapshot is accepted only on the first request for a new user message;
   * subsequent tool iterations carry the same committed explicit history. */
  beginRequest(
    binding: OpenAiHistoryBinding,
    snapshot?: string
  ): OpenAiHistoryRequest {
    this.assertBinding(binding);
    if (this.#state !== "ready" || this.#nextRequest === undefined)
      throw new OpenAiHistoryFault("invalid_state");
    if (snapshot !== undefined && typeof snapshot !== "string")
      throw new OpenAiHistoryFault("invalid_snapshot");
    const input = [...this.#history];
    if (snapshot) {
      if (
        this.#nextRequest !== "user" ||
        snapshot.length > this.#limits.maxSnapshotChars
      )
        throw new OpenAiHistoryFault("invalid_snapshot");
      input.push({ type: "message", role: "user", content: snapshot });
    }
    this.measure(input);
    const handle = new IssuedRequest(freezeDeep(structuredClone(input)));
    this.#active = { handle, input };
    this.#nextRequest = undefined;
    this.#state = "request_in_flight";
    return handle;
  }

  private requireRequest(request: OpenAiHistoryRequest): ActiveRequest {
    const active = this.#active;
    if (!active || active.handle !== request)
      throw new OpenAiHistoryFault("invalid_request");
    return active;
  }

  /** Finish a failed/cancelled request without committing output or a snapshot.
   * A stale/foreign handle cannot cancel another in-flight request. */
  failRequest(request: OpenAiHistoryRequest): boolean {
    if (this.#active?.handle !== request) return false;
    this.#active.handle.release();
    this.#active = undefined;
    this.#nextRequest = undefined;
    this.#state = "ready";
    return true;
  }

  /** Validate the completed output/projection pairing and issue an opaque,
   * instance-owned one-use continuation. No history is committed yet. */
  completeRequest(
    request: OpenAiHistoryRequest,
    output: readonly OpenAiHistoryOutputItem[],
    blocks: readonly CompletedTurnBlock[]
  ): CompletedTurn {
    const active = this.requireRequest(request);
    if (this.#state !== "request_in_flight")
      throw new OpenAiHistoryFault("invalid_state");
    try {
      if (!isArrayValue(output) || output.length === 0 || !isArrayValue(blocks))
        throw new OpenAiHistoryFault("invalid_output");
      // Bound the complete proposed history before cloning any provider items.
      const history = [...active.input, ...output];
      this.measure(history);
      const callIds = this.validateProjection(active.input, output, blocks);
      const turn: CompletedTurn = freezeDeep({
        stopReason: callIds.length ? "tool_use" : "end_turn",
        blocks: structuredClone([...blocks]),
        continuation: { type: "opaque", provider: OPENAI_PROVIDER, value: {} },
      });
      active.completion = {
        turn,
        history: structuredClone(history),
        callIds,
      };
      this.#state = "completed_pending_append";
      return turn;
    } catch (error) {
      this.failRequest(request);
      if (error instanceof OpenAiHistoryFault) throw error;
      throw new OpenAiHistoryFault("invalid_output");
    }
  }

  private validateProjection(
    input: InputItem[],
    output: readonly OpenAiHistoryOutputItem[],
    blocks: readonly CompletedTurnBlock[]
  ): string[] {
    const ids = new Set<string>();
    for (const item of input) {
      if (item.type === "function_call" && validItemId(item.call_id))
        ids.add(item.call_id);
      if ("id" in item && validItemId(item.id)) ids.add(item.id);
    }
    const projection: CompletedTurnBlock[] = [];
    const callIds: string[] = [];
    let refusal = false;
    for (const raw of output) {
      const item = row(raw);
      if (
        !item ||
        !validItemId(item.id) ||
        ids.has(item.id) ||
        (item.status !== undefined && item.status !== "completed")
      )
        throw new OpenAiHistoryFault("invalid_output");
      ids.add(item.id);
      if (item.type === "message") {
        if (
          item.role !== "assistant" ||
          item.status !== "completed" ||
          !Array.isArray(item.content)
        )
          throw new OpenAiHistoryFault("invalid_output");
        for (const value of item.content as unknown[]) {
          const content = row(value);
          if (
            content?.type === "output_text" &&
            typeof content.text === "string"
          )
            projection.push({ type: "text", text: content.text });
          else if (
            content?.type === "refusal" &&
            typeof content.refusal === "string"
          ) {
            refusal = true;
            projection.push({ type: "text", text: content.refusal });
          } else throw new OpenAiHistoryFault("invalid_output");
        }
      } else if (item.type === "reasoning") {
        if (
          !Array.isArray(item.summary) ||
          !(item.summary as unknown[]).every((value) => {
            const part = row(value);
            return (
              part?.type === "summary_text" && typeof part.text === "string"
            );
          }) ||
          (item.content !== undefined &&
            (!Array.isArray(item.content) ||
              !(item.content as unknown[]).every((value) => {
                const part = row(value);
                return (
                  part?.type === "reasoning_text" &&
                  typeof part.text === "string"
                );
              }))) ||
          (item.encrypted_content !== undefined &&
            item.encrypted_content !== null &&
            typeof item.encrypted_content !== "string")
        )
          throw new OpenAiHistoryFault("invalid_output");
        // The complete provider item, including encrypted continuation, is
        // retained; reasoning is never projected to the local/UI blocks.
      } else if (item.type === "function_call") {
        if (
          !validItemId(item.call_id) ||
          ids.has(item.call_id) ||
          item.namespace !== OPENAI_TOOL_NAMESPACE ||
          typeof item.name !== "string" ||
          !isToolName(item.name) ||
          item.async === true ||
          (item.caller != null && row(item.caller)?.type !== "direct") ||
          typeof item.arguments !== "string"
        )
          throw new OpenAiHistoryFault("invalid_output");
        // B2 validates the complete streamed arguments (including duplicate
        // keys) before calling this history boundary. Check the exact paired
        // projection here; do not rebuild the provider's arguments string.
        const args: unknown = JSON.parse(item.arguments);
        if (!row(args)) throw new OpenAiHistoryFault("invalid_output");
        ids.add(item.call_id);
        callIds.push(item.call_id);
        projection.push({
          type: "tool_call",
          call: { id: item.call_id, name: item.name, input: args },
        });
      } else throw new OpenAiHistoryFault("invalid_output");
    }
    if (
      (refusal && callIds.length > 0) ||
      !isDeepStrictEqual(projection, blocks)
    )
      throw new OpenAiHistoryFault("invalid_output");
    return callIds;
  }

  /** Append only the exact completed turn issued by this active request, once. */
  appendAssistant(turn: CompletedTurn): void {
    const completion = this.#active?.completion;
    if (
      this.#state !== "completed_pending_append" ||
      !completion ||
      completion.turn !== turn
    )
      throw new OpenAiHistoryFault("invalid_continuation");
    this.commit(completion.history);
    this.#active?.handle.release();
    this.#expected = completion.callIds;
    this.#active = undefined;
    this.#state = this.#expected.length ? "awaiting_results" : "ready";
  }

  /** Validate the entire ordered result batch before committing any items.
   * Success text stays exact. Errors retain exact content inside an explicit
   * is_error envelope; local narration is deliberately not sent. */
  appendToolResults(results: ToolResultPayload[]): void {
    if (
      this.#state !== "awaiting_results" ||
      !Array.isArray(results) ||
      results.length !== this.#expected.length
    )
      throw new OpenAiHistoryFault("invalid_results");
    const outputs: InputItem[] = [];
    for (const [index, result] of results.entries()) {
      if (
        !result ||
        result.toolUseId !== this.#expected[index] ||
        typeof result.content !== "string" ||
        (result.isError !== undefined && typeof result.isError !== "boolean")
      )
        throw new OpenAiHistoryFault("invalid_results");
      if (result.content.length > this.#limits.maxBytes)
        throw new OpenAiHistoryFault("history_limit");
      outputs.push({
        type: "function_call_output",
        call_id: result.toolUseId,
        output:
          result.isError === true
            ? JSON.stringify({ is_error: true, content: result.content })
            : result.content,
      });
    }
    this.commit([...this.#history, ...outputs]);
    this.#expected = [];
    this.#nextRequest = "results";
    this.#state = "ready";
  }

  /** Drop all private history, pending output and continuation references. */
  dispose(): void {
    this.#active?.handle.release();
    this.#history = [];
    this.#bytes = 2;
    this.#expected = [];
    this.#nextRequest = undefined;
    this.#active = undefined;
    this.#state = "disposed";
  }
}
