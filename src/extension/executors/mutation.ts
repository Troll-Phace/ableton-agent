/**
 * Mutation executors (Phase 5 Task 4, ARCHITECTURE §8.2, §7, §6, §9, §16).
 *
 * Each maps a mutating tool to the SDK write surface, re-resolving every ref to a
 * FRESH object first (§6), then producing a {@link MutationPlan} the registry
 * flushes inside ONE `withinTransaction` per turn-batch (§7, one undo step).
 *
 * ## The two-phase plan (single-transaction discipline, §7)
 * A mutation executor runs in two phases:
 *  1. **prepare** (async, OUTSIDE the transaction): validate args, re-resolve refs,
 *     read any current state it needs (e.g. read notes before transforming, read a
 *     param's min/max before clamping). Returns either an error payload or a
 *     {@link MutationPlan} whose `run()` is purely synchronous-launch.
 *  2. **run** (sync, INSIDE the transaction): apply sync setters and *launch* async
 *     SDK ops, returning their promises. The registry collects every plan's promises
 *     and `return Promise.all([...])` from the single transaction callback — so we
 *     NEVER `await` inside the callback (§7) and still group the whole batch into
 *     one undo step.
 *
 * `run()` returns `{ promise?, finalize }`: `finalize(resolvedValue)` builds the
 * `tool_result` payload after the transaction resolves (so creates can mint the new
 * object's fresh ref from its actual position, §6, and return it to the agent).
 *
 * ## Honesty (§9)
 * Unsupported requests fail loudly (never a fake success): automation has no API
 * (`live_set_param` is a STATIC value), markers are create-time only, audio tools
 * are deferred to Phase 14, and the SDK rejects unknown (third-party) device names.
 */

import {
  AudioClip,
  AudioTrack,
  Chain,
  Clip,
  ClipSlot,
  CuePoint,
  Device,
  DeviceParameter,
  MidiClip,
  MidiTrack,
  RackDevice,
  Scene,
  TakeLane,
  Track,
  WarpMode,
  type ApiVersion,
  type ExtensionContext,
  type NoteDescription,
} from "@ableton-extensions/sdk";

import type { ToolCall, ToolResultPayload } from "../agent-loop.js";
import { ReferenceTable, type RefError } from "../references.js";
import { parseRef, serializeRef, type RefSegment } from "../../shared/refs.js";
import {
  WARP_MODE_VALUE,
  type MidiNoteOp,
  type WarpModeName,
} from "../../shared/tools.js";
import {
  clamp,
  deferred,
  errorMessage,
  fail,
  invalidArgs,
  isRecord,
  ok,
  optBoolean,
  optNumber,
  optString,
  readNumber,
  readString,
  resolveOrFail,
  sdkError,
  unsupported,
  type ExecutorError,
} from "./shared.js";

// ---------------------------------------------------------------------------
// MutationPlan — the transaction-batchable unit
// ---------------------------------------------------------------------------

/**
 * What a prepared mutation executes INSIDE the single transaction. `run()` is
 * synchronous-launch: it applies sync setters and starts async SDK ops, returning
 * an optional `promise` (the launched op) and a `finalize` that turns the resolved
 * value into the `tool_result` payload AFTER the transaction settles.
 */
export interface MutationPlan {
  /**
   * Launch the mutation. Called once, synchronously, inside `withinTransaction`.
   * MUST NOT await. Returns the async op's promise (if any) plus a finalizer.
   */
  run(): {
    /** The launched async SDK op, or `undefined` for sync-only mutations. */
    promise?: Promise<unknown>;
    /**
     * Build the result payload from the (optional) resolved op value. Declared
     * `this: void` (it is always a standalone closure) so callers can destructure
     * it from `run()` without an unbound-method lint.
     */
    finalize(this: void, resolved: unknown): ToolResultPayload;
  };
}

/** A prepared mutation: an early error payload, or a runnable plan. */
export type Prepared =
  | { kind: "error"; payload: ToolResultPayload }
  | { kind: "plan"; plan: MutationPlan };

/** Helper: an early-error {@link Prepared} from a {@link RefError}/{@link ExecutorError}. */
function err(call: ToolCall, e: RefError | ExecutorError): Prepared {
  return { kind: "error", payload: fail(call.id, e) };
}

/** Helper: an early deferred {@link Prepared} (audio tools, Phase 14). */
function deferPrepared(call: ToolCall, what: string): Prepared {
  return { kind: "error", payload: deferred(call.id, what) };
}

/** A sync-only plan: applies `apply()` then finalizes with `result`. */
function syncPlan(
  apply: () => void,
  result: () => ToolResultPayload
): Prepared {
  return {
    kind: "plan",
    plan: {
      run() {
        apply();
        return { finalize: () => result() };
      },
    },
  };
}

/** An async plan: launches `launch()`, finalizes with `result(resolved)`. */
function asyncPlan(
  launch: () => Promise<unknown>,
  result: (resolved: unknown) => ToolResultPayload
): Prepared {
  return {
    kind: "plan",
    plan: {
      run() {
        const promise = launch();
        return { promise, finalize: (resolved) => result(resolved) };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Narrow accessors for setter-bearing SDK objects (no `any`)
// ---------------------------------------------------------------------------

/** A track with the SDK's writable name/mute/solo/arm setters. */
type WritableTrack = {
  name: string;
  mute: boolean;
  solo: boolean;
  arm: boolean;
};

/** A clip with the writable common setters; audio adds warping/warpMode. */
type WritableClip = {
  name: string;
  color: number;
  looping: boolean;
  muted: boolean;
};
type WritableAudioClip = WritableClip & {
  warping: boolean;
  warpMode: WarpMode;
};
type WritableMidiClip = { notes: NoteDescription[] };

/** A DeviceParameter view with the read fields + async setValue. */
interface ParamView {
  min: number;
  max: number;
  isQuantized: boolean;
  valueItems: { name: string }[];
  setValue(value: number): Promise<void>;
}

/** Narrow a resolved object to a {@link ParamView}, or `null`. */
function asParamView(obj: unknown): ParamView | null {
  if (!isRecord(obj) || typeof obj["setValue"] !== "function") {
    return null;
  }
  return obj as unknown as ParamView;
}

// ---------------------------------------------------------------------------
// live_update_track
// ---------------------------------------------------------------------------

/** `live_update_track` — set track name/mute/solo/arm (§8.2). Sync setters. */
export function prepareUpdateTrack<V extends ApiVersion>(
  ctx: ExtensionContext<V>,
  call: ToolCall
): Prepared {
  if (!isRecord(call.input)) {
    return err(call, invalidArgs("expected an object with a 'track' ref"));
  }
  const ref = readString(call.input, "track");
  if (ref === null) {
    return err(call, invalidArgs("'track' must be a ref string"));
  }
  const name = optString(call.input, "name");
  const mute = optBoolean(call.input, "mute");
  const solo = optBoolean(call.input, "solo");
  const arm = optBoolean(call.input, "arm");
  if (name === null) {
    return err(call, invalidArgs("'name' is the wrong type"));
  }
  if (mute === null) {
    return err(call, invalidArgs("'mute' is the wrong type"));
  }
  if (solo === null) {
    return err(call, invalidArgs("'solo' is the wrong type"));
  }
  if (arm === null) {
    return err(call, invalidArgs("'arm' is the wrong type"));
  }
  const resolved = resolveOrFail(ctx, ref);
  if (!resolved.ok) {
    return err(call, resolved.err);
  }
  const track = resolved.resolved.object as unknown as WritableTrack;
  const canonicalRef = resolved.resolved.canonicalRef;
  const applied: string[] = [];
  return syncPlan(
    () => {
      if (name !== undefined) {
        track.name = name;
        applied.push("name");
      }
      if (mute !== undefined) {
        track.mute = mute;
        applied.push("mute");
      }
      if (solo !== undefined) {
        track.solo = solo;
        applied.push("solo");
      }
      if (arm !== undefined) {
        track.arm = arm;
        applied.push("arm");
      }
    },
    () =>
      ok(
        call.id,
        { ref: canonicalRef, updated: applied },
        `update track (${applied.join(", ") || "no-op"})`
      )
  );
}

// ---------------------------------------------------------------------------
// live_update_clip
// ---------------------------------------------------------------------------

/**
 * `live_update_clip` — set clip name/color/looping/muted, and (audio only)
 * warping/warpMode (§8.2). Markers are NOT settable here (read-only post-create,
 * §9). Sync setters.
 */
export function prepareUpdateClip<V extends ApiVersion>(
  ctx: ExtensionContext<V>,
  call: ToolCall
): Prepared {
  if (!isRecord(call.input)) {
    return err(call, invalidArgs("expected an object with a 'clip' ref"));
  }
  const ref = readString(call.input, "clip");
  if (ref === null) {
    return err(call, invalidArgs("'clip' must be a ref string"));
  }
  const name = optString(call.input, "name");
  const color = optNumber(call.input, "color");
  const looping = optBoolean(call.input, "looping");
  const muted = optBoolean(call.input, "muted");
  const warping = optBoolean(call.input, "warping");
  const warpModeName = optString(call.input, "warpMode");
  if (name === null) {
    return err(call, invalidArgs("'name' is the wrong type"));
  }
  if (color === null) {
    return err(call, invalidArgs("'color' is the wrong type"));
  }
  if (looping === null) {
    return err(call, invalidArgs("'looping' is the wrong type"));
  }
  if (muted === null) {
    return err(call, invalidArgs("'muted' is the wrong type"));
  }
  if (warping === null) {
    return err(call, invalidArgs("'warping' is the wrong type"));
  }
  if (warpModeName === null) {
    return err(call, invalidArgs("'warpMode' is the wrong type"));
  }
  let warpModeValue: WarpMode | undefined;
  if (warpModeName !== undefined) {
    if (!(warpModeName in WARP_MODE_VALUE)) {
      return err(
        call,
        invalidArgs(
          `unknown warpMode "${warpModeName}"; expected one of ${Object.keys(
            WARP_MODE_VALUE
          ).join(", ")}`
        )
      );
    }
    warpModeValue = WARP_MODE_VALUE[warpModeName as WarpModeName];
  }

  const resolved = resolveOrFail(ctx, ref);
  if (!resolved.ok) {
    return err(call, resolved.err);
  }
  const className = resolved.resolved.className;
  const isAudio = className === "AudioClip";
  // Warp fields are audio-only — reject on a MIDI/base clip rather than no-op (§9).
  if ((warping !== undefined || warpModeValue !== undefined) && !isAudio) {
    return err(
      call,
      unsupported(
        `warping/warpMode are audio-clip-only; "${ref}" is a ${className}`,
        "drop warping/warpMode, or target an audio clip"
      )
    );
  }
  const clip = resolved.resolved.object as unknown as WritableClip &
    Partial<WritableAudioClip>;
  const canonicalRef = resolved.resolved.canonicalRef;
  const applied: string[] = [];
  return syncPlan(
    () => {
      if (name !== undefined) {
        clip.name = name;
        applied.push("name");
      }
      if (color !== undefined) {
        clip.color = color;
        applied.push("color");
      }
      if (looping !== undefined) {
        clip.looping = looping;
        applied.push("looping");
      }
      if (muted !== undefined) {
        clip.muted = muted;
        applied.push("muted");
      }
      if (warping !== undefined) {
        (clip as WritableAudioClip).warping = warping;
        applied.push("warping");
      }
      if (warpModeValue !== undefined) {
        (clip as WritableAudioClip).warpMode = warpModeValue;
        applied.push("warpMode");
      }
    },
    () =>
      ok(
        call.id,
        { ref: canonicalRef, updated: applied },
        `update clip (${applied.join(", ") || "no-op"})`
      )
  );
}

// ---------------------------------------------------------------------------
// live_set_param
// ---------------------------------------------------------------------------

/**
 * `live_set_param` — set a STATIC value on a device or mixer parameter (§8.2).
 * NOT automation (§9). Resolves the target param, clamps to [min,max], snaps to
 * the nearest legal step when quantized, then `setValue()` (async). The param's
 * domain is read in prepare (outside the txn); only `setValue` runs inside it.
 */
export function prepareSetParam<V extends ApiVersion>(
  ctx: ExtensionContext<V>,
  call: ToolCall
): Prepared {
  if (!isRecord(call.input)) {
    return err(
      call,
      invalidArgs("expected an object with 'target' and 'value'")
    );
  }
  const value = readNumber(call.input, "value");
  if (value === null) {
    return err(call, invalidArgs("'value' must be a finite number"));
  }
  const target = call.input["target"];
  if (!isRecord(target)) {
    return err(call, invalidArgs("'target' must be an object"));
  }
  const type = readString(target, "type");

  // Build the param ref from the target discriminant.
  let paramRef: string;
  if (type === "device") {
    const param = readString(target, "param");
    if (param === null) {
      return err(call, invalidArgs("device target needs a 'param' ref"));
    }
    paramRef = param;
  } else if (type === "mixer") {
    const trackRef = readString(target, "track");
    if (trackRef === null) {
      return err(call, invalidArgs("mixer target needs a 'track' ref"));
    }
    const mixerRef = buildMixerParamRef(trackRef, target["mixer"]);
    if (mixerRef === null) {
      return err(
        call,
        invalidArgs("mixer must be { kind: 'volume' | 'pan' | 'send', index? }")
      );
    }
    paramRef = mixerRef;
  } else {
    return err(call, invalidArgs("'target.type' must be 'device' or 'mixer'"));
  }

  const resolved = resolveOrFail(ctx, paramRef);
  if (!resolved.ok) {
    return err(call, resolved.err);
  }
  const param = asParamView(resolved.resolved.object);
  if (param === null) {
    return err(
      call,
      invalidArgs(`resolved target "${paramRef}" is not a settable parameter`)
    );
  }
  // Clamp to range; quantized params snap to the nearest integer step (§8.2).
  let finalValue = clamp(value, param.min, param.max);
  if (param.isQuantized) {
    finalValue = clamp(Math.round(finalValue), param.min, param.max);
  }
  const canonicalRef = resolved.resolved.canonicalRef;
  return asyncPlan(
    () => param.setValue(finalValue),
    () =>
      ok(
        call.id,
        { ref: canonicalRef, value: finalValue, clampedFrom: value },
        "set parameter"
      )
  );
}

/** Build a `mixer/param:*` ref suffix on a track ref from a mixer selector. */
function buildMixerParamRef(trackRef: string, mixer: unknown): string | null {
  if (!isRecord(mixer)) {
    return null;
  }
  const kind = mixer["kind"];
  if (kind === "volume") {
    return `${trackRef}/mixer/param:volume`;
  }
  if (kind === "pan") {
    return `${trackRef}/mixer/param:pan`;
  }
  if (kind === "send") {
    const index = mixer["index"];
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
      return null;
    }
    return `${trackRef}/mixer/param:send:${String(index)}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// live_edit_midi_notes
// ---------------------------------------------------------------------------

/**
 * `live_edit_midi_notes` — read → transform → write a MIDI clip's notes (§8.2).
 * The current notes are read in prepare (outside the txn); the single `notes=`
 * write runs inside it. `op:"filter"` is destructive (§8.2) — marked via the
 * summary; actual confirmation gating is Phase 9/13.
 *
 * Transforms are deterministic: `humanize` is seeded by note identity so tests are
 * reproducible (no wall-clock / unseeded randomness, testing rules).
 */
export function prepareEditMidiNotes<V extends ApiVersion>(
  ctx: ExtensionContext<V>,
  call: ToolCall
): Prepared {
  if (!isRecord(call.input)) {
    return err(call, invalidArgs("expected an object with 'clip' and 'op'"));
  }
  const ref = readString(call.input, "clip");
  if (ref === null) {
    return err(call, invalidArgs("'clip' must be a ref string"));
  }
  const op = readString(call.input, "op") as MidiNoteOp | null;
  if (
    op === null ||
    !["replace", "transpose", "quantize", "humanize", "filter"].includes(op)
  ) {
    return err(
      call,
      invalidArgs("'op' must be replace|transpose|quantize|humanize|filter")
    );
  }
  const resolved = resolveOrFail(ctx, ref);
  if (!resolved.ok) {
    return err(call, resolved.err);
  }
  if (resolved.resolved.className !== "MidiClip") {
    return err(
      call,
      unsupported(
        `"${ref}" is a ${resolved.resolved.className}; only MIDI clips have notes`,
        "target a MIDI clip, or use live_update_clip for audio clips"
      )
    );
  }
  const clip = resolved.resolved.object as unknown as WritableMidiClip;
  const canonicalRef = resolved.resolved.canonicalRef;

  // Compute the new note set (read current notes for non-replace ops).
  let nextNotes: NoteDescription[];
  if (op === "replace") {
    const parsed = parseNotesArg(call.input["notes"]);
    if (!parsed.ok) {
      return err(call, parsed.err);
    }
    nextNotes = parsed.notes;
  } else {
    let current: NoteDescription[];
    try {
      current = readCurrentNotes(clip);
    } catch (e) {
      return err(
        call,
        sdkError(`failed to read current notes: ${errorMessage(e)}`)
      );
    }
    const transformed = transformNotes(op, current, call.input);
    if (!transformed.ok) {
      return err(call, transformed.err);
    }
    nextNotes = transformed.notes;
  }

  const destructive = op === "filter";
  return syncPlan(
    () => {
      clip.notes = nextNotes;
    },
    () =>
      ok(
        call.id,
        {
          ref: canonicalRef,
          op,
          noteCount: nextNotes.length,
          destructive,
        },
        `edit MIDI notes (${op})`
      )
  );
}

/** Read a MIDI clip's current notes defensively. */
function readCurrentNotes(clip: WritableMidiClip): NoteDescription[] {
  const notes = (clip as unknown as Record<string, unknown>)["notes"];
  return Array.isArray(notes) ? (notes as NoteDescription[]) : [];
}

/** Validate + normalize a `replace` notes array argument. */
function parseNotesArg(
  raw: unknown
): { ok: true; notes: NoteDescription[] } | { ok: false; err: ExecutorError } {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      err: invalidArgs("op='replace' requires a 'notes' array"),
    };
  }
  const rawNotes = raw as unknown[];
  const notes: NoteDescription[] = [];
  for (let i = 0; i < rawNotes.length; i++) {
    const n = rawNotes[i];
    if (!isRecord(n)) {
      return {
        ok: false,
        err: invalidArgs(`note ${String(i)} is not an object`),
      };
    }
    const pitch = readNumber(n, "pitch");
    const startTime = readNumber(n, "startTime");
    const duration = readNumber(n, "duration");
    if (pitch === null || startTime === null || duration === null) {
      return {
        ok: false,
        err: invalidArgs(
          `note ${String(i)} needs numeric pitch, startTime, duration`
        ),
      };
    }
    // The wire schema no longer carries numeric min/max bounds (strict tool use
    // rejects `minimum`/`maximum` — §8). The executor is therefore the sole
    // guard: clamp every bounded field here so an out-of-range value from the
    // model is corrected, never passed raw to the SDK (§9 honesty contract).
    const note: NoteDescription = {
      pitch: clamp(Math.round(pitch), 0, 127),
      startTime,
      duration,
    };
    const velocity = optNumber(n, "velocity");
    if (typeof velocity === "number") {
      note.velocity = clamp(Math.round(velocity), 0, 127);
    }
    const muted = optBoolean(n, "muted");
    if (typeof muted === "boolean") {
      note.muted = muted;
    }
    const probability = optNumber(n, "probability");
    if (typeof probability === "number") {
      note.probability = clamp(probability, 0, 1);
    }
    const velocityDeviation = optNumber(n, "velocityDeviation");
    if (typeof velocityDeviation === "number") {
      note.velocityDeviation = velocityDeviation;
    }
    const releaseVelocity = optNumber(n, "releaseVelocity");
    if (typeof releaseVelocity === "number") {
      note.releaseVelocity = clamp(Math.round(releaseVelocity), 0, 127);
    }
    notes.push(note);
  }
  return { ok: true, notes };
}

/** Apply a non-replace transform to the current notes. */
function transformNotes(
  op: Exclude<MidiNoteOp, "replace">,
  current: NoteDescription[],
  input: Record<string, unknown>
): { ok: true; notes: NoteDescription[] } | { ok: false; err: ExecutorError } {
  switch (op) {
    case "transpose": {
      const semitones = readNumber(input, "semitones");
      if (semitones === null) {
        return {
          ok: false,
          err: invalidArgs("op='transpose' requires numeric 'semitones'"),
        };
      }
      return {
        ok: true,
        notes: current.map((n) => ({
          ...n,
          pitch: clamp(Math.round(n.pitch + semitones), 0, 127),
        })),
      };
    }
    case "quantize": {
      const grid = readNumber(input, "grid");
      if (grid === null || grid <= 0) {
        return {
          ok: false,
          err: invalidArgs("op='quantize' requires positive numeric 'grid'"),
        };
      }
      const strengthRaw = optNumber(input, "strength");
      if (strengthRaw === null) {
        return { ok: false, err: invalidArgs("'strength' must be a number") };
      }
      const strength = strengthRaw === undefined ? 1 : clamp(strengthRaw, 0, 1);
      return {
        ok: true,
        notes: current.map((n) => {
          const snapped = Math.round(n.startTime / grid) * grid;
          const moved = n.startTime + (snapped - n.startTime) * strength;
          return { ...n, startTime: moved };
        }),
      };
    }
    case "humanize": {
      const timingAmount = optNumber(input, "timingAmount");
      const velocityAmount = optNumber(input, "velocityAmount");
      if (timingAmount === null || velocityAmount === null) {
        return {
          ok: false,
          err: invalidArgs("'timingAmount'/'velocityAmount' must be numbers"),
        };
      }
      const t = timingAmount ?? 0;
      const v = velocityAmount ?? 0;
      return {
        ok: true,
        notes: current.map((n, i) => {
          // Deterministic, identity-seeded jitter in [-1, 1) (reproducible tests).
          const jitterT = seededJitter(n.pitch * 131 + i * 17 + 1);
          const jitterV = seededJitter(n.pitch * 977 + i * 31 + 7);
          const startTime = Math.max(0, n.startTime + jitterT * t);
          const baseVel = n.velocity ?? 100;
          const velocity = clamp(Math.round(baseVel + jitterV * v), 0, 127);
          return { ...n, startTime, velocity };
        }),
      };
    }
    case "filter": {
      const f = input["filter"];
      if (!isRecord(f)) {
        return {
          ok: false,
          err: invalidArgs("op='filter' requires a 'filter' object"),
        };
      }
      const pitchMin = optNumber(f, "pitchMin");
      const pitchMax = optNumber(f, "pitchMax");
      const velocityMin = optNumber(f, "velocityMin");
      const velocityMax = optNumber(f, "velocityMax");
      for (const [k, val] of [
        ["pitchMin", pitchMin],
        ["pitchMax", pitchMax],
        ["velocityMin", velocityMin],
        ["velocityMax", velocityMax],
      ] as const) {
        if (val === null) {
          return {
            ok: false,
            err: invalidArgs(`'filter.${k}' must be a number`),
          };
        }
      }
      const pMin = pitchMin ?? 0;
      const pMax = pitchMax ?? 127;
      const vMin = velocityMin ?? 0;
      const vMax = velocityMax ?? 127;
      return {
        ok: true,
        notes: current.filter((n) => {
          const vel = n.velocity ?? 100;
          return (
            n.pitch >= pMin && n.pitch <= pMax && vel >= vMin && vel <= vMax
          );
        }),
      };
    }
  }
}

/** A deterministic jitter in [-1, 1) from an integer seed (no Math.random). */
function seededJitter(seed: number): number {
  // xorshift-ish hash → [0,1) → [-1,1).
  let x = (seed | 0) ^ 0x9e3779b9;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  const unit = ((x >>> 0) % 1000000) / 1000000;
  return unit * 2 - 1;
}

// ---------------------------------------------------------------------------
// live_create
// ---------------------------------------------------------------------------

/**
 * A name-set deferred to the batch's SECOND transaction (create-then-configure,
 * §7). The create transaction must settle before the new object can be located,
 * so naming happens afterward: the create's `finalize` locates the object, mints a
 * provisional ref, and queues this record; the registry then applies every queued
 * name in ONE shared rename transaction and re-mints each ref to reflect the
 * applied name (so the agent re-grounds, §6).
 *
 * `object` is the freshly-located created object from THIS call's finalize pass —
 * never cached across calls (§6); the rename transaction runs in the same flush.
 */
export interface PendingRename {
  /** The originating tool_use id (so the registry can replace its payload). */
  callId: string;
  /** The freshly-located created object whose `.name` will be set. */
  object: { name: string };
  /** The name the agent asked for. */
  desiredName: string;
  /**
   * Build this call's final payload AFTER the rename transaction settles, minting
   * a fresh ref from the object's current position/name.
   *
   * - `applied: true` → the name was set; the ref's name segment reflects it and
   *   no "not applied" note is added.
   * - `applied: false` → the rename was skipped (cancelled) or rolled back
   *   (transaction threw). The object WAS still created (txn #1 committed
   *   atomically, R5), so the payload is an honest SUCCESS carrying the un-renamed
   *   ref plus the caller-supplied `notApplied` note. It is NEVER a pure error —
   *   that would hide the created object and risk a duplicate re-create (§9).
   *
   * @param applied   Whether the name-set actually committed.
   * @param notApplied The honest "name not applied" note (caller distinguishes
   *                   "cancelled before configure" from "naming failed: …"); used
   *                   only when `applied` is false.
   */
  buildResult(
    this: void,
    applied: boolean,
    notApplied?: string
  ): ToolResultPayload;
}

/**
 * `live_create` — create an audio/MIDI track, scene, cue point, or take lane
 * (§8.2). Async creation; the new object is minted into a FRESH canonical ref from
 * its actual resolved position AFTER the transaction settles and returned so the
 * agent re-grounds (§6).
 *
 * When `name` is supplied, `live_create` applies it ITSELF: no create method
 * accepts a name at creation, so the name is set on the freshly-located object in
 * a SECOND transaction the registry runs for the whole batch (create-then-configure,
 * §7 — one logical action, ≥2 undo steps). The create's finalize queues a
 * {@link PendingRename} into `pendingRenames` and the registry flushes them
 * together; if no create in the batch is named, no second transaction is opened.
 *
 * `index` positions a SCENE only (`createScene(index)`; `-1` appends). For
 * audio/MIDI tracks and take lanes the SDK has no positional insert — a supplied
 * `index` is reported as ignored in the success payload (never silently dropped).
 */
export function prepareCreate<V extends ApiVersion>(
  ctx: ExtensionContext<V>,
  call: ToolCall,
  refs: ReferenceTable,
  pendingRenames: PendingRename[]
): Prepared {
  if (!isRecord(call.input)) {
    return err(call, invalidArgs("expected an object with a 'kind'"));
  }
  const kind = readString(call.input, "kind");
  const name = optString(call.input, "name");
  if (name === null) {
    return err(call, invalidArgs("'name' is the wrong type"));
  }
  const song = ctx.application.song;

  switch (kind) {
    case "audio_track":
      return asyncPlan(
        () => song.createAudioTrack(),
        (created) =>
          finalizeCreatedTrack(
            call,
            refs,
            ctx,
            created,
            "audio track",
            name,
            pendingRenames,
            indexIgnoredNote(call, "audio_track")
          )
      );
    case "midi_track":
      return asyncPlan(
        () => song.createMidiTrack(),
        (created) =>
          finalizeCreatedTrack(
            call,
            refs,
            ctx,
            created,
            "MIDI track",
            name,
            pendingRenames,
            indexIgnoredNote(call, "midi_track")
          )
      );
    case "scene": {
      const index = optNumber(call.input, "index");
      if (index === null) {
        return err(call, invalidArgs("'index' must be an integer"));
      }
      // -1 appends (SDK). Default to append when omitted.
      const at = index === undefined ? -1 : index;
      return asyncPlan(
        () => song.createScene(at),
        (created) =>
          finalizeCreatedNamed(
            call,
            refs,
            ctx,
            created,
            "scene",
            "scenes",
            "scene",
            name,
            pendingRenames
          )
      );
    }
    case "cue_point": {
      const time = readNumber(call.input, "time");
      if (time === null) {
        return err(
          call,
          invalidArgs("'cue_point' requires numeric 'time' (beats)")
        );
      }
      return asyncPlan(
        () => song.createCuePoint(time),
        (created) =>
          finalizeCreatedNamed(
            call,
            refs,
            ctx,
            created,
            "cuePoint",
            "cuePoints",
            "cuePoint",
            name,
            pendingRenames,
            indexIgnoredNote(call, "cue_point")
          )
      );
    }
    case "take_lane": {
      const trackRef = readString(call.input, "takeLaneTrack");
      if (trackRef === null) {
        return err(
          call,
          invalidArgs("'take_lane' requires a 'takeLaneTrack' ref")
        );
      }
      const resolved = resolveOrFail(ctx, trackRef);
      if (!resolved.ok) {
        return err(call, resolved.err);
      }
      const trackObj = resolved.resolved.object;
      if (
        typeof (trackObj as { createTakeLane?: unknown }).createTakeLane !==
        "function"
      ) {
        return err(
          call,
          invalidArgs(`"${trackRef}" is not a track that can hold take lanes`)
        );
      }
      const parentRef = resolved.resolved.canonicalRef;
      return asyncPlan(
        () => (trackObj as unknown as Track<V>).createTakeLane(),
        (created) =>
          finalizeCreatedChild(
            ctx,
            call,
            refs,
            created,
            parentRef,
            "takeLane",
            "takeLanes",
            "take lane",
            name,
            pendingRenames,
            indexIgnoredNote(call, "take_lane")
          )
      );
    }
    default:
      return err(
        call,
        invalidArgs(
          "'kind' must be audio_track|midi_track|scene|cue_point|take_lane"
        )
      );
  }
}

/**
 * If the agent passed an `index` for a kind that does NOT honor it, return the
 * honest, kind-accurate "index ignored" note (§9 — never silently drop). Scenes
 * honor `index` upstream, so this is never called for them; every other kind is
 * positioned by appension or by `time`, not by index.
 */
function indexIgnoredNote(
  call: ToolCall,
  kind: "audio_track" | "midi_track" | "take_lane" | "cue_point"
): string | undefined {
  if (!isRecord(call.input) || optNumber(call.input, "index") === undefined) {
    return undefined;
  }
  switch (kind) {
    case "audio_track":
    case "midi_track":
      return "index ignored — new tracks are appended after the selected track; the SDK has no positional insert";
    case "take_lane":
      return "index ignored — take lanes are appended to the end of the track's take lanes; the SDK has no positional insert";
    case "cue_point":
      return "index ignored — a cue point is positioned by 'time' (beats), not index";
  }
}

/**
 * Queue a name-set for the batch's second transaction (§7) and return the
 * PROVISIONAL success payload using `provisionalRef` (the object's current,
 * un-renamed position). The registry replaces this payload after the rename
 * transaction via {@link PendingRename.buildResult}. `mintFinalRef` re-mints the
 * ref from the object's position once the name is applied (or the un-renamed
 * position if the rename was skipped).
 */
function queueRename(
  call: ToolCall,
  pendingRenames: PendingRename[],
  object: { name: string },
  desiredName: string,
  label: string,
  provisionalRef: string,
  mintFinalRef: (applied: boolean) => string,
  indexNote: string | undefined
): ToolResultPayload {
  pendingRenames.push({
    callId: call.id,
    object,
    desiredName,
    buildResult: (applied, notApplied) => {
      const ref = mintFinalRef(applied);
      const data: Record<string, unknown> = { created: label, ref };
      if (!applied) {
        // The object WAS created; only the name didn't land. Honest success with
        // the un-renamed ref + the caller's distinguishing note (§9).
        data.note =
          notApplied ??
          "created, but name not applied — cancelled before configure";
      } else if (indexNote !== undefined) {
        data.note = indexNote;
      }
      return ok(call.id, data, `create ${label}`);
    },
  });
  // Provisional payload (overwritten by the registry after the rename txn).
  const data: Record<string, unknown> = {
    created: label,
    ref: provisionalRef,
  };
  if (indexNote !== undefined) {
    data.note = indexNote;
  }
  return ok(call.id, data, `create ${label}`);
}

/** Mint a top-level track ref by locating the created object's live index. */
function finalizeCreatedTrack<V extends ApiVersion>(
  call: ToolCall,
  refs: ReferenceTable,
  ctx: ExtensionContext<V>,
  created: unknown,
  label: string,
  name: string | undefined,
  pendingRenames: PendingRename[],
  indexNote: string | undefined
): ToolResultPayload {
  return finalizeCreatedNamed(
    call,
    refs,
    ctx,
    created,
    "track",
    "tracks",
    label,
    name,
    pendingRenames,
    indexNote
  );
}

/**
 * Mint a top-level named ref (track/scene/cuePoint) from its live position. When
 * the agent supplied a `name`, queue it for the batch's second rename transaction
 * (§7) and mint the ref to reflect the applied name once that settles; otherwise
 * return the ref immediately.
 */
function finalizeCreatedNamed<V extends ApiVersion>(
  call: ToolCall,
  refs: ReferenceTable,
  ctx: ExtensionContext<V>,
  created: unknown,
  segmentKind: "track" | "scene" | "cuePoint",
  collectionKey: "tracks" | "scenes" | "cuePoints",
  label: string,
  name: string | undefined,
  pendingRenames: PendingRename[],
  indexNote: string | undefined = undefined
): ToolResultPayload {
  const handleId = handleIdOf(created);
  if (handleId === null) {
    return ok(
      call.id,
      { created: label, note: "created but ref could not be minted" },
      `create ${label}`
    );
  }
  const song = ctx.application.song as unknown as Record<string, unknown>;
  const collectionRaw = song[collectionKey];
  if (Array.isArray(collectionRaw)) {
    const collection = collectionRaw as unknown[];
    for (let i = 0; i < collection.length; i++) {
      const obj = collection[i];
      if (handleIdOf(obj) === handleId) {
        // Re-mint the ref from the object's current position; when a rename is
        // pending, the name segment reflects the applied (or un-renamed) name.
        const mintFinalRef = (applied: boolean): string =>
          refs.mint(
            serializeRef([
              {
                kind: segmentKind,
                index: i,
                name: applied && name !== undefined ? name : nameOf(obj),
              },
            ])
          );
        if (name !== undefined && isRecord(obj)) {
          return queueRename(
            call,
            pendingRenames,
            obj as unknown as { name: string },
            name,
            label,
            mintFinalRef(false),
            mintFinalRef,
            indexNote
          );
        }
        const data: Record<string, unknown> = {
          created: label,
          ref: mintFinalRef(false),
        };
        if (indexNote !== undefined) {
          data.note = indexNote;
        }
        return ok(call.id, data, `create ${label}`);
      }
    }
  }
  return ok(
    call.id,
    { created: label, note: "created but not yet located in the live model" },
    `create ${label}`
  );
}

/**
 * Mint a child ref (e.g. take lane) by re-resolving the PARENT fresh and locating
 * the created object's handle within the parent's child collection (§6). The
 * created object is not cached — we re-read the parent's live collection and match
 * by handle id, exactly like {@link finalizeCreatedNamed} does at the song level.
 * When a `name` was supplied, queue it for the batch's second rename transaction.
 */
function finalizeCreatedChild<V extends ApiVersion>(
  ctx: ExtensionContext<V>,
  call: ToolCall,
  refs: ReferenceTable,
  created: unknown,
  parentRef: string,
  segmentKind: "takeLane",
  collectionKey: "takeLanes",
  label: string,
  name: string | undefined,
  pendingRenames: PendingRename[],
  indexNote: string | undefined
): ToolResultPayload {
  const handleId = handleIdOf(created);
  const parent = resolveOrFail(ctx, parentRef);
  if (handleId !== null && parent.ok) {
    const parentObj = parent.resolved.object as unknown as Record<
      string,
      unknown
    >;
    const collectionRaw = parentObj[collectionKey];
    if (Array.isArray(collectionRaw)) {
      const collection = collectionRaw as unknown[];
      const parentSegs = parseRef(parent.resolved.canonicalRef).segments;
      for (let i = 0; i < collection.length; i++) {
        const obj = collection[i];
        if (handleIdOf(obj) === handleId) {
          const mintFinalRef = (applied: boolean): string =>
            refs.mint(
              serializeRef([
                ...parentSegs,
                {
                  kind: segmentKind,
                  index: i,
                  name: applied && name !== undefined ? name : nameOf(obj),
                },
              ])
            );
          if (name !== undefined && isRecord(obj)) {
            return queueRename(
              call,
              pendingRenames,
              obj as unknown as { name: string },
              name,
              label,
              mintFinalRef(false),
              mintFinalRef,
              indexNote
            );
          }
          const data: Record<string, unknown> = {
            created: label,
            ref: mintFinalRef(false),
          };
          if (indexNote !== undefined) {
            data.note = indexNote;
          }
          return ok(call.id, data, `create ${label}`);
        }
      }
    }
  }
  return ok(
    call.id,
    {
      created: label,
      parent: parentRef,
      hint: "re-read the parent track with live_get_track to ground the new take lane ref",
    },
    `create ${label}`
  );
}

/** Read a created object's handle id, or `null`. */
function handleIdOf(obj: unknown): bigint | null {
  if (!isRecord(obj)) {
    return null;
  }
  const handle = obj["handle"];
  if (isRecord(handle) && typeof handle["id"] === "bigint") {
    return handle["id"];
  }
  return null;
}

/** Read an object's `.name` getter as a string, defaulting to `""`. */
function nameOf(obj: unknown): string {
  if (isRecord(obj) && typeof obj["name"] === "string") {
    return obj["name"];
  }
  return "";
}

// ---------------------------------------------------------------------------
// live_create_clip
// ---------------------------------------------------------------------------

/**
 * `live_create_clip` — create a MIDI clip at a track/clipSlot/takeLane (§8.2).
 * The AUDIO path is DEFERRED to Phase 14 (returns the deferred payload, never a
 * fake success, §9). Markers are set ONLY here via `loopSettings` (read-only
 * afterward, §9) — but for MIDI the SDK create takes only a length/duration, so
 * marker settings on a MIDI clip are rejected as unsupported.
 */
export function prepareCreateClip<V extends ApiVersion>(
  ctx: ExtensionContext<V>,
  call: ToolCall
): Prepared {
  if (!isRecord(call.input)) {
    return err(
      call,
      invalidArgs("expected an object with 'location' and 'type'")
    );
  }
  const location = readString(call.input, "location");
  if (location === null) {
    return err(call, invalidArgs("'location' must be a ref string"));
  }
  const type = readString(call.input, "type");
  if (type === "audio") {
    return deferPrepared(call, "live_create_clip (audio)");
  }
  if (type !== "midi") {
    return err(call, invalidArgs("'type' must be 'midi' or 'audio'"));
  }

  const resolved = resolveOrFail(ctx, location);
  if (!resolved.ok) {
    return err(call, resolved.err);
  }
  const className = resolved.resolved.className;
  const obj = resolved.resolved.object as unknown as Record<string, unknown>;

  // ClipSlot.createMidiClip(length); MidiTrack/TakeLane.createMidiClip(start,dur).
  if (className === "ClipSlot") {
    const duration = readNumber(call.input, "duration");
    if (duration === null || duration <= 0) {
      return err(
        call,
        invalidArgs(
          "clip slot MIDI clip needs positive 'duration' (length, beats)"
        )
      );
    }
    if (typeof obj["createMidiClip"] !== "function") {
      return err(
        call,
        invalidArgs("resolved clip slot cannot create a MIDI clip")
      );
    }
    return asyncPlan(
      () => (obj as unknown as ClipSlot<V>).createMidiClip(duration),
      () =>
        ok(
          call.id,
          {
            created: "midi clip",
            location: resolved.resolved.canonicalRef,
            hint: "re-read the clip slot to ground the new clip ref",
          },
          "create MIDI clip"
        )
    );
  }

  // Arrangement MIDI clip on a track or take lane: (startTime, duration).
  const startTime = readNumber(call.input, "startTime");
  const duration = readNumber(call.input, "duration");
  if (startTime === null) {
    return err(
      call,
      invalidArgs("arrangement MIDI clip needs numeric 'startTime' (beats)")
    );
  }
  if (duration === null || duration <= 0) {
    return err(
      call,
      invalidArgs("arrangement MIDI clip needs positive 'duration' (beats)")
    );
  }
  if (typeof obj["createMidiClip"] !== "function") {
    return err(
      call,
      unsupported(
        `"${location}" (${className}) cannot create an arrangement MIDI clip`,
        "target a MIDI track, a clip slot, or a take lane"
      )
    );
  }
  return asyncPlan(
    () =>
      (
        obj as unknown as {
          createMidiClip(startTime: number, duration: number): Promise<unknown>;
        }
      ).createMidiClip(startTime, duration),
    () =>
      ok(
        call.id,
        {
          created: "midi clip",
          location: resolved.resolved.canonicalRef,
          hint: "re-read the location to ground the new clip ref",
        },
        "create MIDI clip"
      )
  );
}

// ---------------------------------------------------------------------------
// live_insert_device
// ---------------------------------------------------------------------------

/**
 * `live_insert_device` — insert a BUILT-IN Live device by name into a track or
 * chain (§8.2). We do NOT maintain a built-in allowlist here: the SDK rejects
 * unknown/third-party names, and that rejection is surfaced as a structured
 * `sdk_error` (the §9 "no plugins" guard is enforced by the SDK at insert time).
 */
export function prepareInsertDevice<V extends ApiVersion>(
  ctx: ExtensionContext<V>,
  call: ToolCall
): Prepared {
  if (!isRecord(call.input)) {
    return err(call, invalidArgs("expected 'location', 'deviceName', 'index'"));
  }
  const location = readString(call.input, "location");
  const deviceName = readString(call.input, "deviceName");
  const index = readNumber(call.input, "index");
  if (location === null) {
    return err(call, invalidArgs("'location' must be a ref string"));
  }
  if (deviceName === null || deviceName.trim() === "") {
    return err(call, invalidArgs("'deviceName' must be a non-empty string"));
  }
  if (index === null || !Number.isInteger(index) || index < 0) {
    return err(call, invalidArgs("'index' must be a non-negative integer"));
  }
  const resolved = resolveOrFail(ctx, location);
  if (!resolved.ok) {
    return err(call, resolved.err);
  }
  const obj = resolved.resolved.object as unknown as Record<string, unknown>;
  if (typeof obj["insertDevice"] !== "function") {
    return err(
      call,
      unsupported(
        `"${location}" (${resolved.resolved.className}) cannot host a device`,
        "target a track or a chain"
      )
    );
  }
  const canonicalRef = resolved.resolved.canonicalRef;
  return asyncPlan(
    () =>
      (
        obj as unknown as {
          insertDevice(name: string, index: number): Promise<unknown>;
        }
      ).insertDevice(deviceName, index),
    () =>
      ok(
        call.id,
        {
          inserted: deviceName,
          location: canonicalRef,
          index,
          hint: "re-read the location to ground the new device ref",
        },
        `insert device ${deviceName}`
      )
  );
}

// ---------------------------------------------------------------------------
// live_modify_device_chain
// ---------------------------------------------------------------------------

/**
 * `live_modify_device_chain` — `duplicate` a device, or `insert_chain` into a rack
 * (§8.2). Duplicate needs the device ref; insert_chain needs the rack `location`
 * and an index.
 */
export function prepareModifyDeviceChain<V extends ApiVersion>(
  ctx: ExtensionContext<V>,
  call: ToolCall
): Prepared {
  if (!isRecord(call.input)) {
    return err(call, invalidArgs("expected 'location' and 'op'"));
  }
  const location = readString(call.input, "location");
  const op = readString(call.input, "op");
  if (location === null) {
    return err(call, invalidArgs("'location' must be a ref string"));
  }

  if (op === "duplicate") {
    const deviceRef = readString(call.input, "device");
    if (deviceRef === null) {
      return err(call, invalidArgs("op='duplicate' requires a 'device' ref"));
    }
    // location = the track/chain hosting the device; device = the device to copy.
    const host = resolveOrFail(ctx, location);
    if (!host.ok) {
      return err(call, host.err);
    }
    const device = resolveOrFail(ctx, deviceRef);
    if (!device.ok) {
      return err(call, device.err);
    }
    const hostObj = host.resolved.object as unknown as Record<string, unknown>;
    if (typeof hostObj["duplicateDevice"] !== "function") {
      return err(
        call,
        unsupported(
          `"${location}" cannot duplicate a device`,
          "the host must be a track or chain"
        )
      );
    }
    const hostRef = host.resolved.canonicalRef;
    return asyncPlan(
      () =>
        (
          hostObj as unknown as {
            duplicateDevice(d: unknown): Promise<unknown>;
          }
        ).duplicateDevice(device.resolved.object),
      () =>
        ok(
          call.id,
          {
            duplicated: device.resolved.canonicalRef,
            host: hostRef,
            hint: "re-read the host to ground the duplicated device ref",
          },
          "duplicate device"
        )
    );
  }

  if (op === "insert_chain") {
    const index = readNumber(call.input, "index");
    if (index === null || !Number.isInteger(index) || index < 0) {
      return err(
        call,
        invalidArgs("op='insert_chain' requires a non-negative integer 'index'")
      );
    }
    const rack = resolveOrFail(ctx, location);
    if (!rack.ok) {
      return err(call, rack.err);
    }
    const rackObj = rack.resolved.object as unknown as Record<string, unknown>;
    if (typeof rackObj["insertChain"] !== "function") {
      return err(
        call,
        unsupported(
          `"${location}" (${rack.resolved.className}) is not a rack device`,
          "target a rack device that exposes chains"
        )
      );
    }
    const rackRef = rack.resolved.canonicalRef;
    return asyncPlan(
      () =>
        (
          rackObj as unknown as { insertChain(i: number): Promise<unknown> }
        ).insertChain(index),
      () =>
        ok(
          call.id,
          {
            insertedChainInto: rackRef,
            index,
            hint: "re-read the rack to ground the new chain ref",
          },
          "insert chain"
        )
    );
  }

  return err(call, invalidArgs("'op' must be 'duplicate' or 'insert_chain'"));
}

// ---------------------------------------------------------------------------
// live_replace_sample (deferred to Phase 14)
// ---------------------------------------------------------------------------

/**
 * `live_replace_sample` — DEFERRED to Phase 14 (audio tooling, §8.2/§14). Returns
 * the honest deferred payload (`isError: true`); never a fake success (§9).
 */
export function prepareReplaceSample(call: ToolCall): Prepared {
  return deferPrepared(call, "live_replace_sample");
}

// ---------------------------------------------------------------------------
// live_delete
// ---------------------------------------------------------------------------

/**
 * `live_delete` — type-routed delete of a track/scene/cuePoint/clip/device (§8.2).
 * Destructive (`D`); the confirmation gate is Phase 9/13 — here we mark it. After
 * the delete settles, the {@link ReferenceTable} invalidates the deleted ref and
 * shifts later siblings; the affected refs are returned so the agent re-grounds
 * (§6).
 */
export function prepareDelete<V extends ApiVersion>(
  ctx: ExtensionContext<V>,
  call: ToolCall,
  refs: ReferenceTable
): Prepared {
  if (!isRecord(call.input)) {
    return err(call, invalidArgs("expected an object with a 'target' ref"));
  }
  const ref = readString(call.input, "target");
  if (ref === null) {
    return err(call, invalidArgs("'target' must be a ref string"));
  }
  const resolved = resolveOrFail(ctx, ref);
  if (!resolved.ok) {
    return err(call, resolved.err);
  }
  const canonicalRef = resolved.resolved.canonicalRef;
  const kind = leafKind(canonicalRef);
  const obj = resolved.resolved.object;
  const song = ctx.application.song;

  // Route by the leaf kind of the resolved ref.
  switch (kind) {
    case "track":
      return deletePlan(call, refs, canonicalRef, "track", () =>
        song.deleteTrack(obj as unknown as Track<V>)
      );
    case "scene":
      return deletePlan(call, refs, canonicalRef, "scene", () =>
        song.deleteScene(obj as unknown as Scene<V>)
      );
    case "cuePoint":
      return deletePlan(call, refs, canonicalRef, "cuePoint", () =>
        song.deleteCuePoint(obj as unknown as CuePoint<V>)
      );
    case "clip":
      return prepareDeleteClip(ctx, call, refs, ref, canonicalRef, obj);
    case "device":
      return prepareDeleteDevice(ctx, call, refs, ref, canonicalRef, obj);
    default:
      return err(
        call,
        unsupported(
          `cannot delete a "${kind}" via live_delete`,
          "delete a track, scene, cue point, clip, or device"
        )
      );
  }
}

/** Build a delete plan that invalidates the ref table after the delete settles. */
function deletePlan(
  call: ToolCall,
  refs: ReferenceTable,
  canonicalRef: string,
  label: string,
  launch: () => Promise<void>
): Prepared {
  return asyncPlan(
    () => launch(),
    () => {
      const affected = refs.invalidateAndShift(canonicalRef);
      return ok(
        call.id,
        {
          deleted: label,
          ref: canonicalRef,
          affectedRefs: affected,
          destructive: true,
        },
        `delete ${label}`
      );
    }
  );
}

/**
 * Delete a clip: route session clips to `ClipSlot.deleteClip()` and arrangement
 * clips to `track.deleteClip(clip)`. The ref's parent kind decides which: a
 * `clipSlot` parent → session; a `track`/`takeLane` parent → arrangement/lane.
 */
function prepareDeleteClip<V extends ApiVersion>(
  ctx: ExtensionContext<V>,
  call: ToolCall,
  refs: ReferenceTable,
  ref: string,
  canonicalRef: string,
  clipObj: unknown
): Prepared {
  const parentKind = parentKindOf(canonicalRef);
  if (parentKind === "clipSlot") {
    // Resolve the parent slot to call deleteClip() on it.
    const slotRef = parentRefOf(ref);
    if (slotRef === null) {
      return err(
        call,
        invalidArgs("could not derive the clip slot from the clip ref")
      );
    }
    const slot = resolveOrFail(ctx, slotRef);
    if (!slot.ok) {
      return err(call, slot.err);
    }
    const slotObj = slot.resolved.object as unknown as Record<string, unknown>;
    if (typeof slotObj["deleteClip"] !== "function") {
      return err(call, invalidArgs("resolved slot cannot delete its clip"));
    }
    return deletePlan(call, refs, canonicalRef, "clip", () =>
      (slotObj as unknown as ClipSlot<V>).deleteClip()
    );
  }
  // Arrangement / take-lane clip: delete via the parent track.
  const trackRef = topTrackRefOf(canonicalRef);
  if (trackRef === null) {
    return err(
      call,
      invalidArgs("could not derive the parent track from the clip ref")
    );
  }
  const track = resolveOrFail(ctx, trackRef);
  if (!track.ok) {
    return err(call, track.err);
  }
  const trackObj = track.resolved.object as unknown as Record<string, unknown>;
  if (typeof trackObj["deleteClip"] !== "function") {
    return err(call, invalidArgs("resolved track cannot delete the clip"));
  }
  return deletePlan(call, refs, canonicalRef, "clip", () =>
    (trackObj as unknown as Track<V>).deleteClip(clipObj as Clip<V>)
  );
}

/** Delete a device via its host track or chain (the device ref's parent). */
function prepareDeleteDevice<V extends ApiVersion>(
  ctx: ExtensionContext<V>,
  call: ToolCall,
  refs: ReferenceTable,
  ref: string,
  canonicalRef: string,
  deviceObj: unknown
): Prepared {
  const hostRef = parentRefOf(ref);
  if (hostRef === null) {
    return err(
      call,
      invalidArgs("could not derive the device's host from the ref")
    );
  }
  const host = resolveOrFail(ctx, hostRef);
  if (!host.ok) {
    return err(call, host.err);
  }
  const hostObj = host.resolved.object as unknown as Record<string, unknown>;
  if (typeof hostObj["deleteDevice"] !== "function") {
    return err(call, invalidArgs("resolved host cannot delete the device"));
  }
  return deletePlan(call, refs, canonicalRef, "device", () =>
    (hostObj as unknown as Track<V> | Chain<V>).deleteDevice(
      deviceObj as Device<V>
    )
  );
}

// ---------------------------------------------------------------------------
// Ref-path helpers (pure; reuse the shared grammar)
// ---------------------------------------------------------------------------

/** The leaf segment's kind of a canonical ref, or `""` if unparsable. */
function leafKind(ref: string): RefSegment["kind"] | "" {
  try {
    const segs = parseRef(ref).segments;
    return segs.length > 0 ? segs[segs.length - 1].kind : "";
  } catch {
    return "";
  }
}

/** The kind of the segment immediately before the leaf, or `null`. */
function parentKindOf(ref: string): RefSegment["kind"] | null {
  try {
    const segs = parseRef(ref).segments;
    return segs.length >= 2 ? segs[segs.length - 2].kind : null;
  } catch {
    return null;
  }
}

/** The canonical ref of the leaf's parent (all but the last segment), or `null`. */
function parentRefOf(ref: string): string | null {
  try {
    const segs = parseRef(ref).segments;
    if (segs.length < 2) {
      return null;
    }
    return serializeRef(segs.slice(0, -1));
  } catch {
    return null;
  }
}

/** The top-level `track:*` ref of a ref rooted at a track, or `null`. */
function topTrackRefOf(ref: string): string | null {
  try {
    const segs = parseRef(ref).segments;
    if (segs.length === 0 || segs[0].kind !== "track") {
      return null;
    }
    return serializeRef([segs[0]]);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// live_import_audio (deferred to Phase 14)
// ---------------------------------------------------------------------------

/**
 * `live_import_audio` — DEFERRED to Phase 14 (audio tooling, §8.3/§14). Returns
 * the honest deferred payload; never a fake success/path (§9).
 */
export function prepareImportAudio(call: ToolCall): Prepared {
  return deferPrepared(call, "live_import_audio");
}

// Keep the SDK class imports referenced for the type-narrowing casts above so the
// bundler/types retain them (they document the concrete delete/route targets).
void AudioClip;
void AudioTrack;
void DeviceParameter;
void MidiClip;
void MidiTrack;
void RackDevice;
void TakeLane;
