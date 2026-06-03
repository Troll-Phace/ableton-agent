/**
 * Chat session glue — binds the {@link TransportServer} socket to the agentic
 * tool-use loop for Spike R3 **Outcome D** (localhost full-duplex WS, act in
 * place; docs/ARCHITECTURE.md §4 data flow, §13 socket protocol, §11 transport).
 *
 * One {@link ChatSession} exists **per open modal**. It owns:
 *  - the inbound dispatcher (`server.onMessage`), branching with
 *    {@link isMessageOfType} over the §13 client subset wired this phase
 *    (`ready` / `user_message` / `cancel`); `confirm_response` / `set_config`
 *    are defined-but-unwired (Phases 9/10) and ignored gracefully;
 *  - the in-memory transcript (`Anthropic.MessageParam[]`) carried across turns
 *    of this session (durable persistence is Phase 10);
 *  - an {@link AgentEvents} adapter that serializes each loop event to a §13
 *    socket frame via `server.send(message(...))`, minting a fresh
 *    `crypto.randomUUID()` id per frame;
 *  - the per-turn {@link AbortController} that `cancel` (and {@link ChatSession.dispose})
 *    trips so the loop never lands a half-applied transaction (§7 / R5).
 *
 * **Outcome D only**: mutations apply in place — there is no close-to-apply
 * bridge (that is Outcome C) and no propose→apply plan (that is A/B). There is no
 * real project snapshot yet (Phase 11); a short honest placeholder is sent so the
 * model never fabricates project state.
 *
 * **Key discipline (§10):** the Anthropic API key never enters any outbound
 * {@link ProtocolMessage} — `config_state` carries only the boolean `hasKey`. The
 * key lives in Node (env for now; Phase 10 reads it from `config.json`).
 *
 * **Concurrent turns:** a single turn runs at a time. If a `user_message` arrives
 * while a turn is in flight, the session rejects it with one `error` frame
 * ("A turn is already in progress.") and drops it — the simplest correct
 * behavior (no hidden queue that could surprise the user with a delayed reply).
 *
 * The host's only log sink is `console.*` (code-style "Error handling"), so every
 * caught failure logs structured context and converts to an `error` frame rather
 * than throwing.
 */

import { randomUUID } from "node:crypto";

import type { ApiVersion, ExtensionContext } from "@ableton-extensions/sdk";

import type Anthropic from "@anthropic-ai/sdk";

import {
  isMessageOfType,
  message,
  type ClientMessage,
  type ProtocolMessage,
} from "../../shared/protocol.js";
import { runAgentLoop, type AgentEvents } from "../agent-loop.js";
import { createClaudeClient, MODEL } from "../claude-client.js";
import { ReferenceTable } from "../references.js";
import { buildSystemPrompt } from "../system-prompt.js";
import { LiveToolRuntime } from "../tool-registry.js";

import type { TransportServer } from "./server.js";

/** Log prefix mirroring the host's `console.*` convention. */
const LOG_PREFIX = "[session]";

/**
 * Placeholder snapshot sent until the real serializer lands (Phase 11). Kept
 * deliberately minimal and honest — it states that no project data is wired yet
 * so the model leans on the `live_get_*` read tools rather than inventing state.
 */
const SNAPSHOT_PLACEHOLDER =
  "[project snapshot not yet wired — Phase 11 will provide the full Live Set " +
  "snapshot here; until then, use the live_get_* read tools to inspect the Set].";

/** Message surfaced to the webview when no Anthropic API key is available. */
const NO_KEY_MESSAGE =
  "No Anthropic API key configured. Add one in settings to start chatting.";

/** Message surfaced when a second turn is requested while one is in flight. */
const BUSY_MESSAGE = "A turn is already in progress.";

/** Arguments handed to a {@link TurnRunner} for one turn. */
export interface TurnRunArgs {
  /** The user's chat input text for this turn. */
  text: string;
  /**
   * The running transcript (by reference). The runner appends the user turn and
   * any assistant/tool_result messages and returns the array to adopt. On a
   * graceful no-start (e.g. no API key) it returns the transcript unchanged so no
   * dangling user message is left behind.
   */
  transcript: Anthropic.MessageParam[];
  /**
   * The event adapter that serializes loop events to socket frames. The same
   * instance is passed to both the default and an injected runner, so a runner
   * emitting `events.assistantDelta` / `toolActivity` / `assistantDone` produces
   * real `assistant_delta` / `tool_activity` / `assistant_done` frames.
   */
  events: AgentEvents;
  /**
   * The in-flight turn's cancellation signal. `cancel` / `dispose` trip it, so a
   * runner that observes `signal.aborted` (or the loop's own check) cancels
   * cleanly (§7 / R5).
   */
  signal: AbortSignal;
}

/** Result a {@link TurnRunner} returns after one turn. */
export interface TurnRunResult {
  /** Whether the turn completed successfully (false → an `error` frame is sent). */
  ok: boolean;
  /** The transcript to adopt so multi-turn context carries (§4). */
  messages: Anthropic.MessageParam[];
  /** The turn-scoped refs to surface via `refs_updated` (§6). */
  refs: string[];
  /**
   * On `ok:false`, the user-facing message for the single `error` frame the
   * session should send. Must already be sanitized (no key, no stack — §10).
   *
   * Single-ownership of the error frame (EXACTLY ONE per failed turn): set this
   * ONLY for a failure the runner did NOT itself surface via `events.error` (e.g.
   * the no-key short-circuit). When the runner already emitted an `error` frame
   * through `events.error` (as `runAgentLoop` does on every loop failure), OMIT
   * `errorMessage` — the session then adds no second frame.
   */
  errorMessage?: string;
  /**
   * Whether the turn actually engaged the loop. The session emits the trailing
   * `refs_updated` only when `true`, so a graceful no-start (e.g. no API key)
   * short-circuits before `refs_updated` (preserving the original contract).
   * Defaults to `true` when omitted — a runner that ran a turn need not set it.
   */
  ran?: boolean;
}

/**
 * The per-turn loop runner. The default ({@link ChatSession} private
 * `defaultRunTurn`) wires `createClaudeClient` + a fresh turn-scoped
 * {@link LiveToolRuntime} + {@link runAgentLoop}; tests inject a scripted fake to
 * drive a turn without a live API key/network.
 */
export type TurnRunner = (args: TurnRunArgs) => Promise<TurnRunResult>;

/** Optional construction options for a {@link ChatSession}. */
export interface ChatSessionOptions {
  /** Model override forwarded to the loop/client (defaults to the client's). */
  model?: Anthropic.Model;
  /** Max output tokens per turn (forwarded to the loop/client). */
  maxTokens?: number;
  /**
   * Test seam: override the per-turn loop runner. Defaults to the production
   * `createClaudeClient` + `LiveToolRuntime` + `runAgentLoop` wiring. The session
   * still owns the `activeTurn` AbortController (set before the runner, cleared in
   * `finally`), the concurrent-turn rejection, and the post-turn `refs_updated` —
   * so the guard, `cancel`, and ref emission are testable through an injected
   * runner.
   */
  runTurn?: TurnRunner;
}

/**
 * One chat session per open modal: wires the socket transport to the agentic
 * loop, owns the transcript and the in-flight turn's cancellation.
 *
 * Construct with the SDK context and a started {@link TransportServer}, then the
 * session is fully wired — no further setup call is needed. Call
 * {@link ChatSession.dispose} on modal close.
 *
 * @typeParam V The SDK API version (matches the host's `ExtensionContext`).
 */
export class ChatSession<V extends ApiVersion> {
  /** The SDK context (host or test fake). Never cached into handles (§6). */
  private readonly ctx: ExtensionContext<V>;

  /** The localhost transport this session drives. */
  private readonly server: TransportServer;

  /** Construction options (model / token overrides). */
  private readonly opts: ChatSessionOptions;

  /**
   * In-memory transcript carried across turns of THIS session. The loop appends
   * the assistant + tool_result messages and returns the updated array, which we
   * adopt so multi-turn context accumulates (Phase 10 makes this durable).
   */
  private transcript: Anthropic.MessageParam[] = [];

  /** The in-flight turn's abort controller, or `null` when idle. */
  private activeTurn: AbortController | null = null;

  /** True once {@link ChatSession.dispose} has run (idempotency guard). */
  private disposed = false;

  /**
   * @param ctx    The SDK extension context (real host or the test fake).
   * @param server A started {@link TransportServer} (the modal's socket channel).
   * @param opts   Optional model / token overrides.
   */
  public constructor(
    ctx: ExtensionContext<V>,
    server: TransportServer,
    opts: ChatSessionOptions = {}
  ) {
    this.ctx = ctx;
    this.server = server;
    this.opts = opts;
    this.server.onMessage((msg) => {
      this.dispatch(msg);
    });
  }

  /* ----------------------------------------------------------------------- */
  /* Inbound dispatch                                                        */
  /* ----------------------------------------------------------------------- */

  /**
   * Route one validated inbound {@link ClientMessage} to its handler.
   *
   * Wired this phase: `ready`, `user_message`, `cancel`. `confirm_response`
   * (Phase 9) and `set_config` (Phase 10) are ignored gracefully with a debug
   * log — never an error to the user. Never throws (the transport's handler
   * wrapper also guards, but we keep this total for safety).
   */
  private dispatch(msg: ClientMessage): void {
    try {
      if (isMessageOfType(msg, "ready")) {
        this.handleReady();
        return;
      }
      if (isMessageOfType(msg, "user_message")) {
        void this.handleUserMessage(msg.payload.text);
        return;
      }
      if (isMessageOfType(msg, "cancel")) {
        this.handleCancel();
        return;
      }
      // confirm_response (Phase 9) / set_config (Phase 10): not wired here.
      console.debug(`${LOG_PREFIX} ignoring unwired message "${msg.type}"`);
    } catch (err) {
      console.error(`${LOG_PREFIX} dispatch failed for "${msg.type}"`, err);
    }
  }

  /**
   * Answer `ready` with a best-effort `config_state` carrying only the boolean
   * `hasKey` (never the key itself, §10) and the active model. `hasKey` reflects
   * whether a key is available to the host now (env fallback for this phase).
   */
  private handleReady(): void {
    const hasKey = this.hasApiKey();
    // Single source of truth for the default model (the client's `MODEL`); an
    // explicit `opts.model` override wins.
    const model = this.opts.model ?? MODEL;
    this.send(message("config_state", { hasKey, model }, randomUUID()));
  }

  /** Trip the in-flight turn's abort signal, if any (idempotent). */
  private handleCancel(): void {
    if (this.activeTurn !== null) {
      console.debug(`${LOG_PREFIX} cancel — aborting in-flight turn`);
      this.activeTurn.abort();
    }
  }

  /* ----------------------------------------------------------------------- */
  /* Turn execution                                                          */
  /* ----------------------------------------------------------------------- */

  /**
   * Run one agentic turn for the given user text.
   *
   * Single-turn-at-a-time: a `user_message` arriving while a turn is in flight is
   * rejected with one `error` frame and dropped (see class docs). On success the
   * loop streams `assistant_delta` / `tool_activity` / `assistant_done`; on
   * failure it emits one `error` frame. A trailing `refs_updated` always follows
   * a turn that actually ran the loop, carrying the turn-scoped table's refs.
   *
   * Never throws — every async step is guarded and converted to an `error` frame.
   */
  private async handleUserMessage(text: string): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.activeTurn !== null) {
      this.sendError(BUSY_MESSAGE);
      return;
    }

    // The session owns the AbortController regardless of which runner runs, so
    // the concurrent-turn guard and `cancel` work for both the default and an
    // injected runner. Set BEFORE running; cleared in `finally`.
    const controller = new AbortController();
    this.activeTurn = controller;

    const events = this.buildEvents();
    const runner = this.opts.runTurn ?? ((args) => this.defaultRunTurn(args));

    // The refs to surface and whether to surface them. A graceful no-start (e.g.
    // no key, `ran:false`) short-circuits before `refs_updated`, matching the
    // original contract; a turn that ran the loop emits the runner's refs. The
    // catch path keeps `sendRefs` true (a loop throw still emits empty refs,
    // as before).
    let refs: string[] = [];
    let sendRefs = true;

    try {
      const result = await runner({
        text,
        transcript: this.transcript,
        events,
        signal: controller.signal,
      });

      // Adopt the updated transcript either way so multi-turn context carries
      // (the runner returns it as far as it progressed, even on failure).
      this.transcript = result.messages;
      refs = result.refs;
      sendRefs = result.ran !== false;

      if (!result.ok && result.errorMessage !== undefined) {
        // EXACTLY ONE `error` frame per failed turn. The session sends the frame
        // ONLY when the runner hands up an (already-sanitized) `errorMessage` —
        // i.e. for a failure the runner did NOT itself surface (e.g. the no-key
        // short-circuit). A loop failure already emitted its frame via
        // `events.error` and returns WITHOUT `errorMessage`, so the session adds
        // none — never double-reporting.
        this.sendError(result.errorMessage);
      }
    } catch (err) {
      // Defensive: the default runner never throws, but an injected runner (or a
      // surprise) must still become an `error` frame, never an unhandled
      // rejection.
      console.error(`${LOG_PREFIX} unexpected turn failure`, err);
      this.sendError("The turn failed unexpectedly. Please try again.");
    } finally {
      this.activeTurn = null;
    }

    // After a turn that ran, surface the turn-scoped refs so the webview can
    // re-ground (§6). Sent outside the try so it runs on success and failure.
    if (sendRefs) {
      try {
        this.send(message("refs_updated", { refs }, randomUUID()));
      } catch (err) {
        console.error(`${LOG_PREFIX} failed to send refs_updated`, err);
      }
    }
  }

  /**
   * The production per-turn runner: build the Claude client, run the agentic loop
   * with a fresh turn-scoped {@link ReferenceTable} + {@link LiveToolRuntime}, and
   * return the adopted transcript plus the table's refs.
   *
   * No-key / graceful path: when `createClaudeClient` returns `{ ok:false }` (no
   * API key), it returns `{ ok:false }` with `errorMessage = NO_KEY_MESSAGE` and
   * WITHOUT appending the user message — the transcript is returned unchanged so
   * no dangling user turn is left behind, and `refs` is empty. The session sends
   * the single `error` frame; the key never enters any frame (only the sanitized
   * `NO_KEY_MESSAGE`, §10).
   *
   * Never throws: a loop failure returns `{ ok:false }` carrying the loop's
   * sanitized structured-error detail as `errorMessage`.
   */
  private async defaultRunTurn(args: TurnRunArgs): Promise<TurnRunResult> {
    const { text, transcript, events, signal } = args;

    // Build the client first so a missing key never appends a dangling user
    // message to the transcript (the turn simply does not start).
    const created = createClaudeClient(undefined, this.opts.model);
    if (!created.ok) {
      console.error(`${LOG_PREFIX} no Claude client: ${created.err.detail}`);
      return {
        ok: false,
        messages: transcript,
        refs: [],
        errorMessage: NO_KEY_MESSAGE,
        // No-start: the loop never ran, so short-circuit before `refs_updated`.
        ran: false,
      };
    }

    // Append the user turn to the running transcript.
    transcript.push({ role: "user", content: text });

    // Turn-scoped ReferenceTable (§6): construct it here and pass it into the
    // runtime so we can read `refs.all()` after the loop for `refs_updated`.
    const refs = new ReferenceTable();
    const runtime = new LiveToolRuntime(this.ctx, refs, signal);

    const result = await runAgentLoop({
      client: created.client,
      runtime,
      events,
      system: buildSystemPrompt(),
      snapshot: SNAPSHOT_PLACEHOLDER,
      messages: transcript,
      model: this.opts.model,
      maxTokens: this.opts.maxTokens,
      signal,
    });

    if (!result.ok) {
      // The loop ALREADY surfaced this failure via `events.error(detail)` (→ the
      // `error` adapter → one `error` frame). Return WITHOUT `errorMessage` so the
      // session adds no second frame — single-ownership of the error frame
      // (EXACTLY ONE per failed turn). `refs_updated` still follows since the loop
      // ran (`ran` defaults to true).
      return { ok: false, messages: result.messages, refs: refs.all() };
    }

    return { ok: true, messages: result.messages, refs: refs.all() };
  }

  /**
   * Build the {@link AgentEvents} adapter that serializes each loop event to a
   * §13 socket frame with a fresh per-frame id. Every send is best-effort: the
   * transport drops sends when no client is connected, so a closed modal mid-turn
   * never throws here.
   */
  private buildEvents(): AgentEvents {
    return {
      assistantDelta: (text: string): void => {
        this.send(message("assistant_delta", { text }, randomUUID()));
      },
      toolActivity: (
        tool: string,
        summary: string,
        status: "started" | "ok" | "error"
      ): void => {
        this.send(
          message("tool_activity", { tool, summary, status }, randomUUID())
        );
      },
      assistantDone: (stopReason: string): void => {
        this.send(message("assistant_done", { stopReason }, randomUUID()));
      },
      error: (msg: string): void => {
        this.sendError(msg);
      },
    };
  }

  /* ----------------------------------------------------------------------- */
  /* Teardown                                                                */
  /* ----------------------------------------------------------------------- */

  /**
   * Dispose the session on modal close: abort any in-flight turn and mark the
   * session done so no further turn starts. Idempotent and safe to call multiple
   * times (e.g. on both `onDisconnect` and an explicit close). Does NOT close the
   * {@link TransportServer} — the activation owner owns the server lifecycle.
   */
  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.activeTurn !== null) {
      console.debug(`${LOG_PREFIX} dispose — aborting in-flight turn`);
      this.activeTurn.abort();
      this.activeTurn = null;
    }
  }

  /* ----------------------------------------------------------------------- */
  /* Helpers                                                                 */
  /* ----------------------------------------------------------------------- */

  /**
   * Whether an Anthropic API key is available to the host right now. Reads the
   * env fallback only (Phase 10 adds the `config.json` source). NEVER returns or
   * logs the key itself.
   */
  private hasApiKey(): boolean {
    const key = process.env.ANTHROPIC_API_KEY;
    return typeof key === "string" && key.length > 0;
  }

  /** Send one server frame; the transport no-ops when no client is connected. */
  private send(msg: ProtocolMessage): void {
    this.server.send(msg);
  }

  /** Convenience: send a single `error` frame with a fresh id. */
  private sendError(message_: string): void {
    this.send(message("error", { message: message_ }, randomUUID()));
  }
}
