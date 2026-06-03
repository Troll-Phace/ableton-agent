/**
 * Webview SPA entry point.
 *
 * Phase 7 T6 (Spike R3 **Outcome D**): a MINIMAL connect-echo stub that proves
 * the live localhost WebSocket round-trip inside the modal. This is NOT the real
 * chat UI — Phase 8 builds the tokenized, polished interface. Here we mount a
 * bare functional layout (scrollable log + pinned input row), wire it to
 * {@link ChatTransport}, and render inbound frames as plain text.
 *
 * Transport-agnostic discipline still holds: this SPA never imports from
 * `src/extension/`, never touches the Anthropic API key, and talks to the host
 * ONLY over the WebSocket transport.
 */

import { ChatTransport, type ChatSink } from "./transport.js";

/** Minimal, intentionally-unpolished styling. Phase 8 replaces this with tokens. */
const STYLE = `
  :root { color-scheme: dark; }
  body {
    margin: 0;
    font-family: system-ui, sans-serif;
    font-size: 12px;
    background: #1a1a1a;
    color: #e6e6e6;
  }
  #app { display: flex; flex-direction: column; height: 100vh; }
  #log {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .line { white-space: pre-wrap; word-break: break-word; line-height: 1.4; }
  .line-user { color: #ffffff; }
  .line-assistant { color: #cfe3ff; }
  .line-tool { color: #9aa0a6; font-style: italic; }
  .line-status { color: #9aa0a6; }
  .line-error { color: #ff8a80; }
  #input-row {
    flex: 0 0 auto;
    display: flex;
    gap: 6px;
    padding: 8px;
    border-top: 1px solid #333;
    background: #222;
  }
  #message-input {
    flex: 1 1 auto;
    background: #111;
    color: #e6e6e6;
    border: 1px solid #444;
    border-radius: 4px;
    padding: 6px 8px;
    font: inherit;
  }
  #message-input:focus-visible,
  #send-button:focus-visible {
    outline: 2px solid #ffb866;
    outline-offset: 1px;
  }
  #send-button {
    background: #3a3a3a;
    color: #e6e6e6;
    border: 1px solid #555;
    border-radius: 4px;
    padding: 6px 12px;
    font: inherit;
    cursor: pointer;
  }
  .visually-hidden {
    position: absolute;
    width: 1px; height: 1px;
    padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0);
    white-space: nowrap; border: 0;
  }
`;

/**
 * Build the minimal chat DOM inside `#app`: a scrollable log and a pinned input
 * row (labelled text input + Send button).
 *
 * @param root - the mounted `#app` element.
 * @returns the constructed log element and the input/button controls.
 */
function buildUi(root: HTMLElement): {
  log: HTMLElement;
  input: HTMLInputElement;
  sendButton: HTMLButtonElement;
} {
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.appendChild(style);

  root.replaceChildren();

  const log = document.createElement("div");
  log.id = "log";
  log.setAttribute("role", "log");
  log.setAttribute("aria-live", "polite");

  const inputRow = document.createElement("div");
  inputRow.id = "input-row";

  const label = document.createElement("label");
  label.className = "visually-hidden";
  label.htmlFor = "message-input";
  label.textContent = "Chat message";

  const input = document.createElement("input");
  input.id = "message-input";
  input.type = "text";
  input.autocomplete = "off";
  input.placeholder = "Type a message…";

  const sendButton = document.createElement("button");
  sendButton.id = "send-button";
  sendButton.type = "button";
  sendButton.textContent = "Send";

  inputRow.append(label, input, sendButton);
  root.append(log, inputRow);

  return { log, input, sendButton };
}

/**
 * Mount the stub UI and wire it to the WebSocket transport.
 *
 * Creates a {@link ChatSink} backed by the DOM, instantiates the
 * {@link ChatTransport}, connects, and binds Send/Enter to submit
 * `user_message` frames.
 */
function mount(): void {
  const root = document.getElementById("app");
  if (root === null) {
    throw new Error('Webview root element "#app" not found.');
  }

  const { log, input, sendButton } = buildUi(root);

  /** Append a line element of the given variant to the log and autoscroll. */
  const appendLine = (variant: string, text: string): HTMLElement => {
    const line = document.createElement("div");
    line.className = `line line-${variant}`;
    line.textContent = text;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
    return line;
  };

  // The in-flight assistant line accumulates deltas until `assistant_done`.
  let assistantLine: HTMLElement | null = null;

  const sink: ChatSink = {
    appendAssistantDelta(text: string): void {
      if (assistantLine === null) {
        assistantLine = appendLine("assistant", "");
      }
      assistantLine.textContent = (assistantLine.textContent ?? "") + text;
      log.scrollTop = log.scrollHeight;
    },
    finishAssistant(stopReason: string): void {
      if (assistantLine !== null && stopReason !== "end_turn") {
        assistantLine.textContent = `${assistantLine.textContent ?? ""}  ⟨${stopReason}⟩`;
      }
      assistantLine = null;
    },
    appendToolActivity(tool: string, summary: string, status: string): void {
      appendLine("tool", `[tool] ${tool}: ${summary} (${status})`);
    },
    appendError(messageText: string): void {
      appendLine("error", `Error: ${messageText}`);
    },
    appendStatus(text: string): void {
      appendLine("status", text);
    },
  };

  const transport = new ChatTransport(sink);

  const submit = (): void => {
    const text = input.value;
    if (text.trim().length === 0) {
      return;
    }
    appendLine("user", `> ${text.trim()}`);
    transport.sendUserMessage(text);
    input.value = "";
    input.focus();
  };

  sendButton.addEventListener("click", submit);
  input.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  });

  transport.connect();
  input.focus();
}

mount();
