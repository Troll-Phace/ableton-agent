/**
 * Webview SPA entry point — Phase 8 (Spike R3 **Outcome D**, streaming SPA).
 *
 * The real, tokenized chat surface: a scrolling message list above a pinned
 * input bar, assistant tokens streaming into a live bubble with a blinking
 * caret, and tool-activity chips that transition started→ok/error in place.
 *
 * Transport discipline is unchanged from Phase 7: this SPA never imports from
 * `src/extension/`, never touches the Anthropic API key, and talks to the host
 * ONLY over the WebSocket transport. The {@link ChatTransport} +
 * {@link ChatSink} contract is frozen — this file rebuilds only the DOM
 * construction and the five sink method bodies; all dynamic text is set via
 * `.textContent` (never `innerHTML`), so model/network-derived strings carry no
 * markup or XSS surface and render as plain text with CSS-preserved line breaks.
 */

import "./chat.css";

import { closeModal } from "./host-bridge.js";
import {
  createSettingsView,
  type SettingsViewHandle,
  type SettingsState,
} from "./settings.js";
import {
  ChatTransport,
  deriveWebSocketUrl,
  type ChatSink,
} from "./transport.js";

/* -------------------------------------------------------------------------- */
/* DOM construction                                                           */
/* -------------------------------------------------------------------------- */

/** The interactive surface produced by {@link buildUi}. */
interface ChatUi {
  /** The scrolling message list (`role="log"`, `aria-live="polite"`). */
  readonly log: HTMLElement;
  /** The multiline message input (Enter sends, Shift+Enter inserts newline). */
  readonly input: HTMLTextAreaElement;
  /** The send pill button. */
  readonly sendButton: HTMLButtonElement;
  /** The header close button ("✕") that closes the modal. */
  readonly closeButton: HTMLButtonElement;
  /** The header gear button that opens the settings view. */
  readonly settingsButton: HTMLButtonElement;
  /** Empty host element the settings view mounts into (in place of the chat). */
  readonly settingsContainer: HTMLElement;
}

/**
 * Build the chat DOM inside `#app`: a compact header bar (title + close), a
 * scrolling message list, and a pinned input bar (visually-hidden label +
 * multiline textarea + send pill).
 *
 * @param root - the mounted `#app` element.
 * @returns the constructed log element and the input/close/send controls.
 */
function buildUi(root: HTMLElement): ChatUi {
  root.replaceChildren();

  // Header bar: app title (left) + close button (right). Kept compact so the
  // 420×560 modal still fits with the message list flexing below it.
  const header = document.createElement("div");
  header.id = "header-bar";

  const titleEl = document.createElement("div");
  titleEl.id = "header-title";
  titleEl.textContent = "Claude";

  // Header controls cluster: gear (settings) + close, right-aligned.
  const headerControls = document.createElement("div");
  headerControls.id = "header-controls";

  const settingsButton = document.createElement("button");
  settingsButton.id = "settings-button";
  settingsButton.type = "button";
  settingsButton.setAttribute("aria-label", "Settings");
  // The glyph is decorative; the accessible name comes from aria-label.
  const settingsGlyph = document.createElement("span");
  settingsGlyph.setAttribute("aria-hidden", "true");
  settingsGlyph.textContent = "⚙";
  settingsButton.appendChild(settingsGlyph);

  const closeButton = document.createElement("button");
  closeButton.id = "close-button";
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "Close chat");
  // The glyph is decorative; the accessible name comes from aria-label.
  const closeGlyph = document.createElement("span");
  closeGlyph.setAttribute("aria-hidden", "true");
  closeGlyph.textContent = "✕";
  closeButton.appendChild(closeGlyph);

  headerControls.append(settingsButton, closeButton);
  header.append(titleEl, headerControls);

  const log = document.createElement("div");
  log.id = "log";
  log.setAttribute("role", "log");
  log.setAttribute("aria-live", "polite");

  // The settings view mounts here, in place of the chat. Empty (and CSS-hidden)
  // until the first-run gate or the gear opens it.
  const settingsContainer = document.createElement("div");
  settingsContainer.id = "settings-container";

  const inputBar = document.createElement("div");
  inputBar.id = "input-bar";

  const label = document.createElement("label");
  label.className = "visually-hidden";
  label.htmlFor = "message-input";
  label.textContent = "Chat message";

  const input = document.createElement("textarea");
  input.id = "message-input";
  input.rows = 1;
  input.autocomplete = "off";
  input.placeholder = "Message Claude…";
  input.setAttribute("aria-label", "Chat message");

  const sendButton = document.createElement("button");
  sendButton.id = "send-button";
  sendButton.type = "button";
  sendButton.textContent = "Send";

  inputBar.append(label, input, sendButton);
  root.append(header, log, settingsContainer, inputBar);

  return {
    log,
    input,
    sendButton,
    closeButton,
    settingsButton,
    settingsContainer,
  };
}

/* -------------------------------------------------------------------------- */
/* Mount + sink wiring                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Mount the chat UI and wire it to the WebSocket transport.
 *
 * Builds the DOM, implements the {@link ChatSink} over it, instantiates the
 * {@link ChatTransport}, connects, and binds Send/Enter to submit
 * `user_message` frames (rendering the user's own bubble locally, since the
 * transport does not echo user input).
 */
/**
 * Build the {@link ChatSink} that renders inbound server frames into `log`.
 *
 * Exported as the testable seam: it owns ALL message→DOM rendering (streaming
 * bubble accumulation, in-place chip transitions, status/error lines) over a
 * single `log` element, with no dependency on the transport or the input bar.
 * `mount` calls this to wire the live socket; render tests call it directly
 * against a jsdom `log` to drive and assert the real DOM.
 *
 * @param log - the message-list element to append rendered frames into.
 * @param onConfirmResponse - optional callback invoked when a confirm card is
 *   answered (Cancel/Esc → `false`, destructive → `true`). Threaded in so the
 *   card buttons can reply WITHOUT this sink importing the transport, keeping
 *   `createSink` unit-testable against a bare jsdom `log`.
 * @returns the {@link ChatSink} implementation bound to `log`.
 */
export function createSink(
  log: HTMLElement,
  onConfirmResponse?: (planId: string, approved: boolean) => void
): ChatSink {
  /** Pin the viewport to the latest content. */
  const scrollToBottom = (): void => {
    log.scrollTop = log.scrollHeight;
  };

  /** Append a low-emphasis line (status / error / warning) and autoscroll. */
  const appendLine = (variant: string, text: string): void => {
    const line = document.createElement("div");
    line.className = `line line-${variant}`;
    line.textContent = text;
    log.appendChild(line);
    scrollToBottom();
  };

  // --- Streaming-bubble accumulator -------------------------------------- //
  // The in-flight agent bubble and its text node + caret. Reset on
  // `finishAssistant` so the next turn opens a fresh bubble.
  let streamBubble: HTMLElement | null = null;
  let streamText: Text | null = null;
  let streamCaret: HTMLElement | null = null;

  /** Open a new agent bubble with a live text node and a blinking caret. */
  const openStreamBubble = (): Text => {
    const bubble = document.createElement("div");
    bubble.className = "msg msg-agent";

    const textNode = document.createTextNode("");
    const caret = document.createElement("span");
    caret.className = "caret";
    caret.setAttribute("aria-hidden", "true");

    bubble.append(textNode, caret);
    log.appendChild(bubble);

    streamBubble = bubble;
    streamText = textNode;
    streamCaret = caret;
    return textNode;
  };

  // --- Tool-chip registry ------------------------------------------------ //
  // The protocol carries no correlation id, so an `ok`/`error` is matched to
  // the OLDEST unsettled chip with the same tool name (FIFO correlation),
  // mirroring the backend's in-order settlement in agent-loop.ts: it fires all
  // `started` events first, then settles them in request order (i=0, i=1, …).
  // Settled chips are dropped from the lookup so they are never re-targeted.
  const unsettledChips = new Map<string, HTMLElement[]>();

  /** Build a chip element in its `started` state for the given tool. */
  const createChip = (
    summary: string,
    settledStatus?: "ok" | "error"
  ): HTMLElement => {
    const chip = document.createElement("div");
    chip.className = "chip chip-started";

    const dot = document.createElement("span");
    dot.className = "chip-dot";
    dot.setAttribute("aria-hidden", "true");

    const labelEl = document.createElement("span");
    labelEl.className = "chip-label";
    labelEl.textContent = summary;

    chip.append(dot, labelEl);
    log.appendChild(chip);

    if (settledStatus !== undefined) {
      settleChip(chip, summary, settledStatus);
    }
    scrollToBottom();
    return chip;
  };

  /** Transition a chip to its terminal state (dot color + text both change). */
  const settleChip = (
    chip: HTMLElement,
    summary: string,
    status: "ok" | "error"
  ): void => {
    chip.classList.remove("chip-started");
    chip.classList.add(status === "ok" ? "chip-ok" : "chip-error");
    const labelEl = chip.querySelector(".chip-label");
    if (labelEl !== null) {
      // Status is conveyed by text AND dot color — never color alone.
      labelEl.textContent = `${summary} — ${status === "ok" ? "done" : "failed"}`;
    }
  };

  /**
   * Derive an explicit, action-stating label for the destructive button —
   * NEVER a bare "OK". When every listed action is a delete, summarize as
   * "Delete N item(s)"; otherwise fall back to "Confirm — N action(s)". The
   * count always pluralizes so the label matches the listed actions exactly.
   *
   * @param actions - the destructive actions the card itemizes.
   * @returns the destructive button's visible label.
   */
  const deriveConfirmLabel = (actions: string[]): string => {
    const count = actions.length;
    const allDeletes =
      count > 0 &&
      actions.every((a) => a.trim().toLowerCase().startsWith("delete"));
    if (allDeletes) {
      return `Delete ${String(count)} item${count === 1 ? "" : "s"}`;
    }
    return `Confirm — ${String(count)} action${count === 1 ? "" : "s"}`;
  };

  const sink: ChatSink = {
    renderHistory(items: { role: "user" | "assistant"; text: string }[]): void {
      if (items.length === 0) {
        return;
      }
      // Each restored message is a finished, standalone bubble reusing the SAME
      // classes as live bubbles: `.msg.msg-user` (right-aligned, identical to a
      // locally-echoed user bubble) and `.msg.msg-agent` (a finished assistant
      // bubble — full text set at once, NO caret, NOT streamed). All text via
      // `.textContent`, so model/host strings carry no markup (XSS-inert).
      //
      // This deliberately does NOT touch the streaming accumulator
      // (`streamBubble`/`streamText`/`streamCaret`), so the next real
      // `assistant_delta` still opens a fresh bubble.
      for (const item of items) {
        const bubble = document.createElement("div");
        bubble.className =
          item.role === "user" ? "msg msg-user" : "msg msg-agent";
        bubble.textContent = item.text;
        log.appendChild(bubble);
      }

      // A subtle, decorative divider separating the restored block from the
      // live conversation. Token-styled, reduced-motion safe (the global
      // prefers-reduced-motion rule disables animation), and a11y-inert: it is
      // marked aria-hidden so the restored bubbles (already announced as log
      // content) are not double-narrated, and it traps no focus.
      const divider = document.createElement("div");
      divider.className = "history-divider";
      divider.setAttribute("aria-hidden", "true");
      const dividerLabel = document.createElement("span");
      dividerLabel.className = "history-divider-label";
      dividerLabel.textContent = "Restored from your last session";
      divider.appendChild(dividerLabel);
      log.appendChild(divider);

      scrollToBottom();
    },

    appendAssistantDelta(text: string): void {
      const textNode = streamText ?? openStreamBubble();
      textNode.appendData(text);
      scrollToBottom();
    },

    finishAssistant(stopReason: string): void {
      if (streamBubble !== null && streamCaret !== null) {
        streamCaret.remove();
        if (stopReason !== "end_turn") {
          const hint = document.createElement("span");
          hint.className = "stop-hint";
          hint.textContent = ` (${stopReason})`;
          streamBubble.appendChild(hint);
        }
      }
      streamBubble = null;
      streamText = null;
      streamCaret = null;
    },

    appendToolActivity(tool: string, summary: string, status: string): void {
      if (status === "started") {
        const chip = createChip(summary);
        const list = unsettledChips.get(tool) ?? [];
        list.push(chip);
        unsettledChips.set(tool, list);
        return;
      }

      const settle: "ok" | "error" = status === "error" ? "error" : "ok";
      const list = unsettledChips.get(tool);
      if (list !== undefined && list.length > 0) {
        // Settle the oldest unsettled chip for this tool name, matching the
        // backend's in-order settlement in agent-loop.ts (FIFO correlation).
        const chip = list.shift();
        if (list.length === 0) {
          unsettledChips.delete(tool);
        }
        if (chip !== undefined) {
          settleChip(chip, summary, settle);
          scrollToBottom();
          return;
        }
      }
      // Defensive: no matching started chip — render a fresh settled chip.
      createChip(summary, settle);
    },

    appendError(messageText: string): void {
      appendLine("error", messageText);
    },

    appendStatus(text: string): void {
      appendLine("status", text);
    },

    appendConfirmCard(
      planId: string,
      summary: string,
      actions: string[]
    ): void {
      const card = document.createElement("div");
      card.className = "confirm-card";
      card.setAttribute("role", "group");
      card.setAttribute("aria-label", "Destructive action confirmation");

      // Title — the plan summary (states the total destructive count).
      const title = document.createElement("div");
      title.className = "confirm-title";
      title.textContent = summary;

      // Itemized destructive actions (inert, plain text).
      const list = document.createElement("ul");
      list.className = "confirm-list";
      for (const action of actions) {
        const item = document.createElement("li");
        item.className = "confirm-item";
        item.textContent = action;
        list.appendChild(item);
      }

      // Action row: Cancel + an explicitly-labelled destructive button.
      const row = document.createElement("div");
      row.className = "confirm-actions";

      const cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.className = "confirm-btn confirm-btn-cancel";
      cancelButton.textContent = "Cancel";

      const destructiveButton = document.createElement("button");
      destructiveButton.type = "button";
      destructiveButton.className = "confirm-btn confirm-btn-destructive";
      destructiveButton.textContent = deriveConfirmLabel(actions);

      // Resolved-state line (replaces the buttons once the card is answered),
      // so the decision is conveyed by explicit text — never color alone.
      const resolved = document.createElement("div");
      resolved.className = "confirm-resolved";
      resolved.hidden = true;

      let answered = false;

      /** Answer the card exactly once: reply, then lock into an inert state. */
      const answer = (approved: boolean): void => {
        if (answered) {
          return;
        }
        answered = true;
        cancelButton.disabled = true;
        destructiveButton.disabled = true;
        card.removeEventListener("keydown", onKeydown);
        // Don't double-surface a decline as a scary failure: the card's own
        // resolved text is the user-facing signal (the backend still emits a
        // tool_activity "error" for the model, which is fine).
        resolved.textContent = approved ? "Approved" : "Declined";
        resolved.classList.toggle("confirm-resolved-approved", approved);
        resolved.classList.toggle("confirm-resolved-declined", !approved);
        resolved.hidden = false;
        row.hidden = true;
        onConfirmResponse?.(planId, approved);
      };

      /** Esc while the card is focused is treated as Cancel. */
      function onKeydown(event: KeyboardEvent): void {
        if (event.key === "Escape") {
          event.preventDefault();
          answer(false);
        }
      }

      cancelButton.addEventListener("click", () => {
        answer(false);
      });
      destructiveButton.addEventListener("click", () => {
        answer(true);
      });
      card.addEventListener("keydown", onKeydown);

      row.append(cancelButton, destructiveButton);
      card.append(title, list, row, resolved);
      log.appendChild(card);
      scrollToBottom();

      // Default focus to the SAFE control (Cancel) so an inadvertent Enter
      // never fires the destructive path. The destructive button stays one Tab
      // away, and Esc also declines.
      cancelButton.focus();
    },
  };

  return sink;
}

/* -------------------------------------------------------------------------- */
/* Mount + transport wiring                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Mount the chat UI and wire it to the WebSocket transport.
 *
 * Builds the DOM, builds the {@link ChatSink} over the message list via
 * {@link createSink}, instantiates the {@link ChatTransport}, connects, and
 * binds Send/Enter to submit `user_message` frames (rendering the user's own
 * bubble locally, since the transport does not echo user input).
 */
function mount(): void {
  const root = document.getElementById("app");
  if (root === null) {
    throw new Error('Webview root element "#app" not found.');
  }

  const {
    log,
    input,
    sendButton,
    closeButton,
    settingsButton,
    settingsContainer,
  } = buildUi(root);

  // Holder so the confirm-card callback can reach the transport: the sink is
  // built first (the transport takes it in its constructor), so the callback
  // reads `holder.transport` lazily rather than capturing it eagerly.
  const holder: { transport: ChatTransport | null } = { transport: null };
  const sink = createSink(log, (planId, approved) => {
    holder.transport?.sendConfirmResponse(planId, approved);
  });

  // --- Settings view gating --------------------------------------------- //
  // The latest non-secret config snapshot. `null` until the first
  // `config_state` arrives; the first frame decides whether the settings view
  // gates the chat (no key yet) or the chat shows immediately.
  let configState: SettingsState | null = null;
  let settingsView: SettingsViewHandle | null = null;

  /** Show the chat shell; hide the settings view. */
  const showChat = (): void => {
    settingsView?.destroy();
    settingsView = null;
    root.classList.remove("settings-open");
    input.focus();
  };

  /** Mount (or re-render) the settings view in place of the chat. */
  const openSettings = (): void => {
    const state: SettingsState = configState ?? { hasKey: false, model: "" };
    root.classList.add("settings-open");
    if (settingsView !== null) {
      settingsView.update(state);
      return;
    }
    settingsView = createSettingsView(
      settingsContainer,
      state,
      (apiKey, model) => {
        // The key's only exit point. Forward it to the host; the settings view
        // has already scrubbed its own input by the time this returns.
        holder.transport?.sendSetConfig(apiKey, model);
      }
    );
  };

  /**
   * Apply a `config_state` snapshot. The FIRST frame gates first-run: if no key
   * is on file, open the settings view instead of the chat. A later frame with
   * `hasKey: true` tears the settings view down and reveals the chat (unless the
   * user opened settings manually, in which case it stays open and just
   * refreshes its non-secret status).
   */
  const onConfigState = (state: SettingsState): void => {
    const isFirstFrame = configState === null;
    const justGainedKey =
      !isFirstFrame &&
      configState !== null &&
      !configState.hasKey &&
      state.hasKey;
    configState = state;

    if (isFirstFrame && !state.hasKey) {
      openSettings();
      return;
    }
    if (settingsView !== null) {
      settingsView.update(state);
      // A key was just saved during first-run gating → reveal the chat. If the
      // user opened settings manually (key already present), leave it open.
      if (justGainedKey) {
        showChat();
      }
    }
  };

  /** Append the user's own bubble locally (the transport does not echo it). */
  const appendUserBubble = (text: string): void => {
    const bubble = document.createElement("div");
    bubble.className = "msg msg-user";
    bubble.textContent = text;
    log.appendChild(bubble);
    log.scrollTop = log.scrollHeight;
  };

  const transport = new ChatTransport(sink, deriveWebSocketUrl(), {
    onConfigState,
  });
  holder.transport = transport;

  /** Read, render, and send the current input; clear and refocus. */
  const submit = (): void => {
    const text = input.value;
    if (text.trim().length === 0) {
      return;
    }
    appendUserBubble(text.trim());
    transport.sendUserMessage(text);
    input.value = "";
    autoSize();
    input.focus();
  };

  /** Grow the textarea with its content up to the CSS max-height. */
  const autoSize = (): void => {
    input.style.height = "auto";
    input.style.height = `${String(input.scrollHeight)}px`;
  };

  sendButton.addEventListener("click", submit);
  closeButton.addEventListener("click", () => {
    closeModal();
  });
  settingsButton.addEventListener("click", () => {
    // Toggle: if settings are already open, the gear returns to the chat
    // (only when a key is on file — first-run gating cannot be dismissed).
    if (settingsView !== null) {
      if (configState?.hasKey === true) {
        showChat();
      }
      return;
    }
    openSettings();
  });
  input.addEventListener("input", autoSize);
  input.addEventListener("keydown", (event: KeyboardEvent) => {
    // Enter sends; Shift+Enter inserts a newline.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });

  // Top-level Esc closes the chat (the documented "Esc closes the chat"
  // affordance). An OPEN confirm card owns Esc=decline: its own keydown
  // listener fires first (it is closer to the target in the bubble path) and
  // calls preventDefault(), so we skip closing when the card already consumed
  // the key. Once a card is answered it removes its listener, so its Esc no
  // longer fires and a subsequent Esc closes the chat as normal.
  document.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) {
      return;
    }
    // While the settings view is open: Esc returns to the chat if a key is on
    // file (dismissible), but is swallowed during first-run gating (no key yet),
    // so the user cannot escape into a chat that has no key to operate with.
    if (settingsView !== null) {
      event.preventDefault();
      if (configState?.hasKey === true) {
        showChat();
      }
      return;
    }
    closeModal();
  });

  transport.connect();
  input.focus();
}

// Auto-mount in the real webview, where `index.html` provides `#app`. Guarded
// so importing this module for unit tests (which drive `createSink` directly)
// does not instantiate the transport/WebSocket against a bare document.
if (
  typeof document !== "undefined" &&
  document.getElementById("app") !== null
) {
  mount();
}
