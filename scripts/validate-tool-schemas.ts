/**
 * Dev script: validate the real tool schemas against the live Anthropic API.
 *
 * Anthropic validates `strict` tool JSON Schemas server-side against its
 * supported subset. That validation is environment-independent, so running ONE
 * minimal `messages.create` with `tools: TOOL_DEFINITIONS` tells us — in
 * seconds, on the dev machine — whether the next Live run will get past tool
 * validation. A 400 `invalid_request_error` reports the FIRST offending tool as
 * `tools.N.custom: <reason>`; we map index N back to its tool name so the fix is
 * unambiguous.
 *
 * This is a dev script, NOT part of `npm test` (it hits the network). It is the
 * only place allowed to import the Anthropic SDK alongside the pure
 * `src/shared/tools.ts` source of truth.
 *
 * Key discipline (ARCHITECTURE §10): the API key is read from the environment
 * (or the gitignored repo-root `.env`) and is NEVER printed, logged, or
 * committed. Run:
 *
 *   npm run validate:tools
 *
 * Exit code 0 = the API accepted all tool schemas; 1 = a schema (or other)
 * error.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import Anthropic from "@anthropic-ai/sdk";

import { TOOL_DEFINITIONS } from "../src/shared/tools.js";

/**
 * Resolve the Anthropic API key: prefer `process.env.ANTHROPIC_API_KEY`, else
 * parse the single `ANTHROPIC_API_KEY=...` line out of the repo-root `.env`.
 * The returned value is used only to construct the client and is never logged.
 */
function readApiKey(): string {
  const fromEnv = process.env.ANTHROPIC_API_KEY;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return fromEnv.trim();
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = join(here, "..", ".env");
  let raw: string;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch {
    throw new Error(
      "ANTHROPIC_API_KEY not in env and .env not readable at repo root."
    );
  }

  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*ANTHROPIC_API_KEY\s*=\s*(.+)\s*$/.exec(line);
    if (match) {
      // Strip optional surrounding quotes; never log the captured value.
      return match[1].replace(/^["']|["']$/g, "").trim();
    }
  }
  throw new Error("ANTHROPIC_API_KEY line not found in .env.");
}

/**
 * Parse a strict-mode 400 message of the form `tools.N.custom: <reason>` and
 * annotate it with the offending tool's name, so the fix target is obvious.
 * Returns the original message unchanged if it does not match that shape.
 */
function annotateToolIndex(message: string): string {
  const match = /tools\.(\d+)\.custom/.exec(message);
  if (!match) {
    return message;
  }
  const index = Number(match[1]);
  const tool = TOOL_DEFINITIONS[index];
  const name = tool ? tool.name : "<out of range>";
  return `${message}\n  → tool index ${index} = "${name}"`;
}

async function main(): Promise<void> {
  const client = new Anthropic({ apiKey: readApiKey() });

  process.stdout.write(
    `Validating ${TOOL_DEFINITIONS.length} tool schemas against the Anthropic API...\n`
  );

  try {
    await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
      tools: [...TOOL_DEFINITIONS],
    });
    process.stdout.write(
      `OK — the API accepted all ${TOOL_DEFINITIONS.length} tool schemas (no 400).\n`
    );
    process.exitCode = 0;
  } catch (err: unknown) {
    if (err instanceof Anthropic.APIError) {
      const message = typeof err.message === "string" ? err.message : "";
      // A schema rejection is ANY 400 invalid_request_error about the tools:
      // either a per-tool subset violation (`tools.N.custom: …`) or one of the
      // aggregate strict complexity limits (too many optional params / union
      // params / strict tools, or "compiled grammar is too large"). All of
      // these mean a schema fix is needed — never auth/network.
      const isPerToolSubset = /tools\.\d+\.custom/.test(message);
      const isComplexityLimit =
        /optional parameters|union types|strict tools|compiled grammar|grammar compilation/i.test(
          message
        );
      const isSchema =
        err.status === 400 && (isPerToolSubset || isComplexityLimit);
      if (isSchema) {
        process.stderr.write(
          `SCHEMA REJECTED (HTTP ${String(err.status)}):\n${annotateToolIndex(
            message
          )}\n`
        );
      } else {
        process.stderr.write(
          `NON-SCHEMA API error (HTTP ${String(
            err.status
          )}) — auth/network/other, NOT a schema problem:\n${err.message}\n`
        );
      }
    } else {
      process.stderr.write(
        `Unexpected error (not an Anthropic API error): ${String(err)}\n`
      );
    }
    process.exitCode = 1;
  }
}

void main();
