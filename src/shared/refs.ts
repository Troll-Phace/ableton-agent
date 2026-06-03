/**
 * Semantic reference grammar for the Ableton Claude Agent (pure module).
 *
 * The SDK has no stable object identity — handles die on delete and move, and
 * names are not unique (ARCHITECTURE §1.4, §6). The agent therefore speaks in
 * **semantic refs**: a `/`-joined path of `kind:index:name` segments anchored
 * implicitly at the song, re-resolved against the live model on every tool call.
 *
 * This module owns the *lexical* and *structural* grammar only — parsing,
 * serialization, structural validation, and the pure index-shift used by the
 * resolver's subtree-rebuild after a delete. It performs NO resolution and
 * touches NO SDK (it must stay importable across the socket boundary).
 *
 * Grammar (ARCHITECTURE §6, §16):
 * ```
 * track:2:Bass
 * track:2:Bass/clip:0:Verse
 * track:2:Bass/clipSlot:5                      (index-only — ClipSlot has no name)
 * track:2:Bass/clipSlot:5/clip:0:Verse
 * track:2:Bass/takeLane:1:Comp/clip:0:Verse
 * track:2:Bass/device:1:Reverb
 * track:2:Bass/device:1:Reverb/param:7:Decay   (device param — index:name)
 * track:2:Bass/device:0:Rack/chain:1:B/device:0:Reverb/param:7:Decay
 * track:2:Bass/mixer                           (bare — no index, no name)
 * track:2:Bass/mixer/param:volume              (mixer param — keyword)
 * track:2:Bass/mixer/param:pan
 * track:2:Bass/mixer/param:send:1
 * scene:4:Chorus
 * cuePoint:0:Intro
 * ```
 */

/** Every legal segment kind in the ref grammar. */
export type RefKind =
  | "track"
  | "clip"
  | "clipSlot"
  | "takeLane"
  | "scene"
  | "cuePoint"
  | "device"
  | "chain"
  | "param"
  | "mixer";

/**
 * Standard `kind:index:name` segment (everything except `mixer` and `param`).
 * `name` is the decoded display name; it is `""` for `clipSlot`, which has no
 * name in the SDK and serializes index-only (`clipSlot:5`).
 */
export interface IndexedSegment {
  kind:
    | "track"
    | "clip"
    | "clipSlot"
    | "takeLane"
    | "scene"
    | "cuePoint"
    | "device"
    | "chain";
  index: number;
  /** Decoded name; `""` for `clipSlot` (no name). */
  name: string;
}

/** The bare `mixer` segment — no index, no name. */
export interface MixerSegment {
  kind: "mixer";
}

/** Which mixer DeviceParameter a `param under:"mixer"` segment selects. */
export type MixerParamSelector =
  | { selector: "volume" }
  | { selector: "pan" }
  | { selector: "send"; sendIndex: number };

/**
 * A `param` segment under a `mixer` parent, addressed by keyword:
 * `param:volume`, `param:pan`, or `param:send:N`.
 */
export interface MixerParamSegment {
  kind: "param";
  under: "mixer";
  ref: MixerParamSelector;
}

/**
 * A `param` segment under a `device` parent, addressed by `index:name`
 * (`param:7:Decay`).
 */
export interface DeviceParamSegment {
  kind: "param";
  under: "device";
  index: number;
  /** Decoded parameter name. */
  name: string;
}

/** Any single segment of a parsed ref. */
export type RefSegment =
  | IndexedSegment
  | MixerSegment
  | MixerParamSegment
  | DeviceParamSegment;

/** A fully parsed ref: its ordered segments plus the original source string. */
export interface ParsedRef {
  segments: RefSegment[];
  /** The exact input string passed to {@link parseRef}. */
  source: string;
}

/** Result of {@link validateRef}: either clean or a list of structural issues. */
export type ValidationResult = { ok: true } | { ok: false; issues: string[] };

/** Thrown by {@link parseRef} on lexically malformed input. */
export class RefParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefParseError";
    // Restore prototype chain (TS target/transpile safety).
    Object.setPrototypeOf(this, RefParseError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const ALL_KINDS = new Set<RefKind>([
  "track",
  "clip",
  "clipSlot",
  "takeLane",
  "scene",
  "cuePoint",
  "device",
  "chain",
  "param",
  "mixer",
]);

/** Mixer-param keywords recognized in the middle field of a `param` segment. */
const MIXER_PARAM_KEYWORDS = new Set(["volume", "pan", "send"]);

// ---------------------------------------------------------------------------
// Name escaping (Design Decision 1)
// ---------------------------------------------------------------------------

/**
 * Percent-encode the name field. Only `%`, `:`, and `/` are encoded (the three
 * characters that would otherwise break field/segment boundaries); all other
 * characters — including spaces and unicode — are left intact so names stay
 * readable in tool JSON. `%` is encoded first to keep the transform reversible.
 */
function encodeName(name: string): string {
  return name.replace(/%/g, "%25").replace(/:/g, "%3A").replace(/\//g, "%2F");
}

/**
 * Inverse of {@link encodeName}. Decodes `%25`/`%3A`/`%2F` (case-insensitive)
 * back to `%`/`:`/`/`. A bare `%` not followed by two hex digits is malformed.
 *
 * Note: by the time a name field reaches here, `parseRef` has already split on
 * unescaped `/` and `:`, so the field cannot contain raw `:` or `/`; the only
 * valid `%` occurrences are the three escapes above. We still scan for *any*
 * two-hex-digit `%XX` and reject anything else, so a stray `%XY` is caught.
 */
function decodeName(field: string): string {
  let out = "";
  for (let i = 0; i < field.length; i++) {
    const ch = field[i];
    if (ch !== "%") {
      out += ch;
      continue;
    }
    const hex = field.slice(i + 1, i + 3);
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
      throw new RefParseError(
        `Malformed percent-escape at position ${String(i)} in name field "${field}"`
      );
    }
    out += String.fromCharCode(parseInt(hex, 16));
    i += 2;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse an integer index field, rejecting anything non-canonical (leading `+`,
 * whitespace, `1.0`, negative, etc.). Indices are always non-negative integers.
 */
function parseIndexField(field: string, context: string): number {
  if (!/^[0-9]+$/.test(field)) {
    throw new RefParseError(
      `Expected a non-negative integer index in ${context}, got "${field}"`
    );
  }
  return parseInt(field, 10);
}

/**
 * Parse a single raw segment string into a {@link RefSegment}.
 *
 * `param`'s variant is decided positionally by `prevKind` (the kind of the
 * immediately-preceding segment): after a `mixer` segment it is a
 * {@link MixerParamSegment}; after a `device` segment it is a
 * {@link DeviceParamSegment}; any other predecessor is a parse error. The
 * keyword form (`volume|pan|send`) is detected from the middle field.
 *
 * @param raw       The segment text (already split on unescaped `/`).
 * @param prevKind  Kind of the preceding segment, or `null` if this is first.
 * @param segIndex  Position of this segment in the path (for error messages).
 */
function parseSegment(
  raw: string,
  prevKind: RefKind | null,
  segIndex: number
): RefSegment {
  if (raw === "") {
    throw new RefParseError(
      `Empty segment at position ${String(segIndex)} (check for "//")`
    );
  }

  // Split on unescaped ":" only. Names never contain a raw ":" (escaped as
  // %3A), so a simple split is sound.
  const fields = raw.split(":");
  const kind = fields[0];

  if (!ALL_KINDS.has(kind as RefKind)) {
    throw new RefParseError(
      `Unknown kind "${kind}" at position ${String(segIndex)}`
    );
  }
  const refKind = kind as RefKind;

  // --- mixer: bare segment, no fields ---
  if (refKind === "mixer") {
    if (fields.length !== 1) {
      throw new RefParseError(
        `"mixer" is a bare segment and takes no fields, got "${raw}" at position ${String(segIndex)}`
      );
    }
    return { kind: "mixer" };
  }

  // --- param: variant decided by predecessor ---
  if (refKind === "param") {
    const middle = fields[1];
    if (middle === undefined) {
      throw new RefParseError(
        `"param" segment is missing its selector/index at position ${String(segIndex)}`
      );
    }
    const looksLikeKeyword = MIXER_PARAM_KEYWORDS.has(middle);

    if (prevKind === "mixer") {
      if (!looksLikeKeyword) {
        throw new RefParseError(
          `mixer param must be "volume", "pan", or "send:N", got "${raw}" at position ${String(
            segIndex
          )}`
        );
      }
      if (middle === "send") {
        const idxField = fields[2];
        if (idxField === undefined) {
          throw new RefParseError(
            `"param:send" is missing its index at position ${String(segIndex)}`
          );
        }
        if (fields.length !== 3) {
          throw new RefParseError(
            `"param:send:N" takes exactly one index, got "${raw}" at position ${String(segIndex)}`
          );
        }
        const sendIndex = parseIndexField(
          idxField,
          `"param:send" at position ${String(segIndex)}`
        );
        return {
          kind: "param",
          under: "mixer",
          ref: { selector: "send", sendIndex },
        };
      }
      // volume | pan
      if (fields.length !== 2) {
        throw new RefParseError(
          `"param:${middle}" takes no extra fields, got "${raw}" at position ${String(segIndex)}`
        );
      }
      return {
        kind: "param",
        under: "mixer",
        ref: middle === "volume" ? { selector: "volume" } : { selector: "pan" },
      };
    }

    if (prevKind === "device") {
      // Device param: kind:index:name. A keyword in the middle field here would
      // be an index error (caught by parseIndexField), which is correct — under
      // a device the form is always index:name.
      const nameField = fields[2];
      if (nameField === undefined) {
        throw new RefParseError(
          `device "param" must be "param:index:name", got "${raw}" at position ${String(segIndex)}`
        );
      }
      if (fields.length !== 3) {
        throw new RefParseError(
          `device "param" takes exactly index and name, got "${raw}" at position ${String(
            segIndex
          )}`
        );
      }
      const index = parseIndexField(
        fields[1],
        `device "param" at position ${String(segIndex)}`
      );
      return {
        kind: "param",
        under: "device",
        index,
        name: decodeName(nameField),
      };
    }

    throw new RefParseError(
      `"param" at position ${String(segIndex)} must follow a "mixer" or "device" segment` +
        (prevKind === null ? " (it cannot be first)" : `, not "${prevKind}"`)
    );
  }

  // --- clipSlot: index-only (no name) ---
  if (refKind === "clipSlot") {
    if (fields.length !== 2) {
      throw new RefParseError(
        `"clipSlot" is index-only ("clipSlot:N"), got "${raw}" at position ${String(segIndex)}`
      );
    }
    const index = parseIndexField(
      fields[1],
      `"clipSlot" at position ${String(segIndex)}`
    );
    return { kind: "clipSlot", index, name: "" };
  }

  // --- standard indexed kinds: kind:index:name ---
  // The remaining kinds (mixer/param/clipSlot returned above) all share the
  // index:name shape. Switching on `refKind` lets the compiler prove
  // exhaustiveness: the `default` is a `never` guard, so adding a new RefKind
  // becomes a compile error rather than silent fall-through — and there is no
  // unreachable trailing throw (TS7027).
  switch (refKind) {
    case "track":
    case "clip":
    case "takeLane":
    case "scene":
    case "cuePoint":
    case "device":
    case "chain": {
      const nameField = fields[2];
      if (fields.length !== 3 || nameField === undefined) {
        throw new RefParseError(
          `"${refKind}" must be "${refKind}:index:name", got "${raw}" at position ${String(
            segIndex
          )}`
        );
      }
      const index = parseIndexField(
        fields[1],
        `"${refKind}" at position ${String(segIndex)}`
      );
      return { kind: refKind, index, name: decodeName(nameField) };
    }
    default: {
      // Exhaustiveness guard: every RefKind is handled above (mixer/param/
      // clipSlot returned earlier). If a new kind is added to RefKind without
      // a case here, this assignment fails to compile.
      const _exhaustive: never = refKind;
      throw new RefParseError(
        `Unhandled kind "${String(_exhaustive)}" at position ${String(segIndex)}`
      );
    }
  }
}

/**
 * Parse a ref string into a {@link ParsedRef}. Splits on `/` (names never
 * contain a raw `/` — it is escaped as `%2F`), then parses each segment by kind,
 * deciding `param`'s variant from its predecessor.
 *
 * Throws {@link RefParseError} on: empty input, leading/trailing slash, empty
 * segment (`//`), unknown kind, non-numeric index, malformed `%`-escape,
 * `param:send` missing its index, or any structurally impossible segment.
 * Structural/semantic legality of the whole path (parent/child rules) is the
 * job of {@link validateRef}, not this function.
 */
export function parseRef(ref: string): ParsedRef {
  if (ref === "") {
    throw new RefParseError("Cannot parse an empty ref");
  }
  if (ref.startsWith("/")) {
    throw new RefParseError(`Ref must not start with "/": "${ref}"`);
  }
  if (ref.endsWith("/")) {
    throw new RefParseError(`Ref must not end with "/": "${ref}"`);
  }

  const rawSegments = ref.split("/");
  const segments: RefSegment[] = [];
  let prevKind: RefKind | null = null;

  for (let i = 0; i < rawSegments.length; i++) {
    const segment = parseSegment(rawSegments[i], prevKind, i);
    segments.push(segment);
    prevKind = segment.kind;
  }

  return { segments, source: ref };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** Serialize a single segment to its canonical string form. */
function serializeSegment(segment: RefSegment): string {
  switch (segment.kind) {
    case "mixer":
      return "mixer";
    case "clipSlot":
      // Index-only; the (always empty) name is not serialized.
      return `clipSlot:${String(segment.index)}`;
    case "param":
      if (segment.under === "mixer") {
        const sel = segment.ref;
        switch (sel.selector) {
          case "volume":
            return "param:volume";
          case "pan":
            return "param:pan";
          case "send":
            return `param:send:${String(sel.sendIndex)}`;
          default:
            // Exhaustiveness guard: adding a new MixerParamSelector member
            // without a case here is a compile error. Inside the switch so the
            // call is reachable control flow (no TS7027).
            return assertNever(sel);
        }
      }
      // under: "device"
      return `param:${String(segment.index)}:${encodeName(segment.name)}`;
    case "track":
    case "clip":
    case "takeLane":
    case "scene":
    case "cuePoint":
    case "device":
    case "chain":
      return `${segment.kind}:${String(segment.index)}:${encodeName(segment.name)}`;
  }
}

/** Compile-time exhaustiveness guard. */
function assertNever(value: never): never {
  throw new RefParseError(
    `Unexpected value in ref serialization: ${JSON.stringify(value)}`
  );
}

/**
 * Serialize a list of segments to a canonical ref string. The inverse of
 * {@link parseRef}: `parseRef(serializeRef(s)).segments` deep-equals `s` for
 * every valid `s`, and `serializeRef(parseRef(x).segments) === x` for every
 * canonical `x`. Percent-encodes the name field only.
 */
export function serializeRef(segments: RefSegment[]): string {
  return segments.map(serializeSegment).join("/");
}

// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------

/** Legal parent kinds for each kind. `null` means "must be top-level". */
function checkParentLegality(
  segment: RefSegment,
  prevKind: RefKind | null,
  pos: number
): string[] {
  const issues: string[] = [];
  const at = ` (segment ${String(pos)})`;

  switch (segment.kind) {
    case "track":
    case "scene":
    case "cuePoint":
      if (prevKind !== null) {
        issues.push(
          `"${segment.kind}" must be top-level (song-anchored), not under "${prevKind}"${at}`
        );
      }
      break;

    case "clipSlot":
    case "takeLane":
      if (prevKind !== "track") {
        issues.push(
          `"${segment.kind}" parent must be a track, not "${prevKind ?? "(song)"}"${at}`
        );
      }
      break;

    case "clip":
      if (
        prevKind !== "track" &&
        prevKind !== "clipSlot" &&
        prevKind !== "takeLane"
      ) {
        issues.push(
          `"clip" parent must be a track, clipSlot, or takeLane, not "${prevKind ?? "(song)"}"${at}`
        );
      }
      break;

    case "mixer":
      if (prevKind !== "track" && prevKind !== "chain") {
        issues.push(
          `"mixer" parent must be a track or chain, not "${prevKind ?? "(song)"}"${at}`
        );
      }
      break;

    case "device":
      if (prevKind !== "track" && prevKind !== "chain") {
        issues.push(
          `"device" parent must be a track or chain, not "${prevKind ?? "(song)"}"${at}`
        );
      }
      break;

    case "chain":
      if (prevKind !== "device") {
        issues.push(
          `"chain" parent must be a device, not "${prevKind ?? "(song)"}"${at}`
        );
      }
      break;

    case "param":
      if (segment.under === "mixer" && prevKind !== "mixer") {
        issues.push(
          `mixer "param" must follow a "mixer" segment, not "${prevKind ?? "(song)"}"${at}`
        );
      }
      if (segment.under === "device" && prevKind !== "device") {
        issues.push(
          `device "param" must follow a "device" segment, not "${prevKind ?? "(song)"}"${at}`
        );
      }
      break;
  }

  return issues;
}

/** Check non-negative index/sendIndex bounds for a segment. */
function checkBounds(segment: RefSegment, pos: number): string[] {
  const issues: string[] = [];
  const at = ` (segment ${String(pos)})`;

  if (segment.kind === "param") {
    if (segment.under === "device" && segment.index < 0) {
      issues.push(`device "param" index must be >= 0${at}`);
    }
    if (
      segment.under === "mixer" &&
      segment.ref.selector === "send" &&
      segment.ref.sendIndex < 0
    ) {
      issues.push(`"param:send" sendIndex must be >= 0${at}`);
    }
    return issues;
  }
  if (segment.kind === "mixer") {
    return issues;
  }
  // IndexedSegment
  if (segment.index < 0) {
    issues.push(`"${segment.kind}" index must be >= 0${at}`);
  }
  return issues;
}

/**
 * Validate the *structural/semantic* legality of a parsed ref: that its
 * segments form a legal tree (parent/child kind rules) and all indices are
 * non-negative. Lexical errors are already handled by {@link parseRef}; this
 * function assumes a well-formed {@link ParsedRef} and checks the relationships
 * `parseRef` cannot (it parses segment-by-segment without a whole-path model).
 *
 * Returns `{ ok: true }` if clean, else `{ ok: false, issues }` listing *every*
 * problem found (not just the first), so callers can surface them all at once.
 */
export function validateRef(parsed: ParsedRef): ValidationResult {
  const issues: string[] = [];

  if (parsed.segments.length === 0) {
    issues.push("Ref has no segments");
    return { ok: false, issues };
  }

  let prevKind: RefKind | null = null;
  for (let i = 0; i < parsed.segments.length; i++) {
    const segment = parsed.segments[i];
    issues.push(...checkParentLegality(segment, prevKind, i));
    issues.push(...checkBounds(segment, i));
    prevKind = segment.kind;
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

// ---------------------------------------------------------------------------
// Sibling index-shift (subtree rebuild after a delete)
// ---------------------------------------------------------------------------

/**
 * Read the index of a segment at a given path position, if it is one of the
 * index-bearing kinds matching `kind`. Mixer and param (mixer) segments have no
 * comparable positional index for sibling-shift purposes.
 */
function segmentIndexForKind(
  segment: RefSegment,
  kind: RefKind
): number | null {
  if (segment.kind !== kind) {
    return null;
  }
  if (segment.kind === "mixer") {
    return null;
  }
  if (segment.kind === "param") {
    // Only device params carry a shiftable positional index; mixer params are
    // keyword-addressed and have no sibling ordering.
    return segment.under === "device" ? segment.index : null;
  }
  return segment.index;
}

/** Produce a copy of `segment` with its index decremented by one. */
function withDecrementedIndex(segment: RefSegment): RefSegment {
  if (segment.kind === "mixer") {
    return segment;
  }
  if (segment.kind === "param") {
    if (segment.under === "device") {
      return { ...segment, index: segment.index - 1 };
    }
    return segment;
  }
  return { ...segment, index: segment.index - 1 };
}

/**
 * Pure subtree-rebuild used by the resolver's Reference Table after a delete
 * (ARCHITECTURE §6, Design Decision 6). Given a list of canonical ref strings:
 *
 * - For every ref whose path passes through the affected parent collection
 *   (its first `depth` segments serialize exactly to `parentPrefix`) and whose
 *   segment at that level matches `kind`:
 *     - **drop** the ref if that segment's index === `deletedIndex` (it is the
 *       deleted object, or a descendant of it);
 *     - **decrement** that segment's index by one if it is `> deletedIndex`;
 *     - leave it untouched if its index is `< deletedIndex`.
 * - All refs that do not pass through the affected collection are returned
 *   unchanged.
 *
 * `parentPrefix` is the serialized path of the parent whose child collection
 * changed, or `""` for the song-level (top-level) collection. The transform is
 * a pure parse → mutate → serialize round-trip; it never touches the SDK.
 *
 * Refs that fail to parse are passed through unchanged (defensive — the table
 * holds canonical strings, so this should not happen in practice).
 *
 * @param refs          Canonical ref strings to rewrite.
 * @param parentPrefix  Serialized parent path, or `""` for song-level.
 * @param kind          Kind of the deleted child within that collection.
 * @param deletedIndex  Index of the deleted child.
 * @returns The rewritten list (deleted refs dropped, others shifted/untouched).
 */
export function shiftSiblingIndices(
  refs: string[],
  parentPrefix: string,
  kind: RefKind,
  deletedIndex: number
): string[] {
  // Depth of the affected segment = number of segments in the parent prefix.
  const parentDepth = parentPrefix === "" ? 0 : parentPrefix.split("/").length;

  const result: string[] = [];

  for (const ref of refs) {
    let parsed: ParsedRef;
    try {
      parsed = parseRef(ref);
    } catch {
      // Not canonical; leave it as-is rather than dropping data.
      result.push(ref);
      continue;
    }

    const segments = parsed.segments;

    // Must be deep enough to contain the affected segment.
    if (segments.length <= parentDepth) {
      result.push(ref);
      continue;
    }

    // The first `parentDepth` segments must serialize exactly to parentPrefix.
    const prefix = serializeRef(segments.slice(0, parentDepth));
    if (prefix !== parentPrefix) {
      result.push(ref);
      continue;
    }

    const affected = segments[parentDepth];
    const currentIndex = segmentIndexForKind(affected, kind);
    if (currentIndex === null) {
      // Same level but a different kind (or a non-indexed kind) — untouched.
      result.push(ref);
      continue;
    }

    if (currentIndex === deletedIndex) {
      // The deleted object itself, or a descendant of it — drop the ref.
      continue;
    }

    if (currentIndex > deletedIndex) {
      const rewritten = segments.slice();
      rewritten[parentDepth] = withDecrementedIndex(affected);
      result.push(serializeRef(rewritten));
      continue;
    }

    // currentIndex < deletedIndex — untouched.
    result.push(ref);
  }

  return result;
}
