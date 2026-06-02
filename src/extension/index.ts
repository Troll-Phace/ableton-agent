import { initialize, type ActivationContext } from "@ableton-extensions/sdk";

import Anthropic from "@anthropic-ai/sdk";

/**
 * Activation entry point for the Ableton Claude Agent extension.
 *
 * Called by Live's Extension Host when the extension loads. For Phase 1 this is
 * the canonical hello-world: it initializes the SDK context and logs the current
 * Live Set's tempo to `ExtensionHost.txt`, proving the host round-trip works.
 *
 * Context-menu wiring, the chat modal, and the Claude tool-use loop are added in
 * later phases (transport family is decided by the Phase 2 Spike R3 outcome).
 *
 * @param activation - The activation handle provided by the Extension Host.
 */
export function activate(activation: ActivationContext): void {
  const context = initialize(activation, "1.0.0");
  const { tempo } = context.application.song;
  console.log(
    `Hello from ableton-claude-agent! Your Live Set's tempo is: ${tempo} bpm.`
  );

  // Phase 1 bundle-inclusion smoke check: reference `@anthropic-ai/sdk` so a
  // production esbuild proves it bundles cleanly into the single Node output at
  // `dist/extension.js`. This is intentionally inert — it touches only the class
  // identity (`Anthropic.name`), makes NO network request, and does NOT construct
  // a client at module load. Later phases replace this with the real Claude client
  // in its own module under `src/extension/`, not in this activation entry.
  console.log(`Claude SDK bundled and available: ${Anthropic.name}.`);
}
