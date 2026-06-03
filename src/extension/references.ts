/**
 * Reference resolver — the re-resolve-every-call identity layer (Phase 3, R1).
 *
 * The SDK has no stable object identity: handles die on delete *and* on move,
 * and names are not unique (ARCHITECTURE §1.4, §6). This module is the project's
 * highest-risk subsystem: every tool call re-resolves a **semantic ref**
 * (`track:2:Bass/device:1:Reverb/param:7:Decay`) against the *live* model,
 * never reusing a handle across calls.
 *
 * What it does (ARCHITECTURE §6):
 *  - Parse + structurally validate the ref via the pure grammar (`../shared/refs`).
 *  - Walk from `song`, segment by segment, reading the **live child collection**
 *    off the freshly-read parent (the SDK collection getters *are* the live
 *    re-query, so we never round-trip `getObjectFromHandle` just to "freshen"
 *    an object we already read from a getter).
 *  - Verify names for drift; on mismatch, do a unique-name search to re-anchor
 *    (1 match → accept + re-mint index; 0 → `ref_unresolved`; ≥2 →
 *    `ref_ambiguous`).
 *  - Assert the leaf's type once via `getObjectFromHandle`, so a stale-but-present
 *    index pointing at a wrong-typed object surfaces as `type_mismatch` rather
 *    than a silent wrong edit. This single call is the one point asserting the
 *    "fresh handle" guarantee against the SDK.
 *
 * It NEVER throws to its caller: every failure (lexical, structural, drift,
 * type) returns a structured {@link RefError}.
 *
 * Handle discipline (code-style "Async & SDK Discipline"): no handle or resolved
 * object is stored between calls. {@link ReferenceTable} holds canonical ref
 * **strings** only.
 */

import {
  Chain,
  ChainMixer,
  Clip,
  ClipSlot,
  CuePoint,
  DataModelObject,
  Device,
  DeviceParameter,
  Scene,
  TakeLane,
  Track,
  TrackMixer,
  type ApiVersion,
  type ExtensionContext,
  type Handle,
} from "@ableton-extensions/sdk";

import {
  parseRef,
  RefParseError,
  serializeRef,
  shiftSiblingIndices,
  validateRef,
  type DeviceParamSegment,
  type IndexedSegment,
  type MixerParamSegment,
  type RefSegment,
} from "../shared/refs.js";

// ---------------------------------------------------------------------------
// Public result / error types
// ---------------------------------------------------------------------------

/** Structured error returned (never thrown) on any resolution failure. */
export interface RefError {
  /** Failure class, matching the ARCHITECTURE §6 error contract. */
  error: "ref_unresolved" | "ref_ambiguous" | "type_mismatch";
  /** The ref string that failed (the original input). */
  ref: string;
  /** Human-readable detail (drift cause, expected-vs-actual type, etc.). */
  detail: string;
  /** Recovery hint for the agent. */
  hint: string;
}

/** Successful resolution: the freshly-resolved object plus its re-anchored ref. */
export interface ResolveOk<V extends ApiVersion> {
  ok: true;
  /** The live SDK object, resolved fresh this call — do NOT cache it. */
  object: DataModelObject<V>;
  /** The resolved object's concrete SDK className (e.g. `"AudioTrack"`). */
  className: string;
  /**
   * The canonical ref re-serialized from the ACTUAL resolved indices, so any
   * re-anchored drift (rename that shifted the matched index) is reflected.
   */
  canonicalRef: string;
}

/** Failed resolution. */
export interface ResolveErr {
  ok: false;
  err: RefError;
}

/** Result of {@link resolveRef} / {@link refFromHandle}. */
export type ResolveResult<V extends ApiVersion> = ResolveOk<V> | ResolveErr;

const DEFAULT_HINT = "re-read with live_get_project";

// ---------------------------------------------------------------------------
// Expected-class injection (works against both the SDK and the test fake)
// ---------------------------------------------------------------------------

/**
 * An abstract class token, matching the SDK's `getObjectFromHandle` `type`
 * parameter shape (`abstract new (...args: never) => T`). The resolver only ever
 * passes these tokens through to `getObjectFromHandle`; it never constructs them.
 *
 * The real SDK classes are used by default. The test fake supplies its own
 * `FakeClass` tokens (tagged with a matching `static className`) so the resolver
 * runs UNMODIFIED in both environments — see {@link resolveRef}.
 */
export type ClassToken = abstract new (
  ...args: never[]
) => DataModelObject<ApiVersion>;

/**
 * The set of class tokens the resolver needs:
 *  - `probe` — the base class passed when distinguishing deleted (throws) from
 *    wrong-type (succeeds) in the exceptional `getObjectFromHandle`-throw path.
 *  - one **base** token per leaf kind for the single leaf type-assertion. Always
 *    the base class (`Track`, not `AudioTrack`; `Device`, not `Simpler`) so a
 *    legal subtype is never a false `type_mismatch`.
 */
export interface ClassTokens {
  probe: ClassToken;
  track: ClassToken;
  clip: ClassToken;
  clipSlot: ClassToken;
  takeLane: ClassToken;
  scene: ClassToken;
  cuePoint: ClassToken;
  device: ClassToken;
  chain: ClassToken;
  trackMixer: ClassToken;
  chainMixer: ClassToken;
  param: ClassToken;
}

/**
 * Default class-token map built from the real SDK class constructors. The SDK's
 * `getObjectFromHandle` does an `obj instanceof type` check, so passing the base
 * class accepts every legal subtype; `DataModelObject` accepts any live object
 * (the probe). Tests inject {@link ClassTokens} backed by the fake's `FakeClass`
 * tokens instead.
 */
const SDK_CLASS_TOKENS: ClassTokens = {
  probe: DataModelObject,
  track: Track,
  clip: Clip,
  clipSlot: ClipSlot,
  takeLane: TakeLane,
  scene: Scene,
  cuePoint: CuePoint,
  device: Device,
  chain: Chain,
  trackMixer: TrackMixer,
  chainMixer: ChainMixer,
  param: DeviceParameter,
};

// ---------------------------------------------------------------------------
// Internal walk types
// ---------------------------------------------------------------------------

/**
 * Minimal structural view of the SDK objects the walk reads. The resolver only
 * accesses collection getters and `.name`/`.handle`; everything is typed as
 * `unknown`-bearing accessors and narrowed at the access site. Declaring this
 * locally keeps the walk decoupled from each concrete SDK class while staying
 * fully type-checked (no `any`).
 */
interface WalkNode {
  readonly handle: Handle;
}

/** A node that carries a `.name` getter (everything except clipSlot/mixers). */
interface NamedNode extends WalkNode {
  readonly name: string;
}

/**
 * Outcome of resolving one segment: either the accepted child node and its
 * actually-resolved index (which may differ from the segment's index after a
 * unique-name re-anchor), or a structured error.
 */
type StepResult =
  | { ok: true; node: WalkNode; resolvedIndex: number | null; name: string }
  | { ok: false; err: RefError };

// ---------------------------------------------------------------------------
// Small typed accessors (narrow `unknown` instead of using `any`)
// ---------------------------------------------------------------------------

/** Read a named collection getter off a node as a fresh array, or `null`. */
function readCollection(node: unknown, key: string): WalkNode[] | null {
  if (typeof node !== "object" || node === null) {
    return null;
  }
  const value = (node as Record<string, unknown>)[key];
  return Array.isArray(value) ? (value as WalkNode[]) : null;
}

/** Read a single (non-array) object-valued getter off a node, or `null`. */
function readSingle(node: unknown, key: string): WalkNode | null {
  if (typeof node !== "object" || node === null) {
    return null;
  }
  const value = (node as Record<string, unknown>)[key];
  if (value !== null && typeof value === "object" && "handle" in value) {
    return value as WalkNode;
  }
  return null;
}

/** Read a node's `.name` getter if present, else `null` (clipSlot/mixer). */
function readName(node: WalkNode): string | null {
  const value = (node as Partial<NamedNode>).name;
  return typeof value === "string" ? value : null;
}

// ---------------------------------------------------------------------------
// Drift-aware collection step (index → name verify → unique-name re-anchor)
// ---------------------------------------------------------------------------

/**
 * Resolve one child within a known live collection, applying the §6 drift
 * authority chain: index first, then name verification, then a unique-name
 * search to re-anchor.
 *
 * @param collection   The freshly-read live child array.
 * @param index        The segment's recorded index.
 * @param expectedName The segment's recorded name, or `null` if the kind has no
 *                     name (clipSlot) — in which case it is index-only.
 * @param ref          The original ref (for error payloads).
 */
function stepInCollection(
  collection: WalkNode[],
  index: number,
  expectedName: string | null,
  ref: string
): StepResult {
  const candidate =
    index >= 0 && index < collection.length ? collection[index] : undefined;

  // Index-only kinds (clipSlot): the index is the sole authority.
  if (expectedName === null) {
    if (candidate === undefined) {
      return {
        ok: false,
        err: refError(
          "ref_unresolved",
          ref,
          `index ${String(index)} is out of range (collection length ${String(
            collection.length
          )})`
        ),
      };
    }
    return { ok: true, node: candidate, resolvedIndex: index, name: "" };
  }

  // Named kinds: accept the indexed candidate if its name still matches.
  if (candidate !== undefined && readName(candidate) === expectedName) {
    return {
      ok: true,
      node: candidate,
      resolvedIndex: index,
      name: expectedName,
    };
  }

  // Drift: index missing or renamed → unique-name search across the collection.
  const matches: { node: WalkNode; index: number }[] = [];
  for (let i = 0; i < collection.length; i++) {
    if (readName(collection[i]) === expectedName) {
      matches.push({ node: collection[i], index: i });
    }
  }

  if (matches.length === 1) {
    const match = matches[0];
    return {
      ok: true,
      node: match.node,
      resolvedIndex: match.index,
      name: expectedName,
    };
  }
  if (matches.length === 0) {
    return {
      ok: false,
      err: refError(
        "ref_unresolved",
        ref,
        `no object named "${expectedName}" at index ${String(
          index
        )} or elsewhere in the collection (length ${String(collection.length)})`
      ),
    };
  }
  return {
    ok: false,
    err: refError(
      "ref_ambiguous",
      ref,
      `${String(matches.length)} objects named "${expectedName}" in the collection; cannot disambiguate`
    ),
  };
}

// ---------------------------------------------------------------------------
// Per-segment dispatch (kind → live accessor on the current parent)
// ---------------------------------------------------------------------------

/**
 * Resolve a single segment against `parent`, reading the correct live child
 * collection/single-getter per the kind→accessor map (ARCHITECTURE §6, Design
 * Decision 4). `prevSegment` disambiguates `clip` (parent kind) and is unused
 * otherwise.
 */
function resolveSegment(
  parent: WalkNode,
  segment: RefSegment,
  prevSegment: RefSegment | null,
  ref: string
): StepResult {
  switch (segment.kind) {
    case "track": {
      const tracks = readCollection(parent, "tracks");
      if (tracks === null) {
        return missingCollection(ref, "tracks");
      }
      return stepInCollection(tracks, segment.index, segment.name, ref);
    }
    case "scene": {
      const scenes = readCollection(parent, "scenes");
      if (scenes === null) {
        return missingCollection(ref, "scenes");
      }
      return stepInCollection(scenes, segment.index, segment.name, ref);
    }
    case "cuePoint": {
      const cuePoints = readCollection(parent, "cuePoints");
      if (cuePoints === null) {
        return missingCollection(ref, "cuePoints");
      }
      return stepInCollection(cuePoints, segment.index, segment.name, ref);
    }
    case "clipSlot": {
      const slots = readCollection(parent, "clipSlots");
      if (slots === null) {
        return missingCollection(ref, "clipSlots");
      }
      // Index-only (no name).
      return stepInCollection(slots, segment.index, null, ref);
    }
    case "takeLane": {
      const lanes = readCollection(parent, "takeLanes");
      if (lanes === null) {
        return missingCollection(ref, "takeLanes");
      }
      return stepInCollection(lanes, segment.index, segment.name, ref);
    }
    case "clip":
      return resolveClipSegment(parent, segment, prevSegment, ref);
    case "device": {
      const devices = readCollection(parent, "devices");
      if (devices === null) {
        return missingCollection(ref, "devices");
      }
      return stepInCollection(devices, segment.index, segment.name, ref);
    }
    case "chain": {
      // Parent must be a rack device (exposes `chains`); narrow by presence.
      const chains = readCollection(parent, "chains");
      if (chains === null) {
        return {
          ok: false,
          err: refError(
            "ref_unresolved",
            ref,
            "parent device exposes no chains (not a rack device)"
          ),
        };
      }
      return stepInCollection(chains, segment.index, segment.name, ref);
    }
    case "mixer": {
      const mixer = readSingle(parent, "mixer");
      if (mixer === null) {
        return missingCollection(ref, "mixer");
      }
      // Mixer has no name; single object, no index re-anchoring.
      return { ok: true, node: mixer, resolvedIndex: null, name: "" };
    }
    case "param":
      return resolveParamSegment(parent, segment, ref);
  }
}

/** Resolve a `clip` segment, disambiguating by the parent kind (§6 / DD4). */
function resolveClipSegment(
  parent: WalkNode,
  segment: IndexedSegment,
  prevSegment: RefSegment | null,
  ref: string
): StepResult {
  const parentKind = prevSegment?.kind ?? null;

  if (parentKind === "track") {
    const clips = readCollection(parent, "arrangementClips");
    if (clips === null) {
      return missingCollection(ref, "arrangementClips");
    }
    return stepInCollection(clips, segment.index, segment.name, ref);
  }
  if (parentKind === "takeLane") {
    const clips = readCollection(parent, "clips");
    if (clips === null) {
      return missingCollection(ref, "clips");
    }
    return stepInCollection(clips, segment.index, segment.name, ref);
  }
  if (parentKind === "clipSlot") {
    // A slot holds a single optional clip; the index must be 0.
    if (segment.index !== 0) {
      return {
        ok: false,
        err: refError(
          "ref_unresolved",
          ref,
          `a clipSlot holds a single clip; expected index 0, got ${String(
            segment.index
          )}`
        ),
      };
    }
    const clip = readSingle(parent, "clip");
    if (clip === null) {
      return {
        ok: false,
        err: refError(
          "ref_unresolved",
          ref,
          "the clip slot is empty (no clip)"
        ),
      };
    }
    // Single clip: verify the name for drift detection, but there is no sibling
    // collection to re-anchor against — a mismatch is unresolved.
    if (readName(clip) !== segment.name) {
      return {
        ok: false,
        err: refError(
          "ref_unresolved",
          ref,
          `clip in slot is named "${String(
            readName(clip)
          )}", expected "${segment.name}"`
        ),
      };
    }
    return { ok: true, node: clip, resolvedIndex: 0, name: segment.name };
  }

  // Structurally validated upstream, but guard defensively.
  return {
    ok: false,
    err: refError(
      "ref_unresolved",
      ref,
      `clip parent kind "${String(parentKind)}" is not track/clipSlot/takeLane`
    ),
  };
}

/** Resolve a `param` segment under either a mixer or a device parent (§6 / DD4). */
function resolveParamSegment(
  parent: WalkNode,
  segment: MixerParamSegment | DeviceParamSegment,
  ref: string
): StepResult {
  if (segment.under === "mixer") {
    const sel = segment.ref;
    if (sel.selector === "volume" || sel.selector === "pan") {
      const key = sel.selector === "volume" ? "volume" : "panning";
      const param = readSingle(parent, key);
      if (param === null) {
        return missingCollection(ref, key);
      }
      return { ok: true, node: param, resolvedIndex: null, name: "" };
    }
    // send:N
    const sends = readCollection(parent, "sends");
    if (sends === null) {
      return missingCollection(ref, "sends");
    }
    if (sel.sendIndex < 0 || sel.sendIndex >= sends.length) {
      return {
        ok: false,
        err: refError(
          "ref_unresolved",
          ref,
          `send index ${String(sel.sendIndex)} out of range (${String(
            sends.length
          )} sends)`
        ),
      };
    }
    // Sends are keyword-addressed by position; no name re-anchor.
    return {
      ok: true,
      node: sends[sel.sendIndex],
      resolvedIndex: sel.sendIndex,
      name: "",
    };
  }

  // under: "device" — index:name device parameter.
  const params = readCollection(parent, "parameters");
  if (params === null) {
    return missingCollection(ref, "parameters");
  }
  return stepInCollection(params, segment.index, segment.name, ref);
}

/** Build a `ref_unresolved` error for a parent that lacks an expected accessor. */
function missingCollection(ref: string, key: string): StepResult {
  return {
    ok: false,
    err: refError(
      "ref_unresolved",
      ref,
      `parent object has no "${key}" collection/getter at this position`
    ),
  };
}

/** Construct a {@link RefError} with the default recovery hint. */
function refError(
  error: RefError["error"],
  ref: string,
  detail: string
): RefError {
  return { error, ref, detail, hint: DEFAULT_HINT };
}

// ---------------------------------------------------------------------------
// Leaf type-assertion
// ---------------------------------------------------------------------------

/** Map a leaf segment to the base class token it must satisfy. */
function leafToken(segment: RefSegment, tokens: ClassTokens): ClassToken {
  switch (segment.kind) {
    case "track":
      return tokens.track;
    case "clip":
      return tokens.clip;
    case "clipSlot":
      return tokens.clipSlot;
    case "takeLane":
      return tokens.takeLane;
    case "scene":
      return tokens.scene;
    case "cuePoint":
      return tokens.cuePoint;
    case "device":
      return tokens.device;
    case "chain":
      return tokens.chain;
    case "param":
      return tokens.param;
    case "mixer":
      // A `mixer` leaf is a TrackMixer or ChainMixer; we cannot tell which from
      // the ref alone (both are valid), so the leaf assertion is skipped for
      // bare mixer leaves (handled by the caller). This branch is unreachable
      // for assertion purposes; return the probe as a harmless default.
      return tokens.probe;
  }
}

// ---------------------------------------------------------------------------
// resolveRef — the public re-resolve-every-call entry point
// ---------------------------------------------------------------------------

/**
 * Re-resolve a semantic ref against the live model, returning the fresh object.
 *
 * Pipeline: parse (lexical) → validate (structural) → walk (live, drift-aware)
 * → single leaf type-assertion → return `{ ok, object, className, canonicalRef }`,
 * where `canonicalRef` is re-serialized from the indices actually resolved (so a
 * re-anchored rename is reflected for the agent to re-ground on).
 *
 * NEVER throws — every failure path returns a structured {@link RefError}. The
 * resolved object is fresh this call and MUST NOT be cached by the caller.
 *
 * @param ctx    The extension context (real SDK or {@link ../../tests/fixtures/fake-extension-context}).
 * @param ref    The semantic ref string.
 * @param tokens Optional class-token override (tests inject the fake's tokens);
 *               defaults to the real SDK classes.
 */
export function resolveRef<V extends ApiVersion>(
  ctx: ExtensionContext<V>,
  ref: string,
  tokens: ClassTokens = SDK_CLASS_TOKENS
): ResolveResult<V> {
  try {
    // 1. Parse (lexical).
    let segments: RefSegment[];
    try {
      const parsed = parseRef(ref);
      segments = parsed.segments;
    } catch (e) {
      const detail =
        e instanceof RefParseError ? e.message : "ref failed to parse";
      return { ok: false, err: refError("ref_unresolved", ref, detail) };
    }

    // 2. Validate (structural legality of the whole path).
    const validation = validateRef({ segments, source: ref });
    if (!validation.ok) {
      return {
        ok: false,
        err: refError(
          "ref_unresolved",
          ref,
          `structurally invalid ref: ${validation.issues.join("; ")}`
        ),
      };
    }
    if (segments.length === 0) {
      return {
        ok: false,
        err: refError("ref_unresolved", ref, "ref has no segments"),
      };
    }

    // 3. Walk. Re-read the song fresh at the top of EVERY call (never stored).
    const song = ctx.application.song as unknown as WalkNode;
    let parent: WalkNode = song;
    const resolvedSegments: RefSegment[] = [];

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const prev = i > 0 ? segments[i - 1] : null;
      const step = resolveSegment(parent, segment, prev, ref);
      if (!step.ok) {
        return { ok: false, err: step.err };
      }
      resolvedSegments.push(
        reindexSegment(segment, step.resolvedIndex, step.name)
      );
      parent = step.node;
    }

    // 4. Single leaf type-assertion via getObjectFromHandle (the one place the
    //    "fresh handle" guarantee is asserted against the SDK). Skipped only for
    //    a bare `mixer` leaf, whose concrete class (Track/Chain mixer) is
    //    ambiguous from the ref alone.
    const leafSegment = segments[segments.length - 1];
    const leafHandle = parent.handle;

    if (leafSegment.kind !== "mixer") {
      const expected = leafToken(leafSegment, tokens);
      const asserted = assertType(
        ctx,
        leafHandle,
        expected,
        tokens.probe,
        leafSegment.kind,
        ref
      );
      if (!asserted.ok) {
        return asserted;
      }
      return {
        ok: true,
        object: asserted.object,
        className: asserted.className,
        canonicalRef: serializeRef(resolvedSegments),
      };
    }

    // Bare mixer leaf: probe for liveness without a concrete assertion. The
    // concrete class (Track vs Chain mixer) is ambiguous from the ref alone, so
    // report the base mixer className.
    const probed = probeObject(ctx, leafHandle, tokens.probe, ref);
    if (!probed.ok) {
      return probed;
    }
    return {
      ok: true,
      object: probed.object,
      className: classNameOf(probed.object, "MixerDevice"),
      canonicalRef: serializeRef(resolvedSegments),
    };
  } catch (e) {
    // Defensive: the walk should never throw, but any unexpected error becomes a
    // structured failure rather than escaping to the tool-use loop.
    const detail = e instanceof Error ? e.message : "unexpected resolver error";
    console.error(`resolveRef("${ref}") unexpected error: ${detail}`);
    return { ok: false, err: refError("ref_unresolved", ref, detail) };
  }
}

/**
 * Re-mint a segment with its actually-resolved index (and name) so the canonical
 * ref reflects re-anchored drift. Index-less kinds (mixer, mixer-param) are
 * returned unchanged; device params and indexed kinds adopt the resolved index.
 */
function reindexSegment(
  segment: RefSegment,
  resolvedIndex: number | null,
  resolvedName: string
): RefSegment {
  if (resolvedIndex === null) {
    return segment;
  }
  if (segment.kind === "param") {
    if (segment.under === "device") {
      return { ...segment, index: resolvedIndex, name: resolvedName };
    }
    return segment; // mixer param: keyword-addressed, no index re-mint
  }
  if (segment.kind === "mixer") {
    return segment;
  }
  if (segment.kind === "clipSlot") {
    return { ...segment, index: resolvedIndex };
  }
  return { ...segment, index: resolvedIndex, name: resolvedName };
}

/**
 * Assert the leaf object's type via `getObjectFromHandle`. On a throw, re-probe
 * with the base class: probe succeeds ⇒ object exists but is the wrong type
 * (`type_mismatch`); probe also throws ⇒ object is gone (`ref_unresolved`).
 */
function assertType<V extends ApiVersion>(
  ctx: ExtensionContext<V>,
  handle: Handle,
  expected: ClassToken,
  probe: ClassToken,
  leafKind: RefSegment["kind"],
  ref: string
): { ok: true; object: DataModelObject<V>; className: string } | ResolveErr {
  try {
    const object = ctx.getObjectFromHandle(
      handle,
      expected as unknown as abstract new (...args: never) => DataModelObject<V>
    );
    // Prefer the runtime concrete className (real SDK: "AudioTrack" etc.); fall
    // back to a kind-derived label when the object's constructor carries no
    // `static className` (e.g. the test fake's plain-object proxies).
    return {
      ok: true,
      object,
      className: classNameOf(object, baseClassNameForKind(leafKind)),
    };
  } catch {
    // Disambiguate deleted vs wrong-type via the base-class probe.
    const probed = probeObject(ctx, handle, probe, ref);
    if (!probed.ok) {
      // Probe also threw → genuinely gone.
      return probed;
    }
    return {
      ok: false,
      err: refError(
        "type_mismatch",
        ref,
        `object at the resolved position is "${probed.className}", not the expected type for this ref kind`
      ),
    };
  }
}

/**
 * Resolve a handle with the base probe class. Succeeds for any live object;
 * throws (→ `ref_unresolved`) only if the handle is dead.
 */
function probeObject<V extends ApiVersion>(
  ctx: ExtensionContext<V>,
  handle: Handle,
  probe: ClassToken,
  ref: string
): { ok: true; object: DataModelObject<V>; className: string } | ResolveErr {
  try {
    const object = ctx.getObjectFromHandle(
      handle,
      probe as unknown as abstract new (...args: never) => DataModelObject<V>
    );
    return { ok: true, object, className: classNameOf(object, "unknown") };
  } catch {
    return {
      ok: false,
      err: refError(
        "ref_unresolved",
        ref,
        "the resolved handle is no longer valid (object deleted)"
      ),
    };
  }
}

/**
 * Read an object's concrete className. Real SDK objects expose it as a `static`
 * member on their constructor (e.g. `"AudioTrack"`); the test fake's
 * materialized proxies are plain objects with no such tag, so we fall back to
 * the provided base-class label so the value is still meaningful in both
 * environments.
 */
function classNameOf(
  object: DataModelObject<ApiVersion>,
  fallback: string
): string {
  const ctor = (object as { constructor?: { className?: unknown } })
    .constructor;
  if (ctor && typeof ctor.className === "string") {
    return ctor.className;
  }
  return fallback;
}

/** Base SDK class name for a ref kind, used as a className fallback. */
function baseClassNameForKind(kind: RefSegment["kind"]): string {
  switch (kind) {
    case "track":
      return "Track";
    case "clip":
      return "Clip";
    case "clipSlot":
      return "ClipSlot";
    case "takeLane":
      return "TakeLane";
    case "scene":
      return "Scene";
    case "cuePoint":
      return "CuePoint";
    case "device":
      return "Device";
    case "chain":
      return "Chain";
    case "param":
      return "DeviceParameter";
    case "mixer":
      return "MixerDevice";
  }
}

// ---------------------------------------------------------------------------
// refFromHandle — anchor a raw launch-scope handle
// ---------------------------------------------------------------------------

/**
 * Anchor a raw launch-scope {@link Handle} (from a context-menu scope) into a
 * canonical ref. With only a bare handle and no path, a full reverse-walk to the
 * song root is not generally possible through the SDK's forward-only getters.
 *
 * **Phase 3 scope (documented):** this implements the type-probe contract and
 * full anchoring for the **top-level** launch scopes only — `track` (incl.
 * Audio/Midi subtypes), `scene`, and `cuePoint`. It:
 *  1. probes the handle for liveness via the base class (deleted ⇒
 *     `ref_unresolved`);
 *  2. identifies the kind by probing the top-level class tokens (`instanceof` in
 *     the SDK, assignable-to in the fake) — never by a className string, so it
 *     works against both environments;
 *  3. finds the object's actual position in the matching song collection by
 *     handle id and mints a canonical single-segment ref with the real index +
 *     name.
 *
 * Nested launch scopes (a clip/device/param handle) cannot be anchored from a
 * bare handle alone; those return `type_mismatch` here and are layered in later
 * phases once the launch routine supplies the scope path alongside the handle.
 *
 * @param tokens Optional class-token override (tests inject the fake's tokens).
 * @returns `{ ok: true, ref }` with the minted canonical ref, or a {@link ResolveErr}.
 */
export function refFromHandle<V extends ApiVersion>(
  ctx: ExtensionContext<V>,
  handle: Handle,
  tokens: ClassTokens = SDK_CLASS_TOKENS
): { ok: true; ref: string } | ResolveErr {
  // 1. Liveness probe — a dead handle is ref_unresolved, never type_mismatch.
  const probed = probeObject(ctx, handle, tokens.probe, "<handle>");
  if (!probed.ok) {
    return probed;
  }

  // 2. Kind discovery by token probing, ordered most-likely first.
  const song = ctx.application.song as unknown as WalkNode;
  const targetId = handle.id;

  if (isOfToken(ctx, handle, tokens.track)) {
    const found = findInCollection(song, "tracks", targetId);
    if (found) {
      return {
        ok: true,
        ref: serializeRef([
          { kind: "track", index: found.index, name: found.name },
        ]),
      };
    }
  }
  if (isOfToken(ctx, handle, tokens.scene)) {
    const found = findInCollection(song, "scenes", targetId);
    if (found) {
      return {
        ok: true,
        ref: serializeRef([
          { kind: "scene", index: found.index, name: found.name },
        ]),
      };
    }
  }
  if (isOfToken(ctx, handle, tokens.cuePoint)) {
    const found = findInCollection(song, "cuePoints", targetId);
    if (found) {
      return {
        ok: true,
        ref: serializeRef([
          { kind: "cuePoint", index: found.index, name: found.name },
        ]),
      };
    }
  }

  return {
    ok: false,
    err: refError(
      "type_mismatch",
      "<handle>",
      `launch-scope object "${probed.className}" is not a top-level track/scene/cuePoint anchorable from a bare handle in Phase 3`
    ),
  };
}

/** True if `handle` resolves as `token` (object is-a that class), else false. */
function isOfToken<V extends ApiVersion>(
  ctx: ExtensionContext<V>,
  handle: Handle,
  token: ClassToken
): boolean {
  try {
    ctx.getObjectFromHandle(
      handle,
      token as unknown as abstract new (...args: never) => DataModelObject<V>
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate a node by handle id within a top-level song collection, returning its
 * live index and name. Reads the collection fresh (no caching).
 */
function findInCollection(
  song: WalkNode,
  key: string,
  targetId: bigint
): { index: number; name: string } | null {
  const collection = readCollection(song, key);
  if (collection === null) {
    return null;
  }
  for (let i = 0; i < collection.length; i++) {
    if (collection[i].handle.id === targetId) {
      return { index: i, name: readName(collection[i]) ?? "" };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// ReferenceTable — turn-scoped canonical ref strings (no handles, no objects)
// ---------------------------------------------------------------------------

/**
 * Turn-scoped store of canonical ref **strings** (ARCHITECTURE §6, Design
 * Decision 6). It holds NO SDK handles or objects — only strings — so nothing is
 * cached across tool calls. After a delete, {@link invalidateAndShift} rewrites
 * the affected sibling indices purely (via `shiftSiblingIndices`) and returns the
 * updated set for the `refs_updated` payload.
 */
export class ReferenceTable {
  private readonly refs = new Set<string>();

  /** Store a canonical ref and return it (mirrors the create-then-return flow). */
  mint(ref: string): string {
    this.refs.add(ref);
    return ref;
  }

  /**
   * Drop the deleted ref and its descendants, shift later siblings down by one,
   * and return the resulting full ref set. Pure string/segment math — no SDK.
   *
   * @param deletedRef The canonical ref of the just-deleted object.
   * @returns The updated ref list (the `refs_updated` payload), or the unchanged
   *          list if `deletedRef` is not parseable.
   */
  invalidateAndShift(deletedRef: string): string[] {
    let segments: RefSegment[];
    try {
      segments = parseRef(deletedRef).segments;
    } catch {
      // Not canonical — cannot compute the shift; leave the table untouched.
      return this.all();
    }
    if (segments.length === 0) {
      return this.all();
    }

    // The deleted object's own segment is the last one; its parent prefix is
    // everything before it, and the affected collection is keyed by its kind.
    const lastSegment = segments[segments.length - 1];
    const parentSegments = segments.slice(0, -1);
    const parentPrefix = serializeRef(parentSegments);
    const deletedIndex = indexOfSegment(lastSegment);

    if (deletedIndex === null) {
      // Non-indexed leaf (mixer / mixer-param) — nothing to shift; just drop it.
      this.refs.delete(deletedRef);
      return this.all();
    }

    const current = [...this.refs];
    const rewritten = shiftSiblingIndices(
      current,
      parentPrefix,
      lastSegment.kind,
      deletedIndex
    );

    this.refs.clear();
    for (const r of rewritten) {
      this.refs.add(r);
    }
    return this.all();
  }

  /** All stored canonical refs (order not guaranteed). */
  all(): string[] {
    return [...this.refs];
  }

  /** Clear the table for a fresh turn (per-turn rebuild). */
  reset(): void {
    this.refs.clear();
  }
}

/** Read the shiftable positional index of a segment, or `null` if it has none. */
function indexOfSegment(segment: RefSegment): number | null {
  if (segment.kind === "mixer") {
    return null;
  }
  if (segment.kind === "param") {
    return segment.under === "device" ? segment.index : null;
  }
  return segment.index;
}
