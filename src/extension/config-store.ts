/**
 * Config store — the host-side persistence seam for the API key, model choice,
 * and user defaults (Phase 10, ARCHITECTURE §10).
 *
 * Everything here lives in **Node only**. The Anthropic API key is read from /
 * written to `storageDirectory/config.json` and is NEVER logged, NEVER serialized
 * to the webview, and NEVER returned by the one webview-facing projection
 * ({@link toConfigState}). The only thing that crosses the socket boundary is
 * `{ hasKey, model }` — the presence of a key, never its value.
 *
 * Design rules baked in (code-style "Error handling", §10):
 *  - SDK-free and dependency-free: only `node:fs`/`node:path`/`node:os` builtins,
 *    so it is safe under the stripped V8 realm (no `URL`/`fetch`/web globals; see
 *    `runtime-shim.ts`).
 *  - `storageDirectory` may be `undefined` — that is a FIRST-CLASS path (first run
 *    / no storage granted), not an error. Reads fall back to defaults; writes
 *    return a structured `{ ok: false }` (honest: cannot persist), never a phantom
 *    success.
 *  - Malformed `config.json` recovers to defaults with a single honest
 *    `console.warn` (no key value in the log line). Nothing here throws.
 *
 * Mirrors the model-default precedence used by `claude-client.ts`
 * ({@link MODEL} / `process.env.ANTHROPIC_API_KEY`) so the host resolves the key
 * and model identically wherever it asks.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ConfigStatePayload } from "../shared/protocol.js";

import { MODEL } from "./claude-client.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Module log prefix (matches the per-module convention, e.g. `[session]`). */
const LOG_PREFIX = "[config]";

/** Filename of the on-disk config, under `storageDirectory`. */
const CONFIG_FILENAME = "config.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** User-tunable defaults persisted alongside the key/model. */
export interface ConfigDefaults {
  /** Scope the snapshot to the launch selection when present (§4/§16). */
  scopeToSelection: boolean;
  /** Require explicit approval before destructive edits (§9/§12). */
  confirmDestructive: boolean;
}

/**
 * The persisted config shape (`storageDirectory/config.json`). Every field is
 * optional on disk so a partial / first-run file still parses; readers fill gaps
 * via {@link resolveModel} / {@link DEFAULT_DEFAULTS}.
 */
export interface Config {
  /** Anthropic API key — Node-only; never crosses to the webview. */
  anthropicApiKey?: string;
  /** Model id override (defaults to {@link MODEL}). */
  model?: string;
  /** User defaults (scoping / confirmation behavior). */
  defaults?: ConfigDefaults;
}

/** Structured write failure (mirrors the §6/§9 error contract; never thrown). */
export interface SaveErr {
  ok: false;
  /** Failure class for the caller to branch on. */
  error: "no_storage_dir" | "write_failed";
  /** Human-readable detail — never contains the key value. */
  detail: string;
}

/** Successful write result. */
export interface SaveOk {
  ok: true;
}

/** Result of {@link saveConfig}. */
export type SaveResult = SaveOk | SaveErr;

// ---------------------------------------------------------------------------
// Defaults (first run / undefined dir / missing file all resolve here)
// ---------------------------------------------------------------------------

/** The sensible {@link ConfigDefaults} used when none are persisted. */
const DEFAULT_DEFAULTS: ConfigDefaults = {
  scopeToSelection: true,
  confirmDestructive: true,
};

/** A fresh, empty config (no key, default model, default defaults). */
function emptyConfig(): Config {
  return { defaults: { ...DEFAULT_DEFAULTS } };
}

// ---------------------------------------------------------------------------
// Path helper
// ---------------------------------------------------------------------------

/** Resolve the absolute `config.json` path under a (defined) storage dir. */
function configPath(storageDir: string): string {
  return join(storageDir, CONFIG_FILENAME);
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Read the persisted {@link Config}, never throwing.
 *
 * Resolution:
 *  - `storageDir === undefined` OR the file is absent → return {@link emptyConfig}
 *    (first run; not an error).
 *  - Malformed JSON or a non-object payload → recover to {@link emptyConfig} with
 *    a single honest `console.warn` (the key value is NEVER logged).
 *
 * The returned object always carries a `defaults` block (gaps filled from
 * {@link DEFAULT_DEFAULTS}) so callers never see a missing-default surprise.
 *
 * @param storageDir `ctx.environment.storageDirectory` (may be `undefined`).
 */
export function loadConfig(storageDir: string | undefined): Config {
  if (storageDir === undefined) {
    return emptyConfig();
  }

  const path = configPath(storageDir);
  if (!existsSync(path)) {
    return emptyConfig();
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    // I/O failure (permissions, race with deletion). Recover, do not throw.
    const detail = err instanceof Error ? err.message : "unknown read error";
    console.warn(`${LOG_PREFIX} could not read ${CONFIG_FILENAME}: ${detail}`);
    return emptyConfig();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown parse error";
    console.warn(
      `${LOG_PREFIX} malformed ${CONFIG_FILENAME} — recovering to defaults: ${detail}`
    );
    return emptyConfig();
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.warn(
      `${LOG_PREFIX} ${CONFIG_FILENAME} is not a JSON object — recovering to defaults`
    );
    return emptyConfig();
  }

  return normalizeConfig(parsed as Record<string, unknown>);
}

/**
 * Coerce an arbitrary parsed object into a {@link Config}, defensively typing each
 * field (the file is user-editable). Unknown/typo'd fields are dropped; a missing
 * or malformed `defaults` block falls back to {@link DEFAULT_DEFAULTS}. Never logs
 * the key.
 */
function normalizeConfig(obj: Record<string, unknown>): Config {
  const config: Config = { defaults: { ...DEFAULT_DEFAULTS } };

  if (
    typeof obj.anthropicApiKey === "string" &&
    obj.anthropicApiKey.length > 0
  ) {
    config.anthropicApiKey = obj.anthropicApiKey;
  }
  if (typeof obj.model === "string" && obj.model.length > 0) {
    config.model = obj.model;
  }

  const d = obj.defaults;
  if (typeof d === "object" && d !== null && !Array.isArray(d)) {
    const dr = d as Record<string, unknown>;
    config.defaults = {
      scopeToSelection:
        typeof dr.scopeToSelection === "boolean"
          ? dr.scopeToSelection
          : DEFAULT_DEFAULTS.scopeToSelection,
      confirmDestructive:
        typeof dr.confirmDestructive === "boolean"
          ? dr.confirmDestructive
          : DEFAULT_DEFAULTS.confirmDestructive,
    };
  }

  return config;
}

// ---------------------------------------------------------------------------
// Save (load → shallow-merge → write; never throws)
// ---------------------------------------------------------------------------

/**
 * Shallow-merge `partial` over the existing on-disk config and persist it,
 * pretty-printed (2-space). Never throws.
 *
 * Behavior:
 *  - `storageDir === undefined` → return `{ ok: false, error: "no_storage_dir" }`
 *    (honest: there is nowhere to persist — NO phantom success).
 *  - Otherwise: load current config, spread `partial` over it (top-level keys
 *    replace whole values — `defaults` is replaced, not deep-merged), `mkdir -p`
 *    the dir, and write `config.json`.
 *  - Any I/O failure maps to `{ ok: false, error: "write_failed" }` — the detail
 *    never contains the key value.
 *
 * @param storageDir `ctx.environment.storageDirectory` (may be `undefined`).
 * @param partial    The fields to overlay (e.g. `{ anthropicApiKey }`).
 */
export function saveConfig(
  storageDir: string | undefined,
  partial: Partial<Config>
): SaveResult {
  if (storageDir === undefined) {
    return {
      ok: false,
      error: "no_storage_dir",
      detail:
        "no storageDirectory available — cannot persist config (first run / storage not granted)",
    };
  }

  const merged: Config = { ...loadConfig(storageDir), ...partial };
  const path = configPath(storageDir);

  try {
    mkdirSync(storageDir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    return { ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown write error";
    // Log context (host has only console.*) — never the key value.
    console.error(
      `${LOG_PREFIX} failed to write ${CONFIG_FILENAME}: ${detail}`
    );
    return { ok: false, error: "write_failed", detail };
  }
}

// ---------------------------------------------------------------------------
// Resolution helpers (match claude-client precedence)
// ---------------------------------------------------------------------------

/**
 * Resolve the effective API key: the config value wins, else
 * `process.env.ANTHROPIC_API_KEY`. An empty string is treated as ABSENT (same as
 * `createClaudeClient`'s precedence). Returns `undefined` when neither is set.
 *
 * Node-only: the result must never be sent to the webview.
 */
export function resolveApiKey(config: Config): string | undefined {
  const fromConfig = config.anthropicApiKey;
  if (fromConfig !== undefined && fromConfig.length > 0) {
    return fromConfig;
  }
  const fromEnv = process.env.ANTHROPIC_API_KEY;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  return undefined;
}

/**
 * Resolve the effective model id: the config override, else the shared default
 * {@link MODEL} from `claude-client.ts` (single source of truth — not redefined).
 */
export function resolveModel(config: Config): string {
  return config.model ?? MODEL;
}

// ---------------------------------------------------------------------------
// Webview projection (the ONLY shape that crosses the socket boundary)
// ---------------------------------------------------------------------------

/**
 * Project a {@link Config} to the non-secret {@link ConfigStatePayload} the webview
 * may render. This is the ONLY config shape allowed across the boundary, and it
 * MUST NEVER include the key — only whether one is present.
 *
 * `hasKey` is derived via {@link resolveApiKey} (so an env-only key still reads as
 * present); `model` via {@link resolveModel}.
 */
export function toConfigState(config: Config): ConfigStatePayload {
  return {
    hasKey: resolveApiKey(config) !== undefined,
    model: resolveModel(config),
  };
}
