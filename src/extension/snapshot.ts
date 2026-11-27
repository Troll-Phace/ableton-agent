/**
 * Per-turn scoped snapshot serializer (Phase 11 Task 1, ARCHITECTURE §4, §6, §15).
 *
 * Builds the cheap, always-present context block that seeds the Claude loop on
 * iteration 0 of each turn (the detail layer is the on-demand `live_get_*` read
 * tools). Per §4 the scope is "selection if present, else project header":
 *  - ALWAYS the project header (tempo/scale/grid + shallow `{index,name}` lists
 *    of tracks / return tracks / scenes / cue points), produced by the SAME
 *    builder the `live_get_project` tool uses ({@link buildProjectHeader}).
 *  - WHEN a launch scope ref resolves to a track, ALSO that one track expanded
 *    to its shallow {@link buildTrackDetail} shape (devices / clip slots / take
 *    lanes / mute-solo-arm — names + indices only). Same builder as
 *    `live_get_track`, so the snapshot and the read tools can never drift.
 *
 * ## Discipline (project-critical)
 *  - **Shallow only (§15):** no device-parameter values, no MIDI note arrays.
 *    **Zero `getValue()`** (async + forbidden as a fan-out), **zero
 *    `withinTransaction`**, **zero mutation** — strictly read-only.
 *  - **Handle discipline (§6):** the caller passes a ref STRING, never a Handle.
 *    The scope ref is re-resolved FRESH every call via {@link resolveRef}; no
 *    handle or object is cached across turns.
 *  - **Never throws, never fabricates (§9):** if the scope ref fails to resolve
 *    (deleted / renamed / ambiguous / type mismatch) or resolves to a non-track,
 *    the `scopedTrack` block is OMITTED and an honest `scopeNote` string explains
 *    why; the header is still returned. Any unexpected internal error degrades to
 *    a minimal honest snapshot rather than escaping to the loop.
 */

import type { ApiVersion, ExtensionContext } from "@ableton-extensions/sdk";

import { parseRef } from "../shared/refs.js";
import {
  buildProjectHeader,
  buildTrackDetail,
  type ProjectHeader,
  type TrackDetail,
} from "./executors/read.js";
import { resolveRef } from "./references.js";

/**
 * The serialized snapshot object. `kind` tags it self-describingly so the model
 * (and tests) can parse it without ambiguity. `scopedTrack` is present only when
 * the launch scope resolved to a track this turn; `scopeNote` is present only
 * when a scope was requested but could not be expanded (honest fallback).
 */
export interface ProjectSnapshot {
  kind: "project_snapshot";
  header: ProjectHeader;
  scopedTrack?: TrackDetail;
  scopeNote?: string;
}

/**
 * Defensive hard cap on the serialized snapshot length (§15: the snapshot must
 * stay a small fraction of the ≤ 25k input budget). The snapshot is already
 * shallow, so this is a BACKSTOP for pathological Sets (e.g. hundreds of tracks).
 * ~8000 chars ≈ ~2k tokens, matching the snapshot allowance baked into the
 * session's per-turn reserve. The cap degrades the snapshot GRACEFULLY (drop the
 * heaviest optional part, then fall back to a minimal valid object) — it never
 * slices the JSON string (that would hand the agent invalid JSON to read) and
 * never throws.
 */
const MAX_SNAPSHOT_CHARS = 8000;

/** Honest note appended to `scopeNote` when the snapshot is capped. */
const TRUNCATION_NOTE = "…(snapshot truncated to stay within context budget)";

/**
 * Append {@link TRUNCATION_NOTE} to an optional existing `scopeNote` (honest,
 * non-destructive: any prior note is preserved and the truncation note added).
 */
function withTruncationNote(existing?: string): string {
  return existing !== undefined && existing.trim() !== ""
    ? `${existing}; ${TRUNCATION_NOTE}`
    : TRUNCATION_NOTE;
}

/**
 * Serialize a snapshot, enforcing {@link MAX_SNAPSHOT_CHARS} while keeping the
 * result VALID JSON and HONEST. Strategy, in order:
 *  1. If the full snapshot fits, return it unchanged.
 *  2. Else drop the heaviest optional part (`scopedTrack`) and add the truncation
 *     note; if that now fits, return it.
 *  3. Else (even the header is over cap) fall back to a minimal valid snapshot
 *     object carrying only the truncation note — never an invalid string slice.
 */
function serializeCapped(snapshot: ProjectSnapshot): string {
  const full = JSON.stringify(snapshot);
  if (full.length <= MAX_SNAPSHOT_CHARS) {
    return full;
  }

  // 2. Drop the heaviest optional detail and flag the truncation honestly.
  const trimmed: ProjectSnapshot = {
    kind: "project_snapshot",
    header: snapshot.header,
    scopeNote: withTruncationNote(snapshot.scopeNote),
  };
  const trimmedStr = JSON.stringify(trimmed);
  if (trimmedStr.length <= MAX_SNAPSHOT_CHARS) {
    return trimmedStr;
  }

  // 3. Even the header is over cap: minimal valid object, header omitted, honest.
  const minimal: ProjectSnapshot = {
    kind: "project_snapshot",
    header: {
      tempo: null,
      scaleName: null,
      scaleMode: null,
      rootNote: null,
      gridQuantization: null,
      gridIsTriplet: null,
      tracks: [],
      returnTracks: [],
      mainTrack: { name: null },
      scenes: [],
      cuePoints: [],
    },
    scopeNote: `${TRUNCATION_NOTE}; the project is too large to summarize inline — use the live_get_* tools to read state on demand`,
  };
  return JSON.stringify(minimal);
}

/**
 * True if a resolver `className` denotes a track. The base resolver fallback is
 * `"Track"`; the real SDK reports concrete subtypes (`"AudioTrack"`,
 * `"MidiTrack"`). A name-suffix check covers both without importing SDK classes,
 * matching the className-dispatch style of the read executors.
 */
function isTrackClassName(className: string): boolean {
  return className === "Track" || className.endsWith("Track");
}

/**
 * True if a canonical ref's LEAF segment is a `track`. Used alongside the
 * className check so a scope ref that happens to point at a non-track object
 * named like a track cannot be mistaken for a track.
 */
function refLeafIsTrack(ref: string): boolean {
  try {
    const { segments } = parseRef(ref);
    const leaf = segments[segments.length - 1] as { kind?: string } | undefined;
    return leaf?.kind === "track";
  } catch {
    return false;
  }
}

/**
 * Build the scoped per-turn snapshot as a compact JSON string for the Claude loop.
 *
 * - No `scopeRef` → project header only.
 * - `scopeRef` resolves to a track → header + shallow `scopedTrack`.
 * - `scopeRef` present but unresolved / non-track → header + honest `scopeNote`
 *   (never throws, never fabricates).
 *
 * Re-resolves `scopeRef` FRESH via {@link resolveRef} every call (§6); the caller
 * MUST pass a ref string, never a Handle, and nothing is cached across turns.
 * The whole body is defensive: any unexpected error degrades to a minimal honest
 * snapshot string rather than escaping to the loop.
 *
 * @param ctx      The extension context (real SDK or the test fake).
 * @param scopeRef Optional launch-scope ref string (e.g. `"track:0:Drums"`).
 * @returns A JSON string of {@link ProjectSnapshot}.
 */
export function buildSnapshot<V extends ApiVersion>(
  ctx: ExtensionContext<V>,
  scopeRef?: string
): string {
  try {
    const header = buildProjectHeader(ctx);
    const snapshot: ProjectSnapshot = { kind: "project_snapshot", header };

    if (scopeRef !== undefined && scopeRef.trim() !== "") {
      const resolved = resolveRef(ctx, scopeRef);
      if (!resolved.ok) {
        snapshot.scopeNote = `launch-scoped object "${scopeRef}" could not be resolved this turn (${resolved.err.error}: ${resolved.err.detail}); showing project header only`;
      } else if (
        !isTrackClassName(resolved.className) ||
        !refLeafIsTrack(resolved.canonicalRef)
      ) {
        snapshot.scopeNote = `launch-scoped object "${resolved.canonicalRef}" is a ${resolved.className}, not a track; showing project header only`;
      } else {
        snapshot.scopedTrack = buildTrackDetail({
          object: resolved.object,
          className: resolved.className,
          canonicalRef: resolved.canonicalRef,
        });
      }
    }

    // Defensive hard cap (§15): keep the serialized snapshot under
    // `MAX_SNAPSHOT_CHARS`, degrading to valid JSON + an honest note, never a
    // string slice and never a throw.
    return serializeCapped(snapshot);
  } catch (e) {
    // Defensive: the loop must never crash on a snapshot failure (§9). Emit a
    // minimal, honest snapshot and log context (console-only host).
    const detail = e instanceof Error ? e.message : String(e);
    console.error(`buildSnapshot failed: ${detail}`);
    const fallback: ProjectSnapshot = {
      kind: "project_snapshot",
      header: {
        tempo: null,
        scaleName: null,
        scaleMode: null,
        rootNote: null,
        gridQuantization: null,
        gridIsTriplet: null,
        tracks: [],
        returnTracks: [],
        mainTrack: { name: null },
        scenes: [],
        cuePoints: [],
      },
      scopeNote:
        "snapshot could not be built this turn (internal error); the project state is unavailable — use the live_get_* tools to read state on demand",
    };
    return JSON.stringify(fallback);
  }
}
