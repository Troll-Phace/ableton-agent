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

import type {
  ApiVersion,
  AudioTrack,
  ExtensionContext,
} from "@ableton-extensions/sdk";

import type {
  ToolCall,
  LocalToolResultPayload as ToolResultPayload,
} from "../../shared/provider.js";
import type {
  LiveGetClipArgs,
  LiveGetDeviceParamsArgs,
  LiveGetTrackArgs,
  LiveRenderAudioArgs,
  ReportLimitationArgs,
} from "../../shared/tools.js";
import {
  beatsToSeconds,
  errorMessage,
  fail,
  invalidArgs,
  isRecord,
  ok,
  optString,
  readNumber,
  readString,
  resolveOrFail,
  sdkError,
  unsupported,
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
// Shared shape builders (single source of truth for read tools + snapshot)
// ---------------------------------------------------------------------------

/**
 * The shallow project-header shape (§8.1): tempo, scale, grid, and `{index,name}`
 * lists of tracks / return tracks / scenes / cue points + the main-track name.
 * Used by both {@link executeGetProject} and the per-turn snapshot serializer
 * (`../snapshot`) so the two cannot drift. Reads `song.*` synchronously — no
 * `getValue()`, no mutation.
 */
export interface ProjectHeader {
  tempo: number | null;
  scaleName: string | null;
  scaleMode: boolean | null;
  rootNote: number | null;
  gridQuantization: number | null;
  gridIsTriplet: boolean | null;
  tracks: { index: number; name: string }[];
  returnTracks: { index: number; name: string }[];
  mainTrack: { name: string | null };
  scenes: { index: number; name: string }[];
  cuePoints: { index: number; name: string }[];
}

/**
 * Build the shallow {@link ProjectHeader} off the freshly-read song. This is the
 * single source of truth for the `live_get_project` payload AND the snapshot
 * header (`../snapshot`). Pure read: SYNC, no `getValue()`, no transaction, no
 * mutation. Re-reads `ctx.application.song` fresh on every call (§6).
 */
export function buildProjectHeader<V extends ApiVersion>(
  ctx: ExtensionContext<V>
): ProjectHeader {
  const song = ctx.application.song as unknown as Record<string, unknown>;
  return {
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
}

/**
 * The shallow track-detail shape (§8.1): ref/className/name, mute/solo/arm,
 * group-track name, and `{index,name}`-level lists of devices / arrangement clips
 * / clip slots / take lanes plus mixer presence. Used by both
 * {@link executeGetTrack} and the snapshot's `scopedTrack` block. No
 * device-parameter values, no MIDI note arrays — those are fetched on demand via
 * the other `live_get_*` tools (§15).
 */
export interface TrackDetail {
  ref: string;
  className: string;
  name: string | null;
  mute: boolean | null;
  solo: boolean | null;
  arm: boolean | null;
  groupTrack: string | null;
  devices: { index: number; name: string }[];
  arrangementClips: { index: number; name: string }[];
  clipSlots: { index: number; hasClip: boolean; clipName: string | null }[];
  takeLanes: { index: number; name: string }[];
  hasMixer: boolean;
}

/**
 * Build the shallow {@link TrackDetail} from an already-resolved track object.
 * This is the single source of truth for the `live_get_track` payload AND the
 * snapshot's `scopedTrack` block (`../snapshot`). Pure read: SYNC, no
 * `getValue()`, no transaction, no mutation.
 *
 * @param resolved A freshly-resolved track (its `object`, `className`, and
 *                 `canonicalRef`). The object must NOT be cached across calls (§6).
 */
export function buildTrackDetail<V extends ApiVersion>(
  resolved: Resolved<V>
): TrackDetail {
  const track = resolved.object as unknown as Record<string, unknown>;
  const groupTrack = getObject(track, "groupTrack");
  return {
    ref: resolved.canonicalRef,
    className: resolved.className,
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
}

// ---------------------------------------------------------------------------
// live_get_project
// ---------------------------------------------------------------------------

/**
 * `live_get_project` — the project header: tempo, scale, grid, and shallow lists
 * of tracks / scenes / cue points / return tracks / the main track (§8.1). Reads
 * `song.*` directly off the freshly-read song; names + indices ground every ref.
 * Delegates shape construction to {@link buildProjectHeader} (shared with the
 * snapshot serializer).
 */
export function executeGetProject<V extends ApiVersion>(
  ctx: ExtensionContext<V>,
  call: ToolCall
): ToolResultPayload {
  try {
    return ok(call.id, buildProjectHeader(ctx), "read project");
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
 * Delegates shape construction to {@link buildTrackDetail} (shared with the
 * snapshot serializer).
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
    return ok(call.id, buildTrackDetail(resolved.resolved), "read track");
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
// live_render_audio (§8.1, §14, §16)
// ---------------------------------------------------------------------------

/**
 * True if a resolver `className` denotes an **audio** track. Render is
 * AudioTrack-only (the SDK's `renderPreFxAudio` takes an `AudioTrack`), so a
 * `MidiTrack` — or the base `"Track"` fallback the test fake reports for
 * generic tracks — is refused. The real SDK reports the concrete subtype.
 */
function isAudioTrackClass(className: string): boolean {
  return className === "AudioTrack";
}

/**
 * `live_render_audio` — render a region of an AudioTrack to a temporary pre-FX
 * WAV and return its path (§8.1, §14). A READ tool: it runs immediately in the
 * read partition and opens NO transaction (the render is a side-effecting read,
 * not an undoable model edit).
 *
 * The `track` ref is re-resolved FRESH (§6); it must resolve to an `AudioTrack`
 * (a `MidiTrack` is refused with a structured `unsupported`, never a fake path,
 * §9). `startTime`/`endTime` cross the boundary in **beats** (§16) and are passed
 * STRAIGHT THROUGH to `renderPreFxAudio` (which is itself beats-native) — no
 * seconds conversion happens at the SDK boundary. The reported `durationSeconds`
 * is a convenience derived from the rendered span and the song tempo (§16). The
 * SDK call is wrapped in try/catch → structured `sdk_error`; it never throws (§9).
 */
export async function executeRenderAudio<V extends ApiVersion>(
  ctx: ExtensionContext<V>,
  call: ToolCall
): Promise<ToolResultPayload> {
  if (!isRecord(call.input)) {
    return fail(
      call.id,
      invalidArgs("expected an object with 'track', 'startTime', 'endTime'")
    );
  }
  const ref = readString(call.input, "track");
  if (ref === null) {
    return fail(call.id, invalidArgs("'track' must be a ref string"));
  }
  const startTime = readNumber(call.input, "startTime");
  if (startTime === null) {
    return fail(
      call.id,
      invalidArgs("'startTime' must be a finite number (beats)")
    );
  }
  const endTime = readNumber(call.input, "endTime");
  if (endTime === null) {
    return fail(
      call.id,
      invalidArgs("'endTime' must be a finite number (beats)")
    );
  }
  if (endTime <= startTime) {
    return fail(
      call.id,
      invalidArgs("'endTime' must be greater than 'startTime' (beats)")
    );
  }
  const resolved = resolveOrFail(ctx, ref);
  if (!resolved.ok) {
    return fail(call.id, resolved.err);
  }
  if (!isAudioTrackClass(resolved.resolved.className)) {
    return fail(
      call.id,
      unsupported(
        `render needs an audio track; "${ref}" resolved to ${resolved.resolved.className}`,
        "target an AudioTrack; MIDI tracks carry no renderable pre-FX audio"
      )
    );
  }
  try {
    // Pass beats straight through — `renderPreFxAudio` is beats-native (§16).
    const path = await ctx.resources.renderPreFxAudio(
      resolved.resolved.object as unknown as AudioTrack<V>,
      startTime,
      endTime
    );
    const tempo = getNumber(ctx.application.song, "tempo") ?? 120;
    return ok(
      call.id,
      {
        path,
        track: resolved.resolved.canonicalRef,
        startBeats: startTime,
        endBeats: endTime,
        durationSeconds: beatsToSeconds(endTime - startTime, tempo),
      },
      "render audio"
    );
  } catch (e) {
    return fail(
      call.id,
      sdkError(`render of "${ref}" failed: ${errorMessage(e)}`)
    );
  }
}

// ---------------------------------------------------------------------------
// report_limitation (honesty tool — §8.3, §9)
// ---------------------------------------------------------------------------

/**
 * `report_limitation` — the honesty tool (§8.3, §9). It makes NO Live change and
 * claims none: it simply acknowledges that a requested capability is unsupported
 * and echoes back the reason + the closest supported alternative, so the agent's
 * "I can't do that, but I can do this" is a first-class, recorded outcome rather
 * than a fake success. Sync (no SDK call); runs immediately in the read partition
 * so it is never queued into a transaction.
 *
 * Validates that `requested` and `reason` are non-empty strings (else
 * `invalid_args`); `alternative` is optional and only echoed when present.
 */
export function executeReportLimitation(call: ToolCall): ToolResultPayload {
  if (!isRecord(call.input)) {
    return fail(
      call.id,
      invalidArgs("expected an object with 'requested' and 'reason'")
    );
  }
  const requested = readString(call.input, "requested");
  if (requested === null || requested.trim() === "") {
    return fail(call.id, invalidArgs("'requested' must be a non-empty string"));
  }
  const reason = readString(call.input, "reason");
  if (reason === null || reason.trim() === "") {
    return fail(call.id, invalidArgs("'reason' must be a non-empty string"));
  }
  const alternativeRaw = optString(call.input, "alternative");
  // `optString` returns `null` only when the key is present with a wrong type;
  // treat that as "no alternative" rather than failing the honesty report.
  const alternative =
    typeof alternativeRaw === "string" && alternativeRaw.trim() !== ""
      ? alternativeRaw
      : undefined;

  return ok(
    call.id,
    {
      acknowledged: true,
      requested,
      reason,
      ...(alternative !== undefined ? { alternative } : {}),
    },
    `limitation reported: ${requested}`
  );
}

// Re-export arg types for callers/tests that want them adjacent to the executors.
export type {
  LiveGetTrackArgs,
  LiveGetClipArgs,
  LiveGetDeviceParamsArgs,
  LiveRenderAudioArgs,
  ReportLimitationArgs,
  Resolved,
};
