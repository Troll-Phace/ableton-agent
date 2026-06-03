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

import { ChatTransport, type ChatSink } from "./transport.js";

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
}

/**
 * Build the chat DOM inside `#app`: a scrolling message list and a pinned input
 * bar (visually-hidden label + multiline textarea + send pill).
 *
 * @param root - the mounted `#app` element.
 * @returns the constructed log element and the input/button controls.
 */
function buildUi(root: HTMLElement): ChatUi {
  root.replaceChildren();

  const log = document.createElement("div");
  log.id = "log";
  log.setAttribute("role", "log");
  log.setAttribute("aria-live", "polite");

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
  root.append(log, inputBar);

  return { log, input, sendButton };
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
 * @returns the {@link ChatSink} implementation bound to `log`.
 */
export function createSink(log: HTMLElement): ChatSink {
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

  const sink: ChatSink = {
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

  const { log, input, sendButton } = buildUi(root);
  const sink = createSink(log);

  /** Append the user's own bubble locally (the transport does not echo it). */
  const appendUserBubble = (text: string): void => {
    const bubble = document.createElement("div");
    bubble.className = "msg msg-user";
    bubble.textContent = text;
    log.appendChild(bubble);
    log.scrollTop = log.scrollHeight;
  };

  const transport = new ChatTransport(sink);

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
  input.addEventListener("input", autoSize);
  input.addEventListener("keydown", (event: KeyboardEvent) => {
    // Enter sends; Shift+Enter inserts a newline.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
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
