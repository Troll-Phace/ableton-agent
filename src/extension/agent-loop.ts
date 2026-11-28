/**
 * Agentic tool-use loop — the engine the whole product runs on (Phase 4,
 * ARCHITECTURE §4, §7, §8).
 *
 * Per the client-tool-use contract (§1.1) the provider emits structured tool
 * calls and the extension executes them. This loop drives that contract:
 *  - run one streamed turn ({@link TurnProvider.runTurn});
 *  - while `stopReason === "tool_use"`: collect ALL completed tool calls,
 *    run **read** tools immediately/in-order, and **queue**
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

import {
  isDestructiveCall,
  summarizeDestructivePlan,
  summarizeToolCall,
} from "../shared/tools.js";

import type {
  AssistantDeltaSink,
  ProviderError,
  ProviderTurnInput,
  ToolCall,
  ToolResultPayload,
  ToolRuntime,
  TurnProvider,
} from "../shared/provider.js";
import {
  LegacyClaudeProvider,
  type LegacyMessages,
  type LegacyRunOptions,
  type LegacyToolRuntime,
} from "./providers/legacy-claude.js";

// ---------------------------------------------------------------------------
// Legacy compatibility exports (the loop itself uses the canonical contracts)
// ---------------------------------------------------------------------------

export type { ToolCall } from "../shared/provider.js";
export type {
  LegacyToolResultContent as ToolResultContent,
  LegacyToolResultPayload as ToolResultPayload,
  LegacyToolRuntime as ToolRuntime,
} from "./providers/legacy-claude.js";

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

/** Provider-neutral inputs for one full agentic run. The provider owns history. */
export interface ProviderLoopInput {
  provider: TurnProvider;
  runtime: ToolRuntime;
  /** Outward event sink (Phase 7). */
  events: AgentEvents;
  /** The per-turn project snapshot (Phase 11 fills; optional). */
  snapshot?: string;
  /** Optional model override (forwarded to the client). */
  model?: string;
  /** Optional max output tokens (forwarded to the client). */
  maxTokens?: number;
  /** Optional cancellation signal (checked before each mutation flush, §7). */
  signal?: AbortSignal;
  /** Optional iteration cap override (defaults to {@link DEFAULT_MAX_ITERATIONS}). */
  maxIterations?: number;
  /**
   * Optional async confirmation gate (Phase 9, outcome D, §9/§13). Called BEFORE
   * the mutation flush when the batch contains a destructive call
   * ({@link isDestructiveCall}). Resolves `true` to proceed with the flush,
   * `false` to skip the WHOLE flush (the batch shares one transaction, §7). MUST
   * settle (resolve `false`) on abort so the loop never hangs; the loop re-checks
   * `signal.aborted` after the await to distinguish a user *cancel* (abort-return)
   * from a user *decline* (continue the loop). Never rejects.
   */
  requestConfirmation?: (plan: {
    summary: string;
    actions: string[];
    calls: ToolCall[];
  }) => Promise<boolean>;
}

/** Existing legacy entry point: still accepts and returns the same transcript. */
export interface RunLoopInput
  extends Omit<ProviderLoopInput, "provider" | "runtime">, LegacyRunOptions {
  runtime: LegacyToolRuntime;
}

/** Successful provider-neutral loop result. */
export interface ProviderLoopOk {
  ok: true;
  /** The final terminal `stop_reason`. */
  stopReason: string;
  /** The concatenated assistant text of the final (non-tool) message. */
  text: string;
}

/** Failed loop result (client error, abort, or cap exceeded). */
export interface ProviderLoopErr {
  ok: false;
  /** Structured provider or loop-level error. */
  err:
    | ProviderError
    | { error: "iteration_cap" | "aborted"; detail: string; hint: string };
}

export type ProviderLoopResult = ProviderLoopOk | ProviderLoopErr;
export interface RunLoopOk extends ProviderLoopOk {
  messages: LegacyMessages;
}
export interface RunLoopErr extends ProviderLoopErr {
  messages: LegacyMessages;
}
/** Result of {@link runAgentLoop}. */
export type RunLoopResult = RunLoopOk | RunLoopErr;

// ---------------------------------------------------------------------------
// Block helpers (pure)
// ---------------------------------------------------------------------------

/** Coerce an unknown structured-error field to a short single-line string. */
function fieldStr(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim() !== "") {
    // Collapse newlines so the diagnostic stays one line.
    return value.replace(/\s+/g, " ").trim();
  }
  return fallback;
}

/**
 * Host-side diagnostic for a failed tool call (observability only — never changes
 * behavior). Every read/mutation result that comes back with `isError` is the §6
 * error contract `{ error, ref?, detail, hint }`; we parse it defensively and emit
 * ONE structural `console.warn` line so a red chip in the UI always has a matching
 * terminal line. Logs ONLY the failure class / ref / detail (object names and
 * positions) — NEVER the tool input, transcript, message content, or the API key.
 * It cannot throw: a non-JSON or oddly-shaped body falls back to a literal label.
 */
function logToolError(toolName: string, payload: ToolResultPayload): void {
  if (payload.isError !== true) {
    return;
  }
  try {
    let error = "error";
    let ref = "-";
    let detail = "(no detail)";
    if (typeof payload.content === "string") {
      const parsed: unknown = JSON.parse(payload.content);
      if (typeof parsed === "object" && parsed !== null) {
        const body = parsed as Record<string, unknown>;
        error = fieldStr(body["error"], error);
        ref = fieldStr(body["ref"], "-");
        detail = fieldStr(body["detail"], detail);
      }
    }
    console.warn(
      `[tool] ${toolName} failed: ${error} ref=${ref} detail=${detail}`
    );
  } catch {
    // Body was not the structured-error JSON we expected; still record the class
    // of failure without ever risking a throw in the loop.
    console.warn(`[tool] ${toolName} failed: (unparseable error payload)`);
  }
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
  const provider = new LegacyClaudeProvider(input);
  const result = await runProviderLoop({
    ...input,
    provider,
    runtime: provider.bindRuntime(input.runtime),
  });
  return { ...result, messages: input.messages };
}

/** Run the same local execution/confirmation loop over completed canonical turns. */
export async function runProviderLoop(
  input: ProviderLoopInput
): Promise<ProviderLoopResult> {
  const {
    provider,
    runtime,
    events,
    snapshot,
    model,
    maxTokens,
    signal,
    requestConfirmation,
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
      return { ok: false, err };
    }

    // 1. Stream one turn. The snapshot only seeds the FIRST turn of a loop run;
    //    subsequent turns carry the accumulated tool_result context instead.
    const turnInput: ProviderTurnInput = {
      tools: runtime.toolDefinitions(),
      snapshot: iteration === 0 ? snapshot : undefined,
      model,
      maxTokens,
      signal,
      onDelta,
    };
    const turn = await provider.runTurn(turnInput);
    if (!turn.ok) {
      events.error(turn.err.detail);
      return { ok: false, err: turn.err };
    }

    const completed = turn.turn;
    const stopReason = completed.stopReason;

    // Commit the provider-owned completed turn before executing any tools.
    // A provider may reject a previously issued continuation if its selected
    // account or operation was invalidated between completion and this append.
    try {
      provider.appendAssistant(completed);
    } catch {
      const err: ProviderError = signal?.aborted
        ? {
            error: "aborted",
            detail:
              "the agent loop was aborted before committing the completed turn",
            hint: "the user cancelled; no tools were executed this iteration",
          }
        : {
            error: "stream_error",
            detail:
              "the provider rejected the completed turn before local execution",
            hint: "verify the selected conversation and account; no tools were executed this iteration",
          };
      events.error(err.detail);
      return { ok: false, err };
    }

    // 2. Terminal stop → done.
    if (stopReason !== "tool_use") {
      events.assistantDone(stopReason);
      return {
        ok: true,
        stopReason,
        text: completed.blocks
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join(""),
      };
    }

    // 3. Collect + partition tool_use blocks (preserve request order).
    const calls = completed.blocks
      .filter((block) => block.type === "tool_call")
      .map((block) => block.call);
    // Defensive: tool_use stop with no blocks would otherwise loop forever.
    if (calls.length === 0) {
      const err = {
        error: "stream_error" as const,
        detail: "stop_reason was tool_use but no tool_use blocks were present",
        hint: "the model response was malformed; retry the turn",
      };
      events.error(err.detail);
      return { ok: false, err };
    }

    const readCalls: ToolCall[] = [];
    const mutationCalls: ToolCall[] = [];
    for (const call of calls) {
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
      logToolError(call.name, payload);
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
        return { ok: false, err };
      }

      // 3b-i. Confirmation gate (Phase 9, outcome D, §9/§13). If the batch
      //       contains a destructive call, it must be confirmed before ANY of it
      //       flushes — the whole batch shares one transaction (§7), so a decline
      //       skips the entire flush. `proceed` stays true for non-destructive
      //       batches (which never gate) and for an approved destructive batch.
      let proceed = true;
      const destructiveCalls = mutationCalls.filter((call) =>
        isDestructiveCall(call.name, call.input)
      );
      if (destructiveCalls.length > 0) {
        if (requestConfirmation) {
          const plan = {
            ...summarizeDestructivePlan(
              destructiveCalls.map((call) => ({
                name: call.name,
                input: call.input,
              }))
            ),
            calls: destructiveCalls,
          };
          const approved = await requestConfirmation(plan);

          // THE critical race (decision 5): a cancel WHILE the card is open must
          // take the aborted-return path, NOT the decline path. The seam resolves
          // false on abort, so re-check the signal FIRST — it is the discriminator
          // between "user cancelled the turn" and "user clicked Decline".
          if (signal?.aborted) {
            const err = {
              error: "aborted" as const,
              detail: "aborted while awaiting destructive-action confirmation",
              hint: "the user cancelled; no mutations were applied this iteration",
            };
            events.error(err.detail);
            return { ok: false, err };
          }

          if (!approved) {
            // Decline path: skip the WHOLE flush; synthesize a user_declined
            // result for EVERY mutation id (destructive or not — the batch is
            // skipped together) so the model re-grounds and ends end_turn. No
            // transaction is opened. Do NOT return — fall through to step 4.
            proceed = false;
            for (const call of mutationCalls) {
              const payload: ToolResultPayload = {
                toolUseId: call.id,
                content: JSON.stringify({
                  error: "user_declined",
                  detail:
                    "the user declined the destructive action; nothing was changed",
                  hint: "propose a non-destructive alternative or ask what to do instead",
                }),
                isError: true,
              };
              resultsById.set(payload.toolUseId, payload);
              events.toolActivity(call.name, summaryOf(call), "error");
            }
          }
        } else {
          // Fail-closed (decision 4): a destructive action was requested but no
          // confirmation channel is wired. NEVER auto-approve — skip the flush
          // and surface a structured configuration error for every mutation id.
          proceed = false;
          for (const call of mutationCalls) {
            const payload: ToolResultPayload = {
              toolUseId: call.id,
              content: JSON.stringify({
                error: "confirmation_unavailable",
                detail:
                  "a destructive action was requested but no confirmation channel is wired; nothing was changed",
                hint: "this is a configuration error — destructive actions require a confirmation UI",
              }),
              isError: true,
            };
            resultsById.set(payload.toolUseId, payload);
            events.toolActivity(call.name, summaryOf(call), "error");
          }
        }
      }

      // 3b-ii. Started-narration + flush — ONLY for an approved destructive batch
      //        or a non-destructive batch (never on the decline / fail-closed
      //        paths above, which already populated resultsById).
      if (proceed) {
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
          logToolError(mutationCalls[i].name, payload);
          events.toolActivity(
            mutationCalls[i].name,
            payload.summary ?? summaryOf(mutationCalls[i]),
            payload.isError ? "error" : "ok"
          );
        }
      }
    }

    // 4. Append tool_result blocks in the SAME order/ids as requested.
    const results: ToolResultPayload[] = calls.map((call) => {
      return (
        resultsById.get(call.id) ?? {
          toolUseId: call.id,
          content: JSON.stringify({
            error: "tool_result_missing",
            detail: "no executor produced a result for this tool call",
            hint: "retry the action",
          }),
          isError: true,
        }
      );
    });
    try {
      provider.appendToolResults(results);
    } catch {
      // Local tools may already have run and their undo step may be committed.
      // A rejected history append cannot justify repeating them or dispatching
      // another provider request. Preserve the emitted tool activity.
      const err: ProviderError = {
        error: signal?.aborted ? "aborted" : "stream_error",
        detail:
          "the provider could not accept tool results; local actions may already have completed",
        hint: "inspect the local state before continuing; do not replay tool actions or retry automatically",
      };
      events.error(err.detail);
      return { ok: false, err };
    }
    // Continue: next streamed turn consumes these tool_result blocks.
  }

  // Iteration cap exceeded — stop rather than spin forever.
  const capErr = {
    error: "iteration_cap" as const,
    detail: `exceeded the ${String(maxIterations)}-iteration tool-use cap`,
    hint: "the request needs too many tool steps; simplify or split it",
  };
  events.error(capErr.detail);
  return { ok: false, err: capErr };
}

/**
 * A short, key-free narration summary for a tool call, driving the §13
 * `tool_activity.summary` chip (the *started* and *error* states). Delegates to
 * the pure {@link summarizeToolCall} in shared. The *ok* chip may still be
 * overridden at the settle sites by a richer executor-returned summary via the
 * `payload.summary ?? summaryOf(call)` fallback.
 */
function summaryOf(call: ToolCall): string {
  return summarizeToolCall(call.name, call.input);
}
