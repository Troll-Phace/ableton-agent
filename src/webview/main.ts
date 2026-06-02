/**
 * Webview SPA entry point.
 *
 * Phase 1 placeholder: mounts a trivial message into the root element to prove
 * the Vite single-file build pipeline works. Vanilla DOM, no framework.
 *
 * This SPA is TRANSPORT-AGNOSTIC. The channel back to the extension (localhost
 * WebSocket vs. `close_and_send`) is decided by the Phase 2 Spike R3 outcome and
 * wired in Phases 7/8 — nothing here may assume a transport. It must never import
 * from `src/extension/`, and never touch the Anthropic API key.
 */
function mount(): void {
  const root = document.getElementById("app");
  if (root === null) {
    throw new Error('Webview root element "#app" not found.');
  }
  root.textContent = "Ableton Claude Agent — webview ready.";
}

mount();
