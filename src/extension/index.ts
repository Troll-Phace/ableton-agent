// MUST be first: Live's Extension Host runs the extension in a stripped V8 realm
// that omits Node's web-global injections (`TextDecoder`, `Headers`, `URL`,
// `crypto`, `ReadableStream`, … are all undefined). This side-effecting import
// installs them — from `node:*` builtins, then undici (loaded LAZILY so its
// factory does not hoist-eval before the globals exist) — before any dependency
// (e.g. @anthropic-ai/sdk) initializes and touches one. ES import ordering runs
// this import before the imports below. See runtime-shim.ts.
import "./runtime-shim.js";

import { initialize, type ActivationContext } from "@ableton-extensions/sdk";

import { startLaunchWiring } from "./transport/launch.js";

/** Log prefix mirroring the host's `console.*` convention. */
const LOG_PREFIX = "[ableton-claude-agent]";

/**
 * Activation entry point for the Ableton Claude Agent extension.
 *
 * Called by Live's Extension Host when the extension loads. Returns `void` to
 * match the SDK signature, so all async setup runs in a **non-blocking** inner
 * task: `initialize` resolves the SDK context synchronously, then the transport
 * server is started and the `live.launchAgent` context-menu action is registered
 * without `activate` ever awaiting (the host must not be blocked here).
 *
 * Spike R3 **Outcome D** (localhost full-duplex WS, act-in-place): the chat modal
 * is opened **fire-and-forget** from the launch handler — never awaited — because
 * awaiting `showModalDialog` parks the host event loop (spike 3.1). The modal is
 * opened once per launch and left open while the socket carries the conversation;
 * there is no background mode (docs/ARCHITECTURE.md §5, §11, §12).
 *
 * Setup failures are caught and logged (the host's only sink is `console.*`); a
 * failure leaves Live usable rather than crashing the extension. The launch
 * wiring performs best-effort server cleanup if it fails partway.
 *
 * @param activation - The activation handle provided by the Extension Host.
 */
export function activate(activation: ActivationContext): void {
  const context = initialize(activation, "1.0.0");

  const { tempo } = context.application.song;
  console.log(`${LOG_PREFIX} activated — Live Set tempo is ${tempo} bpm.`);

  // Non-blocking setup: `activate` returns immediately while the server starts
  // and the launch action registers. Never awaited here (and the modal it later
  // opens is itself fire-and-forget) so the host event loop stays live.
  void startLaunchWiring(context).catch((err) => {
    console.error(`${LOG_PREFIX} launch wiring failed to start`, err);
  });
}
