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

  /**
   * Render an unmistakable destructive-action confirm card with explicit
   * Cancel / approve controls. The card answers exactly once, then resolves to
   * an inert "Approved"/"Declined" state.
   *
   * @param planId - the plan id echoed back in `confirm_response`.
   * @param summary - the human-readable headline (states the total count).
   * @param actions - the itemized destructive actions the card lists.
   */
  appendConfirmCard(planId: string, summary: string, actions: string[]): void;
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
   * Whether the current connection has yielded at least one valid inbound
   * `ServerMessage`. Gates the one-time `reconnectAttempts` reset so the counter
   * only clears on *confirmed* bidirectional communication — never on the raw
   * socket `open`, which can fire even for a connection the server then rejects
   * post-handshake (the latent infinite-reconnect footgun). Set true on the
   * first valid server frame; cleared on `close` so each new connection re-arms.
   */
  private receivedServerFrame = false;

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

  /**
   * Send a `confirm_response` answering a prior `confirm_request`. No-op (with a
   * status line) when disconnected — a stale card cannot be answered offline.
   *
   * @param planId - the plan id from the `confirm_request` being answered.
   * @param approved - the user's decision (`true` = run the destructive batch).
   */
  public sendConfirmResponse(planId: string, approved: boolean): void {
    if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) {
      this.sink.appendStatus("Not connected — confirmation not sent.");
      return;
    }
    const envelope = message(
      "confirm_response",
      { planId, approved },
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
      // NOTE: do NOT reset `reconnectAttempts` here. A raw `open` only means the
      // browser accepted the upgrade; the server may still reject the connection
      // post-handshake and close it. Resetting the counter on `open` would let
      // such a reject→reconnect cycle loop forever, never hitting the cap. The
      // counter is reset only on the first valid inbound server frame (see
      // `handleRaw`), which proves real bidirectional communication.
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
      // Re-arm the one-time counter reset for the next connection: a fresh
      // socket must again prove itself with a valid inbound server frame.
      this.receivedServerFrame = false;
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
    // First valid server frame on this connection confirms real bidirectional
    // communication — only now is it safe to clear the reconnect counter. Gated
    // by `receivedServerFrame` so the reset happens once per connection (any
    // valid server frame qualifies; `config_state` is not special-cased).
    if (!this.receivedServerFrame) {
      this.receivedServerFrame = true;
      this.reconnectAttempts = 0;
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
    if (isMessageOfType(msg, "confirm_request")) {
      const { planId, summary, actions } = msg.payload;
      this.sink.appendConfirmCard(planId, summary, actions);
      return;
    }
    // config_state is not wired this phase (Phase 10).
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
