/**
 * FakeMessagesClient — a scriptable stand-in for the SDK `messages.stream` seam
 * consumed by the Claude client wrapper (Phase 4, ARCHITECTURE §4, §15).
 *
 * It implements the narrow {@link MessagesClient} interface from
 * `src/extension/claude-client.ts`: each `stream(params)` call pops the next
 * scripted turn off a queue and returns a {@link MessageStreamLike} that
 *  - fires `on('text', …)` for that turn's text deltas (in order, synchronously
 *    on the next microtask so listeners registered after `stream()` still see
 *    them — mirroring the real SDK, which buffers until `finalMessage()` is
 *    awaited);
 *  - resolves `finalMessage()` to a hand-built {@link Anthropic.Messages.Message}
 *    assembled from the scripted text + tool_use blocks, `stop_reason`, and a
 *    `usage` object that includes `cache_read_input_tokens` /
 *    `cache_creation_input_tokens`;
 *  - records `.abort()` and, for abort/error turns, rejects `finalMessage()` the
 *    way the real SDK does (an `APIUserAbortError` on abort, the scripted error
 *    otherwise) and/or emits an `error` event.
 *
 * Every `params` object passed to `stream()` is captured in {@link capturedParams}
 * so tests can assert cache_control placement (§15.1) and snapshot-uncached
 * behavior without a network call.
 *
 * The fake never imports the real SDK *values* beyond the type-only `Anthropic`
 * namespace and the `APIUserAbortError` class used to mimic the SDK's abort
 * rejection; it instantiates no `Anthropic` client.
 */

import Anthropic from "@anthropic-ai/sdk";

import type {
  MessageStreamLike,
  MessagesClient,
} from "../../src/extension/claude-client.js";

// ---------------------------------------------------------------------------
// Scripted-turn description
// ---------------------------------------------------------------------------

/** A scripted tool_use block to embed in a turn's assistant message. */
export interface ScriptedToolUse {
  id: string;
  name: string;
  input: unknown;
}

/**
 * One scripted streamed turn. Exactly one of the terminal modes applies:
 *  - default: `finalMessage()` resolves to the assembled message;
 *  - `rejectWith`: `finalMessage()` rejects with this error (SDK/stream error);
 *  - `abort`: `finalMessage()` rejects with an `APIUserAbortError`;
 *  - `emitErrorEvent`: additionally fire `on('error', …)` with this value.
 *
 * `throwOnStream` makes the `stream()` call itself throw synchronously (mimics a
 * client that fails to even open the request).
 */
export interface ScriptedTurn {
  /** Text deltas streamed via `on('text', …)`, in order. */
  textDeltas?: string[];
  /** tool_use blocks assembled into the final message content. */
  toolUses?: ScriptedToolUse[];
  /** The final `stop_reason` (defaults to `end_turn`, or `tool_use` if toolUses present). */
  stopReason?: Anthropic.Messages.StopReason;
  /** Usage overrides (merged over zeroed defaults). */
  usage?: Partial<Anthropic.Messages.Usage>;
  /** When set, `finalMessage()` rejects with this error. */
  rejectWith?: unknown;
  /** When true, `finalMessage()` rejects with an `APIUserAbortError`. */
  abort?: boolean;
  /** When set, fire an `error` event carrying this value before rejecting. */
  emitErrorEvent?: unknown;
  /** When true, `stream()` itself throws this turn (synchronously). */
  throwOnStream?: unknown;
}

// ---------------------------------------------------------------------------
// Message assembly
// ---------------------------------------------------------------------------

/** A fully-zeroed {@link Anthropic.Messages.Usage} with the cache fields present. */
function defaultUsage(): Anthropic.Messages.Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: null,
    inference_geo: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
  };
}

/** Assemble a complete {@link Anthropic.Messages.Message} from a scripted turn. */
export function buildMessage(turn: ScriptedTurn): Anthropic.Messages.Message {
  const content: Anthropic.Messages.ContentBlock[] = [];
  for (const delta of turn.textDeltas ?? []) {
    // Coalesce all deltas into ONE text block, mirroring the SDK's assembled
    // final message (per-delta blocks are a streaming detail, not the final).
    const last = content[content.length - 1];
    if (last && last.type === "text") {
      last.text += delta;
    } else {
      content.push({
        type: "text",
        text: delta,
        citations: null,
      });
    }
  }
  for (const tu of turn.toolUses ?? []) {
    content.push({
      type: "tool_use",
      id: tu.id,
      name: tu.name,
      input: tu.input as object,
      caller: { type: "direct" },
    });
  }

  const stopReason: Anthropic.Messages.StopReason =
    turn.stopReason ??
    ((turn.toolUses?.length ?? 0) > 0 ? "tool_use" : "end_turn");

  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content,
    container: null,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    usage: { ...defaultUsage(), ...turn.usage },
  };
}

// ---------------------------------------------------------------------------
// FakeMessageStream
// ---------------------------------------------------------------------------

/** A scripted {@link MessageStreamLike} driving one turn. */
class FakeMessageStream implements MessageStreamLike {
  private readonly turn: ScriptedTurn;
  private readonly textListeners: ((delta: string) => void)[] = [];
  private readonly errorListeners: ((error: unknown) => void)[] = [];
  /** Set true by {@link abort}; tests assert on it. */
  public aborted = false;

  constructor(turn: ScriptedTurn) {
    this.turn = turn;
  }

  on(event: "text", listener: (textDelta: string) => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
  on(event: "text" | "error", listener: (arg: never) => void): unknown {
    if (event === "text") {
      this.textListeners.push(listener as (delta: string) => void);
    } else {
      this.errorListeners.push(listener as (error: unknown) => void);
    }
    return this;
  }

  abort(): void {
    this.aborted = true;
  }

  async finalMessage(): Promise<Anthropic.Messages.Message> {
    // Flush text deltas first, so a listener attached right after `stream()`
    // (as the wrapper does) still receives every delta — like the real SDK,
    // which dispatches buffered events while `finalMessage()` is awaited.
    for (const delta of this.turn.textDeltas ?? []) {
      for (const listener of this.textListeners) {
        listener(delta);
      }
    }
    if (this.turn.emitErrorEvent !== undefined) {
      for (const listener of this.errorListeners) {
        listener(this.turn.emitErrorEvent);
      }
    }
    // Yield a microtask so the assembly is genuinely async (matches the SDK).
    await Promise.resolve();

    if (this.aborted || this.turn.abort) {
      throw new Anthropic.APIUserAbortError();
    }
    // Failure modes reject `finalMessage()`. `rejectWith` / `emitErrorEvent` are
    // intentionally `unknown` so a test can drive the wrapper's non-Error-throw
    // mapping path (→ `stream_error` with "unknown stream error"). A real
    // rejected value need not be an Error, so the lint rule is suppressed here.
    if (this.turn.rejectWith !== undefined) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw this.turn.rejectWith;
    }
    if (this.turn.emitErrorEvent !== undefined) {
      // An error event without an explicit reject still surfaces as a rejection
      // (the wrapper relies on finalMessage() rejecting).
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw this.turn.emitErrorEvent;
    }
    return buildMessage(this.turn);
  }
}

// ---------------------------------------------------------------------------
// FakeMessagesClient
// ---------------------------------------------------------------------------

/**
 * A scriptable {@link MessagesClient}. Construct with the ordered list of turns
 * each `stream()` call should produce. Captures every `params` and every issued
 * stream for assertions.
 */
export class FakeMessagesClient implements MessagesClient {
  private readonly turns: ScriptedTurn[];
  private index = 0;

  /** Params passed to each `stream()` call, in call order. */
  public readonly capturedParams: Anthropic.MessageStreamParams[] = [];
  /** Every stream issued (for abort/listener assertions), in call order. */
  public readonly streams: FakeMessageStream[] = [];

  constructor(turns: ScriptedTurn[]) {
    this.turns = turns;
  }

  /** Number of `stream()` calls made so far. */
  get streamCallCount(): number {
    return this.index;
  }

  stream(params: Anthropic.MessageStreamParams): MessageStreamLike {
    this.capturedParams.push(params);
    const turn = this.turns[this.index] ?? this.turns[this.turns.length - 1];
    this.index++;
    if (turn?.throwOnStream !== undefined) {
      // `throwOnStream` is `unknown` so a test can simulate the SDK throwing a
      // non-Error while OPENING the stream (the wrapper's `try { stream() }`
      // catch path). A synchronous throw is required to hit that catch; there
      // is no promise to reject here.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw turn.throwOnStream;
    }
    const stream = new FakeMessageStream(turn ?? {});
    this.streams.push(stream);
    return stream;
  }
}

// ---------------------------------------------------------------------------
// Ergonomic turn builders
// ---------------------------------------------------------------------------

/** A turn that streams text and ends the conversation (`end_turn`). */
export function textTurn(
  text: string,
  opts?: { stopReason?: Anthropic.Messages.StopReason; deltas?: string[] }
): ScriptedTurn {
  return {
    textDeltas: opts?.deltas ?? [text],
    stopReason: opts?.stopReason ?? "end_turn",
  };
}

/** A turn that requests one or more tools (`tool_use`), optionally with text. */
export function toolUseTurn(
  toolUses: ScriptedToolUse[],
  opts?: { text?: string }
): ScriptedTurn {
  return {
    textDeltas: opts?.text === undefined ? undefined : [opts.text],
    toolUses,
    stopReason: "tool_use",
  };
}

/** A turn whose `finalMessage()` rejects with an `APIUserAbortError`. */
export function abortTurn(): ScriptedTurn {
  return { abort: true };
}

/** A turn whose `finalMessage()` rejects with the given error. */
export function errorTurn(error: unknown): ScriptedTurn {
  return { rejectWith: error };
}
