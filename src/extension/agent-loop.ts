/**
 * Agentic tool-use loop — the engine the whole product runs on (Phase 4,
 * ARCHITECTURE §4, §7, §8).
 *
 * Per the client-tool-use contract (§1.1) Claude emits structured tool calls and
 * the extension executes them. This loop drives that contract:
 *  - run one streamed turn ({@link ClaudeClient.runTurn});
 *  - while `stop_reason === "tool_use"`: collect ALL `tool_use` blocks of the
 *    assistant message, run **read** tools immediately/in-order, and **queue**
 *    mutation tools to flush in ONE batch per iteration — the seam Phase 5 wraps
 *    in a single `withinTransaction` (§7, one undo step per agent action);
 *  - append `tool_result` blocks in the SAME order and with the SAME
 *    `tool_use_id`s as the requested blocks (success payload, or `is_error` for a
 *    structured error);
 *  - exit on ANY non-`tool_use` stop — `end_turn` / `max_tokens` / `stop_sequence`
 *    / `refusal`, and also `pause_turn` — treating it as terminal. (This is a pure
 *    client-tool-use loop with no server tools, so `pause_turn` does not occur in
 *    practice; resuming it would only be needed if server tools are added later.)
 *  - enforce an iteration cap so a misbehaving model can never spin forever.
 *
 * Abort discipline (§7 / R5): the loop checks the `AbortSignal` BEFORE asking the
 * runtime to flush mutations, so a cancel never lands a half-applied transaction.
 *
 * It NEVER throws to its caller and NEVER caches SDK handles (the runtime
 * re-resolves refs per call, §6): the loop only moves opaque tool payloads.
 */

import type Anthropic from "@anthropic-ai/sdk";

import type {
  AssistantDeltaSink,
  ClaudeClient,
  ClientError,
  RunTurnInput,
} from "./claude-client.js";

// ---------------------------------------------------------------------------
// Tool call / result shapes (thin views over the SDK blocks)
// ---------------------------------------------------------------------------

/**
 * A single requested tool call — a thin, runtime-facing view of an
 * {@link Anthropic.ToolUseBlock}. `input` is `unknown` (the schema is the
 * runtime's concern); executors narrow it.
 */
export interface ToolCall {
  /** The `tool_use_id` that the matching `tool_result` MUST echo. */
  id: string;
  /** The tool name (e.g. `live_get_project`). */
  name: string;
  /** The model-supplied, coalesced input JSON (validated by the executor). */
  input: unknown;
}

/**
 * The exact content shape a `tool_result` block accepts (a string, or the
 * narrow block union the SDK permits inside a tool result). Derived from the SDK
 * type so it can never drift from {@link Anthropic.ToolResultBlockParam}.
 */
export type ToolResultContent = NonNullable<
  Anthropic.ToolResultBlockParam["content"]
>;

/**
 * The payload an executor returns for one tool call. Maps directly onto a
 * `tool_result` content block: a success `content` string/blocks, or a structured
 * error with `isError: true` (the §6/§9 contract — never a thrown error).
 */
export interface ToolResultPayload {
  /** The `tool_use_id` this result answers (must match the originating call). */
  toolUseId: string;
  /** The result content (success data, or a serialized structured error). */
  content: ToolResultContent;
  /** True when the content is a structured error (sets `is_error` on the block). */
  isError?: boolean;
  /** Optional human summary for `tool_activity` narration (Phase 7). */
  summary?: string;
}

// ---------------------------------------------------------------------------
// DI seams (extension-internal; Phases 5/6/7 fill these)
// ---------------------------------------------------------------------------

/**
 * What the loop needs from the (future) tool registry + executors. Phase 5/6
 * implement this against the real SDK; tests inject a fake capturing call order.
 */
export interface ToolRuntime {
  /** The tool definitions sent as the cacheable tools prefix (§15.1). */
  toolDefinitions(): Anthropic.ToolUnion[];
  /** Classify a tool as read (immediate) or mutation (batched, §8). */
  classify(toolName: string): "read" | "mutation";
  /** Execute one read tool immediately; never throws (returns a structured payload). */
  executeRead(call: ToolCall): Promise<ToolResultPayload>;
  /**
   * Flush ALL queued mutations of one iteration in ONE batch — Phase 5 wraps
   * this in a single `withinTransaction` (§7). Returns one payload per call, in
   * the SAME order as `calls`. Never throws.
   */
  flushMutations(calls: ToolCall[]): Promise<ToolResultPayload[]>;
}

/**
 * What the loop emits outward. Phase 7 maps these to the §13 socket messages
 * (`assistant_delta` / `tool_activity` / `assistant_done` / `error`).
 */
export interface AgentEvents {
  /** A streamed assistant text delta. */
  assistantDelta(text: string): void;
  /** Tool-activity narration, emitted around each tool execution. */
  toolActivity(
    tool: string,
    summary: string,
    status: "started" | "ok" | "error"
  ): void;
  /** The turn ended; carries the terminal `stop_reason`. */
  assistantDone(stopReason: string): void;
  /** A loop-level failure (client error, cap exceeded). */
  error(message: string): void;
}

// ---------------------------------------------------------------------------
// Loop inputs / outputs
// ---------------------------------------------------------------------------

/** Default maximum number of tool-use iterations before the loop bails. */
export const DEFAULT_MAX_ITERATIONS = 10;

/** Inputs for one full agentic run (one user turn → assistant end). */
export interface RunLoopInput {
  /** The streamed Claude client (Task 1). */
  client: ClaudeClient;
  /** The tool registry/executor seam (Phase 5/6). */
  runtime: ToolRuntime;
  /** Outward event sink (Phase 7). */
  events: AgentEvents;
  /** The system prompt blocks (Phase 6 fills; empty accepted). */
  system: Anthropic.TextBlockParam[];
  /** The per-turn project snapshot (Phase 11 fills; optional). */
  snapshot?: string;
  /**
   * The running transcript. The loop appends the assistant message and the
   * `tool_result` user message to this array as the turn progresses, and returns
   * the updated array.
   */
  messages: Anthropic.MessageParam[];
  /** Optional model override (forwarded to the client). */
  model?: Anthropic.Model;
  /** Optional max output tokens (forwarded to the client). */
  maxTokens?: number;
  /** Optional cancellation signal (checked before each mutation flush, §7). */
  signal?: AbortSignal;
  /** Optional iteration cap override (defaults to {@link DEFAULT_MAX_ITERATIONS}). */
  maxIterations?: number;
}

/** Successful loop result. */
export interface RunLoopOk {
  ok: true;
  /** The final terminal `stop_reason`. */
  stopReason: string;
  /** The concatenated assistant text of the final (non-tool) message. */
  text: string;
  /** The updated transcript (assistant + tool_result messages appended). */
  messages: Anthropic.MessageParam[];
}

/** Failed loop result (client error, abort, or cap exceeded). */
export interface RunLoopErr {
  ok: false;
  /** Structured error — `ClientError` from the client, or a loop-level error. */
  err:
    | ClientError
    | { error: "iteration_cap" | "aborted"; detail: string; hint: string };
  /** The transcript as far as it progressed (for persistence/debugging). */
  messages: Anthropic.MessageParam[];
}

/** Result of {@link runAgentLoop}. */
export type RunLoopResult = RunLoopOk | RunLoopErr;

// ---------------------------------------------------------------------------
// Block helpers (pure)
// ---------------------------------------------------------------------------

/** Extract the `tool_use` blocks from an assistant message, in order. */
function collectToolUseBlocks(
  message: Anthropic.Messages.Message
): Anthropic.ToolUseBlock[] {
  const blocks: Anthropic.ToolUseBlock[] = [];
  for (const block of message.content) {
    if (block.type === "tool_use") {
      blocks.push(block);
    }
  }
  return blocks;
}

/** Concatenate the text of all `text` blocks in an assistant message. */
function collectText(message: Anthropic.Messages.Message): string {
  let text = "";
  for (const block of message.content) {
    if (block.type === "text") {
      text += block.text;
    }
  }
  return text;
}

/** A thin {@link ToolCall} view of a {@link Anthropic.ToolUseBlock}. */
function toToolCall(block: Anthropic.ToolUseBlock): ToolCall {
  return { id: block.id, name: block.name, input: block.input };
}

/** Build a `tool_result` content block from an executor payload. */
function toToolResultBlock(
  payload: ToolResultPayload
): Anthropic.ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: payload.toolUseId,
    content: payload.content,
    ...(payload.isError ? { is_error: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// runAgentLoop
// ---------------------------------------------------------------------------

/**
 * Run the full tool-use loop for one user turn.
 *
 * Behavior (ARCHITECTURE §4):
 *  1. Run a streamed turn; emit deltas via {@link AgentEvents.assistantDelta}.
 *  2. While `stop_reason === "tool_use"` and under the iteration cap:
 *     - collect ALL `tool_use` blocks; partition via {@link ToolRuntime.classify};
 *     - run reads immediately/in-order, queue mutations;
 *     - **check the abort signal BEFORE flushing mutations** (§7), then flush the
 *       whole queue in ONE {@link ToolRuntime.flushMutations} call;
 *     - append `tool_result` blocks in the SAME order/ids as requested.
 *  3. On a terminal stop, emit {@link AgentEvents.assistantDone} and return.
 *
 * NEVER throws: client/loop failures return a structured {@link RunLoopErr} and
 * emit {@link AgentEvents.error}. The iteration cap guarantees termination.
 */
export async function runAgentLoop(
  input: RunLoopInput
): Promise<RunLoopResult> {
  const {
    client,
    runtime,
    events,
    system,
    snapshot,
    messages,
    model,
    maxTokens,
    signal,
  } = input;
  const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  const onDelta: AssistantDeltaSink = (textDelta) => {
    events.assistantDelta(textDelta);
  };

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (signal?.aborted) {
      const err = {
        error: "aborted" as const,
        detail: "the agent loop was aborted before the next turn",
        hint: "the user cancelled; the transcript is left consistent",
      };
      events.error(err.detail);
      return { ok: false, err, messages };
    }

    // 1. Stream one turn. The snapshot only seeds the FIRST turn of a loop run;
    //    subsequent turns carry the accumulated tool_result context instead.
    const turnInput: RunTurnInput = {
      system,
      tools: runtime.toolDefinitions(),
      snapshot: iteration === 0 ? snapshot : undefined,
      messages,
      model,
      maxTokens,
      signal,
      onDelta,
    };
    const turn = await client.runTurn(turnInput);
    if (!turn.ok) {
      events.error(turn.err.detail);
      return { ok: false, err: turn.err, messages };
    }

    const assistantMessage = turn.message;
    const stopReason = assistantMessage.stop_reason ?? "end_turn";

    // Append the assistant message to the transcript (content blocks as params).
    messages.push({
      role: "assistant",
      content: assistantMessage.content,
    });

    // 2. Terminal stop → done.
    if (stopReason !== "tool_use") {
      events.assistantDone(stopReason);
      return {
        ok: true,
        stopReason,
        text: collectText(assistantMessage),
        messages,
      };
    }

    // 3. Collect + partition tool_use blocks (preserve request order).
    const toolUseBlocks = collectToolUseBlocks(assistantMessage);
    // Defensive: tool_use stop with no blocks would otherwise loop forever.
    if (toolUseBlocks.length === 0) {
      const err = {
        error: "stream_error" as const,
        detail: "stop_reason was tool_use but no tool_use blocks were present",
        hint: "the model response was malformed; retry the turn",
      };
      events.error(err.detail);
      return { ok: false, err, messages };
    }

    const readCalls: ToolCall[] = [];
    const mutationCalls: ToolCall[] = [];
    for (const block of toolUseBlocks) {
      const call = toToolCall(block);
      if (runtime.classify(call.name) === "read") {
        readCalls.push(call);
      } else {
        mutationCalls.push(call);
      }
    }

    // Map tool_use_id → payload so results can be re-ordered to match requests.
    const resultsById = new Map<string, ToolResultPayload>();

    // 3a. Reads execute immediately, in order.
    for (const call of readCalls) {
      events.toolActivity(call.name, summaryOf(call), "started");
      const payload = await runtime.executeRead(call);
      resultsById.set(payload.toolUseId, payload);
      events.toolActivity(
        call.name,
        payload.summary ?? summaryOf(call),
        payload.isError ? "error" : "ok"
      );
    }

    // 3b. Mutations: check abort BEFORE the flush (§7 / R5 — never a partial
    //     transaction on cancel), then flush the whole queue as one batch.
    if (mutationCalls.length > 0) {
      if (signal?.aborted) {
        const err = {
          error: "aborted" as const,
          detail: "aborted before flushing the mutation batch",
          hint: "the user cancelled; no mutations were applied this iteration",
        };
        events.error(err.detail);
        return { ok: false, err, messages };
      }
      for (const call of mutationCalls) {
        events.toolActivity(call.name, summaryOf(call), "started");
      }
      const payloads = await runtime.flushMutations(mutationCalls);
      for (let i = 0; i < mutationCalls.length; i++) {
        // Guard against a short payload array; fall back to a structured error.
        const payload =
          payloads[i] ??
          ({
            toolUseId: mutationCalls[i].id,
            content: JSON.stringify({
              error: "mutation_missing_result",
              detail: "the mutation flush returned no result for this call",
              hint: "retry the action",
            }),
            isError: true,
          } satisfies ToolResultPayload);
        resultsById.set(payload.toolUseId, payload);
        events.toolActivity(
          mutationCalls[i].name,
          payload.summary ?? summaryOf(mutationCalls[i]),
          payload.isError ? "error" : "ok"
        );
      }
    }

    // 4. Append tool_result blocks in the SAME order/ids as requested.
    const resultBlocks: Anthropic.ToolResultBlockParam[] = toolUseBlocks.map(
      (block) => {
        const payload = resultsById.get(block.id) ?? {
          toolUseId: block.id,
          content: JSON.stringify({
            error: "tool_result_missing",
            detail: "no executor produced a result for this tool call",
            hint: "retry the action",
          }),
          isError: true,
        };
        return toToolResultBlock(payload);
      }
    );
    messages.push({ role: "user", content: resultBlocks });
    // Continue: next streamed turn consumes these tool_result blocks.
  }

  // Iteration cap exceeded — stop rather than spin forever.
  const capErr = {
    error: "iteration_cap" as const,
    detail: `exceeded the ${String(maxIterations)}-iteration tool-use cap`,
    hint: "the request needs too many tool steps; simplify or split it",
  };
  events.error(capErr.detail);
  return { ok: false, err: capErr, messages };
}

/** A short, key-free narration summary for a tool call (refined in Phase 7). */
function summaryOf(call: ToolCall): string {
  return call.name;
}
