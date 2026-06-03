import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for the Ableton Claude Agent.
 *
 * Phase 1 scope: exercise the pure modules only. The test suite runs in a Node
 * environment (the extension host and `src/shared` are Node-side; the webview
 * DOM is not under test here). Specs are matched by the `include` globs below
 * and import from `src/shared`. The fixture `FakeExtensionContext` and stub
 * Anthropic client arrive in later phases.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**", "vendor/**", ".claude/**"],
  },
});
