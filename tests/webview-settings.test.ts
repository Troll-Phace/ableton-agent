// @vitest-environment jsdom

/**
 * Webview settings-view tests — Phase 10 (Spike R3 **Outcome D**, in-webview key
 * capture). Drives the REAL {@link createSettingsView} from
 * `src/webview/settings.ts` against a jsdom container and asserts the produced
 * DOM + the one-way Save seam.
 *
 * Integrity-critical invariants:
 *  - the API-key input is a **masked** `type="password"` field, label tied via
 *    `htmlFor`/`id` (a11y);
 *  - Save invokes `onSave(apiKey, model)` EXACTLY ONCE with the typed values and
 *    then CLEARS the input (no key reference lingers in the DOM);
 *  - an empty key with a model change calls `onSave(undefined, model)` — the key
 *    is omitted so a model-only change never clobbers an existing key;
 *  - all dynamic text is `.textContent` → an `<img onerror>` / `<b>` payload
 *    round-trips as inert text, injecting no nodes (XSS-inert);
 *  - Enter in the key field submits Save.
 *
 * A first-run gate test (mirroring `webview-close.test.ts`'s dynamic-import-after-
 * `#app`-seed pattern) proves `main.ts` hides the chat / shows settings on
 * `hasKey:false` and reveals the chat on a later `config_state {hasKey:true}`.
 *
 * Like the sibling jsdom suites this file is registered in
 * `tsconfig.webview-tests.json` (NOT `tsconfig.tests.json`) and type-checks
 * against the real webview + shared sources; `tsc -b` is authoritative.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSettingsView } from "../src/webview/settings.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** A fresh container element for one test. */
let container: HTMLElement;

beforeEach(() => {
  document.body.replaceChildren();
  container = document.createElement("div");
  container.id = "settings-container";
  document.body.appendChild(container);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

/** The masked key input under test. */
function keyInput(): HTMLInputElement {
  return container.querySelector("#settings-api-key") as HTMLInputElement;
}

/** The model select under test. */
function modelSelect(): HTMLSelectElement {
  return container.querySelector("#settings-model") as HTMLSelectElement;
}

/** The Save (submit) button. */
function saveButton(): HTMLButtonElement {
  return container.querySelector(".settings-save") as HTMLButtonElement;
}

/* -------------------------------------------------------------------------- */
/* Render                                                                     */
/* -------------------------------------------------------------------------- */

describe("createSettingsView — render", () => {
  it("test_webview_settings_rendersMaskedInputModelSelectSavePillHelper", () => {
    createSettingsView(
      container,
      { hasKey: false, model: "claude-sonnet-4-6" },
      () => undefined
    );

    const input = keyInput();
    expect(input).not.toBeNull();
    // The key field is masked (never a plain text field).
    expect(input.type).toBe("password");

    expect(modelSelect()).not.toBeNull();
    expect(modelSelect().tagName).toBe("SELECT");

    const save = saveButton();
    expect(save).not.toBeNull();
    expect(save.textContent).toBe("Save");

    // Helper text present (states the key stays local).
    const helper = container.querySelector(".settings-helper");
    expect(helper?.textContent).toMatch(/locally/i);
  });

  it("test_webview_settings_labelTiedToInputViaHtmlForId", () => {
    createSettingsView(
      container,
      { hasKey: false, model: "m" },
      () => undefined
    );
    const label = container.querySelector(
      'label[for="settings-api-key"]'
    ) as HTMLLabelElement;
    expect(label).not.toBeNull();
    // The htmlFor target exists and is the masked input (programmatic a11y tie).
    expect(label.htmlFor).toBe("settings-api-key");
    expect(keyInput().id).toBe("settings-api-key");
  });

  it("test_webview_settings_activeModelAlwaysSelectableEvenIfNotCurated", () => {
    // A model not in the curated shortlist is added dynamically and preselected.
    createSettingsView(
      container,
      { hasKey: true, model: "claude-sonnet-4-6" },
      () => undefined
    );
    const options = Array.from(modelSelect().options).map((o) => o.value);
    expect(options).toContain("claude-sonnet-4-6");
    expect(modelSelect().value).toBe("claude-sonnet-4-6");
  });

  it("test_webview_settings_a11yAttributesPresent", () => {
    createSettingsView(
      container,
      { hasKey: false, model: "m" },
      () => undefined
    );
    const form = container.querySelector(".settings-view");
    expect(form?.getAttribute("role")).toBe("group");
    expect(form?.getAttribute("aria-label")).toBe("Agent settings");
  });
});

/* -------------------------------------------------------------------------- */
/* Save seam                                                                  */
/* -------------------------------------------------------------------------- */

describe("createSettingsView — Save seam", () => {
  it("test_webview_settings_saveCallsOnSaveExactlyOnceWithTypedValues", () => {
    const onSave = vi.fn();
    createSettingsView(
      container,
      { hasKey: false, model: "claude-sonnet-4-6" },
      onSave
    );

    keyInput().value = "sk-ant-typed";
    modelSelect().value = "claude-3-5-haiku-20241022";
    saveButton().click();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(
      "sk-ant-typed",
      "claude-3-5-haiku-20241022"
    );
  });

  it("test_webview_settings_saveClearsInputAfterHandoff", () => {
    const onSave = vi.fn();
    createSettingsView(container, { hasKey: false, model: "m" }, onSave);

    keyInput().value = "sk-ant-clear-me";
    saveButton().click();

    // The key reference is scrubbed from the DOM the moment it is handed off.
    expect(keyInput().value).toBe("");
  });

  it("test_webview_settings_emptyKeyOmitsKeyArgPassesModelOnly", () => {
    const onSave = vi.fn();
    createSettingsView(
      container,
      { hasKey: true, model: "claude-sonnet-4-6" },
      onSave
    );

    // No key typed; only the model changed. The empty key must be OMITTED so a
    // model-only change never clobbers the stored key.
    expect(keyInput().value).toBe("");
    modelSelect().value = "claude-opus-4-20250514";
    saveButton().click();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(undefined, "claude-opus-4-20250514");
  });

  it("test_webview_settings_enterInKeyFieldSubmitsSave", () => {
    const onSave = vi.fn();
    createSettingsView(container, { hasKey: false, model: "m" }, onSave);

    keyInput().value = "sk-ant-enter";
    // A real submit (Enter in a form field) fires the form's submit event.
    const form = container.querySelector(".settings-view") as HTMLFormElement;
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true })
    );

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("sk-ant-enter", "m");
    // And the input is cleared after the Enter-driven save.
    expect(keyInput().value).toBe("");
  });
});

/* -------------------------------------------------------------------------- */
/* XSS-inert                                                                  */
/* -------------------------------------------------------------------------- */

describe("createSettingsView — XSS-inert", () => {
  it("test_webview_settings_markupModelValueRoundTripsAsInertText", () => {
    const onSave = vi.fn();
    const payload = '<img src=x onerror="alert(1)"><b>boom</b>';
    // A markup-bearing active model must render as inert text, not nodes.
    createSettingsView(container, { hasKey: false, model: payload }, onSave);

    // No injected <img>/<b> element appeared anywhere in the rendered view.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();

    // The active model option carries the payload as its literal textContent.
    const option = Array.from(modelSelect().options).find(
      (o) => o.value === payload
    );
    expect(option).not.toBeUndefined();
    expect(option?.textContent).toBe(payload);
  });

  it("test_webview_settings_markupTypedKeyPassesThroughVerbatimNoNodes", () => {
    const onSave = vi.fn();
    createSettingsView(container, { hasKey: false, model: "m" }, onSave);

    const payload = "<script>alert(1)</script>";
    keyInput().value = payload;
    saveButton().click();

    // The value is forwarded verbatim (the host validates), and NO script/markup
    // node was injected into the DOM by typing it.
    expect(onSave).toHaveBeenCalledWith(payload, "m");
    expect(container.querySelector("script")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* update / destroy                                                           */
/* -------------------------------------------------------------------------- */

describe("createSettingsView — update / destroy", () => {
  it("test_webview_settings_updateRefreshesModelWithoutTouchingInFlightInput", () => {
    const handle = createSettingsView(
      container,
      { hasKey: false, model: "claude-sonnet-4-6" },
      () => undefined
    );

    // Type a key, then push a fresh non-secret snapshot.
    keyInput().value = "sk-ant-inflight";
    handle.update({ hasKey: true, model: "claude-opus-4-20250514" });

    // The in-flight input is untouched; the model selection refreshed.
    expect(keyInput().value).toBe("sk-ant-inflight");
    expect(modelSelect().value).toBe("claude-opus-4-20250514");
  });

  it("test_webview_settings_destroyRemovesViewAndScrubsKey", () => {
    const handle = createSettingsView(
      container,
      { hasKey: false, model: "m" },
      () => undefined
    );
    keyInput().value = "sk-ant-unsubmitted";
    handle.destroy();
    // The form is gone (no lingering key reference in the DOM).
    expect(container.querySelector(".settings-view")).toBeNull();
    expect(container.children).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* First-run gate (main.ts) — dynamic import after #app seed                   */
/* -------------------------------------------------------------------------- */

describe("main.ts first-run gate", () => {
  // `mount()` registers a document-level keydown listener on the persistent jsdom
  // `document` that `vi.resetModules()` cannot detach. Track listeners added
  // during each mount and remove them in afterEach so handlers never stack.
  let trackedDocListeners: {
    type: string;
    listener: EventListenerOrEventListenerObject;
    options?: boolean | AddEventListenerOptions;
  }[] = [];

  /**
   * Seed `#app`, then dynamically import a FRESH `main.js` so the auto-mount
   * guard runs `mount()` against jsdom and wires the WebSocket transport. The
   * WebSocket is stubbed so no real socket opens; the `config_state` gate is
   * driven by invoking the stub's captured handlers directly.
   */
  async function mountFresh(): Promise<{
    sockets: FakeSocket[];
  }> {
    vi.resetModules();
    document.body.replaceChildren();
    const app = document.createElement("div");
    app.id = "app";
    document.body.appendChild(app);

    const sockets: FakeSocket[] = [];
    vi.stubGlobal(
      "WebSocket",
      class {
        public static readonly OPEN = 1;
        public readonly OPEN = 1;
        public readyState = 1;
        private readonly listeners = new Map<
          string,
          ((e: unknown) => void)[]
        >();
        public constructor(public readonly url: string) {
          sockets.push(this);
        }
        public addEventListener(
          type: string,
          listener: (e: unknown) => void
        ): void {
          const arr = this.listeners.get(type) ?? [];
          arr.push(listener);
          this.listeners.set(type, arr);
        }
        public removeEventListener(): void {
          /* no-op for the stub */
        }
        public send(): void {
          /* swallow outbound frames */
        }
        public close(): void {
          /* no-op */
        }
        /** Test helper: deliver a server frame to the message listeners. */
        public emitMessage(data: string): void {
          for (const l of this.listeners.get("message") ?? []) {
            l({ data });
          }
        }
      }
    );

    const realAdd = document.addEventListener.bind(document);
    const addSpy = vi
      .spyOn(document, "addEventListener")
      .mockImplementation((type, listener, options) => {
        trackedDocListeners.push({ type, listener, options });
        realAdd(type, listener, options);
      });

    await import("../src/webview/main.js");
    addSpy.mockRestore();
    return { sockets };
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
    vi.unstubAllGlobals();
  });

  /** Build a `config_state` server frame string for the stubbed socket. */
  function configStateFrame(hasKey: boolean, model: string): string {
    return JSON.stringify({
      v: 1,
      id: "cfg-1",
      type: "config_state",
      payload: { hasKey, model },
    });
  }

  it("test_webview_gate_hasKeyFalse_showsSettingsHidesChat", async () => {
    const { sockets } = await mountFresh();
    const app = document.getElementById("app") as HTMLElement;

    // First config_state with NO key → first-run gate opens settings.
    sockets[0].emitMessage(configStateFrame(false, "claude-sonnet-4-6"));

    expect(app.classList.contains("settings-open")).toBe(true);
    // The settings view mounted into the container.
    expect(document.getElementById("settings-api-key")).not.toBeNull();
  });

  it("test_webview_gate_laterHasKeyTrue_revealsChatHidesSettings", async () => {
    const { sockets } = await mountFresh();
    const app = document.getElementById("app") as HTMLElement;

    // First-run: no key → settings shown.
    sockets[0].emitMessage(configStateFrame(false, "claude-sonnet-4-6"));
    expect(app.classList.contains("settings-open")).toBe(true);

    // A later config_state with hasKey:true (key just saved) reveals the chat.
    sockets[0].emitMessage(configStateFrame(true, "claude-sonnet-4-6"));
    expect(app.classList.contains("settings-open")).toBe(false);
    expect(document.getElementById("settings-api-key")).toBeNull();
  });

  it("test_webview_gate_firstFrameHasKeyTrue_chatShownNoSettings", async () => {
    const { sockets } = await mountFresh();
    const app = document.getElementById("app") as HTMLElement;

    // A key already on file on the first frame → chat shown, settings not gated.
    sockets[0].emitMessage(configStateFrame(true, "claude-sonnet-4-6"));
    expect(app.classList.contains("settings-open")).toBe(false);
    expect(document.getElementById("settings-api-key")).toBeNull();
  });
});

/** Minimal shape of the stubbed socket the gate tests drive. */
interface FakeSocket {
  url: string;
  emitMessage(data: string): void;
}
