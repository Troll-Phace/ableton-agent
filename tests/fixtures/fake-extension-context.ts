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

export interface FakeDeviceParameter extends FakeObject {
  readonly name: string;
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
}

export interface FakeChain extends FakeObject {
  readonly name: string;
  readonly devices: FakeDevice[];
  readonly mixer: FakeChainMixer;
}

export interface FakeClip extends FakeObject {
  readonly name: string;
}

export interface FakeClipSlot extends FakeObject {
  /** ClipSlot has NO name (SDK fidelity). */
  readonly clip: FakeClip | null;
}

export interface FakeTakeLane extends FakeObject {
  readonly name: string;
  readonly clips: FakeClip[];
}

export interface FakeTrack extends FakeObject {
  readonly name: string;
  readonly devices: FakeDevice[];
  readonly clipSlots: FakeClipSlot[];
  readonly takeLanes: FakeTakeLane[];
  readonly arrangementClips: FakeClip[];
  readonly mixer: FakeTrackMixer;
}

export interface FakeScene extends FakeObject {
  readonly name: string;
}

export interface FakeCuePoint extends FakeObject {
  readonly name: string;
}

export interface FakeSong extends FakeObject {
  readonly tracks: FakeTrack[];
  readonly returnTracks: FakeTrack[];
  readonly mainTrack: FakeTrack;
  readonly scenes: FakeScene[];
  readonly cuePoints: FakeCuePoint[];
  readonly tempo: number;
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
    };
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
  const tempo = filled.tempo ?? 120;

  // --- live array helper: fresh array of non-deleted children on each access ---
  const liveChildren = (node: FakeNode, key: string): FakeNode[] =>
    (node.children.get(key) ?? []).filter((c) => !c.deleted);

  // --- getter-proxy builders (each reads its backing node live) ---
  function makeParam(node: FakeNode): FakeDeviceParameter {
    return {
      handle: { id: node.id },
      get name() {
        return node.name;
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
    return {
      handle: { id: node.id },
      get name() {
        return node.name;
      },
    };
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
    // RackDevice / DrumRack expose `chains`.
    if (node.children.has("chains")) {
      return {
        ...base,
        get chains() {
          return liveChildren(node, "chains").map(makeChain);
        },
      };
    }
    return base;
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
    };
  }

  function makeClipSlot(node: FakeNode): FakeClipSlot {
    return {
      handle: { id: node.id },
      get clip() {
        return node.clip && !node.clip.deleted ? makeClip(node.clip) : null;
      },
    };
  }

  function makeTakeLane(node: FakeNode): FakeTakeLane {
    return {
      handle: { id: node.id },
      get name() {
        return node.name;
      },
      get clips() {
        return liveChildren(node, "clips").map(makeClip);
      },
    };
  }

  function makeTrack(node: FakeNode): FakeTrack {
    return {
      handle: { id: node.id },
      get name() {
        return node.name;
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
    };
  }

  function makeScene(node: FakeNode): FakeScene {
    return {
      handle: { id: node.id },
      get name() {
        return node.name;
      },
    };
  }

  function makeCuePoint(node: FakeNode): FakeCuePoint {
    return {
      handle: { id: node.id },
      get name() {
        return node.name;
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
      return tempo;
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

  return {
    application: { song },
    getObjectFromHandle,
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
