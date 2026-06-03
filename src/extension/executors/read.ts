/**
 * Read executors (Phase 5 Task 3, ARCHITECTURE §8.1, §6, §15, §16).
 *
 * Each maps a `live_get_*` tool to the SDK read surface, re-resolving its ref to
 * a FRESH object every call (§6, via {@link resolveOrFail}) and returning a shallow
 * JSON snapshot as the `tool_result` content. Reads run immediately and in order
 * (the loop's read partition); they never mutate and never throw — failures come
 * back as the resolver's structured error or an executor `invalid_args` error (§9).
 *
 * ## Class-name dispatch, not `instanceof`
 * The resolver returns each object's concrete `className` ("AudioTrack",
 * "MidiClip", "Reverb", …). We branch on that string and read getters through
 * narrow `unknown`-accessors, so the executors run UNMODIFIED against both the
 * real SDK and the test fake (whose materialized proxies are plain objects, not
 * SDK-class instances). No `any`.
 *
 * ## Lazy `getValue()` (§15)
 * `DeviceParameter.getValue()` is async and on-demand ONLY — `live_get_device_params`
 * fans out one `getValue()` per parameter of the SINGLE requested device, never
 * eagerly across the whole Set.
 */

import type { ApiVersion, ExtensionContext } from "@ableton-extensions/sdk";

import type { ToolCall, ToolResultPayload } from "../agent-loop.js";
import type {
  LiveGetClipArgs,
  LiveGetDeviceParamsArgs,
  LiveGetTrackArgs,
} from "../../shared/tools.js";
import {
  deferred,
  errorMessage,
  fail,
  invalidArgs,
  isRecord,
  ok,
  readString,
  resolveOrFail,
  type Resolved,
} from "./shared.js";

// ---------------------------------------------------------------------------
// Narrow accessors over the resolved object (no `any`)
// ---------------------------------------------------------------------------

/** Read a getter that should yield a string, or `null`. */
function getString(obj: unknown, key: string): string | null {
  if (!isRecord(obj)) {
    return null;
  }
  const v = obj[key];
  return typeof v === "string" ? v : null;
}

/** Read a getter that should yield a number, or `null`. */
function getNumber(obj: unknown, key: string): number | null {
  if (!isRecord(obj)) {
    return null;
  }
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Read a getter that should yield a boolean, or `null`. */
function getBoolean(obj: unknown, key: string): boolean | null {
  if (!isRecord(obj)) {
    return null;
  }
  const v = obj[key];
  return typeof v === "boolean" ? v : null;
}

/** Read a getter that should yield an array, or `[]`. */
function getArray(obj: unknown, key: string): unknown[] {
  if (!isRecord(obj)) {
    return [];
  }
  const v = obj[key];
  return Array.isArray(v) ? v : [];
}

/** Read a getter that should yield an object, or `null`. */
function getObject(obj: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(obj)) {
    return null;
  }
  const v = obj[key];
  return isRecord(v) ? v : null;
}

/** True if `className` is (or derives from, by name) a clip family member. */
function isAudioClipClass(className: string): boolean {
  return className === "AudioClip";
}
function isMidiClipClass(className: string): boolean {
  return className === "MidiClip";
}

// ---------------------------------------------------------------------------
// Shallow summarizers (one level deep — §15 budgets)
// ---------------------------------------------------------------------------

/** Summarize a track child by ref-relevant identity (name only — shallow). */
function summarizeNamed(items: unknown[]): { index: number; name: string }[] {
  return items.map((item, index) => ({
    index,
    name: getString(item, "name") ?? "",
  }));
}

// ---------------------------------------------------------------------------
// live_get_project
// ---------------------------------------------------------------------------

/**
 * `live_get_project` — the project header: tempo, scale, grid, and shallow lists
 * of tracks / scenes / cue points / return tracks / the main track (§8.1). Reads
 * `song.*` directly off the freshly-read song; names + indices ground every ref.
 */
export function executeGetProject<V extends ApiVersion>(
  ctx: ExtensionContext<V>,
  call: ToolCall
): ToolResultPayload {
  try {
    const song = ctx.application.song as unknown as Record<string, unknown>;
    const data = {
      tempo: getNumber(song, "tempo"),
      scaleName: getString(song, "scaleName"),
      scaleMode: getBoolean(song, "scaleMode"),
      rootNote: getNumber(song, "rootNote"),
      gridQuantization: getNumber(song, "gridQuantization"),
      gridIsTriplet: getBoolean(song, "gridIsTriplet"),
      tracks: summarizeNamed(getArray(song, "tracks")),
      returnTracks: summarizeNamed(getArray(song, "returnTracks")),
      mainTrack: { name: getString(getObject(song, "mainTrack"), "name") },
      scenes: summarizeNamed(getArray(song, "scenes")),
      cuePoints: summarizeNamed(getArray(song, "cuePoints")),
    };
    return ok(call.id, data, "read project");
  } catch (e) {
    return fail(
      call.id,
      invalidArgs(`failed to read project: ${errorMessage(e)}`)
    );
  }
}

// ---------------------------------------------------------------------------
// live_get_track
// ---------------------------------------------------------------------------

/**
 * `live_get_track` — one track's contents: devices, arrangement clips, clip
 * slots, take lanes, mixer presence, and mute/solo/arm/group state (§8.1).
 */
export function executeGetTrack<V extends ApiVersion>(
  ctx: ExtensionContext<V>,
  call: ToolCall
): ToolResultPayload {
  if (!isRecord(call.input)) {
    return fail(call.id, invalidArgs("expected an object with a 'track' ref"));
  }
  const ref = readString(call.input, "track");
  if (ref === null) {
    return fail(call.id, invalidArgs("'track' must be a ref string"));
  }
  const resolved = resolveOrFail(ctx, ref);
  if (!resolved.ok) {
    return fail(call.id, resolved.err);
  }
  try {
    const track = resolved.resolved.object as unknown as Record<
      string,
      unknown
    >;
    const groupTrack = getObject(track, "groupTrack");
    const data = {
      ref: resolved.resolved.canonicalRef,
      className: resolved.resolved.className,
      name: getString(track, "name"),
      mute: getBoolean(track, "mute"),
      solo: getBoolean(track, "solo"),
      arm: getBoolean(track, "arm"),
      groupTrack: groupTrack === null ? null : getString(groupTrack, "name"),
      devices: summarizeNamed(getArray(track, "devices")),
      arrangementClips: summarizeNamed(getArray(track, "arrangementClips")),
      clipSlots: getArray(track, "clipSlots").map((slot, index) => ({
        index,
        hasClip: getObject(slot, "clip") !== null,
        clipName: getString(getObject(slot, "clip"), "name"),
      })),
      takeLanes: summarizeNamed(getArray(track, "takeLanes")),
      hasMixer: getObject(track, "mixer") !== null,
    };
    return ok(call.id, data, "read track");
  } catch (e) {
    return fail(
      call.id,
      invalidArgs(`failed to read track "${ref}": ${errorMessage(e)}`)
    );
  }
}

// ---------------------------------------------------------------------------
// live_get_clip
// ---------------------------------------------------------------------------

/**
 * `live_get_clip` — one clip. MIDI clips return their notes; audio clips return
 * warp settings + file path; both return name/color/loop/marker read-only fields
 * (§8.1). Markers are reported but never settable post-creation (§9).
 */
export function executeGetClip<V extends ApiVersion>(
  ctx: ExtensionContext<V>,
  call: ToolCall
): ToolResultPayload {
  if (!isRecord(call.input)) {
    return fail(call.id, invalidArgs("expected an object with a 'clip' ref"));
  }
  const ref = readString(call.input, "clip");
  if (ref === null) {
    return fail(call.id, invalidArgs("'clip' must be a ref string"));
  }
  const resolved = resolveOrFail(ctx, ref);
  if (!resolved.ok) {
    return fail(call.id, resolved.err);
  }
  try {
    const clip = resolved.resolved.object as unknown as Record<string, unknown>;
    const className = resolved.resolved.className;
    const base = {
      ref: resolved.resolved.canonicalRef,
      className,
      name: getString(clip, "name"),
      color: getNumber(clip, "color"),
      muted: getBoolean(clip, "muted"),
      looping: getBoolean(clip, "looping"),
      startTime: getNumber(clip, "startTime"),
      endTime: getNumber(clip, "endTime"),
      startMarker: getNumber(clip, "startMarker"),
      endMarker: getNumber(clip, "endMarker"),
      loopStart: getNumber(clip, "loopStart"),
      loopEnd: getNumber(clip, "loopEnd"),
    };
    if (isMidiClipClass(className)) {
      return ok(
        call.id,
        { ...base, notes: getArray(clip, "notes") },
        "read MIDI clip"
      );
    }
    if (isAudioClipClass(className)) {
      return ok(
        call.id,
        {
          ...base,
          filePath: getString(clip, "filePath"),
          warping: getBoolean(clip, "warping"),
          warpMode: getNumber(clip, "warpMode"),
        },
        "read audio clip"
      );
    }
    // Base Clip (rare): return the common fields only.
    return ok(call.id, base, "read clip");
  } catch (e) {
    return fail(
      call.id,
      invalidArgs(`failed to read clip "${ref}": ${errorMessage(e)}`)
    );
  }
}

// ---------------------------------------------------------------------------
// live_get_device_params
// ---------------------------------------------------------------------------

/** A single parameter shape with a getter for its lazy async value. */
interface ParamLike {
  name: string;
  min: number;
  max: number;
  isQuantized: boolean;
  valueItems: { name: string; shortName: string }[];
  getValue(): Promise<number>;
}

/** Narrow an unknown to a {@link ParamLike} (defensive over the SDK getters). */
function asParam(value: unknown): ParamLike | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value["getValue"] !== "function") {
    return null;
  }
  return value as unknown as ParamLike;
}

/**
 * `live_get_device_params` — a device's parameters: each name/min/max/isQuantized/
 * valueItems plus its CURRENT value via the async `getValue()` (§8.1). The
 * `getValue()` fan-out is lazy + on-demand and scoped to this ONE device only
 * (§15) — never eager across the Set. This is the only read executor that awaits.
 */
export async function executeGetDeviceParams<V extends ApiVersion>(
  ctx: ExtensionContext<V>,
  call: ToolCall
): Promise<ToolResultPayload> {
  if (!isRecord(call.input)) {
    return fail(call.id, invalidArgs("expected an object with a 'device' ref"));
  }
  const ref = readString(call.input, "device");
  if (ref === null) {
    return fail(call.id, invalidArgs("'device' must be a ref string"));
  }
  const resolved = resolveOrFail(ctx, ref);
  if (!resolved.ok) {
    return fail(call.id, resolved.err);
  }
  try {
    const device = resolved.resolved.object as unknown as Record<
      string,
      unknown
    >;
    const params = getArray(device, "parameters");
    // One getValue() per parameter of THIS device only (§15 on-demand fan-out).
    const values = await Promise.all(
      params.map(async (p): Promise<number | null> => {
        const param = asParam(p);
        if (param === null) {
          return null;
        }
        try {
          return await param.getValue();
        } catch {
          return null;
        }
      })
    );
    const data = {
      ref: resolved.resolved.canonicalRef,
      className: resolved.resolved.className,
      name: getString(device, "name"),
      parameters: params.map((p, index) => {
        const param = asParam(p);
        return {
          index,
          name: param?.name ?? getString(p, "name") ?? "",
          value: values[index],
          min: param?.min ?? getNumber(p, "min"),
          max: param?.max ?? getNumber(p, "max"),
          isQuantized: param?.isQuantized ?? getBoolean(p, "isQuantized"),
          valueItems: param?.valueItems ?? getArray(p, "valueItems"),
        };
      }),
    };
    return ok(call.id, data, "read device params");
  } catch (e) {
    return fail(
      call.id,
      invalidArgs(`failed to read device "${ref}": ${errorMessage(e)}`)
    );
  }
}

// ---------------------------------------------------------------------------
// live_render_audio (deferred to Phase 14)
// ---------------------------------------------------------------------------

/**
 * `live_render_audio` — schema is registered but the body is DEFERRED to Phase 14
 * (§8.1, §14). Returns the honest deferred payload (`isError: true`); never a fake
 * success or a fake WAV path (§9).
 */
export function executeRenderAudio(call: ToolCall): ToolResultPayload {
  return deferred(call.id, "live_render_audio");
}

// Re-export arg types for callers/tests that want them adjacent to the executors.
export type {
  LiveGetTrackArgs,
  LiveGetClipArgs,
  LiveGetDeviceParamsArgs,
  Resolved,
};
