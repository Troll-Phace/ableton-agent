// @vitest-environment jsdom

/**
 * Webview modal-close tests — Phase 9 follow-up (Spike R3 **Outcome D**).
 *
 * Covers the close mechanism added to fix the in-Live focus-capture blocker:
 *  - `closeModal()` (`src/webview/host-bridge.ts`) posting the documented
 *    `close_and_send` envelope to the macOS/Windows host bridges, and no-opping
 *    safely when neither bridge is present;
 *  - the mounted UI's `#close-button` and document-level Esc handler
 *    (`src/webview/main.ts` `mount()`), including the confirm-card-vs-Esc
 *    precedence (an open card owns Esc=decline via `preventDefault`, so the
 *    top-level close does NOT fire until the card is answered).
 *
 * The close-button / Esc handlers live inside the non-exported `mount()`, which
 * the module auto-runs at import time iff `#app` is present. So those scenarios
 * use a **dynamic import after seeding `#app`** (with `vi.resetModules()` per
 * test) to trigger a fresh `mount()` against jsdom — driven entirely through the
 * existing exported surface (`closeModal`, `createSink`, the auto-mount guard),
 * no new production seam.
 *
 * Host-bridge globals (`window.webkit` / `window.chrome`) are stubbed per test
 * and torn down in `afterEach` so they never leak across the suite.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeModal } from "../src/webview/host-bridge.js";
import { createSink } from "../src/webview/main.js";

/** The documented close envelope the bridge must post. */
const CLOSE_ENVELOPE = { method: "close_and_send", params: [""] };

/* -------------------------------------------------------------------------- */
/* Host-global stubbing helpers                                               */
/* -------------------------------------------------------------------------- */

/** Cast `window` to a mutable bag so we can attach/remove host bridges. */
function win(): Record<string, unknown> {
  return window as unknown as Record<string, unknown>;
}

/** Install a WKWebView (macOS) bridge; returns the postMessage spy. */
function stubWebkit(): ReturnType<typeof vi.fn> {
  const post = vi.fn();
  win().webkit = { messageHandlers: { live: { postMessage: post } } };
  return post;
}

/** Install a WebView2 (Windows) bridge; returns the postMessage spy. */
function stubWebView2(): ReturnType<typeof vi.fn> {
  const post = vi.fn();
  win().chrome = { webview: { postMessage: post } };
  return post;
}

/** Remove any host bridges stubbed during a test. */
function clearHostBridges(): void {
  delete win().webkit;
  delete win().chrome;
}

afterEach(() => {
  clearHostBridges();
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/* 1–2. closeModal() bridge selection + no-op                                 */
/* -------------------------------------------------------------------------- */

describe("closeModal — host bridge selection", () => {
  it("test_webview_close_postsCloseAndSendViaWebkitWhenPresent", () => {
    const post = stubWebkit();
    closeModal();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(CLOSE_ENVELOPE);
  });

  it("test_webview_close_postsCloseAndSendViaWebView2WhenOnlyChromePresent", () => {
    const post = stubWebView2();
    closeModal();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(CLOSE_ENVELOPE);
  });

  it("test_webview_close_prefersWebkitOverWebView2WhenBothPresent", () => {
    // Detection order is webkit first (macOS), then chrome (Windows).
    const webkitPost = stubWebkit();
    const webview2Post = stubWebView2();
    closeModal();
    expect(webkitPost).toHaveBeenCalledTimes(1);
    expect(webkitPost).toHaveBeenCalledWith(CLOSE_ENVELOPE);
    // Only one bridge is posted to — the first match wins.
    expect(webview2Post).not.toHaveBeenCalled();
  });

  it("test_webview_close_noBridgePresent_noOpsWithoutThrowing", () => {
    // jsdom default: neither global exists → warn + no-op, never throws.
    clearHostBridges();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(() => {
      closeModal();
    }).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */
/* 3–6. Mounted UI: close button + document-level Esc                          */
/* -------------------------------------------------------------------------- */

describe("mounted webview — close button + Esc", () => {
  // `mount()` registers a document-level keydown listener that `vi.resetModules()`
  // cannot detach (it lives on the persistent jsdom `document`, not the module).
  // To keep each test isolated we wrap `document.addEventListener` for the
  // duration of one `mount()`, record what it adds, and remove those exact
  // listeners in `afterEach` — so the top-level Esc handler never stacks across
  // tests (which would make one Esc fire several `closeModal()`s).
  let trackedDocListeners: {
    type: string;
    listener: EventListenerOrEventListenerObject;
    options?: boolean | AddEventListenerOptions;
  }[] = [];

  /**
   * Seed `#app`, then dynamically import a FRESH `main.js` so the auto-mount
   * guard runs `mount()` against jsdom (building the header/close button and
   * registering the document-level Esc handler). Document listeners added during
   * the mount are tracked for teardown in `afterEach`.
   */
  async function mountFresh(): Promise<void> {
    vi.resetModules();
    document.body.replaceChildren();
    const app = document.createElement("div");
    app.id = "app";
    document.body.appendChild(app);

    // Record document-level listeners added during this mount so we can detach
    // them after the test (jsdom's document persists across `it`s).
    const realAdd = document.addEventListener.bind(document);
    const addSpy = vi
      .spyOn(document, "addEventListener")
      .mockImplementation((type, listener, options) => {
        trackedDocListeners.push({ type, listener, options });
        realAdd(type, listener, options);
      });

    // Importing the module triggers the bottom-of-file auto-mount (guarded on
    // `#app` being present), which is the real production mount path.
    await import("../src/webview/main.js");

    addSpy.mockRestore();
  }

  beforeEach(() => {
    document.body.replaceChildren();
    trackedDocListeners = [];
  });

  afterEach(() => {
    for (const { type, listener, options } of trackedDocListeners) {
      document.removeEventListener(type, listener, options);
    }
    trackedDocListeners = [];
  });

  it("test_webview_close_buttonHasAccessibleLabel", async () => {
    await mountFresh();
    const button = document.getElementById("close-button");
    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-label")).toBe("Close chat");
    // The glyph is decorative (hidden from the accessibility tree).
    const glyph = button?.querySelector("span");
    expect(glyph?.getAttribute("aria-hidden")).toBe("true");
    expect(glyph?.textContent).toBe("✕");
  });

  it("test_webview_close_buttonClickFiresCloseBridge", async () => {
    const post = stubWebkit();
    await mountFresh();
    const button = document.getElementById("close-button") as HTMLButtonElement;
    button.click();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(CLOSE_ENVELOPE);
  });

  it("test_webview_close_escWithNoConfirmCard_firesCloseBridge", async () => {
    const post = stubWebkit();
    await mountFresh();
    // No card open → the document-level Esc handler closes the chat.
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(CLOSE_ENVELOPE);
  });

  it("test_webview_close_escWhileConfirmCardOpen_declinesCardAndDoesNotClose", async () => {
    const post = stubWebkit();
    await mountFresh();

    // Render a confirm card into the SAME mounted log via the real sink path, so
    // its keydown listener (Esc=decline + preventDefault) is live in the DOM the
    // mounted document-level Esc handler also observes.
    const log = document.getElementById("log");
    expect(log).not.toBeNull();
    const calls: { planId: string; approved: boolean }[] = [];
    const cardSink = createSink(log as HTMLElement, (planId, approved) => {
      calls.push({ planId, approved });
    });
    cardSink.appendConfirmCard("plan-esc", "Delete it?", [
      "Delete track:1:Bass",
    ]);

    const card = log?.querySelector(".confirm-card");
    expect(card).not.toBeNull();

    // Esc dispatched at the card bubbles up: the card's listener fires first
    // (closer to target), declines, and calls preventDefault — so the
    // document-level handler sees defaultPrevented and does NOT close.
    card?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );

    // The card declined exactly once; the modal did NOT close.
    expect(calls).toEqual([{ planId: "plan-esc", approved: false }]);
    expect(post).not.toHaveBeenCalled();
  });

  it("test_webview_close_escAfterCardAnswered_firesCloseBridge", async () => {
    const post = stubWebkit();
    await mountFresh();

    const log = document.getElementById("log");
    const calls: { planId: string; approved: boolean }[] = [];
    const cardSink = createSink(log as HTMLElement, (planId, approved) => {
      calls.push({ planId, approved });
    });
    cardSink.appendConfirmCard("plan-esc2", "Delete it?", [
      "Delete track:1:Bass",
    ]);
    const card = log?.querySelector(".confirm-card");

    // First Esc declines the card (no close).
    card?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );
    expect(calls).toEqual([{ planId: "plan-esc2", approved: false }]);
    expect(post).not.toHaveBeenCalled();

    // The answered card removed its keydown listener, so it no longer consumes
    // Esc. A subsequent Esc now reaches the document-level handler → close.
    card?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(CLOSE_ENVELOPE);
    // The card was not answered a second time.
    expect(calls).toHaveLength(1);
  });

  it("test_webview_close_nonEscKeydown_doesNotClose", async () => {
    const post = stubWebkit();
    await mountFresh();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    );
    expect(post).not.toHaveBeenCalled();
  });
});
