// @vitest-environment jsdom

/**
 * Webview transport reconnect-counter tests — Phase 8 hardening (P8-4).
 *
 * Pins the latent-footgun fix in {@link ChatTransport}: the reconnect-attempt
 * counter must be reset ONLY on a confirmed first valid inbound server frame,
 * never on the raw socket `open`. A raw `open` can fire for a connection the
 * extension server then rejects post-handshake; resetting the counter there
 * would let a reject→reconnect cycle loop forever, never hitting the cap.
 *
 * The transport is driven through a minimal fake `WebSocket` (the only browser
 * global it touches besides `crypto.randomUUID`, provided by jsdom). We assert
 * counter behavior indirectly through the user-visible reconnect status lines,
 * which embed the live attempt number — no access to private fields needed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatTransport, type ChatSink } from "../src/webview/transport.js";
import { message, serialize } from "../src/shared/protocol.js";

/* -------------------------------------------------------------------------- */
/* Fake WebSocket                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A hand-driven {@link WebSocket} stand-in: tests fire `open`/`message`/`close`
 * explicitly and inspect nothing on the wire. Only the surface the transport
 * uses is implemented.
 */
class FakeWebSocket {
  public static readonly CONNECTING = 0;
  public static readonly OPEN = 1;
  public static readonly CLOSING = 2;
  public static readonly CLOSED = 3;

  /** All instances created during a test, in construction order. */
  public static instances: FakeWebSocket[] = [];

  public readyState: number = FakeWebSocket.CONNECTING;
  public readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(ev: unknown) => void>>();

  public constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  public addEventListener(type: string, fn: (ev: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  /** Fire `open` as the browser would after a successful upgrade. */
  public fireOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  /** Deliver one raw inbound wire frame to the transport. */
  public fireMessage(raw: string): void {
    this.emit("message", { data: raw });
  }

  /** Fire `close` as the browser would after the socket drops. */
  public fireClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
  }

  private emit(type: string, ev: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) {
      fn(ev);
    }
  }
}

/** A no-op sink that records every status line for assertion. */
function recordingSink(): ChatSink & { statuses: string[]; errors: string[] } {
  const statuses: string[] = [];
  const errors: string[] = [];
  return {
    statuses,
    errors,
    appendAssistantDelta(): void {},
    finishAssistant(): void {},
    appendToolActivity(): void {},
    appendError(text: string): void {
      errors.push(text);
    },
    appendStatus(text: string): void {
      statuses.push(text);
    },
    appendConfirmCard(): void {},
  };
}

/** A valid inbound server frame (any server type re-arms the same way). */
const SERVER_FRAME = serialize(
  message("config_state", { hasKey: true, model: "claude" }, "fixed-id")
);

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------- */
/* Reconnect-counter semantics                                                */
/* -------------------------------------------------------------------------- */

describe("ChatTransport — reconnect-counter reset", () => {
  it("test_transport_rawOpenDoesNotResetReconnectCounter", () => {
    const sink = recordingSink();
    const transport = new ChatTransport(sink, "ws://test/");
    transport.connect();

    // Connection 1: open then immediate close WITHOUT a server frame (the
    // post-handshake-reject shape). Counter must climb to 1.
    FakeWebSocket.instances[0]?.fireOpen();
    FakeWebSocket.instances[0]?.fireClose();
    expect(sink.statuses).toContain(
      "Disconnected — reconnecting (attempt 1 of 5)…"
    );

    // Reconnect fires; connection 2 repeats the reject shape (raw open, no
    // frame). If raw `open` reset the counter, this would read "attempt 1"
    // again — it must read "attempt 2", proving no reset on open.
    vi.runOnlyPendingTimers();
    FakeWebSocket.instances[1]?.fireOpen();
    FakeWebSocket.instances[1]?.fireClose();
    expect(sink.statuses).toContain(
      "Disconnected — reconnecting (attempt 2 of 5)…"
    );
  });

  it("test_transport_validServerFrameResetsReconnectCounter", () => {
    const sink = recordingSink();
    const transport = new ChatTransport(sink, "ws://test/");
    transport.connect();

    // Connection 1: reject shape → counter climbs to 1.
    FakeWebSocket.instances[0]?.fireOpen();
    FakeWebSocket.instances[0]?.fireClose();
    expect(sink.statuses).toContain(
      "Disconnected — reconnecting (attempt 1 of 5)…"
    );

    // Connection 2: a HEALTHY connection — open AND a valid server frame —
    // confirms bidirectional comms and must reset the counter.
    vi.runOnlyPendingTimers();
    FakeWebSocket.instances[1]?.fireOpen();
    FakeWebSocket.instances[1]?.fireMessage(SERVER_FRAME);
    FakeWebSocket.instances[1]?.fireClose();

    // Counter was reset by the frame, so this close reads "attempt 1" again.
    const attempt1Count = sink.statuses.filter(
      (s) => s === "Disconnected — reconnecting (attempt 1 of 5)…"
    ).length;
    expect(attempt1Count).toBe(2);
  });

  it("test_transport_capReachedAfterFiveFramelessRejects", () => {
    const sink = recordingSink();
    const transport = new ChatTransport(sink, "ws://test/");
    transport.connect();

    // Consecutive reject-shaped connections (raw open, no frame) must hit the
    // cap — exactly what the old reset-on-open bug prevented. The first close
    // is attempt 1; the cap (give-up) fires once the counter is already at
    // MAX_RECONNECT_ATTEMPTS (5), i.e. on the close after the 5th reconnect.
    // Drive cycles until the give-up error appears (bounded to avoid runaway).
    for (let i = 0; i < 10 && sink.errors.length === 0; i += 1) {
      const socket = FakeWebSocket.instances[i];
      if (socket === undefined) {
        break;
      }
      socket.fireOpen();
      socket.fireClose();
      vi.runOnlyPendingTimers();
    }

    expect(sink.errors).toContain("Disconnected — gave up reconnecting.");
  });
});
