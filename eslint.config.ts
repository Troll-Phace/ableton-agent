import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

/**
 * Flat ESLint config for the Ableton Claude Agent.
 *
 * Authored as `eslint.config.ts` and loaded by ESLint v9 via `jiti`. It layers:
 *   1. `@eslint/js` recommended.
 *   2. `typescript-eslint` recommended-type-checked (type-aware) over all
 *      TypeScript sources, using `projectService` so type info resolves across
 *      `src/**`, `tests/**`, and the build-tooling configs.
 *   3. Architectural import boundaries (§3.2 / code-style.md): `src/webview`
 *      must never reach into `src/extension`, and `src/shared` must stay pure
 *      (no SDK, no DOM).
 *   4. `eslint-config-prettier` LAST, to disable stylistic rules that Prettier
 *      owns (Prettier runs separately — see `.prettierrc`).
 */
export default tseslint.config(
  {
    // Global ignores — must be a standalone object to apply repo-wide.
    ignores: ["dist/", "node_modules/", "vendor/", ".claude/"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // src/webview must never import from src/extension (no host access).
    files: ["src/webview/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/extension/**", "src/extension", "src/extension/**"],
              message:
                "src/webview must not import from src/extension — the webview has no host access (code-style.md, ARCHITECTURE §3.2).",
            },
          ],
        },
      ],
    },
  },
  {
    // src/shared must stay pure: no SDK, no DOM.
    files: ["src/shared/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@ableton-extensions/sdk",
                "**/extension/**",
                "**/webview/**",
              ],
              message:
                "src/shared must stay pure — no SDK, no DOM, no host/webview imports (code-style.md, ARCHITECTURE §3.2).",
            },
          ],
        },
      ],
    },
  },
  prettierConfig
);
