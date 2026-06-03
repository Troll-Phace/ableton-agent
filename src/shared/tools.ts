/**
 * Tool surface — JSON Schemas + arg types + classification (Phase 5 Task 1,
 * ARCHITECTURE §8, §14, §15.1).
 *
 * Claude never touches Live directly (§1.1): it emits structured tool calls and
 * the extension executes them. This module is the **single source of truth** for
 * what those tools look like on the wire — one {@link Anthropic.Tool} definition
 * (name + description + JSON `input_schema` + `strict`/`input_examples`) and a
 * matching exported TypeScript arg type per tool — plus the read/mutation
 * {@link classify classification} the agent loop partitions on (§8, §4 step 5c).
 *
 * It is a **pure** shared module: it imports ONLY the `Anthropic` *type* (for
 * `Tool`/`ToolUnion`) and the ref grammar from `./refs.ts`. It touches NO
 * Extensions SDK and NO DOM, so it compiles under the strict shared tsconfig and
 * imports cleanly in the extension host, the (future) webview, and tests.
 *
 * ## Refs are strings here
 * Every parameter that addresses a Live object is a **string ref path** in the
 * `kind:index:name` grammar (`./refs.ts`, §6), e.g.
 * `"track:2:Bass/device:1:Reverb"`. The JSON schema types these as plain
 * `string` with a format-reminding description and `input_examples`; structural
 * validation against the grammar happens in the **executors** (Task 2), never in
 * the schema — the schema cannot express the grammar and the agent re-grounds via
 * the structured `ref_unresolved`/`ref_ambiguous` errors (§6).
 *
 * ## `strict` + `input_examples`
 * The installed `@anthropic-ai/sdk` (v0.100.1) types `strict?: boolean` and
 * `input_examples?: Array<{ [k: string]: unknown }>` directly on the **stable**
 * `Anthropic.Tool` interface (no beta type, no cast needed). Per §8 every
 * **mutating** tool sets `strict: true`; read tools omit it (they are cacheable
 * and not value-critical). `input_examples` are attached where the format is
 * fiddly (ref strings, MIDI note arrays, loop settings, param targets).
 *
 * ## No `cache_control` here
 * `claude-client.ts` stamps `cache_control` on the LAST tool of the array it
 * sends (§15.1). These definitions therefore carry NO `cache_control` of their
 * own — adding it here would create a second, wrong breakpoint.
 */

import type Anthropic from "@anthropic-ai/sdk";

import type { MixerParamSelector } from "./refs.js";

// ---------------------------------------------------------------------------
// Enums / shared value types mirrored from the SDK (§14)
//
// These MUST NOT import the Extensions SDK (purity). They mirror the SDK's
// values/shapes as plain TS so the wire schema stays faithful; the executors
// (Task 2) map them onto the real SDK enums/types.
// ---------------------------------------------------------------------------

/**
 * Ableton warp algorithm, mirroring the SDK `WarpMode` enum **by value**
 * (§14). Note the gap: there is no `5` (ComplexPro is `6`). Exposed to the
 * agent by name; the executor maps name → numeric SDK enum.
 */
export const WARP_MODE_NAMES = [
  "Beats",
  "Tones",
  "Texture",
  "Repitch",
  "Complex",
  "ComplexPro",
] as const;

/** A warp-mode name accepted on the tool boundary. */
export type WarpModeName = (typeof WARP_MODE_NAMES)[number];

/** Numeric value of each warp-mode name (matches the SDK enum, §14). */
export const WARP_MODE_VALUE: Record<WarpModeName, number> = {
  Beats: 0,
  Tones: 1,
  Texture: 2,
  Repitch: 3,
  Complex: 4,
  ComplexPro: 6,
};

/**
 * A single MIDI note as it crosses the tool boundary — mirrors the SDK
 * `NoteDescription` (§14). All times are in **beats** (§16 units): `startTime`
 * is the note's position, `duration` its length. `pitch` is the MIDI note
 * number (0–127). Optional fields default in the executor when omitted.
 */
export interface NoteDescriptionArg {
  /** MIDI note number, 0–127. */
  pitch: number;
  /** Note start position, in beats. */
  startTime: number;
  /** Note length, in beats. */
  duration: number;
  /** MIDI velocity 0–127 (executor defaults when omitted). */
  velocity?: number;
  /** Whether the note is muted. */
  muted?: boolean;
  /** Per-note trigger probability, 0–1. */
  probability?: number;
  /** Random velocity spread. */
  velocityDeviation?: number;
  /** MIDI release velocity 0–127. */
  releaseVelocity?: number;
  /** Whether the note is selected in the editor. */
  selected?: boolean;
}

/**
 * Create-time loop/region settings for a new clip — mirrors the SDK
 * `ClipLoopSettings` (§14). Loop/start/end markers are **read-only after a clip
 * exists**; they can be set ONLY here, at creation (§9). All values in beats.
 */
export interface ClipLoopSettingsArg {
  looping: boolean;
  /** In beats. */
  startMarker: number;
  /** In beats. */
  endMarker: number;
  /** In beats. */
  loopStart: number;
  /** In beats. */
  loopEnd: number;
}

// ---------------------------------------------------------------------------
// Per-tool exported arg types
//
// One interface/type per tool, mirroring the §8 param tables. Ref-typed fields
// are `string` (the §6 grammar, validated in executors). Discriminators use
// string-literal unions; option bags use optional members so partial updates
// are expressible.
// ---------------------------------------------------------------------------

// ----- §8.1 Read / context tools -----

/** `live_get_project` — no parameters; reads `song.*`. */
export type LiveGetProjectArgs = Record<string, never>;

/** `live_get_track` — read one track's contents (§8.1). */
export interface LiveGetTrackArgs {
  /** Ref to the track, e.g. `"track:2:Bass"`. */
  track: string;
}

/** `live_get_clip` — read one clip (§8.1). */
export interface LiveGetClipArgs {
  /** Ref to the clip, e.g. `"track:2:Bass/clip:0:Verse"`. */
  clip: string;
}

/** `live_get_device_params` — read a device's parameter list (§8.1). */
export interface LiveGetDeviceParamsArgs {
  /** Ref to the device, e.g. `"track:2:Bass/device:1:Reverb"`. */
  device: string;
}

/**
 * `live_render_audio` — pre-FX render of an AudioTrack region to a temp WAV
 * (§8.1, §14). `startTime`/`endTime` are in **beats** (§16); the executor
 * converts to the seconds the render API needs.
 */
export interface LiveRenderAudioArgs {
  /** Ref to the audio track to render. */
  track: string;
  /** Region start, in beats. */
  startTime: number;
  /** Region end, in beats. */
  endTime: number;
}

// ----- §8.2 Mutation tools -----

/** `live_update_track` — set track name/mute/solo/arm (§8.2). */
export interface LiveUpdateTrackArgs {
  /** Ref to the track. */
  track: string;
  name?: string;
  mute?: boolean;
  solo?: boolean;
  arm?: boolean;
}

/** `live_update_clip` — set clip name/color/loop/warp flags (§8.2). */
export interface LiveUpdateClipArgs {
  /** Ref to the clip. */
  clip: string;
  name?: string;
  /** Packed 0xRRGGBB integer color. */
  color?: number;
  looping?: boolean;
  muted?: boolean;
  /** Audio clips only. */
  warping?: boolean;
  /** Audio clips only; a {@link WarpModeName}. */
  warpMode?: WarpModeName;
}

/** Action discriminator for {@link LiveEditMidiNotesArgs} (§8.2). */
export type MidiNoteOp =
  | "replace"
  | "transpose"
  | "quantize"
  | "humanize"
  | "filter";

/**
 * `live_edit_midi_notes` — read → transform → write a MIDI clip's notes (§8.2).
 * `op` selects the transform; the relevant sibling field carries its argument.
 * `filter` is destructive (§8.2, gated in §9/§13). Times are in **beats**.
 */
export interface LiveEditMidiNotesArgs {
  /** Ref to the MIDI clip. */
  clip: string;
  /** Which transform to apply. */
  op: MidiNoteOp;
  /** `op:"replace"` — the full replacement note set. */
  notes?: NoteDescriptionArg[];
  /** `op:"transpose"` — semitone offset (may be negative). */
  semitones?: number;
  /** `op:"quantize"` — grid in beats to snap note starts to (e.g. 0.25). */
  grid?: number;
  /** `op:"quantize"` — snap strength 0–1 (1 = full snap). */
  strength?: number;
  /** `op:"humanize"` — max random timing offset, in beats. */
  timingAmount?: number;
  /** `op:"humanize"` — max random velocity offset, 0–127. */
  velocityAmount?: number;
  /** `op:"filter"` — keep only notes matching these criteria. */
  filter?: {
    /** Inclusive lowest pitch to keep. */
    pitchMin?: number;
    /** Inclusive highest pitch to keep. */
    pitchMax?: number;
    /** Inclusive lowest velocity to keep. */
    velocityMin?: number;
    /** Inclusive highest velocity to keep. */
    velocityMax?: number;
  };
}

/** Mixer-param selector on the tool boundary; mirrors {@link MixerParamSelector}. */
export type MixerParamArg =
  | { kind: "volume" }
  | { kind: "pan" }
  | { kind: "send"; index: number };

/**
 * Target of {@link LiveSetParamArgs}: either a device parameter (by device ref +
 * param ref) or a mixer parameter (by track ref + mixer selector). A
 * discriminated union keyed on `type`.
 */
export type SetParamTarget =
  | {
      type: "device";
      /** Ref to the device. */
      device: string;
      /** Ref to the parameter, e.g. `".../param:7:Decay"`. */
      param: string;
    }
  | {
      type: "mixer";
      /** Ref to the track whose mixer is targeted. */
      track: string;
      /** Which mixer parameter (volume | pan | send[i]). */
      mixer: MixerParamArg;
    };

/**
 * `live_set_param` — set a **static** value on a device or mixer parameter
 * (§8.2). NOT automation (§9): one value, clamped/quantized in the executor to
 * the parameter's `min…max`/`valueItems`. `value` is the raw parameter value.
 */
export interface LiveSetParamArgs {
  /** What to set (device param or mixer param). */
  target: SetParamTarget;
  /** The raw value (executor clamps/quantizes to the param's domain). */
  value: number;
}

/** Object kind to create via {@link LiveCreateArgs} (§8.2). */
export type CreateKind =
  | "audio_track"
  | "midi_track"
  | "scene"
  | "cue_point"
  | "take_lane";

/**
 * `live_create` — create a track / scene / cue point / take lane (§8.2). Fields
 * apply per `kind`; `name` names any kind (applied right after creation via a
 * second transaction, create-then-configure §7), `index` positions a SCENE only,
 * `takeLaneTrack` anchors a take lane to its track.
 */
export interface LiveCreateArgs {
  /** What to create. */
  kind: CreateKind;
  /**
   * Insertion index — **scene only** (`-1`/omitted appends). The SDK has no
   * positional insert for tracks or take lanes; an `index` supplied for those is
   * ignored (reported as an honest note in the result, never silently dropped).
   */
  index?: number;
  /** Optional name for the created object (applied right after creation). */
  name?: string;
  /** `kind:"take_lane"` — ref to the track the lane belongs to. */
  takeLaneTrack?: string;
  /** `kind:"cue_point"` — position in beats. */
  time?: number;
}

/** Clip media type for {@link LiveCreateClipArgs} (§8.2). */
export type CreateClipType = "midi" | "audio";

/**
 * `live_create_clip` — create a MIDI or audio clip at a location (§8.2). The
 * `location` is a ref to a track, clip slot, or take lane. Markers are set ONLY
 * here, via `loopSettings` (read-only afterward, §9). Times are in **beats**.
 */
export interface LiveCreateClipArgs {
  /** Ref to the destination track / clip slot / take lane. */
  location: string;
  /** Media type. */
  type: CreateClipType;
  /** Clip start position, in beats (arrangement clips). */
  startTime?: number;
  /** MIDI clip length, in beats. */
  duration?: number;
  /** `type:"audio"` — managed file path (from `live_import_audio`). */
  filePath?: string;
  /** `type:"audio"` — whether the clip is warped. */
  isWarped?: boolean;
  /** Create-time loop/region settings (the only place markers are set). */
  loopSettings?: ClipLoopSettingsArg;
}

/**
 * `live_insert_device` — insert a **built-in Live device** by name (§8.2). The
 * executor validates the name against the built-in set and returns a structured
 * error for third-party / unknown names (§9 — no plugins). `location` is a ref
 * to a track or chain; `index` is the insertion position.
 */
export interface LiveInsertDeviceArgs {
  /** Ref to the track or chain to insert into. */
  location: string;
  /** Built-in Live device name (validated in the executor). */
  deviceName: string;
  /** Insertion index in the device chain. */
  index: number;
}

/** Operation for {@link LiveModifyDeviceChainArgs} (§8.2). */
export type DeviceChainOp = "duplicate" | "insert_chain";

/**
 * `live_modify_device_chain` — duplicate a device or insert a chain (§8.2).
 * Destructive surface lives in §13; this Phase-5 schema only defines the shape.
 */
export interface LiveModifyDeviceChainArgs {
  /** Ref to the device / rack to modify. */
  location: string;
  /** Which structural edit to perform. */
  op: DeviceChainOp;
  /** `op:"duplicate"` — ref to the device to duplicate. */
  device?: string;
  /** Insertion index for the new chain/device. */
  index?: number;
}

/** `live_replace_sample` — swap the sample loaded in a Simpler (§8.2). */
export interface LiveReplaceSampleArgs {
  /** Ref to the Simpler device. */
  simpler: string;
  /** Managed file path of the replacement sample. */
  filePath: string;
}

/**
 * `live_delete` — delete a track / scene / cue point / clip / device (§8.2).
 * **Destructive** (§8.2 `D`); gated by the confirmation flow in §9/§13. The
 * executor routes by the resolved object's kind, so a single `target` ref
 * suffices.
 */
export interface LiveDeleteArgs {
  /** Ref to the object to delete. */
  target: string;
}

// ----- §8.3 Side-effect tools -----

/**
 * `live_import_audio` — import a local path or URL into the project (§8.3).
 * URLs are fetched to the temp dir then imported; returns the managed path. It
 * mutates project state, so it classifies as a **mutation** (see {@link classify}).
 */
export interface LiveImportAudioArgs {
  /** A local file path or an `http(s)` URL. */
  source: string;
}

// ---------------------------------------------------------------------------
// Tool names + classification
// ---------------------------------------------------------------------------

/**
 * Every tool name defined in this module, in §8 order (reads, then mutations,
 * then the side-effect tool). `report_limitation` is intentionally absent — it
 * is Phase 6's job.
 */
export const TOOL_NAMES = [
  // §8.1 read
  "live_get_project",
  "live_get_track",
  "live_get_clip",
  "live_get_device_params",
  "live_render_audio",
  // §8.2 mutation
  "live_update_track",
  "live_update_clip",
  "live_edit_midi_notes",
  "live_set_param",
  "live_create",
  "live_create_clip",
  "live_insert_device",
  "live_modify_device_chain",
  "live_replace_sample",
  "live_delete",
  // §8.3 side-effect (classified as mutation)
  "live_import_audio",
] as const;

/** The union of all tool name string literals defined here. */
export type ToolName = (typeof TOOL_NAMES)[number];

/** A set of all tool names, for O(1) membership checks. */
export const TOOL_NAME_SET: ReadonlySet<string> = new Set<string>(TOOL_NAMES);

/** Whether a string is one of this module's tool names. */
export function isToolName(name: string): name is ToolName {
  return TOOL_NAME_SET.has(name);
}

/** How the agent loop treats a tool: read (immediate) vs mutation (batched, §4/§8). */
export type ToolClass = "read" | "mutation";

/**
 * Tool → {@link ToolClass}. Reads = §8.1 (`live_get_*`, `live_render_audio`).
 * Mutations = §8.2 plus `live_import_audio` (§8.3 — it changes project state, so
 * the loop batches it like a mutation). The map is exhaustive over {@link ToolName}
 * (a missing entry is a compile error), so the loop can classify by lookup.
 */
export const TOOL_CLASS: Record<ToolName, ToolClass> = {
  // §8.1 read
  live_get_project: "read",
  live_get_track: "read",
  live_get_clip: "read",
  live_get_device_params: "read",
  live_render_audio: "read",
  // §8.2 mutation
  live_update_track: "mutation",
  live_update_clip: "mutation",
  live_edit_midi_notes: "mutation",
  live_set_param: "mutation",
  live_create: "mutation",
  live_create_clip: "mutation",
  live_insert_device: "mutation",
  live_modify_device_chain: "mutation",
  live_replace_sample: "mutation",
  live_delete: "mutation",
  // §8.3 side-effect → mutation
  live_import_audio: "mutation",
};

/**
 * Classify a tool by name as `"read"` or `"mutation"` (the {@link ToolRuntime}
 * seam the agent loop calls, ARCHITECTURE §4 step 5c). Unknown names default to
 * `"mutation"` — the safe side: an unrecognized call is batched + abort-gated
 * rather than run eagerly. (In practice the loop only ever passes names from
 * {@link TOOL_NAMES}.)
 */
export function classify(toolName: string): ToolClass {
  return isToolName(toolName) ? TOOL_CLASS[toolName] : "mutation";
}

// ---------------------------------------------------------------------------
// JSON-schema fragment helpers (keep the definitions DRY + readable)
// ---------------------------------------------------------------------------

/** A `string` property whose value is a §6 semantic ref path. */
function refProp(description: string): Record<string, unknown> {
  return {
    type: "string",
    description: `${description} A semantic ref path in the kind:index:name grammar, e.g. "track:2:Bass/device:1:Reverb".`,
  };
}

/** A `number` property whose value is a time in beats. */
function beatsProp(description: string): Record<string, unknown> {
  return { type: "number", description: `${description} In beats.` };
}

/** The JSON-schema fragment for one optional MIDI {@link NoteDescriptionArg}. */
const NOTE_DESCRIPTION_SCHEMA: Record<string, unknown> = {
  type: "object",
  description: "A single MIDI note. Times are in beats.",
  properties: {
    pitch: { type: "integer", minimum: 0, maximum: 127 },
    startTime: { type: "number", description: "Start position, in beats." },
    duration: { type: "number", description: "Length, in beats." },
    velocity: { type: "integer", minimum: 0, maximum: 127 },
    muted: { type: "boolean" },
    probability: { type: "number", minimum: 0, maximum: 1 },
    velocityDeviation: { type: "number" },
    releaseVelocity: { type: "integer", minimum: 0, maximum: 127 },
    selected: { type: "boolean" },
  },
  required: ["pitch", "startTime", "duration"],
  additionalProperties: false,
};

/** The JSON-schema fragment for create-time {@link ClipLoopSettingsArg}. */
const CLIP_LOOP_SETTINGS_SCHEMA: Record<string, unknown> = {
  type: "object",
  description:
    "Create-time loop/region settings. Markers are read-only after creation; this is the only place to set them. All values in beats.",
  properties: {
    looping: { type: "boolean" },
    startMarker: { type: "number" },
    endMarker: { type: "number" },
    loopStart: { type: "number" },
    loopEnd: { type: "number" },
  },
  required: ["looping", "startMarker", "endMarker", "loopStart", "loopEnd"],
  additionalProperties: false,
};

/** The JSON-schema fragment for the mixer-param selector {@link MixerParamArg}. */
const MIXER_PARAM_SCHEMA: Record<string, unknown> = {
  type: "object",
  description: "Which mixer parameter to target.",
  oneOf: [
    {
      type: "object",
      properties: { kind: { const: "volume" } },
      required: ["kind"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { kind: { const: "pan" } },
      required: ["kind"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "send" },
        index: { type: "integer", minimum: 0 },
      },
      required: ["kind", "index"],
      additionalProperties: false,
    },
  ],
};

// ---------------------------------------------------------------------------
// Tool definitions (§8)
//
// `read*` builders omit `strict` (cacheable, not value-critical); `mutation*`
// builders set `strict: true` (§8). No `cache_control` anywhere — the client
// stamps the final breakpoint (§15.1).
// ---------------------------------------------------------------------------

/** Build a read tool definition (no `strict`, per §8). */
function readTool(
  name: ToolName,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  inputExamples?: Array<Record<string, unknown>>
): Anthropic.Tool {
  const tool: Anthropic.Tool = {
    name,
    description,
    input_schema: { type: "object", properties, required },
  };
  if (inputExamples !== undefined) {
    tool.input_examples = inputExamples;
  }
  return tool;
}

/** Build a mutating tool definition (`strict: true`, per §8). */
function mutationTool(
  name: ToolName,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  inputExamples?: Array<Record<string, unknown>>
): Anthropic.Tool {
  const tool: Anthropic.Tool = {
    name,
    description,
    input_schema: { type: "object", properties, required },
    strict: true,
  };
  if (inputExamples !== undefined) {
    tool.input_examples = inputExamples;
  }
  return tool;
}

// ----- §8.1 read tools -----

const liveGetProject = readTool(
  "live_get_project",
  "Read the project header: tempo, scale, grid, and the lists of tracks, scenes, cue points, return tracks, and the main track. Call this first to ground every ref.",
  {},
  []
);

const liveGetTrack = readTool(
  "live_get_track",
  "Read one track's contents: devices, arrangement clips, clip slots, take lanes, mixer, and mute/solo/arm/group state.",
  { track: refProp("The track to read.") },
  ["track"],
  [{ track: "track:2:Bass" }]
);

const liveGetClip = readTool(
  "live_get_clip",
  "Read one clip. MIDI clips return their notes; audio clips return warp settings and file path.",
  { clip: refProp("The clip to read.") },
  ["clip"],
  [{ clip: "track:2:Bass/clip:0:Verse" }]
);

const liveGetDeviceParams = readTool(
  "live_get_device_params",
  "Read a device's parameters: each parameter's name, current value, min, max, whether it is quantized, and its value items.",
  { device: refProp("The device to read.") },
  ["device"],
  [{ device: "track:2:Bass/device:1:Reverb" }]
);

const liveRenderAudio = readTool(
  "live_render_audio",
  "Render a region of an audio track to a temporary pre-FX WAV file and return its path. Times are in beats.",
  {
    track: refProp("The audio track to render."),
    startTime: beatsProp("Region start."),
    endTime: beatsProp("Region end."),
  },
  ["track", "startTime", "endTime"],
  [{ track: "track:0:Drums", startTime: 0, endTime: 16 }]
);

// ----- §8.2 mutation tools -----

const liveUpdateTrack = mutationTool(
  "live_update_track",
  "Set one or more of a track's name, mute, solo, or arm state. Provide only the fields to change.",
  {
    track: refProp("The track to update."),
    name: { type: "string" },
    mute: { type: "boolean" },
    solo: { type: "boolean" },
    arm: { type: "boolean" },
  },
  ["track"],
  [{ track: "track:2:Bass", name: "Sub Bass", mute: false }]
);

const liveUpdateClip = mutationTool(
  "live_update_clip",
  "Set one or more of a clip's name, color, loop/mute flags, or (audio clips only) warping and warp mode. Provide only the fields to change. Color is a packed 0xRRGGBB integer.",
  {
    clip: refProp("The clip to update."),
    name: { type: "string" },
    color: { type: "integer", description: "Packed 0xRRGGBB color." },
    looping: { type: "boolean" },
    muted: { type: "boolean" },
    warping: { type: "boolean", description: "Audio clips only." },
    warpMode: {
      type: "string",
      enum: [...WARP_MODE_NAMES],
      description: "Audio clips only.",
    },
  },
  ["clip"],
  [{ clip: "track:2:Bass/clip:0:Verse", name: "Verse A", looping: true }]
);

const liveEditMidiNotes = mutationTool(
  "live_edit_midi_notes",
  "Edit a MIDI clip's notes. Choose op: 'replace' (provide the full notes array), 'transpose' (semitones), 'quantize' (snap note starts to a grid; this is grid quantize only, not groove), 'humanize' (randomize timing/velocity), or 'filter' (keep only notes matching criteria; destructive). Times are in beats.",
  {
    clip: refProp("The MIDI clip to edit."),
    op: {
      type: "string",
      enum: ["replace", "transpose", "quantize", "humanize", "filter"],
    },
    notes: {
      type: "array",
      description: "op='replace': the full replacement note set.",
      items: NOTE_DESCRIPTION_SCHEMA,
    },
    semitones: {
      type: "integer",
      description: "op='transpose': semitone offset (may be negative).",
    },
    grid: {
      type: "number",
      description: "op='quantize': grid in beats to snap note starts to.",
    },
    strength: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "op='quantize': snap strength (1 = full snap).",
    },
    timingAmount: {
      type: "number",
      description: "op='humanize': max random timing offset, in beats.",
    },
    velocityAmount: {
      type: "number",
      description: "op='humanize': max random velocity offset, 0-127.",
    },
    filter: {
      type: "object",
      description: "op='filter': keep only notes within these ranges.",
      properties: {
        pitchMin: { type: "integer", minimum: 0, maximum: 127 },
        pitchMax: { type: "integer", minimum: 0, maximum: 127 },
        velocityMin: { type: "integer", minimum: 0, maximum: 127 },
        velocityMax: { type: "integer", minimum: 0, maximum: 127 },
      },
      additionalProperties: false,
    },
  },
  ["clip", "op"],
  [
    {
      clip: "track:1:Keys/clip:0:Chords",
      op: "replace",
      notes: [
        { pitch: 60, startTime: 0, duration: 1, velocity: 100 },
        { pitch: 64, startTime: 0, duration: 1, velocity: 100 },
        { pitch: 67, startTime: 0, duration: 1, velocity: 100 },
      ],
    },
    { clip: "track:1:Keys/clip:0:Chords", op: "transpose", semitones: 12 },
    {
      clip: "track:1:Keys/clip:0:Chords",
      op: "quantize",
      grid: 0.25,
      strength: 1,
    },
  ]
);

const liveSetParam = mutationTool(
  "live_set_param",
  "Set a STATIC value on a device parameter or a mixer parameter (volume/pan/send). This is a single value, NOT automation — there is no automation API. The value is clamped/quantized to the parameter's range.",
  {
    target: {
      type: "object",
      description:
        "What to set: a device parameter, or a track mixer parameter.",
      oneOf: [
        {
          type: "object",
          properties: {
            type: { const: "device" },
            device: refProp("The device."),
            param: refProp("The parameter."),
          },
          required: ["type", "device", "param"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            type: { const: "mixer" },
            track: refProp("The track whose mixer is targeted."),
            mixer: MIXER_PARAM_SCHEMA,
          },
          required: ["type", "track", "mixer"],
          additionalProperties: false,
        },
      ],
    },
    value: { type: "number", description: "The raw parameter value." },
  },
  ["target", "value"],
  [
    {
      target: {
        type: "device",
        device: "track:2:Bass/device:1:Reverb",
        param: "track:2:Bass/device:1:Reverb/param:7:Decay",
      },
      value: 0.5,
    },
    {
      target: {
        type: "mixer",
        track: "track:2:Bass",
        mixer: { kind: "send", index: 0 },
      },
      value: 0.25,
    },
  ]
);

const liveCreate = mutationTool(
  "live_create",
  "Create a new object: an audio track, MIDI track, scene, cue point, or take lane. 'name' names any kind (applied right after creation). 'index' positions a SCENE only (the SDK has no positional insert for tracks/take lanes — new tracks are appended, so 'index' is ignored for them). 'takeLaneTrack' anchors a take lane to its track; 'time' (beats) positions a cue point.",
  {
    kind: {
      type: "string",
      enum: ["audio_track", "midi_track", "scene", "cue_point", "take_lane"],
    },
    index: {
      type: "integer",
      minimum: 0,
      description:
        "scene only: insertion index (-1 or omitted appends). Ignored for tracks/take lanes.",
    },
    name: { type: "string" },
    takeLaneTrack: refProp("take_lane: the track the lane belongs to."),
    time: { type: "number", description: "cue_point: position in beats." },
  },
  ["kind"],
  [
    { kind: "midi_track", name: "Lead" },
    { kind: "scene", name: "Drop", index: 2 },
    { kind: "take_lane", takeLaneTrack: "track:2:Bass", name: "Comp" },
  ]
);

const liveCreateClip = mutationTool(
  "live_create_clip",
  "Create a MIDI or audio clip at a location (a track, clip slot, or take lane). Markers can be set ONLY here via loopSettings (they are read-only after the clip exists). Times are in beats.",
  {
    location: refProp("The destination track, clip slot, or take lane."),
    type: { type: "string", enum: ["midi", "audio"] },
    startTime: { type: "number", description: "Start position, in beats." },
    duration: {
      type: "number",
      description: "MIDI clip length, in beats.",
    },
    filePath: {
      type: "string",
      description: "audio: managed file path from live_import_audio.",
    },
    isWarped: { type: "boolean", description: "audio: whether warped." },
    loopSettings: CLIP_LOOP_SETTINGS_SCHEMA,
  },
  ["location", "type"],
  [
    {
      location: "track:1:Keys/clipSlot:0",
      type: "midi",
      duration: 4,
    },
    {
      location: "track:0:Drums",
      type: "audio",
      filePath: "/managed/temp/loop.wav",
      isWarped: true,
      loopSettings: {
        looping: true,
        startMarker: 0,
        endMarker: 4,
        loopStart: 0,
        loopEnd: 4,
      },
    },
  ]
);

const liveInsertDevice = mutationTool(
  "live_insert_device",
  "Insert a BUILT-IN Live device by name into a track or chain at a given index. Third-party plugins are NOT supported; an unknown or non-built-in name returns an error.",
  {
    location: refProp("The track or chain to insert into."),
    deviceName: {
      type: "string",
      description: "A built-in Live device name (e.g. 'Reverb', 'EQ Eight').",
    },
    index: { type: "integer", minimum: 0 },
  },
  ["location", "deviceName", "index"],
  [{ location: "track:2:Bass", deviceName: "EQ Eight", index: 0 }]
);

const liveModifyDeviceChain = mutationTool(
  "live_modify_device_chain",
  "Modify a device chain: 'duplicate' an existing device, or 'insert_chain' into a rack. Provide the device ref for duplicate, and an index where applicable.",
  {
    location: refProp("The device or rack to modify."),
    op: { type: "string", enum: ["duplicate", "insert_chain"] },
    device: refProp("duplicate: the device to duplicate."),
    index: { type: "integer", minimum: 0 },
  },
  ["location", "op"],
  [
    {
      location: "track:2:Bass/device:0:Rack",
      op: "insert_chain",
      index: 1,
    },
  ]
);

const liveReplaceSample = mutationTool(
  "live_replace_sample",
  "Replace the sample loaded in a Simpler device with the file at the given managed path.",
  {
    simpler: refProp("The Simpler device."),
    filePath: {
      type: "string",
      description: "Managed file path of the replacement sample.",
    },
  },
  ["simpler", "filePath"],
  [
    {
      simpler: "track:3:Drums/device:0:Simpler",
      filePath: "/managed/temp/kick.wav",
    },
  ]
);

const liveDelete = mutationTool(
  "live_delete",
  "Delete an object: a track, scene, cue point, clip, or device. The kind is inferred from the ref. This is destructive and requires confirmation.",
  { target: refProp("The object to delete.") },
  ["target"],
  [{ target: "track:4:Old Take" }]
);

// ----- §8.3 side-effect tool -----

const liveImportAudio = mutationTool(
  "live_import_audio",
  "Import audio into the project from a local file path or an http(s) URL. URLs are downloaded first. Returns the managed path to reference in a clip.",
  {
    source: {
      type: "string",
      description: "A local file path or an http(s) URL.",
    },
  },
  ["source"],
  [{ source: "https://example.com/loop.wav" }]
);

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * All tool definitions in §8 order. The registry in Task 2 returns this (with
 * the client's per-array `cache_control` stamp applied downstream, §15.1) from
 * `ToolRuntime.toolDefinitions()` as `Anthropic.ToolUnion[]` — `Tool` is a
 * member of that union, so this array is assignable without widening.
 *
 * Order matters only cosmetically; the client stamps the LAST element's
 * `cache_control` (§15.1), so do not append non-tool entries here.
 */
export const TOOL_DEFINITIONS: readonly Anthropic.Tool[] = [
  // §8.1 read
  liveGetProject,
  liveGetTrack,
  liveGetClip,
  liveGetDeviceParams,
  liveRenderAudio,
  // §8.2 mutation
  liveUpdateTrack,
  liveUpdateClip,
  liveEditMidiNotes,
  liveSetParam,
  liveCreate,
  liveCreateClip,
  liveInsertDevice,
  liveModifyDeviceChain,
  liveReplaceSample,
  liveDelete,
  // §8.3 side-effect
  liveImportAudio,
];

/**
 * Tool name → its definition, for O(1) lookup by the registry/executors. Keyed
 * by {@link ToolName} so every name resolves to its {@link Anthropic.Tool}.
 */
export const TOOL_BY_NAME: Readonly<Record<ToolName, Anthropic.Tool>> =
  Object.fromEntries(
    TOOL_DEFINITIONS.map((tool) => [tool.name, tool])
  ) as Record<ToolName, Anthropic.Tool>;

/**
 * Compile-time proof that {@link MixerParamArg} stays in lockstep with the ref
 * grammar's {@link MixerParamSelector}: both must cover volume / pan / send. If
 * one gains a member the other lacks, these assignments fail to compile. (Field
 * names differ — `selector`/`sendIndex` in refs vs `kind`/`index` on the tool
 * boundary — so we map the discriminant, not assign the shapes directly.)
 */
type _MixerSelectorKinds = MixerParamSelector["selector"];
type _MixerArgKinds = MixerParamArg["kind"];
const _mixerKindsAligned: _MixerSelectorKinds extends _MixerArgKinds
  ? _MixerArgKinds extends _MixerSelectorKinds
    ? true
    : never
  : never = true;
void _mixerKindsAligned;
