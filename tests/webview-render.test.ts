// @vitest-environment jsdom

/**
 * Webview sink→DOM render tests — Phase 8 (Spike R3 **Outcome D**, streaming SPA).
 *
 * Drives the REAL {@link createSink} from `src/webview/main.ts` against a jsdom
 * message-list element and asserts the produced DOM. The sink is the live
 * rendering surface the frozen {@link ChatTransport} calls into, so these tests
 * exercise the actual message→DOM logic — streaming bubble accumulation,
 * in-place tool-chip transitions, status/error lines, and (critically) the
 * `.textContent`-only rendering that makes model/network text inert against XSS.
 *
 * The transport (`src/webview/transport.ts`) and protocol (`src/shared/protocol.ts`)
 * are NOT imported or exercised here — only the sink contract they share. The
 * `createSink(root)` seam is the single minimal export added to `main.ts` to make
 * the real sink unit-mountable without instantiating the WebSocket transport.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSink } from "../src/webview/main.js";
import type { ChatSink } from "../src/webview/transport.js";

/** A fresh message-list element (the `#log` analogue) for one test. */
let log: HTMLElement;
/** The sink under test, bound to {@link log}. */
let sink: ChatSink;

beforeEach(() => {
  document.body.replaceChildren();
  log = document.createElement("div");
  log.id = "log";
  document.body.appendChild(log);
  sink = createSink(log);
});

afterEach(() => {
  document.body.replaceChildren();
});

/* -------------------------------------------------------------------------- */
/* Assistant streaming                                                        */
/* -------------------------------------------------------------------------- */

describe("createSink — assistant streaming", () => {
  it("test_webview_streaming_multipleDeltasExtendOneBubble", () => {
    sink.appendAssistantDelta("Hello");
    sink.appendAssistantDelta(", ");
    sink.appendAssistantDelta("world");

    const bubbles = log.querySelectorAll(".msg-agent");
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]?.textContent).toBe("Hello, world");
  });

  it("test_webview_streaming_caretPresentDuringStream", () => {
    sink.appendAssistantDelta("typing");

    const carets = log.querySelectorAll(".caret");
    expect(carets).toHaveLength(1);
    // The caret lives inside the single in-flight agent bubble.
    expect(
      log.querySelector(".msg-agent")?.querySelector(".caret")
    ).not.toBeNull();
  });

  it("test_webview_streaming_caretRemovedAfterFinish", () => {
    sink.appendAssistantDelta("done");
    sink.finishAssistant("end_turn");

    expect(log.querySelectorAll(".caret")).toHaveLength(0);
    // The text survives the caret removal.
    expect(log.querySelector(".msg-agent")?.textContent).toBe("done");
  });

  it("test_webview_streaming_finishOpensFreshBubbleForNextTurn", () => {
    sink.appendAssistantDelta("first");
    sink.finishAssistant("end_turn");
    sink.appendAssistantDelta("second");

    const bubbles = log.querySelectorAll(".msg-agent");
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0]?.textContent).toBe("first");
    expect(bubbles[1]?.textContent).toBe("second");
    // Only the new (second) bubble carries a live caret.
    expect(log.querySelectorAll(".caret")).toHaveLength(1);
    expect(bubbles[1]?.querySelector(".caret")).not.toBeNull();
  });

  it("test_webview_streaming_nonEndTurnStopReasonAppendsHint", () => {
    sink.appendAssistantDelta("partial");
    sink.finishAssistant("max_tokens");

    const hint = log.querySelector(".msg-agent .stop-hint");
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toBe(" (max_tokens)");
    expect(log.querySelectorAll(".caret")).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Tool-activity chips: in-place transition                                   */
/* -------------------------------------------------------------------------- */

describe("createSink — tool-activity chips", () => {
  it("test_webview_chip_startedThenOkSettlesSameChip", () => {
    sink.appendToolActivity(
      "live_update_track",
      "Rename track to Bass",
      "started"
    );

    let chips = log.querySelectorAll(".chip");
    expect(chips).toHaveLength(1);
    expect(chips[0]?.classList.contains("chip-started")).toBe(true);
    const startedChip = chips[0];

    sink.appendToolActivity("live_update_track", "Rename track to Bass", "ok");

    chips = log.querySelectorAll(".chip");
    // SAME chip settled in place — count stays 1 across started→ok.
    expect(chips).toHaveLength(1);
    expect(chips[0]).toBe(startedChip);
    expect(chips[0]?.classList.contains("chip-started")).toBe(false);
    expect(chips[0]?.classList.contains("chip-ok")).toBe(true);
    expect(chips[0]?.querySelector(".chip-label")?.textContent).toBe(
      "Rename track to Bass — done"
    );
  });

  it("test_webview_chip_startedThenErrorSettlesSameChip", () => {
    sink.appendToolActivity("live_delete", "Delete clip", "started");
    const startedChip = log.querySelector(".chip");

    sink.appendToolActivity("live_delete", "Delete clip", "error");

    const chips = log.querySelectorAll(".chip");
    expect(chips).toHaveLength(1);
    expect(chips[0]).toBe(startedChip);
    expect(chips[0]?.classList.contains("chip-error")).toBe(true);
    expect(chips[0]?.classList.contains("chip-started")).toBe(false);
    expect(chips[0]?.querySelector(".chip-label")?.textContent).toBe(
      "Delete clip — failed"
    );
  });

  it("test_webview_chip_concurrentSameToolSettleOldestFirst", () => {
    // Two concurrent calls of the same tool; the protocol carries no id, so the
    // oldest unsettled chip settles first (FIFO), mirroring the backend's
    // in-order settlement in agent-loop.ts (fires all started events, then
    // settles them in request order i=0, i=1, …). The count stays stable.
    sink.appendToolActivity("live_set_param", "Set volume", "started");
    sink.appendToolActivity("live_set_param", "Set pan", "started");
    const chips0 = log.querySelectorAll(".chip");
    expect(chips0).toHaveLength(2);
    // Pin the chips by creation order so we can assert WHICH one settled.
    const chipA = chips0[0]; // oldest (Set volume)
    const chipB = chips0[1]; // most-recent (Set pan)

    // First settlement event settles the OLDEST chip (A), not the most recent.
    sink.appendToolActivity("live_set_param", "Set volume", "ok");
    const chips1 = log.querySelectorAll(".chip");
    expect(chips1).toHaveLength(2);
    // Chip identity is preserved (no chip created/destroyed) — same nodes, in order.
    expect(chips1[0]).toBe(chipA);
    expect(chips1[1]).toBe(chipB);
    // The oldest chip (A) settled; the most-recent (B) is still in flight.
    expect(chipA?.classList.contains("chip-ok")).toBe(true);
    expect(chipA?.classList.contains("chip-started")).toBe(false);
    expect(chipA?.querySelector(".chip-label")?.textContent).toBe(
      "Set volume — done"
    );
    expect(chipB?.classList.contains("chip-started")).toBe(true);
    expect(chipB?.classList.contains("chip-ok")).toBe(false);

    // Second settlement event settles the remaining chip (B).
    sink.appendToolActivity("live_set_param", "Set pan", "ok");
    const chips2 = log.querySelectorAll(".chip");
    expect(chips2).toHaveLength(2);
    expect(chipB?.classList.contains("chip-ok")).toBe(true);
    expect(chipB?.classList.contains("chip-started")).toBe(false);
    expect(chipB?.querySelector(".chip-label")?.textContent).toBe(
      "Set pan — done"
    );
  });

  it("test_webview_chip_settledTerminalEmitWithoutStartedRendersFreshChip", () => {
    // Defensive path: a terminal status with no prior started chip still renders
    // exactly one settled chip rather than silently dropping the narration.
    sink.appendToolActivity("live_get_project", "Read project", "ok");

    const chips = log.querySelectorAll(".chip");
    expect(chips).toHaveLength(1);
    expect(chips[0]?.classList.contains("chip-ok")).toBe(true);
    expect(chips[0]?.querySelector(".chip-label")?.textContent).toBe(
      "Read project — done"
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Status + error lines                                                       */
/* -------------------------------------------------------------------------- */

describe("createSink — status and error lines", () => {
  it("test_webview_error_rendersErrorLine", () => {
    sink.appendError("Connection refused");

    const line = log.querySelector(".line-error");
    expect(line).not.toBeNull();
    expect(line?.textContent).toBe("Connection refused");
  });

  it("test_webview_status_rendersStatusLine", () => {
    sink.appendStatus("Connected.");

    const line = log.querySelector(".line-status");
    expect(line).not.toBeNull();
    expect(line?.textContent).toBe("Connected.");
  });
});

/* -------------------------------------------------------------------------- */
/* XSS / escaping                                                             */
/* -------------------------------------------------------------------------- */

describe("createSink — XSS / escaping", () => {
  const PAYLOAD = '<img src=x onerror="alert(1)"><b>bold</b>';

  it("test_webview_xss_assistantDeltaRendersAsLiteralText", () => {
    sink.appendAssistantDelta(PAYLOAD);

    const bubble = log.querySelector(".msg-agent");
    // Round-trips through textContent verbatim — the markup is plain text.
    expect(bubble?.textContent).toBe(PAYLOAD);
    // No injected element nodes were created from the payload.
    expect(log.querySelector("img")).toBeNull();
    expect(log.querySelector("b")).toBeNull();
  });

  it("test_webview_xss_toolSummaryRendersAsLiteralText", () => {
    sink.appendToolActivity("live_update_track", PAYLOAD, "started");

    const label = log.querySelector(".chip-label");
    expect(label?.textContent).toBe(PAYLOAD);
    expect(log.querySelector("img")).toBeNull();
    expect(log.querySelector("b")).toBeNull();
  });

  it("test_webview_xss_errorLineRendersAsLiteralText", () => {
    sink.appendError(PAYLOAD);

    const line = log.querySelector(".line-error");
    expect(line?.textContent).toBe(PAYLOAD);
    expect(log.querySelector("img")).toBeNull();
    expect(log.querySelector("b")).toBeNull();
  });
});
