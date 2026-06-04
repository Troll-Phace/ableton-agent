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

import { createSink, type ChatSinkWithReset } from "../src/webview/main.js";
import type { ChatSink } from "../src/webview/transport.js";

/** A fresh message-list element (the `#log` analogue) for one test. */
let log: HTMLElement;
/** The sink under test, bound to {@link log}. */
let sink: ChatSinkWithReset;

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

/* -------------------------------------------------------------------------- */
/* Confirm card (Phase 9, outcome D — in-chat destructive confirmation)        */
/* -------------------------------------------------------------------------- */

describe("createSink — confirm card", () => {
  /** A spying sink bound to {@link log} that records onConfirmResponse calls. */
  function spyingSink(): {
    sink: ChatSink;
    calls: { planId: string; approved: boolean }[];
  } {
    const calls: { planId: string; approved: boolean }[] = [];
    const spied = createSink(log, (planId, approved) => {
      calls.push({ planId, approved });
    });
    return { sink: spied, calls };
  }

  it("test_webview_confirm_rendersCardWithTitleAndItemPerAction", () => {
    const { sink: s } = spyingSink();
    s.appendConfirmCard("plan-1", "This will permanently change 2 things.", [
      "Delete track:1:Bass",
      "Delete scene:0:Intro",
    ]);

    const card = log.querySelector(".confirm-card");
    expect(card).not.toBeNull();
    // The card is a labelled group for assistive tech.
    expect(card?.getAttribute("role")).toBe("group");
    expect(card?.getAttribute("aria-label")).toBe(
      "Destructive action confirmation"
    );
    // Title = the summary headline.
    expect(card?.querySelector(".confirm-title")?.textContent).toBe(
      "This will permanently change 2 things."
    );
    // One list item per action, in order, as inert text.
    const items = card?.querySelectorAll(".confirm-item");
    expect(items).toHaveLength(2);
    expect(items?.[0]?.textContent).toBe("Delete track:1:Bass");
    expect(items?.[1]?.textContent).toBe("Delete scene:0:Intro");
  });

  it("test_webview_confirm_destructiveButtonHasExplicitLabelNeverOk", () => {
    const { sink: s } = spyingSink();
    s.appendConfirmCard("plan-2", "summary", [
      "Delete track:1:Bass",
      "Delete scene:0:Intro",
      "Delete device:0:Reverb",
    ]);

    const destructive = log.querySelector(".confirm-btn-destructive");
    expect(destructive).not.toBeNull();
    // Explicit, action-stating label derived from the actions — never a bare "OK".
    expect(destructive?.textContent).toBe("Delete 3 items");
    expect(destructive?.textContent).not.toBe("OK");
    // Cancel is explicit too.
    expect(log.querySelector(".confirm-btn-cancel")?.textContent).toBe(
      "Cancel"
    );
  });

  it("test_webview_confirm_singleDeleteLabelIsSingular", () => {
    const { sink: s } = spyingSink();
    s.appendConfirmCard("plan-3", "summary", ["Delete track:1:Bass"]);
    expect(log.querySelector(".confirm-btn-destructive")?.textContent).toBe(
      "Delete 1 item"
    );
  });

  it("test_webview_confirm_mixedActionsLabelIsConfirmNActions", () => {
    const { sink: s } = spyingSink();
    s.appendConfirmCard("plan-4", "summary", [
      "Delete track:1:Bass",
      "Filter notes in track:1:Keys/clip:0:Chords (removes notes outside the kept range)",
    ]);
    // Not all deletes → the generic explicit label, still never "OK".
    const label = log.querySelector(".confirm-btn-destructive")?.textContent;
    expect(label).toBe("Confirm — 2 actions");
    expect(label).not.toBe("OK");
  });

  it("test_webview_confirm_clickDestructiveCallsBackApprovedTrueOnce", () => {
    const { sink: s, calls } = spyingSink();
    s.appendConfirmCard("plan-5", "summary", ["Delete track:1:Bass"]);

    const destructive = log.querySelector<HTMLButtonElement>(
      ".confirm-btn-destructive"
    );
    destructive?.click();
    expect(calls).toEqual([{ planId: "plan-5", approved: true }]);

    // A second click is a no-op (answered exactly once).
    destructive?.click();
    expect(calls).toHaveLength(1);
  });

  it("test_webview_confirm_clickCancelCallsBackApprovedFalseOnce", () => {
    const { sink: s, calls } = spyingSink();
    s.appendConfirmCard("plan-6", "summary", ["Delete track:1:Bass"]);

    const cancel = log.querySelector<HTMLButtonElement>(".confirm-btn-cancel");
    cancel?.click();
    expect(calls).toEqual([{ planId: "plan-6", approved: false }]);

    // After Cancel, clicking the destructive button must NOT fire again.
    log.querySelector<HTMLButtonElement>(".confirm-btn-destructive")?.click();
    expect(calls).toHaveLength(1);
  });

  it("test_webview_confirm_escKeyDeclinesAsCancelOnce", () => {
    const { sink: s, calls } = spyingSink();
    s.appendConfirmCard("plan-7", "summary", ["Delete track:1:Bass"]);

    const card = log.querySelector(".confirm-card");
    card?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    );
    expect(calls).toEqual([{ planId: "plan-7", approved: false }]);

    // A second Esc is a no-op.
    card?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    );
    expect(calls).toHaveLength(1);
  });

  it("test_webview_confirm_afterAnswerButtonsDisabledAndResolvedShown", () => {
    const { sink: s } = spyingSink();
    s.appendConfirmCard("plan-8", "summary", ["Delete track:1:Bass"]);

    const destructive = log.querySelector<HTMLButtonElement>(
      ".confirm-btn-destructive"
    );
    const cancel = log.querySelector<HTMLButtonElement>(".confirm-btn-cancel");
    destructive?.click();

    // Both buttons disabled; the action row hidden; resolved state shown.
    expect(destructive?.disabled).toBe(true);
    expect(cancel?.disabled).toBe(true);
    const resolved = log.querySelector<HTMLElement>(".confirm-resolved");
    expect(resolved?.hidden).toBe(false);
    expect(resolved?.textContent).toBe("Approved");
    expect(resolved?.classList.contains("confirm-resolved-approved")).toBe(
      true
    );
  });

  it("test_webview_confirm_declineShowsDeclinedResolvedState", () => {
    const { sink: s } = spyingSink();
    s.appendConfirmCard("plan-9", "summary", ["Delete track:1:Bass"]);
    log.querySelector<HTMLButtonElement>(".confirm-btn-cancel")?.click();

    const resolved = log.querySelector<HTMLElement>(".confirm-resolved");
    expect(resolved?.textContent).toBe("Declined");
    expect(resolved?.classList.contains("confirm-resolved-declined")).toBe(
      true
    );
  });

  it("test_webview_confirm_actionStringsRenderInertNoInjection", () => {
    const { sink: s } = spyingSink();
    const evil = '<img src=x onerror="alert(1)"><b>bold</b>';
    s.appendConfirmCard("plan-10", evil, [evil]);

    // Title + item carry the markup as literal text; no nodes injected.
    expect(log.querySelector(".confirm-title")?.textContent).toBe(evil);
    expect(log.querySelector(".confirm-item")?.textContent).toBe(evil);
    expect(log.querySelector("img")).toBeNull();
    expect(log.querySelector("b")).toBeNull();
  });

  it("test_webview_confirm_noCallbackWired_doesNotThrowOnAnswer", () => {
    // createSink with no onConfirmResponse must still render + answer safely.
    const noCallbackSink = createSink(log);
    noCallbackSink.appendConfirmCard("plan-11", "summary", [
      "Delete track:1:Bass",
    ]);
    expect(() =>
      log.querySelector<HTMLButtonElement>(".confirm-btn-destructive")?.click()
    ).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* History rehydration (Phase 10 follow-up — `renderHistory`)                  */
/* -------------------------------------------------------------------------- */

describe("createSink — history rehydration", () => {
  it("test_webview_history_rendersUserAndAgentBubblesInOrder", () => {
    sink.renderHistory([
      { role: "user", text: "what's in this track?" },
      { role: "assistant", text: "A Reverb and a Compressor." },
      { role: "user", text: "rename it" },
    ]);

    // The restored bubbles reuse the SAME live classes, in chronological order.
    const bubbles = log.querySelectorAll(".msg");
    expect(bubbles).toHaveLength(3);
    expect(bubbles[0]?.className).toBe("msg msg-user");
    expect(bubbles[0]?.textContent).toBe("what's in this track?");
    expect(bubbles[1]?.className).toBe("msg msg-agent");
    expect(bubbles[1]?.textContent).toBe("A Reverb and a Compressor.");
    expect(bubbles[2]?.className).toBe("msg msg-user");
    expect(bubbles[2]?.textContent).toBe("rename it");

    // One user-bubble per user item, one agent-bubble per assistant item.
    expect(log.querySelectorAll(".msg-user")).toHaveLength(2);
    expect(log.querySelectorAll(".msg-agent")).toHaveLength(1);
    // Restored assistant bubbles are finished — no streaming caret.
    expect(log.querySelectorAll(".caret")).toHaveLength(0);
  });

  it("test_webview_history_xssInert_textContentVerbatimNoInjection", () => {
    const evil = '<img src=x onerror="alert(1)"><b>x</b>';
    sink.renderHistory([
      { role: "user", text: evil },
      { role: "assistant", text: "<script>steal()</script>" },
    ]);

    const bubbles = log.querySelectorAll(".msg");
    // The markup round-trips as inert plain text (set via textContent).
    expect(bubbles[0]?.textContent).toBe(evil);
    expect(bubbles[1]?.textContent).toBe("<script>steal()</script>");
    // No element nodes were injected from the payload strings.
    expect(log.querySelector("img")).toBeNull();
    expect(log.querySelector("b")).toBeNull();
    expect(log.querySelector("script")).toBeNull();
  });

  it("test_webview_history_dividerPresentWithLabelWhenItemsNonEmpty", () => {
    sink.renderHistory([{ role: "user", text: "hi" }]);

    const divider = log.querySelector(".history-divider");
    expect(divider).not.toBeNull();
    // Decorative + a11y-inert so the restored bubbles are not double-narrated.
    expect(divider?.getAttribute("aria-hidden")).toBe("true");
    expect(divider?.querySelector(".history-divider-label")?.textContent).toBe(
      "Restored from your last session"
    );
  });

  it("test_webview_history_emptyArray_rendersNothingNoDivider", () => {
    // Pinned impl behavior: renderHistory([]) early-returns — no bubbles, and
    // (crucially) no orphan divider for an empty restored block.
    sink.renderHistory([]);

    expect(log.querySelectorAll(".msg")).toHaveLength(0);
    expect(log.querySelector(".history-divider")).toBeNull();
    expect(log.childElementCount).toBe(0);
  });

  it("test_webview_history_thenStreamingOpensFreshAgentBubbleUntouched", () => {
    // After rehydration, a live turn must open a BRAND-NEW agent bubble rather
    // than appending into a restored assistant bubble: renderHistory must not
    // touch the streaming accumulator (streamText/streamBubble stay null).
    sink.renderHistory([
      { role: "user", text: "earlier question" },
      { role: "assistant", text: "earlier answer" },
    ]);

    // Snapshot the restored agent bubble + its text before streaming.
    const restoredAgent = log.querySelectorAll(".msg-agent");
    expect(restoredAgent).toHaveLength(1);
    const restoredAgentNode = restoredAgent[0];

    // A fresh streamed turn.
    sink.appendAssistantDelta("Hi");
    sink.finishAssistant("end_turn");

    const agents = log.querySelectorAll(".msg-agent");
    // Two agent bubbles now: the restored one + the freshly streamed one.
    expect(agents).toHaveLength(2);
    // The restored bubble is unchanged (same node, same text — NOT appended into).
    expect(agents[0]).toBe(restoredAgentNode);
    expect(agents[0]?.textContent).toBe("earlier answer");
    // The streamed text landed in its OWN, new node.
    expect(agents[1]).not.toBe(restoredAgentNode);
    expect(agents[1]?.textContent).toBe("Hi");
  });
});

/* -------------------------------------------------------------------------- */
/* "New chat" reset — sink.clear() (the header New chat button's UI seam)      */
/* -------------------------------------------------------------------------- */

describe("createSink — clear() reset", () => {
  it("test_webview_newChat_clearWipesAllRenderedContent", () => {
    // Populate the log across EVERY render surface: a streamed bubble, a
    // tool-activity chip, a confirm card, and restored history bubbles.
    sink.appendAssistantDelta("streaming…");
    sink.appendToolActivity("live_update_track", "Rename track", "started");
    sink.appendConfirmCard("plan-x", "This deletes 1 thing.", [
      "Delete track:1:Bass",
    ]);
    sink.renderHistory([
      { role: "user", text: "earlier question" },
      { role: "assistant", text: "earlier answer" },
    ]);
    // Sanity: the log is non-empty before the reset.
    expect(log.childNodes.length).toBeGreaterThan(0);

    sink.clear();

    // Every rendered node is gone — bubbles, chips, the card, the divider.
    expect(log.childNodes.length).toBe(0);
    expect(log.querySelector(".msg")).toBeNull();
    expect(log.querySelector(".chip")).toBeNull();
    expect(log.querySelector(".confirm-card")).toBeNull();
    expect(log.querySelector(".history-divider")).toBeNull();
  });

  it("test_webview_newChat_clearResetsStreamAccumulatorSoNextDeltaOpensFreshBubble", () => {
    // Open a streaming bubble (the accumulator now points at a live node)…
    sink.appendAssistantDelta("partial-before-clear");
    const before = log.querySelectorAll(".msg-agent");
    expect(before).toHaveLength(1);
    const staleBubble = before[0];

    // …clear wipes the DOM AND nulls the accumulator…
    sink.clear();
    expect(log.querySelectorAll(".msg-agent")).toHaveLength(0);

    // …so the next delta opens a BRAND-NEW bubble rather than appending into the
    // (now-removed) stale node. This proves `streamBubble/streamText` were reset.
    sink.appendAssistantDelta("x");
    const after = log.querySelectorAll(".msg-agent");
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(staleBubble);
    expect(after[0]?.textContent).toBe("x");
    // A fresh stream → exactly one live caret in the new bubble.
    expect(log.querySelectorAll(".caret")).toHaveLength(1);
    expect(after[0]?.querySelector(".caret")).not.toBeNull();
  });

  it("test_webview_newChat_clearResetsChipRegistrySoLateSettleCannotRetarget", () => {
    // A started chip is registered in the unsettled-chip map…
    sink.appendToolActivity("live_set_param", "Set volume", "started");
    expect(log.querySelectorAll(".chip")).toHaveLength(1);

    // …clear drops the registry (and the DOM)…
    sink.clear();
    expect(log.querySelectorAll(".chip")).toHaveLength(0);

    // …so a late `ok` for the cleared turn cannot re-target a removed chip; it
    // renders as a fresh standalone settled chip instead of mutating a stale one.
    sink.appendToolActivity("live_set_param", "Set volume", "ok");
    const chips = log.querySelectorAll(".chip");
    expect(chips).toHaveLength(1);
    expect(chips[0]?.classList.contains("chip-ok")).toBe(true);
  });
});
