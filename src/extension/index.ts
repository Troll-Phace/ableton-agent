import { initialize, type ActivationContext } from "@ableton-extensions/sdk";

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
}
