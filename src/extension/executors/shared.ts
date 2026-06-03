/**
 * Executor shared helpers (Phase 5 Tasks 2–4, ARCHITECTURE §6, §7, §8, §9, §16).
 *
 * The thin, reused machinery every read/mutation executor leans on:
 *  - {@link ok}/{@link fail} — build the {@link ToolResultPayload} the agent loop
 *    appends as a `tool_result` block (success JSON text, or a structured error
 *    with `isError: true`); executors NEVER throw to the loop (§9, code-style).
 *  - {@link resolveOrFail} — re-resolve a ref to a FRESH object via the resolver,
 *    surfacing the resolver's structured {@link RefError} VERBATIM on failure. Per
 *    §6 the returned object MUST be used immediately and never cached across calls.
 *  - {@link deferred} — the honest "not yet implemented" payload for audio tools
 *    that land in Phase 14 (never a fake success, §9).
 *  - {@link beatsToSeconds}/{@link secondsToBeats} — the unit boundary (§16): the
 *    tool surface speaks **beats**; only render conversions touch seconds.
 *  - argument-narrowing guards over `unknown` inputs (strict, no `any`).
 *
 * This module imports the SDK only for the {@link ExtensionContext} type used by
 * the resolver seam; it performs no mutations itself.
 */

import type {
  ApiVersion,
  DataModelObject,
  ExtensionContext,
} from "@ableton-extensions/sdk";

import type { ToolResultPayload } from "../agent-loop.js";
import { resolveRef, type RefError } from "../references.js";

// ---------------------------------------------------------------------------
// Structured error contract (§6 / §9)
// ---------------------------------------------------------------------------

/**
 * The structured error shape every executor returns on failure (ARCHITECTURE
 * §6 error contract / §9 honesty). `ref` is present only for ref-addressed
 * failures. Resolver {@link RefError}s are a structural superset of this and are
 * surfaced verbatim.
 */
export interface ExecutorError {
  /** Failure class. Resolver classes plus executor-level classes. */
  error: string;
  /** The offending ref, when the failure is ref-addressed. */
  ref?: string;
  /** Human-readable detail. */
  detail: string;
  /** Recovery hint for the agent. */
  hint: string;
}

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

/**
 * Build a success {@link ToolResultPayload}: the `data` object serialized as JSON
 * text content, echoing the call's `tool_use_id`. An optional `summary` feeds the
 * `tool_activity` narration (Phase 7).
 */
export function ok(
  toolUseId: string,
  data: unknown,
  summary?: string
): ToolResultPayload {
  return {
    toolUseId,
    content: JSON.stringify(data),
    ...(summary !== undefined ? { summary } : {}),
  };
}

/**
 * Build a structured-error {@link ToolResultPayload} (`isError: true`): the
 * {@link ExecutorError} serialized as JSON text content. This is the ONLY way an
 * executor reports failure — it never throws (§9).
 */
export function fail(
  toolUseId: string,
  err: ExecutorError,
  summary?: string
): ToolResultPayload {
  return {
    toolUseId,
    content: JSON.stringify(err),
    isError: true,
    ...(summary !== undefined ? { summary } : {}),
  };
}

/**
 * Build the honest "deferred to Phase 14" payload (`isError: true`) for the audio
 * tools whose bodies are not yet implemented. Never a fake success (§9).
 */
export function deferred(toolUseId: string, what: string): ToolResultPayload {
  return fail(toolUseId, {
    error: "deferred",
    detail: `${what} is not implemented yet — audio tools land in Phase 14`,
    hint: "do not retry; use report_limitation to tell the user audio support is coming",
  });
}

/** Build an `invalid_args` error for a malformed/missing tool argument. */
export function invalidArgs(
  detail: string,
  hint = "re-emit the tool call with the documented arguments"
): ExecutorError {
  return { error: "invalid_args", detail, hint };
}

/** Build an `unsupported` honesty error (§9 — e.g. a marker edit, automation). */
export function unsupported(detail: string, hint: string): ExecutorError {
  return { error: "unsupported", detail, hint };
}

/** Build an `sdk_error` from a caught SDK rejection (every async SDK call). */
export function sdkError(detail: string): ExecutorError {
  return {
    error: "sdk_error",
    detail,
    hint: "the SDK rejected the operation; check the arguments and re-read state",
  };
}

/** Extract a message from an unknown thrown/rejected value. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Ref resolution seam (re-resolve EVERY call — never cache, §6)
// ---------------------------------------------------------------------------

/** A freshly-resolved object plus its re-anchored canonical ref. */
export interface Resolved<V extends ApiVersion> {
  object: DataModelObject<V>;
  className: string;
  canonicalRef: string;
}

/**
 * Re-resolve `ref` to a FRESH object via the resolver (§6). On success returns
 * the live object + its className + canonical ref; on failure returns the
 * resolver's structured {@link RefError} unchanged, so the agent re-grounds with
 * the documented `ref_unresolved`/`ref_ambiguous`/`type_mismatch` payload.
 *
 * The returned object is valid for THIS call only — callers must use it
 * immediately and never store it across tool calls.
 */
export function resolveOrFail<V extends ApiVersion>(
  ctx: ExtensionContext<V>,
  ref: string
): { ok: true; resolved: Resolved<V> } | { ok: false; err: RefError } {
  const result = resolveRef(ctx, ref);
  if (!result.ok) {
    return { ok: false, err: result.err };
  }
  return {
    ok: true,
    resolved: {
      object: result.object,
      className: result.className,
      canonicalRef: result.canonicalRef,
    },
  };
}

// ---------------------------------------------------------------------------
// Unit conversion (§16 — beats on the boundary, seconds only for render)
// ---------------------------------------------------------------------------

/** Convert beats → seconds at a given tempo (BPM). One beat = `60/tempo` s. */
export function beatsToSeconds(beats: number, tempo: number): number {
  return (beats * 60) / tempo;
}

/** Convert seconds → beats at a given tempo (BPM). */
export function secondsToBeats(seconds: number, tempo: number): number {
  return (seconds * tempo) / 60;
}

// ---------------------------------------------------------------------------
// Argument narrowing (strict; no `any`)
// ---------------------------------------------------------------------------

/** True if `value` is a non-null, non-array object (a record). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a required string field, or `null` if absent/wrong type. */
export function readString(
  obj: Record<string, unknown>,
  key: string
): string | null {
  const v = obj[key];
  return typeof v === "string" ? v : null;
}

/** Read an optional string field; `undefined` if absent, `null` if wrong type. */
export function optString(
  obj: Record<string, unknown>,
  key: string
): string | null | undefined {
  if (!(key in obj)) {
    return undefined;
  }
  const v = obj[key];
  return typeof v === "string" ? v : null;
}

/** Read a required finite number, or `null` if absent/wrong type. */
export function readNumber(
  obj: Record<string, unknown>,
  key: string
): number | null {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Read an optional finite number; `undefined` if absent, `null` if wrong type. */
export function optNumber(
  obj: Record<string, unknown>,
  key: string
): number | null | undefined {
  if (!(key in obj)) {
    return undefined;
  }
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Read an optional boolean; `undefined` if absent, `null` if wrong type. */
export function optBoolean(
  obj: Record<string, unknown>,
  key: string
): boolean | null | undefined {
  if (!(key in obj)) {
    return undefined;
  }
  const v = obj[key];
  return typeof v === "boolean" ? v : null;
}

/** Clamp `value` into `[min, max]`. */
export function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}
