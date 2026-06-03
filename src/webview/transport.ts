/**
 * Webview WebSocket transport client (Phase 7 T6 — Spike R3 **Outcome D**).
 *
 * MINIMAL connect-echo stub, NOT the real chat UI (that is Phase 8). Its only
 * job is to prove the live, full-duplex WS round-trip works inside the modal:
 * connect same-origin to the extension's localhost server, send `ready` on
 * open, send `user_message` on submit, and render inbound server frames as
 * plain text.
 *
 * Transport discipline (docs/ARCHITECTURE.md §11, §13):
 * - The webview has ZERO Live-model access; its only channel to the host is this
 *   socket. It never imports from `src/extension/` and never touches the
 *   Anthropic API key.
 * - Every frame is a JSON envelope `{ v, id, type, payload }`. Construction,
 *   (de)serialization, and validation come from the pure `src/shared/protocol`
 *   module — this file owns only the browser-side transport wiring.
 *
 * The extension serves this SPA from `http://127.0.0.1:<port>/?t=<nonce>` and
 * the WS lives on the same origin; the URL/nonce are derived from `location` so
 * no ephemeral port or nonce is ever hardcoded.
 */

import {
  message,
  parseEnvelope,
  serialize,
  isServerMessage,
  isMessageOfType,
  type ServerMessage,
} from "../shared/protocol.js";

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

/** Maximum number of automatic reconnect attempts after a socket closes. */
const MAX_RECONNECT_ATTEMPTS = 5;

/** Base backoff (ms) between reconnect attempts; grows linearly per attempt. */
const RECONNECT_BACKOFF_MS = 750;

/* -------------------------------------------------------------------------- */
/* Render sink                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The minimal rendering surface the transport drives. Implemented by the UI in
 * `main.ts`; kept as an interface so the transport never reaches into the DOM
 * directly and stays trivially swappable when Phase 8 replaces this stub.
 */
export interface ChatSink {
  /**
   * Append streamed assistant text to the in-flight assistant line, creating
   * that line on first delta of a turn.
   *
   * @param text - the incremental chunk to append.
   */
  appendAssistantDelta(text: string): void;

  /**
   * Finalize the in-flight assistant line so the next turn starts fresh.
   *
   * @param stopReason - terminal `stop_reason` from the Messages API.
   */
  finishAssistant(stopReason: string): void;

  /**
   * Render a one-line tool-activity narration.
   *
   * @param tool - the tool name.
   * @param summary - human-readable summary of the call.
   * @param status - lifecycle status (`started` | `ok` | `error`).
   */
  appendToolActivity(tool: string, summary: string, status: string): void;

  /**
   * Render an error line.
   *
   * @param messageText - the failure message to surface.
   */
  appendError(messageText: string): void;

  /**
   * Render a transient status/system line (e.g. connection state).
   *
   * @param text - the status text.
   */
  appendStatus(text: string): void;
}

/* -------------------------------------------------------------------------- */
/* Transport client                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A live, reconnecting WebSocket client to the extension host.
 *
 * Construct with a {@link ChatSink}, call {@link ChatTransport.connect} once to
 * open the socket, and call {@link ChatTransport.sendUserMessage} to submit
 * chat input. The client sends `ready` on open and bounded-reconnects on close.
 */
export class ChatTransport {
  private readonly sink: ChatSink;
  private readonly url: string;
  private socket: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByCaller = false;

  /**
   * @param sink - the rendering surface for inbound frames and status lines.
   * @param url - the WS URL to connect to. Defaults to {@link deriveWebSocketUrl}
   *   (same-origin, nonce-carrying), overridable for tests.
   */
  public constructor(sink: ChatSink, url: string = deriveWebSocketUrl()) {
    this.sink = sink;
    this.url = url;
  }

  /** Open the socket (idempotent while a socket is already live/connecting). */
  public connect(): void {
    if (this.socket !== null) {
      return;
    }
    this.closedByCaller = false;
    this.open();
  }

  /**
   * Send a `user_message` over the socket if open. No-op (with a status line)
   * when disconnected — the stub does not queue.
   *
   * @param text - the user's chat input; ignored when empty/whitespace.
   */
  public sendUserMessage(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return;
    }
    if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) {
      this.sink.appendStatus("Not connected — message not sent.");
      return;
    }
    const envelope = message(
      "user_message",
      { text: trimmed },
      crypto.randomUUID()
    );
    this.socket.send(serialize(envelope));
  }

  /** Close the socket and stop reconnecting. */
  public close(): void {
    this.closedByCaller = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket !== null) {
      this.socket.close();
      this.socket = null;
    }
  }

  /** Open a fresh socket and bind its lifecycle handlers. */
  private open(): void {
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.reconnectAttempts = 0;
      this.sink.appendStatus("Connected.");
      socket.send(serialize(message("ready", {}, crypto.randomUUID())));
    });

    socket.addEventListener("message", (event: MessageEvent) => {
      this.handleRaw(event.data);
    });

    socket.addEventListener("error", () => {
      // Surfaced via the subsequent `close` event; nothing actionable here.
    });

    socket.addEventListener("close", () => {
      this.socket = null;
      if (this.closedByCaller) {
        return;
      }
      this.scheduleReconnect();
    });
  }

  /** Schedule a bounded reconnect with linear backoff, or give up at the cap. */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.sink.appendError("Disconnected — gave up reconnecting.");
      return;
    }
    this.reconnectAttempts += 1;
    const delay = RECONNECT_BACKOFF_MS * this.reconnectAttempts;
    this.sink.appendStatus(
      `Disconnected — reconnecting (attempt ${String(this.reconnectAttempts)} of ${String(
        MAX_RECONNECT_ATTEMPTS
      )})…`
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByCaller) {
        this.open();
      }
    }, delay);
  }

  /**
   * Parse one raw wire frame and dispatch it to the sink. Parse errors and
   * non-server frames are logged to the console and otherwise ignored — the
   * stub never throws on malformed input.
   *
   * @param raw - the raw `MessageEvent.data` (expected to be a string).
   */
  private handleRaw(raw: unknown): void {
    if (typeof raw !== "string") {
      console.warn("[transport] ignoring non-string frame", raw);
      return;
    }
    const result = parseEnvelope(raw);
    if (!result.ok) {
      console.warn("[transport] invalid frame:", result.error);
      return;
    }
    if (!isServerMessage(result.message)) {
      console.warn(
        "[transport] ignoring non-server frame:",
        result.message.type
      );
      return;
    }
    this.dispatch(result.message);
  }

  /**
   * Route a validated server message to the appropriate sink call.
   *
   * @param msg - the parsed, validated server message.
   */
  private dispatch(msg: ServerMessage): void {
    if (isMessageOfType(msg, "assistant_delta")) {
      this.sink.appendAssistantDelta(msg.payload.text);
      return;
    }
    if (isMessageOfType(msg, "assistant_done")) {
      this.sink.finishAssistant(msg.payload.stopReason);
      return;
    }
    if (isMessageOfType(msg, "tool_activity")) {
      const { tool, summary, status } = msg.payload;
      this.sink.appendToolActivity(tool, summary, status);
      return;
    }
    if (isMessageOfType(msg, "error")) {
      this.sink.appendError(msg.payload.message);
      return;
    }
    if (isMessageOfType(msg, "refs_updated")) {
      // Optional this phase: log only, no UI line.
      console.log("[transport] refs_updated:", msg.payload.refs.length, "refs");
      return;
    }
    // config_state / confirm_request are not wired this phase (Phases 9/10).
    console.log("[transport] unhandled server frame:", msg.type);
  }
}

/* -------------------------------------------------------------------------- */
/* URL derivation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Derive the same-origin WebSocket URL from `window.location`.
 *
 * The extension serves the SPA from `http://127.0.0.1:<port>/?t=<nonce>` and
 * runs the WS on the same origin. Using `location.host` carries the ephemeral
 * port, and `location.search` carries the `?t=<nonce>` through to the upgrade
 * request — so neither port nor nonce is ever hardcoded.
 *
 * @returns the `ws://<host>/<?t=nonce>` URL to connect to.
 */
export function deriveWebSocketUrl(): string {
  return `ws://${location.host}/${location.search}`;
}
