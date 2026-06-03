/**
 * Claude client wrapper — the host-side seam around `@anthropic-ai/sdk` (Phase 4,
 * ARCHITECTURE §4, §15.1).
 *
 * Claude never touches Live directly (§1.1): it emits structured tool calls and
 * this module is the *only* place that talks to the Messages API. It:
 *  - builds one streamed request per turn — `system` + the cacheable `tools`
 *    prefix + an **uncached** snapshot block + the running transcript;
 *  - places `cache_control:{type:"ephemeral"}` on the LAST system block and the
 *    LAST tool so the stable system+tool prefix is cached across turns (§15.1),
 *    while the per-turn snapshot stays in a separate, **uncached** user block;
 *  - pipes text deltas to an {@link AssistantDeltaSink} and resolves to the
 *    assembled final {@link Anthropic.Messages.Message} (content, `stop_reason`,
 *    `usage` incl. cache hit/creation counts);
 *  - honors an `AbortSignal` (calls `stream.abort()` on abort) and maps every SDK
 *    / `APIError` / abort failure to a structured {@link ClientError} — it NEVER
 *    throws to its caller and NEVER leaves an unhandled rejection (code-style
 *    "Error handling").
 *
 * The narrow {@link MessagesClient} seam lets tests inject a scripted fake stream
 * (no network) while production adapts the real `client.messages.stream`.
 *
 * Key discipline (§10, git-conventions): the API key is taken as a constructor
 * arg (or the `ANTHROPIC_API_KEY` env fallback) and lives in Node only — it is
 * never hardcoded, never logged, never serialized to the webview.
 */

import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default model literal (overridable; Phase 10 supplies it from config). */
export const MODEL: Anthropic.Model = "claude-sonnet-4-6";

/** Default per-turn output-token ceiling. */
export const MAX_TOKENS = 4096;

// ---------------------------------------------------------------------------
// Structured error (mirrors the §6/§9 tool-error contract: never thrown)
// ---------------------------------------------------------------------------

/** Structured failure returned (never thrown) by {@link ClaudeClient.runTurn}. */
export interface ClientError {
  /** Failure class for the caller/loop to branch on. */
  error: "aborted" | "api_error" | "stream_error";
  /** Human-readable detail (sanitized — never contains the API key). */
  detail: string;
  /** Recovery hint for the agent/loop. */
  hint: string;
}

// ---------------------------------------------------------------------------
// Injectable stream seam (tests swap in a scripted fake)
// ---------------------------------------------------------------------------

/**
 * The subset of the SDK `MessageStream` the turn runner consumes. Declaring it
 * narrowly keeps the loop decoupled from the full SDK stream surface and lets a
 * fake drive it without a network call.
 */
export interface MessageStreamLike {
  /** Subscribe to incremental text deltas (`textDelta`) or a stream error. */
  on(event: "text", listener: (textDelta: string) => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
  /** Resolve to the fully assembled final message (coalesced tool_use inputs). */
  finalMessage(): Promise<Anthropic.Messages.Message>;
  /** Abort the in-flight request (wired to the caller's `AbortSignal`). */
  abort(): void;
}

/**
 * The narrow client seam: one method that opens a streamed Messages request.
 * Production wraps `new Anthropic({ apiKey }).messages.stream`; tests inject a
 * {@link MessageStreamLike}-emitting fake.
 */
export interface MessagesClient {
  /** Open a streamed turn for the given request params. */
  stream(params: Anthropic.MessageStreamParams): MessageStreamLike;
}

// ---------------------------------------------------------------------------
// Turn inputs / outputs
// ---------------------------------------------------------------------------

/** Sink for streamed assistant text deltas (Phase 7 maps this to the socket). */
export type AssistantDeltaSink = (textDelta: string) => void;

/** Inputs for one streamed turn (Phase 6/11 fill `system`/`tools`/`snapshot`). */
export interface RunTurnInput {
  /**
   * The stable system prompt as one or more text blocks. The LAST block is
   * marked cacheable (§15.1). Empty is accepted (Phase 6 fills real content).
   */
  system: Anthropic.TextBlockParam[];
  /**
   * The tool definitions sent as the cacheable prefix. The LAST tool is marked
   * cacheable so the whole system+tools prefix caches. Empty is accepted
   * (Phase 5 fills real schemas).
   */
  tools: Anthropic.ToolUnion[];
  /**
   * The per-turn project snapshot (§4). Placed in its own UNCACHED user block;
   * `undefined`/empty omits it (Phase 11 fills real content).
   */
  snapshot?: string;
  /** The running conversation transcript owned by the loop. */
  messages: Anthropic.MessageParam[];
  /** Optional model override (defaults to {@link MODEL}). */
  model?: Anthropic.Model;
  /** Optional max output tokens (defaults to {@link MAX_TOKENS}). */
  maxTokens?: number;
  /** Optional cancellation signal; on abort the stream is aborted. */
  signal?: AbortSignal;
  /** Optional sink for streamed text deltas. */
  onDelta?: AssistantDeltaSink;
}

/** Successful turn result: the assembled final message. */
export interface RunTurnOk {
  ok: true;
  /** The fully assembled assistant message (content, stop_reason, usage). */
  message: Anthropic.Messages.Message;
}

/** Failed turn result. */
export interface RunTurnErr {
  ok: false;
  err: ClientError;
}

/** Result of {@link ClaudeClient.runTurn}. */
export type RunTurnResult = RunTurnOk | RunTurnErr;

// ---------------------------------------------------------------------------
// Request building (cache_control placement is the §15.1-critical bit)
// ---------------------------------------------------------------------------

/**
 * Stamp `cache_control:{type:"ephemeral"}` on the LAST system block so the
 * stable system prefix caches. Returns a fresh array (inputs are not mutated);
 * an empty system list is passed through untouched.
 */
function withCachedSystem(
  system: Anthropic.TextBlockParam[]
): Anthropic.TextBlockParam[] {
  if (system.length === 0) {
    return system;
  }
  return system.map((block, i) =>
    i === system.length - 1
      ? { ...block, cache_control: { type: "ephemeral" } }
      : block
  );
}

/**
 * Stamp `cache_control:{type:"ephemeral"}` on the LAST tool so the system+tools
 * prefix caches as a unit (§15.1). Returns a fresh array; an empty tool list is
 * passed through untouched.
 */
function withCachedTools(tools: Anthropic.ToolUnion[]): Anthropic.ToolUnion[] {
  if (tools.length === 0) {
    return tools;
  }
  return tools.map((tool, i) =>
    i === tools.length - 1
      ? { ...tool, cache_control: { type: "ephemeral" } }
      : tool
  );
}

/**
 * Append the per-turn snapshot as its own **uncached** user content block, kept
 * separate from the transcript so it never carries `cache_control` (§15.1). The
 * transcript is copied (not mutated). An empty/absent snapshot is a no-op.
 */
function withSnapshotBlock(
  messages: Anthropic.MessageParam[],
  snapshot: string | undefined
): Anthropic.MessageParam[] {
  if (snapshot === undefined || snapshot.length === 0) {
    return [...messages];
  }
  const snapshotMessage: Anthropic.MessageParam = {
    role: "user",
    content: [
      {
        type: "text",
        text: snapshot,
        // Intentionally NO cache_control: the snapshot changes every turn.
      },
    ],
  };
  return [...messages, snapshotMessage];
}

/**
 * Assemble the full {@link Anthropic.MessageStreamParams} for one turn, with the
 * cache breakpoints in the §15.1-mandated positions.
 */
function buildParams(input: RunTurnInput): Anthropic.MessageStreamParams {
  return {
    model: input.model ?? MODEL,
    max_tokens: input.maxTokens ?? MAX_TOKENS,
    system: withCachedSystem(input.system),
    tools: withCachedTools(input.tools),
    messages: withSnapshotBlock(input.messages, input.snapshot),
  };
}

// ---------------------------------------------------------------------------
// Error mapping (no key, no stack-to-webview; log context per code-style)
// ---------------------------------------------------------------------------

/** Map an abort to a structured {@link ClientError}. */
function abortedError(): ClientError {
  return {
    error: "aborted",
    detail: "the streamed turn was aborted before completion",
    hint: "the user cancelled; do not retry automatically",
  };
}

/**
 * Map an unexpected/SDK error to a structured {@link ClientError}, classifying
 * `APIError` distinctly from generic stream failures. Logs context (the host has
 * only `console.*`) but never logs the key.
 */
function mapError(e: unknown): ClientError {
  if (e instanceof Anthropic.APIUserAbortError) {
    return abortedError();
  }
  if (e instanceof Anthropic.APIError) {
    const status = typeof e.status === "number" ? e.status : "unknown";
    console.error(
      `ClaudeClient.runTurn APIError (status ${String(status)}): ${e.message}`
    );
    return {
      error: "api_error",
      detail: `Anthropic API error (status ${String(status)}): ${e.message}`,
      hint: "check the API key, model name, and request shape",
    };
  }
  const detail = e instanceof Error ? e.message : "unknown stream error";
  console.error(`ClaudeClient.runTurn stream error: ${detail}`);
  return {
    error: "stream_error",
    detail,
    hint: "retry the turn; if it persists, inspect ExtensionHost.txt",
  };
}

// ---------------------------------------------------------------------------
// ClaudeClient
// ---------------------------------------------------------------------------

/**
 * Thin, testable wrapper that runs one streamed Messages turn against an
 * injected {@link MessagesClient}. Holds the default model only — never the key
 * (the key is bound inside the {@link MessagesClient} created by
 * {@link createClaudeClient}).
 */
export class ClaudeClient {
  private readonly client: MessagesClient;
  private readonly defaultModel: Anthropic.Model;

  /**
   * @param client       The injected stream seam (real adapter or test fake).
   * @param defaultModel Model used when {@link RunTurnInput.model} is omitted.
   */
  constructor(client: MessagesClient, defaultModel: Anthropic.Model = MODEL) {
    this.client = client;
    this.defaultModel = defaultModel;
  }

  /**
   * Run one streamed turn: open the stream, pipe text deltas to the sink, wire
   * the abort signal, and resolve to the assembled final message.
   *
   * NEVER throws — every failure path (abort, `APIError`, stream error) returns a
   * structured {@link ClientError}. On an already-aborted signal it short-circuits
   * without opening a stream.
   */
  async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    const signal = input.signal;
    if (signal?.aborted) {
      return { ok: false, err: abortedError() };
    }

    const params = buildParams({
      ...input,
      model: input.model ?? this.defaultModel,
    });

    let stream: MessageStreamLike;
    try {
      stream = this.client.stream(params);
    } catch (e) {
      return { ok: false, err: mapError(e) };
    }

    // Wire abort → stream.abort(). Registered with a named handler so it can be
    // removed in `finally`, avoiding a leak across turns on a long-lived signal.
    const onAbort = (): void => {
      stream.abort();
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      if (input.onDelta) {
        const sink = input.onDelta;
        stream.on("text", (textDelta: string) => {
          sink(textDelta);
        });
      }
      // `error` events are surfaced via the rejected `finalMessage()` promise;
      // we still attach a no-op listener so an emitted error does not become an
      // unhandled 'error' event on the emitter.
      stream.on("error", () => {
        /* handled via finalMessage() rejection below */
      });

      const message = await stream.finalMessage();
      return { ok: true, message };
    } catch (e) {
      // An abort can surface either as an APIUserAbortError or via the signal.
      if (signal?.aborted) {
        return { ok: false, err: abortedError() };
      }
      return { ok: false, err: mapError(e) };
    } finally {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Production factory — binds the real SDK client (key stays in Node)
// ---------------------------------------------------------------------------

/**
 * Adapt the real `@anthropic-ai/sdk` client into the narrow {@link MessagesClient}
 * seam. The constructed `Anthropic` instance — and therefore the API key — is
 * captured in this closure and never exposed.
 */
function realMessagesClient(apiKey: string): MessagesClient {
  const anthropic = new Anthropic({ apiKey });
  return {
    stream(params: Anthropic.MessageStreamParams): MessageStreamLike {
      // The SDK MessageStream is a structural superset of MessageStreamLike.
      return anthropic.messages.stream(params);
    },
  };
}

/**
 * Construct a production {@link ClaudeClient} bound to the real SDK.
 *
 * The key resolves from the explicit `apiKey` arg, falling back to
 * `process.env.ANTHROPIC_API_KEY`. It is NEVER hardcoded. A missing key returns a
 * structured {@link ClientError} (`api_error`) rather than throwing, so the
 * caller can route the user to the first-run settings flow (§10).
 *
 * @param apiKey       The Anthropic API key (omit to use the env fallback).
 * @param defaultModel Optional default model (defaults to {@link MODEL}).
 */
export function createClaudeClient(
  apiKey?: string,
  defaultModel: Anthropic.Model = MODEL
): { ok: true; client: ClaudeClient } | { ok: false; err: ClientError } {
  const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (key === undefined || key.length === 0) {
    return {
      ok: false,
      err: {
        error: "api_error",
        detail: "no Anthropic API key provided (arg or ANTHROPIC_API_KEY)",
        hint: "set the key via the first-run settings modal (config.json)",
      },
    };
  }
  return {
    ok: true,
    client: new ClaudeClient(realMessagesClient(key), defaultModel),
  };
}
