/**
 * FakeExtensionContext — a hand-built SDK stand-in for resolver tests (Phase 3).
 *
 * Mirrors the structural surface of `@ableton-extensions/sdk` closely enough that
 * the reference resolver's drift and error-mapping paths are genuinely exercised
 * (docs/ARCHITECTURE.md §6, §14). It is NOT the real SDK: it does not instantiate
 * any SDK class. Instead it backs every "object" with a mutable in-memory tree of
 * {@link FakeNode}s and exposes thin getter-proxies whose collection getters return
 * FRESH arrays computed from the current tree on each access — so a `reorder` /
 * `remove` / `insert` is observed live exactly like the SDK's live re-query getters.
 *
 * Key SDK fidelity points reproduced here (source of truth = the .d.cts):
 *  - `getObjectFromHandle<T>(handle, type)` is SYNCHRONOUS and THROWS a single
 *    generic `Error` if the object was deleted, is a different type than `type`, or
 *    the type is unrecognized — never returns null. The resolver disambiguates
 *    deleted-vs-wrong-type by re-probing with the base `DataModelObject` class, so
 *    the thrown error is intentionally message-agnostic: the probe SUCCEEDS for a
 *    live-but-wrong-type node and THROWS for a deleted/missing node.
 *  - `Handle = { id: bigint }`.
 *  - Subtype identity: an `AudioTrack`/`MidiTrack` node is reachable as a `Track`;
 *    `Simpler`/`RackDevice`/`DrumRack` reachable as `Device`; `DrumChain` as
 *    `Chain`; `TrackMixer`/`ChainMixer` as their own classes. A className →
 *    assignable-bases table encodes this is-a relationship.
 *
 * Drift is driven exclusively by the helper methods on the returned context
 * (`reorder`/`rename`/`remove`/`insert`/`handleOf`); the fake exposes none of the
 * SDK's create/mutate methods, only the read getters the resolver reads.
 *
 * Navigation by the helpers uses a compact INTERNAL address scheme (not the
 * `src/shared/refs.ts` grammar, which is implemented in parallel) so the fixture is
 * self-contained. See {@link FakeExtensionContext} for the address syntax.
 */

// #region Structural SDK type mirror
//
// These interfaces mirror the getter/collection NAMES the resolver reads from the
// real SDK classes. They are intentionally minimal — only the members the resolver
// touches — and are declared locally so the fixture stays decoupled from the SDK
// package (its types are not in the tests tsconfig include set) and from the
// in-parallel `src/shared/refs.ts`.

/** Mirror of `@ableton-extensions/sdk` `Handle`. */
export interface Handle {
  id: bigint;
}

/**
 * Constructor-token type accepted by {@link FakeExtensionContext.getObjectFromHandle},
 * matching the SDK's `abstract new (...args: never) => T` signature. The fake only
 * uses the token's identity (via its `className` tag), never constructs it.
 */
export type AbstractCtor<T> = abstract new (...args: never[]) => T;

/** Base of every fake object; mirrors SDK `DataModelObject`. */
export interface FakeObject {
  readonly handle: Handle;
}

/**
 * Mirror of SDK `WarpMode`. Duplicated locally (not imported) to keep the fixture
 * decoupled from the SDK package, matching the existing decoupling policy. Values
 * are pinned to the SDK enum (docs/ARCHITECTURE.md §14).
 */
export const FakeWarpMode = {
  Beats: 0,
  Tones: 1,
  Texture: 2,
  Repitch: 3,
  Complex: 4,
  ComplexPro: 6,
} as const;

/**
 * Mirror of SDK `NoteDescription` (extensions-sdk `index.d.mts`). `live_edit_midi_notes`
 * replaces the whole array; the getter returns a fresh COPY so callers cannot mutate
 * backing state without going through the setter.
 */
export interface FakeNoteDescription {
  pitch: number;
  startTime: number;
  duration: number;
  velocity?: number;
  muted?: boolean;
  probability?: number;
  velocityDeviation?: number;
  releaseVelocity?: number;
  selected?: boolean;
}

/**
 * DeviceParameter mirror. `getValue()`/`setValue()` are ASYNC (return a Promise) per
 * the SDK; `min`/`max`/`isQuantized`/`valueItems`/`name` are sync getters. `setValue`
 * CLAMPS to `[min, max]`; when `isQuantized`, it ROUNDS to the nearest integer index
 * (then clamps), matching a quantized parameter's discrete value-item domain.
 */
export interface FakeDeviceParameter extends FakeObject {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly isQuantized: boolean;
  readonly valueItems: { name: string; shortName: string }[];
  getValue(): Promise<number>;
  setValue(value: number): Promise<void>;
}

export interface FakeTrackMixer extends FakeObject {
  readonly volume: FakeDeviceParameter;
  readonly panning: FakeDeviceParameter;
  readonly sends: FakeDeviceParameter[];
}

export interface FakeChainMixer extends FakeObject {
  readonly volume: FakeDeviceParameter;
  readonly panning: FakeDeviceParameter;
  readonly sends: FakeDeviceParameter[];
}

export interface FakeDevice extends FakeObject {
  readonly name: string;
  readonly parameters: FakeDeviceParameter[];
  /** Present only on RackDevice/DrumRack nodes. */
  readonly chains?: FakeChain[];
  /** Present only on RackDevice/DrumRack nodes; async (returns the new chain). */
  insertChain?(index: number): Promise<FakeChain>;
  /** Present only on Simpler nodes; async (returns the new sample's managed path). */
  replaceSample?(filePath: string): Promise<{ filePath: string }>;
}

export interface FakeChain extends FakeObject {
  readonly name: string;
  readonly devices: FakeDevice[];
  readonly mixer: FakeChainMixer;
  insertDevice(deviceName: string, index: number): Promise<FakeDevice>;
  duplicateDevice(device: FakeDevice): Promise<FakeDevice>;
  deleteDevice(device: FakeDevice): Promise<void>;
}

export interface FakeClip extends FakeObject {
  name: string;
  color: number;
  looping: boolean;
  muted: boolean;
  /** AudioClip only (undefined on MIDI clips). */
  warping?: boolean;
  /** AudioClip only (undefined on MIDI clips). */
  warpMode?: number;
  /** MidiClip only (undefined on audio clips); getter returns a fresh copy. */
  notes?: FakeNoteDescription[];
}

export interface FakeClipSlot extends FakeObject {
  /** ClipSlot has NO name (SDK fidelity). */
  readonly clip: FakeClip | null;
  createMidiClip(length: number): Promise<FakeClip>;
  deleteClip(): Promise<void>;
}

export interface FakeTakeLane extends FakeObject {
  name: string;
  readonly clips: FakeClip[];
  createMidiClip(startTime: number, duration: number): Promise<FakeClip>;
}

export interface FakeTrack extends FakeObject {
  name: string;
  mute: boolean;
  solo: boolean;
  arm: boolean;
  readonly devices: FakeDevice[];
  readonly clipSlots: FakeClipSlot[];
  readonly takeLanes: FakeTakeLane[];
  readonly arrangementClips: FakeClip[];
  readonly mixer: FakeTrackMixer;
  createTakeLane(): Promise<FakeTakeLane>;
  insertDevice(deviceName: string, index: number): Promise<FakeDevice>;
  duplicateDevice(device: FakeDevice): Promise<FakeDevice>;
  deleteDevice(device: FakeDevice): Promise<void>;
  deleteClip(clip: FakeClip): Promise<void>;
}

/** MidiTrack adds the arrangement createMidiClip(startTime, duration). */
export interface FakeMidiTrack extends FakeTrack {
  createMidiClip(startTime: number, duration: number): Promise<FakeClip>;
}

export interface FakeScene extends FakeObject {
  name: string;
}

export interface FakeCuePoint extends FakeObject {
  name: string;
}

export interface FakeSong extends FakeObject {
  readonly tracks: FakeTrack[];
  readonly returnTracks: FakeTrack[];
  readonly mainTrack: FakeTrack;
  readonly scenes: FakeScene[];
  readonly cuePoints: FakeCuePoint[];
  tempo: number;
  createAudioTrack(): Promise<FakeTrack>;
  createMidiTrack(): Promise<FakeMidiTrack>;
  createScene(index: number): Promise<FakeScene>;
  createCuePoint(time: number): Promise<FakeCuePoint>;
  deleteTrack(track: FakeTrack): Promise<void>;
  deleteScene(scene: FakeScene): Promise<void>;
  deleteCuePoint(cuePoint: FakeCuePoint): Promise<void>;
  duplicateTrack(track: FakeTrack): Promise<FakeTrack>;
  duplicateScene(scene: FakeScene): Promise<FakeScene>;
}
// #endregion

// #region Backing tree
/**
 * A single node in the mutable backing tree. Collection getters on the public
 * objects read these directly, filtering out `deleted` nodes, so the live array
 * reflects every reorder/remove/insert.
 */
interface FakeNode {
  id: bigint;
  /** Concrete SDK className, e.g. "AudioTrack", "MidiClip", "Reverb", "RackDevice". */
  className: string;
  /** "" for clipSlot / mixer nodes (no name in the SDK). */
  name: string;
  deleted: boolean;
  /** collectionKey ("tracks"|"devices"|"clipSlots"|"chains"|"parameters"|"sends"|...) → ordered child nodes. */
  children: Map<string, FakeNode[]>;
  /** For a clipSlot: its clip node (or null). Distinct from `children` because a slot's clip is a single optional pointer. */
  clip?: FakeNode | null;
  /** For a track/chain: its mixer node. */
  mixer?: FakeNode;

  // --- mutable state seeded by NodeSpec / set by mutation tools ---
  /** Track flags (Track nodes only). */
  mute: boolean;
  solo: boolean;
  arm: boolean;
  /** Clip flags (Clip nodes only). */
  color: number;
  looping: boolean;
  muted: boolean;
  /** AudioClip-only warp state. `undefined` ⇒ not an audio clip. */
  warping?: boolean;
  warpMode?: number;
  /** MidiClip-only note buffer. `undefined` ⇒ not a midi clip. */
  notes?: FakeNoteDescription[];
  /** DeviceParameter spec/state. `undefined` ⇒ not a parameter. */
  param?: {
    min: number;
    max: number;
    isQuantized: boolean;
    value: number;
    valueItems: { name: string; shortName: string }[];
  };
}

/**
 * className → set of class names it is assignable-to (is-a), used by
 * `getObjectFromHandle` to honor SDK subtype acceptance (e.g. an AudioTrack node
 * satisfies a `Track` lookup). A class is always assignable to itself; the base
 * `DataModelObject` accepts every live node (used by the resolver's probe path).
 */
const ASSIGNABLE_TO: Record<string, readonly string[]> = {
  // Tracks
  AudioTrack: ["AudioTrack", "Track"],
  MidiTrack: ["MidiTrack", "Track"],
  Track: ["Track"],
  // Clips
  AudioClip: ["AudioClip", "Clip"],
  MidiClip: ["MidiClip", "Clip"],
  Clip: ["Clip"],
  // Slots / lanes / scenes / cues / song
  ClipSlot: ["ClipSlot"],
  TakeLane: ["TakeLane"],
  Scene: ["Scene"],
  CuePoint: ["CuePoint"],
  Song: ["Song"],
  // Devices (Simpler/RackDevice/DrumRack are-a Device; concrete built-ins too)
  RackDevice: ["RackDevice", "Device"],
  DrumRackDevice: ["DrumRackDevice", "RackDevice", "Device"],
  Simpler: ["Simpler", "Device"],
  Reverb: ["Reverb", "Device"],
  AutoFilter: ["AutoFilter", "Device"],
  Operator: ["Operator", "Device"],
  Device: ["Device"],
  // Chains
  Chain: ["Chain"],
  DrumChain: ["DrumChain", "Chain"],
  // Mixers & params
  MixerDevice: ["MixerDevice"],
  ChainMixerDevice: ["ChainMixerDevice"],
  DeviceParameter: ["DeviceParameter"],
};

/**
 * Maps an {@link AbstractCtor} token to the className the caller intends. The
 * resolver passes SDK class objects (`Track`, `Device`, `DataModelObject`, …); the
 * fake's tests pass {@link FakeClass} tokens carrying a `className`. Either way we
 * read `className` off the token. An unknown/missing tag is treated as unrecognized.
 */
function ctorClassName(type: AbstractCtor<unknown>): string | undefined {
  const tag = (type as { className?: unknown }).className;
  return typeof tag === "string" ? tag : undefined;
}

/** Every className recognized by the fake (drives the "unrecognized type" throw). */
const KNOWN_CLASSES = new Set<string>([
  "DataModelObject",
  ...Object.keys(ASSIGNABLE_TO),
]);
// #endregion

// #region Public class tokens
/**
 * Stand-in class tokens to pass as the `type` argument of
 * {@link FakeExtensionContext.getObjectFromHandle} in tests, mirroring how the
 * resolver passes real SDK classes. Each carries a `static className`; the base
 * `DataModelObject` token is the resolver's probe class (accepts any live node).
 *
 * Example: `ctx.getObjectFromHandle(h, FakeClass.Track)`.
 */
export const FakeClass = {
  DataModelObject: makeToken("DataModelObject"),
  Track: makeToken("Track"),
  Clip: makeToken("Clip"),
  ClipSlot: makeToken("ClipSlot"),
  TakeLane: makeToken("TakeLane"),
  Scene: makeToken("Scene"),
  CuePoint: makeToken("CuePoint"),
  Song: makeToken("Song"),
  Device: makeToken("Device"),
  RackDevice: makeToken("RackDevice"),
  Chain: makeToken("Chain"),
  DeviceParameter: makeToken("DeviceParameter"),
  TrackMixer: makeToken("MixerDevice"),
  ChainMixer: makeToken("ChainMixerDevice"),
} as const;

/** Builds a minimal abstract-constructor token tagged with a className. */
function makeToken(className: string): AbstractCtor<FakeObject> {
  // An abstract class carrying the className tag; never instantiated by the fake.
  abstract class Token {
    static readonly className = className;
  }
  return Token as unknown as AbstractCtor<FakeObject>;
}
// #endregion

// #region Spec types
/** Declarative node spec used by {@link FakeExtensionContext.insert} and the default-Set builder. */
export interface NodeSpec {
  className: string;
  name?: string;
  /** Child collections keyed by collectionKey. */
  children?: Record<string, NodeSpec[]>;
  /** For a clipSlot spec: the contained clip, or null for an empty slot. */
  clip?: NodeSpec | null;
  /** For a track/chain spec: its mixer node spec. */
  mixer?: NodeSpec;

  // --- seed values for the mutable surface (all optional; sensible defaults) ---
  /** Track flags (default false). */
  mute?: boolean;
  solo?: boolean;
  arm?: boolean;
  /** Clip flags. color default 0; looping/muted default false. */
  color?: number;
  looping?: boolean;
  muted?: boolean;
  /** AudioClip warp seed; presence marks the clip as audio. */
  warping?: boolean;
  warpMode?: number;
  /** MidiClip note seed; presence marks the clip as midi. */
  notes?: FakeNoteDescription[];
  /** DeviceParameter seed; presence required for getValue/setValue to behave. */
  param?: {
    min?: number;
    max?: number;
    isQuantized?: boolean;
    value?: number;
    valueItems?: { name: string; shortName: string }[];
  };
}

/** Spec for the whole Set passed to {@link makeFakeContext}. */
export interface SetSpec {
  tempo?: number;
  tracks?: NodeSpec[];
  returnTracks?: NodeSpec[];
  mainTrack?: NodeSpec;
  scenes?: NodeSpec[];
  cuePoints?: NodeSpec[];
}
// #endregion

// #region Public context interface
/**
 * The fake context returned by {@link makeFakeContext}. Exposes the SDK surface the
 * resolver consumes (`application.song`, `getObjectFromHandle`) plus drift helpers
 * that mutate the backing tree.
 *
 * **Address syntax** for `parentRef`/`nodeRef` (internal, NOT the shared ref
 * grammar): a `/`-joined path of `collectionKey[index]` steps from the song root,
 * where leaf single-pointer steps use a bare key. Examples:
 *  - `"tracks[0]"`                        → first track
 *  - `"tracks[2]/devices[0]"`             → first device of the third track
 *  - `"tracks[1]/devices[1]/chains[0]/devices[0]/parameters[2]"`
 *  - `"tracks[0]/mixer/sends[1]"`         → second send of track 0's mixer
 *  - `"tracks[0]/mixer/volume"`           → track 0's mixer volume param
 *  - `"tracks[0]/clipSlots[0]/clip"`      → the clip in slot 0
 *  - `"tracks[0]/takeLanes[0]/clips[0]"`  → first clip of take lane 0
 *  - `"scenes[1]"`, `"cuePoints[0]"`, `"returnTracks[0]"`, `"mainTrack"`
 */
export interface FakeExtensionContext {
  application: { song: FakeSong };

  /** Synchronous; throws a single generic `Error` for deleted/wrong-type/unknown — never returns null. */
  getObjectFromHandle<T>(handle: Handle, type: AbstractCtor<T>): T;

  /**
   * SYNCHRONOUS transaction boundary mirroring the SDK
   * (`withinTransaction<T>(fn: () => T): T`). Runs `fn()` and returns its result
   * verbatim — if `fn` returns a `Promise` (e.g. `Promise.all([...])` of async
   * creates), the fake returns that same Promise for the CALLER to await; the fake
   * never awaits inside the callback (docs/ARCHITECTURE.md §7).
   *
   * **R5 atomic rollback (recorded outcome = atomic):** if `fn()` THROWS
   * synchronously, every sync mutation applied during the callback is rolled back in
   * reverse order and NO committed undo boundary is recorded (the attempt is logged
   * as `rolledBack: true`). Async rejections that settle AFTER the callback returns
   * are the caller's concern and are not rolled back here — matching what Spike R5
   * actually validated (the sync-throw path).
   */
  withinTransaction<T>(fn: () => T): T;

  /**
   * Observability for tests (NOT part of the SDK). `transactions` lists every
   * `withinTransaction` attempt in order, each marked committed or rolled back, so a
   * test can assert "exactly one transaction per flushMutations batch" and that a
   * throwing batch rolled back. `committedCount` is the number that committed.
   */
  readonly transactions: ReadonlyArray<{
    committed: boolean;
    rolledBack: boolean;
  }>;
  readonly committedCount: number;

  /**
   * Reads the current backing value of a parameter addressed by the internal address
   * scheme (e.g. `"tracks[0]/mixer/volume"`, `"tracks[1]/devices[0]/parameters[0]"`).
   * Lets a test assert clamping/quantization outcomes without the async getter.
   */
  paramValueOf(ref: string): number;

  /** Reads the live note buffer of a midi clip addressed internally (fresh copy). */
  notesOf(ref: string): FakeNoteDescription[];

  /** Moves a child within a collection (live reorder). */
  reorder(
    parentRef: string,
    collectionKey: string,
    from: number,
    to: number
  ): void;
  /** Renames a node (drift-detection trigger). */
  rename(nodeRef: string, name: string): void;
  /** Soft-deletes a node; siblings shift index live and its handle becomes invalid. */
  remove(nodeRef: string): void;
  /** Inserts a new node into a collection at an index; returns its fresh handle. */
  insert(
    parentRef: string,
    collectionKey: string,
    atIndex: number,
    spec: NodeSpec
  ): Handle;
  /** Returns the live handle for an addressed node (for raw-handle anchoring tests). */
  handleOf(ref: string): Handle;
}
// #endregion

// #region Implementation
/**
 * Builds a {@link FakeExtensionContext} backed by a mutable node tree. Pass a
 * {@link SetSpec} to customize, or omit it for the deterministic default Set
 * documented on {@link makeFakeContext}.
 */
export function makeFakeContext(spec?: SetSpec): FakeExtensionContext {
  let nextId = 1n;
  const allocId = (): bigint => nextId++;

  /** Index of every minted node by handle id, for O(1) `getObjectFromHandle`. */
  const byId = new Map<bigint, FakeNode>();

  function buildNode(s: NodeSpec): FakeNode {
    const node: FakeNode = {
      id: allocId(),
      className: s.className,
      name: s.name ?? "",
      deleted: false,
      children: new Map<string, FakeNode[]>(),
      mute: s.mute ?? false,
      solo: s.solo ?? false,
      arm: s.arm ?? false,
      color: s.color ?? 0,
      looping: s.looping ?? false,
      muted: s.muted ?? false,
    };
    // AudioClip warp state: present iff a warp seed was given OR the class is AudioClip.
    if (s.warping !== undefined || s.warpMode !== undefined) {
      node.warping = s.warping ?? false;
      node.warpMode = s.warpMode ?? FakeWarpMode.Beats;
    }
    // MidiClip notes: present iff a notes seed was given OR the class is MidiClip.
    if (s.notes !== undefined) {
      node.notes = s.notes.map((n) => ({ ...n }));
    } else if (s.className === "MidiClip") {
      node.notes = [];
    }
    // DeviceParameter state.
    if (s.className === "DeviceParameter") {
      const min = s.param?.min ?? 0;
      const max = s.param?.max ?? 1;
      node.param = {
        min,
        max,
        isQuantized: s.param?.isQuantized ?? false,
        value: s.param?.value ?? min,
        valueItems: s.param?.valueItems ?? [],
      };
    }
    byId.set(node.id, node);

    if (s.children) {
      for (const [key, specs] of Object.entries(s.children)) {
        node.children.set(
          key,
          specs.map((child) => buildNode(child))
        );
      }
    }
    if (s.clip !== undefined) {
      node.clip = s.clip === null ? null : buildNode(s.clip);
    }
    if (s.mixer) {
      node.mixer = buildNode(s.mixer);
    }
    return node;
  }

  const filled = spec ?? defaultSetSpec();
  const songNode: FakeNode = {
    id: allocId(),
    className: "Song",
    name: "",
    deleted: false,
    children: new Map<string, FakeNode[]>(),
    mute: false,
    solo: false,
    arm: false,
    color: 0,
    looping: false,
    muted: false,
  };
  byId.set(songNode.id, songNode);
  songNode.children.set("tracks", (filled.tracks ?? []).map(buildNode));
  songNode.children.set(
    "returnTracks",
    (filled.returnTracks ?? []).map(buildNode)
  );
  songNode.children.set("scenes", (filled.scenes ?? []).map(buildNode));
  songNode.children.set("cuePoints", (filled.cuePoints ?? []).map(buildNode));
  const mainTrackNode = buildNode(
    filled.mainTrack ?? { className: "AudioTrack", name: "Main" }
  );
  /** Mutable tempo box so the `song.tempo` setter can journal/restore it. */
  const tempoState = { value: filled.tempo ?? 120 };

  /** Default track mixer spec for newly created tracks (volume/pan, no sends). */
  const trackMixerSpec = (): NodeSpec => ({
    className: "MixerDevice",
    children: {
      volume: [{ className: "DeviceParameter", name: "Volume" }],
      panning: [{ className: "DeviceParameter", name: "Pan" }],
      sends: [],
    },
  });

  // --- live array helper: fresh array of non-deleted children on each access ---
  const liveChildren = (node: FakeNode, key: string): FakeNode[] =>
    (node.children.get(key) ?? []).filter((c) => !c.deleted);

  // --- transaction machinery (sync boundary + R5 atomic rollback) ---
  /**
   * Each `withinTransaction` attempt is logged here in order. A successful run is
   * `{ committed: true, rolledBack: false }`; a sync throw is rolled back and logged
   * `{ committed: false, rolledBack: true }`. Tests read this via `transactions`.
   */
  const txLog: { committed: boolean; rolledBack: boolean }[] = [];
  /**
   * While a transaction is open, every SYNC mutation pushes an undo thunk here so a
   * sync throw can roll back in reverse order (R5 = atomic). `null` ⇒ no open
   * transaction, so mutations outside a transaction are applied without journaling
   * (they cannot be rolled back — matching "the caller owns un-transacted writes").
   */
  let journal: (() => void)[] | null = null;
  /** Records an undo thunk if a transaction is currently open. */
  function record(undo: () => void): void {
    if (journal !== null) {
      journal.push(undo);
    }
  }
  /** Nested transactions auto-collapse (SDK semantics): only the outermost logs/rolls back. */
  function withinTransaction<T>(fn: () => T): T {
    if (journal !== null) {
      // Already inside a transaction — collapse into it, no new boundary.
      return fn();
    }
    const undoThunks: (() => void)[] = [];
    journal = undoThunks;
    try {
      const result = fn();
      txLog.push({ committed: true, rolledBack: false });
      journal = null;
      return result;
    } catch (err) {
      // R5 atomic rollback: undo every sync mutation in reverse order, log no commit.
      journal = null;
      for (let i = undoThunks.length - 1; i >= 0; i--) {
        undoThunks[i]();
      }
      txLog.push({ committed: false, rolledBack: true });
      throw err;
    }
  }

  // --- structural mutation helpers (async creates/deletes operate on the tree) ---
  /**
   * Appends a freshly built node into `parent.children[key]` and returns it. The
   * mutation runs synchronously when called; async creators invoke this from inside
   * the returned Promise body so it lands AFTER the transaction callback returns
   * (hence not subject to sync-throw rollback — matching the R5 scope).
   */
  function appendChild(
    parent: FakeNode,
    key: string,
    spec: NodeSpec,
    atIndex?: number
  ): FakeNode {
    const arr = parent.children.get(key) ?? [];
    parent.children.set(key, arr);
    const live = arr.filter((c) => !c.deleted);
    const fresh = buildNode(spec);
    if (atIndex === undefined || atIndex >= live.length) {
      arr.push(fresh);
    } else {
      // Insert before the live node currently at atIndex (preserving tombstones).
      const target = live[Math.max(0, atIndex)];
      const realIndex = arr.indexOf(target);
      arr.splice(realIndex, 0, fresh);
    }
    return fresh;
  }

  /** Deep-clones a spec from a live node (for duplicate*). */
  function specOf(node: FakeNode): NodeSpec {
    const children: Record<string, NodeSpec[]> = {};
    for (const [key, arr] of node.children) {
      children[key] = arr.filter((c) => !c.deleted).map(specOf);
    }
    const spec: NodeSpec = { className: node.className, name: node.name };
    if (Object.keys(children).length > 0) {
      spec.children = children;
    }
    if (node.mixer) {
      spec.mixer = specOf(node.mixer);
    }
    if (node.clip !== undefined) {
      spec.clip = node.clip ? specOf(node.clip) : null;
    }
    spec.mute = node.mute;
    spec.solo = node.solo;
    spec.arm = node.arm;
    spec.color = node.color;
    spec.looping = node.looping;
    spec.muted = node.muted;
    if (node.warping !== undefined) {
      spec.warping = node.warping;
      spec.warpMode = node.warpMode;
    }
    if (node.notes !== undefined) {
      spec.notes = node.notes.map((n) => ({ ...n }));
    }
    if (node.param) {
      spec.param = {
        ...node.param,
        valueItems: node.param.valueItems.map((v) => ({ ...v })),
      };
    }
    return spec;
  }

  /** Finds the (live) sibling node of `parent.children[key]` whose handle matches. */
  function childByHandle(
    parent: FakeNode,
    key: string,
    handle: Handle
  ): FakeNode {
    const found = liveChildren(parent, key).find((c) => c.id === handle.id);
    if (!found) {
      throw new Error(`fake: no live '${key}' child with handle ${handle.id}`);
    }
    return found;
  }

  // --- getter-proxy builders (each reads its backing node live) ---
  function makeParam(node: FakeNode): FakeDeviceParameter {
    const spec = (): NonNullable<FakeNode["param"]> => {
      if (!node.param) {
        throw new Error("fake: node is not a DeviceParameter");
      }
      return node.param;
    };
    return {
      handle: { id: node.id },
      get name() {
        return node.name;
      },
      get min() {
        return spec().min;
      },
      get max() {
        return spec().max;
      },
      get isQuantized() {
        return spec().isQuantized;
      },
      get valueItems() {
        return spec().valueItems.map((v) => ({ ...v }));
      },
      getValue(): Promise<number> {
        return Promise.resolve(spec().value);
      },
      setValue(value: number): Promise<void> {
        const p = spec();
        let next = value;
        if (p.isQuantized) {
          next = Math.round(next);
        }
        // Clamp to [min, max].
        next = Math.max(p.min, Math.min(p.max, next));
        const prev = p.value;
        record(() => {
          p.value = prev;
        });
        p.value = next;
        return Promise.resolve();
      },
    };
  }

  function makeMixer(node: FakeNode): FakeTrackMixer & FakeChainMixer {
    const findOne = (key: string): FakeNode => {
      const arr = liveChildren(node, key);
      if (arr.length === 0) {
        throw new Error(`fake: mixer node missing '${key}'`);
      }
      return arr[0];
    };
    return {
      handle: { id: node.id },
      get volume() {
        return makeParam(findOne("volume"));
      },
      get panning() {
        return makeParam(findOne("panning"));
      },
      get sends() {
        return liveChildren(node, "sends").map(makeParam);
      },
    };
  }

  function makeClip(node: FakeNode): FakeClip {
    const clip: FakeClip = {
      handle: { id: node.id },
      get name() {
        return node.name;
      },
      set name(value: string) {
        const prev = node.name;
        record(() => {
          node.name = prev;
        });
        node.name = value;
      },
      get color() {
        return node.color;
      },
      set color(value: number) {
        const prev = node.color;
        record(() => {
          node.color = prev;
        });
        node.color = value;
      },
      get looping() {
        return node.looping;
      },
      set looping(value: boolean) {
        const prev = node.looping;
        record(() => {
          node.looping = prev;
        });
        node.looping = value;
      },
      get muted() {
        return node.muted;
      },
      set muted(value: boolean) {
        const prev = node.muted;
        record(() => {
          node.muted = prev;
        });
        node.muted = value;
      },
    };
    // AudioClip-only warp accessors.
    if (node.warping !== undefined) {
      Object.defineProperty(clip, "warping", {
        enumerable: true,
        get() {
          return node.warping;
        },
        set(value: boolean) {
          const prev = node.warping;
          record(() => {
            node.warping = prev;
          });
          node.warping = value;
        },
      });
      Object.defineProperty(clip, "warpMode", {
        enumerable: true,
        get() {
          return node.warpMode;
        },
        set(value: number) {
          const prev = node.warpMode;
          record(() => {
            node.warpMode = prev;
          });
          node.warpMode = value;
        },
      });
    }
    // MidiClip-only notes accessor (full-array replace; getter returns a fresh copy).
    if (node.notes !== undefined) {
      Object.defineProperty(clip, "notes", {
        enumerable: true,
        get() {
          return (node.notes ?? []).map((n) => ({ ...n }));
        },
        set(value: FakeNoteDescription[]) {
          const prev = node.notes ?? [];
          record(() => {
            node.notes = prev;
          });
          node.notes = value.map((n) => ({ ...n }));
        },
      });
    }
    return clip;
  }

  function makeDevice(node: FakeNode): FakeDevice {
    const base: FakeDevice = {
      handle: { id: node.id },
      get name() {
        return node.name;
      },
      get parameters() {
        return liveChildren(node, "parameters").map(makeParam);
      },
    };
    // RackDevice / DrumRack expose `chains` + insertChain.
    if (assignableIncludes(node.className, "RackDevice")) {
      const isDrum = assignableIncludes(node.className, "DrumRackDevice");
      return {
        ...base,
        get chains() {
          return liveChildren(node, "chains").map(makeChain);
        },
        insertChain(index: number): Promise<FakeChain> {
          return Promise.resolve().then(() => {
            const fresh = appendChild(
              node,
              "chains",
              {
                className: isDrum ? "DrumChain" : "Chain",
                name: "",
                mixer: {
                  className: "ChainMixerDevice",
                  children: {
                    volume: [{ className: "DeviceParameter", name: "Volume" }],
                    panning: [{ className: "DeviceParameter", name: "Pan" }],
                    sends: [],
                  },
                },
              },
              index
            );
            return makeChain(fresh);
          });
        },
      };
    }
    // Simpler exposes replaceSample.
    if (node.className === "Simpler") {
      return {
        ...base,
        replaceSample(filePath: string): Promise<{ filePath: string }> {
          return Promise.resolve({ filePath });
        },
      };
    }
    return base;
  }

  // Shared device-chain mutators used by both Track and Chain (identical SDK shape).
  function insertDeviceInto(
    owner: FakeNode,
    deviceName: string,
    index: number
  ): Promise<FakeDevice> {
    return Promise.resolve().then(() => {
      const fresh = appendChild(
        owner,
        "devices",
        { className: deviceName, name: deviceName },
        index
      );
      return makeDevice(fresh);
    });
  }
  function duplicateDeviceIn(
    owner: FakeNode,
    device: FakeDevice
  ): Promise<FakeDevice> {
    return Promise.resolve().then(() => {
      const original = childByHandle(owner, "devices", device.handle);
      const live = liveChildren(owner, "devices");
      const at = live.indexOf(original) + 1; // inserted directly after original
      const fresh = appendChild(owner, "devices", specOf(original), at);
      return makeDevice(fresh);
    });
  }
  function deleteDeviceIn(owner: FakeNode, device: FakeDevice): Promise<void> {
    return Promise.resolve().then(() => {
      const target = childByHandle(owner, "devices", device.handle);
      markDeleted(target);
    });
  }

  function makeChain(node: FakeNode): FakeChain {
    return {
      handle: { id: node.id },
      get name() {
        return node.name;
      },
      get devices() {
        return liveChildren(node, "devices").map(makeDevice);
      },
      get mixer() {
        if (!node.mixer) {
          throw new Error("fake: chain node missing mixer");
        }
        return makeMixer(node.mixer);
      },
      insertDevice(deviceName: string, index: number): Promise<FakeDevice> {
        return insertDeviceInto(node, deviceName, index);
      },
      duplicateDevice(device: FakeDevice): Promise<FakeDevice> {
        return duplicateDeviceIn(node, device);
      },
      deleteDevice(device: FakeDevice): Promise<void> {
        return deleteDeviceIn(node, device);
      },
    };
  }

  function makeClipSlot(node: FakeNode): FakeClipSlot {
    return {
      handle: { id: node.id },
      get clip() {
        return node.clip && !node.clip.deleted ? makeClip(node.clip) : null;
      },
      createMidiClip(length: number): Promise<FakeClip> {
        return Promise.resolve().then(() => {
          const fresh = buildNode({
            className: "MidiClip",
            name: "",
            notes: [],
          });
          // Length seeded onto the node for tests that care (kept on param-less node).
          void length;
          node.clip = fresh;
          return makeClip(fresh);
        });
      },
      deleteClip(): Promise<void> {
        return Promise.resolve().then(() => {
          if (node.clip) {
            markDeleted(node.clip);
            node.clip = null;
          }
        });
      },
    };
  }

  function makeTakeLane(node: FakeNode): FakeTakeLane {
    return {
      handle: { id: node.id },
      get name() {
        return node.name;
      },
      set name(value: string) {
        const prev = node.name;
        record(() => {
          node.name = prev;
        });
        node.name = value;
      },
      get clips() {
        return liveChildren(node, "clips").map(makeClip);
      },
      createMidiClip(startTime: number, duration: number): Promise<FakeClip> {
        return Promise.resolve().then(() => {
          void startTime;
          void duration;
          const fresh = appendChild(node, "clips", {
            className: "MidiClip",
            name: "",
            notes: [],
          });
          return makeClip(fresh);
        });
      },
    };
  }

  function makeTrack(node: FakeNode): FakeTrack & FakeMidiTrack {
    const track: FakeTrack & FakeMidiTrack = {
      handle: { id: node.id },
      get name() {
        return node.name;
      },
      set name(value: string) {
        const prev = node.name;
        record(() => {
          node.name = prev;
        });
        node.name = value;
      },
      get mute() {
        return node.mute;
      },
      set mute(value: boolean) {
        const prev = node.mute;
        record(() => {
          node.mute = prev;
        });
        node.mute = value;
      },
      get solo() {
        return node.solo;
      },
      set solo(value: boolean) {
        const prev = node.solo;
        record(() => {
          node.solo = prev;
        });
        node.solo = value;
      },
      get arm() {
        return node.arm;
      },
      set arm(value: boolean) {
        const prev = node.arm;
        record(() => {
          node.arm = prev;
        });
        node.arm = value;
      },
      get devices() {
        return liveChildren(node, "devices").map(makeDevice);
      },
      get clipSlots() {
        return liveChildren(node, "clipSlots").map(makeClipSlot);
      },
      get takeLanes() {
        return liveChildren(node, "takeLanes").map(makeTakeLane);
      },
      get arrangementClips() {
        return liveChildren(node, "arrangementClips").map(makeClip);
      },
      get mixer() {
        if (!node.mixer) {
          throw new Error("fake: track node missing mixer");
        }
        return makeMixer(node.mixer);
      },
      createTakeLane(): Promise<FakeTakeLane> {
        return Promise.resolve().then(() => {
          const fresh = appendChild(node, "takeLanes", {
            className: "TakeLane",
            name: "",
          });
          return makeTakeLane(fresh);
        });
      },
      insertDevice(deviceName: string, index: number): Promise<FakeDevice> {
        return insertDeviceInto(node, deviceName, index);
      },
      duplicateDevice(device: FakeDevice): Promise<FakeDevice> {
        return duplicateDeviceIn(node, device);
      },
      deleteDevice(device: FakeDevice): Promise<void> {
        return deleteDeviceIn(node, device);
      },
      deleteClip(clip: FakeClip): Promise<void> {
        return Promise.resolve().then(() => {
          const target = childByHandle(node, "arrangementClips", clip.handle);
          markDeleted(target);
        });
      },
      createMidiClip(startTime: number, duration: number): Promise<FakeClip> {
        return Promise.resolve().then(() => {
          void startTime;
          void duration;
          const fresh = appendChild(node, "arrangementClips", {
            className: "MidiClip",
            name: "",
            notes: [],
          });
          return makeClip(fresh);
        });
      },
    };
    return track;
  }

  function makeScene(node: FakeNode): FakeScene {
    return {
      handle: { id: node.id },
      get name() {
        return node.name;
      },
      set name(value: string) {
        const prev = node.name;
        record(() => {
          node.name = prev;
        });
        node.name = value;
      },
    };
  }

  function makeCuePoint(node: FakeNode): FakeCuePoint {
    return {
      handle: { id: node.id },
      get name() {
        return node.name;
      },
      set name(value: string) {
        const prev = node.name;
        record(() => {
          node.name = prev;
        });
        node.name = value;
      },
    };
  }

  const song: FakeSong = {
    handle: { id: songNode.id },
    get tracks() {
      return liveChildren(songNode, "tracks").map(makeTrack);
    },
    get returnTracks() {
      return liveChildren(songNode, "returnTracks").map(makeTrack);
    },
    get mainTrack() {
      return makeTrack(mainTrackNode);
    },
    get scenes() {
      return liveChildren(songNode, "scenes").map(makeScene);
    },
    get cuePoints() {
      return liveChildren(songNode, "cuePoints").map(makeCuePoint);
    },
    get tempo() {
      return tempoState.value;
    },
    set tempo(value: number) {
      const prev = tempoState.value;
      record(() => {
        tempoState.value = prev;
      });
      tempoState.value = value;
    },
    createAudioTrack(): Promise<FakeTrack> {
      return Promise.resolve().then(() =>
        makeTrack(
          appendChild(songNode, "tracks", {
            className: "AudioTrack",
            name: "",
            mixer: trackMixerSpec(),
          })
        )
      );
    },
    createMidiTrack(): Promise<FakeMidiTrack> {
      return Promise.resolve().then(() =>
        makeTrack(
          appendChild(songNode, "tracks", {
            className: "MidiTrack",
            name: "",
            mixer: trackMixerSpec(),
          })
        )
      );
    },
    createScene(index: number): Promise<FakeScene> {
      return Promise.resolve().then(() =>
        makeScene(
          appendChild(
            songNode,
            "scenes",
            { className: "Scene", name: "" },
            index < 0 ? undefined : index
          )
        )
      );
    },
    createCuePoint(time: number): Promise<FakeCuePoint> {
      return Promise.resolve().then(() => {
        void time;
        return makeCuePoint(
          appendChild(songNode, "cuePoints", {
            className: "CuePoint",
            name: "",
          })
        );
      });
    },
    deleteTrack(track: FakeTrack): Promise<void> {
      return Promise.resolve().then(() => {
        markDeleted(childByHandle(songNode, "tracks", track.handle));
      });
    },
    deleteScene(scene: FakeScene): Promise<void> {
      return Promise.resolve().then(() => {
        markDeleted(childByHandle(songNode, "scenes", scene.handle));
      });
    },
    deleteCuePoint(cuePoint: FakeCuePoint): Promise<void> {
      return Promise.resolve().then(() => {
        markDeleted(childByHandle(songNode, "cuePoints", cuePoint.handle));
      });
    },
    duplicateTrack(track: FakeTrack): Promise<FakeTrack> {
      return Promise.resolve().then(() => {
        const original = childByHandle(songNode, "tracks", track.handle);
        const live = liveChildren(songNode, "tracks");
        const at = live.indexOf(original) + 1;
        return makeTrack(appendChild(songNode, "tracks", specOf(original), at));
      });
    },
    duplicateScene(scene: FakeScene): Promise<FakeScene> {
      return Promise.resolve().then(() => {
        const original = childByHandle(songNode, "scenes", scene.handle);
        const live = liveChildren(songNode, "scenes");
        const at = live.indexOf(original) + 1;
        return makeScene(appendChild(songNode, "scenes", specOf(original), at));
      });
    },
  };

  // --- internal address navigation (see FakeExtensionContext docstring) ---
  /** Resolves an address string to its backing node (throws on bad address). */
  function nodeAt(ref: string): FakeNode {
    if (ref === "" || ref === "song") {
      return songNode;
    }
    const steps = ref.split("/");
    let cursor: FakeNode = songNode;
    for (const step of steps) {
      cursor = stepInto(cursor, step);
    }
    return cursor;
  }

  function stepInto(parent: FakeNode, step: string): FakeNode {
    // Single-pointer steps: mainTrack | mixer | clip | volume | panning
    if (step === "mainTrack") {
      return mainTrackNode;
    }
    if (step === "mixer") {
      if (!parent.mixer) {
        throw new Error(`fake: '${step}' has no mixer`);
      }
      return parent.mixer;
    }
    if (step === "clip") {
      if (!parent.clip) {
        throw new Error("fake: addressed clip is null");
      }
      return parent.clip;
    }
    if (step === "volume" || step === "panning") {
      const arr = parent.children.get(step) ?? [];
      const live = arr.filter((c) => !c.deleted);
      if (live.length === 0) {
        throw new Error(`fake: no '${step}' under node`);
      }
      return live[0];
    }
    // Indexed steps: collectionKey[index]
    const m = /^([A-Za-z]+)\[(\d+)\]$/.exec(step);
    if (!m) {
      throw new Error(`fake: bad address step '${step}'`);
    }
    const key = m[1];
    const index = Number(m[2]);
    const live = (parent.children.get(key) ?? []).filter((c) => !c.deleted);
    const target = live[index];
    if (!target) {
      throw new Error(
        `fake: no '${key}[${index}]' under node (len ${live.length})`
      );
    }
    return target;
  }

  // --- getObjectFromHandle: synchronous, throws like the SDK ---
  function getObjectFromHandle<T>(handle: Handle, type: AbstractCtor<T>): T {
    const wanted = ctorClassName(type);
    if (wanted === undefined || !KNOWN_CLASSES.has(wanted)) {
      // Unrecognized type → generic throw (SDK behavior).
      throw new Error("fake: unrecognized type");
    }
    const node = byId.get(handle.id);
    if (!node || node.deleted) {
      // Deleted/missing → generic throw. The resolver's base-class probe lands here
      // too for a truly-gone node, yielding ref_unresolved.
      throw new Error("fake: object not found or deleted");
    }
    // Base probe: DataModelObject accepts any live node.
    if (wanted === "DataModelObject") {
      return materialize(node) as T;
    }
    const assignable = ASSIGNABLE_TO[node.className] ?? [node.className];
    if (!assignable.includes(wanted)) {
      // Live but wrong type → generic throw. The resolver's DataModelObject probe
      // will SUCCEED on this same node, so it maps to type_mismatch.
      throw new Error("fake: type mismatch");
    }
    return materialize(node) as T;
  }

  /** Builds the appropriate getter-proxy for a node based on its class family. */
  function materialize(node: FakeNode): FakeObject {
    const c = node.className;
    if (c === "Song") {
      return song;
    }
    if (assignableIncludes(c, "Track")) {
      return makeTrack(node);
    }
    if (assignableIncludes(c, "Clip")) {
      return makeClip(node);
    }
    if (c === "ClipSlot") {
      return makeClipSlot(node);
    }
    if (c === "TakeLane") {
      return makeTakeLane(node);
    }
    if (c === "Scene") {
      return makeScene(node);
    }
    if (c === "CuePoint") {
      return makeCuePoint(node);
    }
    if (assignableIncludes(c, "Device")) {
      return makeDevice(node);
    }
    if (assignableIncludes(c, "Chain")) {
      return makeChain(node);
    }
    if (c === "MixerDevice" || c === "ChainMixerDevice") {
      return makeMixer(node);
    }
    if (c === "DeviceParameter") {
      return makeParam(node);
    }
    throw new Error(`fake: cannot materialize className '${c}'`);
  }

  function assignableIncludes(className: string, base: string): boolean {
    return (ASSIGNABLE_TO[className] ?? [className]).includes(base);
  }

  // --- drift helpers ---
  function reorder(
    parentRef: string,
    collectionKey: string,
    from: number,
    to: number
  ): void {
    const parent = nodeAt(parentRef);
    const arr = parent.children.get(collectionKey);
    if (!arr) {
      throw new Error(`fake: no collection '${collectionKey}' to reorder`);
    }
    // Operate on the LIVE (non-deleted) view, then write back preserving tombstones'
    // relative absence (we simply rebuild the backing array from the live order).
    const live = arr.filter((c) => !c.deleted);
    if (from < 0 || from >= live.length || to < 0 || to >= live.length) {
      throw new Error(`fake: reorder index out of range (len ${live.length})`);
    }
    const [moved] = live.splice(from, 1);
    live.splice(to, 0, moved);
    parent.children.set(collectionKey, live);
  }

  function rename(nodeRef: string, name: string): void {
    nodeAt(nodeRef).name = name;
  }

  function remove(nodeRef: string): void {
    const node = nodeAt(nodeRef);
    markDeleted(node);
  }

  /** Recursively tombstones a node and its entire subtree so every handle dies. */
  function markDeleted(node: FakeNode): void {
    node.deleted = true;
    for (const arr of node.children.values()) {
      for (const child of arr) {
        markDeleted(child);
      }
    }
    if (node.clip) {
      markDeleted(node.clip);
    }
    if (node.mixer) {
      markDeleted(node.mixer);
    }
  }

  function insert(
    parentRef: string,
    collectionKey: string,
    atIndex: number,
    spec: NodeSpec
  ): Handle {
    const parent = nodeAt(parentRef);
    const arr = parent.children.get(collectionKey) ?? [];
    const live = arr.filter((c) => !c.deleted);
    const clamped = Math.max(0, Math.min(atIndex, live.length));
    const fresh = buildNode(spec);
    live.splice(clamped, 0, fresh);
    parent.children.set(collectionKey, live);
    return { id: fresh.id };
  }

  function handleOf(ref: string): Handle {
    return { id: nodeAt(ref).id };
  }

  function paramValueOf(ref: string): number {
    const node = nodeAt(ref);
    if (!node.param) {
      throw new Error(`fake: '${ref}' is not a DeviceParameter`);
    }
    return node.param.value;
  }

  function notesOf(ref: string): FakeNoteDescription[] {
    const node = nodeAt(ref);
    if (node.notes === undefined) {
      throw new Error(`fake: '${ref}' is not a MidiClip`);
    }
    return node.notes.map((n) => ({ ...n }));
  }

  return {
    application: { song },
    getObjectFromHandle,
    withinTransaction,
    get transactions() {
      return txLog.map((t) => ({ ...t }));
    },
    get committedCount() {
      return txLog.filter((t) => t.committed).length;
    },
    paramValueOf,
    notesOf,
    reorder,
    rename,
    remove,
    insert,
    handleOf,
  };
}

/**
 * The deterministic default test Set built by `makeFakeContext()` with no spec.
 *
 * Structure (canonical internal addresses in parentheses; node names in quotes):
 *
 *   tracks:
 *     [0] AudioTrack "Drums"   (tracks[0])
 *           devices: [0] Simpler "Kit"   (tracks[0]/devices[0])
 *                       parameters: [0] "Volume" [1] "Filter"
 *           clipSlots: [0] slot WITH clip "Loop A"  (tracks[0]/clipSlots[0]/clip)
 *                      [1] slot EMPTY               (tracks[0]/clipSlots[1])
 *           takeLanes: [0] "Take 1" → clips: [0] "Comp"  (tracks[0]/takeLanes[0]/clips[0])
 *           arrangementClips: [0] "Verse" [1] "Chorus"
 *           mixer: volume "Volume", panning "Pan", sends [0] "Send A" [1] "Send B"
 *     [1] AudioTrack "Bass"    (tracks[1])
 *           devices: [0] Reverb "Reverb"            (tracks[1]/devices[0])
 *                       parameters: [0] "Decay" [1] "Dry/Wet"
 *                    [1] RackDevice "Rack"          (tracks[1]/devices[1])
 *                       chains: [0] Chain "Chain A" (tracks[1]/devices[1]/chains[0])
 *                                  devices: [0] AutoFilter "AutoFilter"
 *                                              parameters: [0] "Freq" [1] "Reso"
 *                                  mixer: volume/panning/sends[0]
 *                               [1] Chain "Chain B" (tracks[1]/devices[1]/chains[1])
 *                                  devices: [0] Operator "Operator"
 *                                              parameters: [0] "Coarse"
 *                                  mixer: volume/panning/sends[0]
 *           mixer: volume/panning/sends[0]
 *     [2] MidiTrack "Keys"     (tracks[2])
 *           devices: []   clipSlots: []   mixer: volume/panning (no sends)
 *
 *   AMBIGUITY case: tracks[1] "Bass" has TWO sibling devices is NOT ambiguous, but
 *   tracks[3] and tracks[4] BOTH named "Dup" provide a name-collision for the
 *   `ref_ambiguous` test, and tracks[1]/devices has a single Reverb (unique).
 *     [3] AudioTrack "Dup"     (tracks[3])
 *     [4] AudioTrack "Dup"     (tracks[4])  ← duplicate sibling name
 *
 *   returnTracks: [0] AudioTrack "Return A"
 *   mainTrack:    AudioTrack "Main"
 *   scenes:       [0] "Intro" [1] "Drop"
 *   cuePoints:    [0] "Start"
 *   tempo: 120
 */
function defaultSetSpec(): SetSpec {
  const mixerSpec = (sendNames: string[]): NodeSpec => ({
    className: "MixerDevice",
    children: {
      volume: [{ className: "DeviceParameter", name: "Volume" }],
      panning: [{ className: "DeviceParameter", name: "Pan" }],
      sends: sendNames.map((n) => ({ className: "DeviceParameter", name: n })),
    },
  });
  const chainMixerSpec = (): NodeSpec => ({
    className: "ChainMixerDevice",
    children: {
      volume: [{ className: "DeviceParameter", name: "Volume" }],
      panning: [{ className: "DeviceParameter", name: "Pan" }],
      sends: [{ className: "DeviceParameter", name: "Send A" }],
    },
  });

  return {
    tempo: 120,
    tracks: [
      {
        className: "AudioTrack",
        name: "Drums",
        children: {
          devices: [
            {
              className: "Simpler",
              name: "Kit",
              children: {
                parameters: [
                  { className: "DeviceParameter", name: "Volume" },
                  { className: "DeviceParameter", name: "Filter" },
                ],
              },
            },
          ],
          clipSlots: [
            {
              className: "ClipSlot",
              clip: { className: "AudioClip", name: "Loop A" },
            },
            { className: "ClipSlot", clip: null },
          ],
          takeLanes: [
            {
              className: "TakeLane",
              name: "Take 1",
              children: {
                clips: [{ className: "AudioClip", name: "Comp" }],
              },
            },
          ],
          arrangementClips: [
            { className: "AudioClip", name: "Verse" },
            { className: "AudioClip", name: "Chorus" },
          ],
        },
        mixer: mixerSpec(["Send A", "Send B"]),
      },
      {
        className: "AudioTrack",
        name: "Bass",
        children: {
          devices: [
            {
              className: "Reverb",
              name: "Reverb",
              children: {
                parameters: [
                  { className: "DeviceParameter", name: "Decay" },
                  { className: "DeviceParameter", name: "Dry/Wet" },
                ],
              },
            },
            {
              className: "RackDevice",
              name: "Rack",
              children: {
                parameters: [{ className: "DeviceParameter", name: "Macro 1" }],
                chains: [
                  {
                    className: "Chain",
                    name: "Chain A",
                    children: {
                      devices: [
                        {
                          className: "AutoFilter",
                          name: "AutoFilter",
                          children: {
                            parameters: [
                              { className: "DeviceParameter", name: "Freq" },
                              { className: "DeviceParameter", name: "Reso" },
                            ],
                          },
                        },
                      ],
                    },
                    mixer: chainMixerSpec(),
                  },
                  {
                    className: "Chain",
                    name: "Chain B",
                    children: {
                      devices: [
                        {
                          className: "Operator",
                          name: "Operator",
                          children: {
                            parameters: [
                              { className: "DeviceParameter", name: "Coarse" },
                            ],
                          },
                        },
                      ],
                    },
                    mixer: chainMixerSpec(),
                  },
                ],
              },
            },
          ],
        },
        mixer: mixerSpec(["Send A"]),
      },
      {
        className: "MidiTrack",
        name: "Keys",
        children: {
          devices: [],
          clipSlots: [],
        },
        mixer: {
          className: "MixerDevice",
          children: {
            volume: [{ className: "DeviceParameter", name: "Volume" }],
            panning: [{ className: "DeviceParameter", name: "Pan" }],
            sends: [],
          },
        },
      },
      { className: "AudioTrack", name: "Dup", mixer: mixerSpec([]) },
      { className: "AudioTrack", name: "Dup", mixer: mixerSpec([]) },
    ],
    returnTracks: [
      { className: "AudioTrack", name: "Return A", mixer: mixerSpec([]) },
    ],
    mainTrack: { className: "AudioTrack", name: "Main", mixer: mixerSpec([]) },
    scenes: [
      { className: "Scene", name: "Intro" },
      { className: "Scene", name: "Drop" },
    ],
    cuePoints: [{ className: "CuePoint", name: "Start" }],
  };
}
// #endregion
