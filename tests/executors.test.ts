import { describe, expect, it, vi } from "vitest";

import type { ApiVersion, ExtensionContext } from "@ableton-extensions/sdk";

import { LiveToolRuntime } from "../src/extension/tool-registry.js";
import { ReferenceTable, resolveRef } from "../src/extension/references.js";
import {
  beatsToSeconds,
  secondsToBeats,
} from "../src/extension/executors/shared.js";
import type {
  ToolCall,
  ToolResultPayload,
} from "../src/extension/agent-loop.js";
import {
  makeFakeContext,
  type FakeExtensionContext,
  type NodeSpec,
  type SetSpec,
  type FakeNoteDescription,
} from "./fixtures/fake-extension-context.js";

/**
 * Phase 5 Task 6 — executor + transaction-batching suite (ARCHITECTURE §8, §7,
 * §6, §9, §16). Drives the real {@link LiveToolRuntime} (registry + executors)
 * against the {@link FakeExtensionContext}.
 *
 * ## className tagging shim (the one fidelity gap, documented)
 * The resolver derives a resolved object's `className` from
 * `object.constructor.className`. The REAL SDK classes carry a `static
 * className` (verified in `node_modules/@ableton-extensions/sdk/dist/index.cjs`),
 * so in production the executors' className dispatch ("AudioClip" vs "MidiClip"
 * vs "ClipSlot") works. The fake's materialized proxies are plain objects with
 * no such tag, so without help the resolver falls back to the BASE class name
 * ("Clip", never "MidiClip"/"AudioClip"). {@link tagged} wraps the fake's
 * `getObjectFromHandle` to attach a `constructor.className` equal to the node's
 * concrete class — faithfully reproducing the production className the executors
 * branch on, so the MIDI/audio-clip code paths are genuinely exercised.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Concrete classes probed for the className tag, most-derived first. */
const CONCRETE_CLASSES = [
  "DrumRackDevice",
  "RackDevice",
  "Simpler",
  "Reverb",
  "AutoFilter",
  "Operator",
  "AudioClip",
  "MidiClip",
  "AudioTrack",
  "MidiTrack",
  "DrumChain",
  "Chain",
  "ClipSlot",
  "TakeLane",
  "Scene",
  "CuePoint",
  "DeviceParameter",
  "Track",
  "Clip",
  "Device",
] as const;

/** A minimal abstract-ctor token carrying a `static className` the fake reads. */
function classToken(className: string): unknown {
  abstract class Token {
    static readonly className = className;
  }
  return Token;
}

/**
 * Wrap the fake's `getObjectFromHandle` so every returned object carries a
 * non-enumerable `constructor.className` equal to the node's concrete class —
 * matching the real SDK and letting the resolver report "MidiClip"/"AudioClip"
 * etc. (see the file docstring). Idempotent per object.
 */
function tagged(fake: FakeExtensionContext): FakeExtensionContext {
  const raw = fake.getObjectFromHandle.bind(fake);
  const probeClassName = (handle: { id: bigint }): string | undefined => {
    for (const c of CONCRETE_CLASSES) {
      try {
        raw(handle, classToken(c) as never);
        return c;
      } catch {
        // not this class; keep probing
      }
    }
    return undefined;
  };
  fake.getObjectFromHandle = <T>(handle: { id: bigint }, type: unknown): T => {
    const obj: unknown = raw(handle, type as never);
    if (obj !== null && typeof obj === "object") {
      const cn = probeClassName(handle);
      if (cn !== undefined) {
        Object.defineProperty(obj, "constructor", {
          value: { className: cn },
          enumerable: false,
          configurable: true,
        });
      }
    }
    return obj as T;
  };
  return fake;
}

/** Cast the fake to the SDK context type at the documented seam. */
function ctxOf(fake: FakeExtensionContext): ExtensionContext<ApiVersion> {
  return fake as unknown as ExtensionContext<ApiVersion>;
}

/** Build a runtime over a fake Set with a fresh turn-scoped table + optional signal. */
function runtimeOf(
  fake: FakeExtensionContext,
  refs: ReferenceTable = new ReferenceTable(),
  signal?: AbortSignal
): LiveToolRuntime<ApiVersion> {
  return new LiveToolRuntime(ctxOf(fake), refs, signal);
}

/** A {@link ToolCall} with a deterministic id derived from the tool name. */
function call(name: string, input: unknown, id = `id_${name}`): ToolCall {
  return { id, name, input };
}

/** Parse a payload's JSON content. */
function body(p: ToolResultPayload): Record<string, unknown> {
  return JSON.parse(p.content as string) as Record<string, unknown>;
}

/** A MixerDevice spec with named volume/pan and the given send names. */
function mixerSpec(sends: string[] = []): NodeSpec {
  return {
    className: "MixerDevice",
    children: {
      volume: [{ className: "DeviceParameter", name: "Volume" }],
      panning: [{ className: "DeviceParameter", name: "Pan" }],
      sends: sends.map((n) => ({ className: "DeviceParameter", name: n })),
    },
  };
}

// ---------------------------------------------------------------------------
// Read executors
// ---------------------------------------------------------------------------

describe("read executors — live_get_project", () => {
  it("executor_getProject_returnsHeaderShape", async () => {
    const p = await runtimeOf(makeFakeContext()).executeRead(
      call("live_get_project", {})
    );
    expect(p.isError).toBeUndefined();
    const data = body(p);
    expect(data.tempo).toBe(120);
    expect(data.tracks).toEqual([
      { index: 0, name: "Drums" },
      { index: 1, name: "Bass" },
      { index: 2, name: "Keys" },
      { index: 3, name: "Dup" },
      { index: 4, name: "Dup" },
    ]);
    expect(data.scenes).toEqual([
      { index: 0, name: "Intro" },
      { index: 1, name: "Drop" },
    ]);
    expect(data.cuePoints).toEqual([{ index: 0, name: "Start" }]);
    expect((data.mainTrack as { name: string }).name).toBe("Main");
  });
});

describe("read executors — live_get_track", () => {
  it("executor_getTrack_returnsContentsShape", async () => {
    const p = await runtimeOf(tagged(makeFakeContext())).executeRead(
      call("live_get_track", { track: "track:0:Drums" })
    );
    expect(p.isError).toBeUndefined();
    const data = body(p);
    expect(data.name).toBe("Drums");
    expect(data.devices).toEqual([{ index: 0, name: "Kit" }]);
    expect(data.arrangementClips).toEqual([
      { index: 0, name: "Verse" },
      { index: 1, name: "Chorus" },
    ]);
    expect(data.clipSlots).toEqual([
      { index: 0, hasClip: true, clipName: "Loop A" },
      { index: 1, hasClip: false, clipName: null },
    ]);
    expect(data.takeLanes).toEqual([{ index: 0, name: "Take 1" }]);
    expect(data.hasMixer).toBe(true);
  });

  it("executor_getTrack_missingRefArg_returnsInvalidArgs", async () => {
    const p = await runtimeOf(makeFakeContext()).executeRead(
      call("live_get_track", {})
    );
    expect(p.isError).toBe(true);
    expect(body(p).error).toBe("invalid_args");
  });

  it("executor_getTrack_nonObjectInput_returnsInvalidArgs", async () => {
    const p = await runtimeOf(makeFakeContext()).executeRead(
      call("live_get_track", "not-an-object")
    );
    expect(p.isError).toBe(true);
    expect(body(p).error).toBe("invalid_args");
  });
});

describe("read executors — live_get_clip", () => {
  it("executor_getClip_midiClip_returnsNotes", async () => {
    const notes: FakeNoteDescription[] = [
      { pitch: 60, startTime: 0, duration: 1, velocity: 100 },
      { pitch: 64, startTime: 1, duration: 1, velocity: 90 },
    ];
    const fake = tagged(
      makeFakeContext({
        tracks: [
          {
            className: "MidiTrack",
            name: "Keys",
            children: {
              arrangementClips: [
                { className: "MidiClip", name: "Chords", notes },
              ],
            },
            mixer: mixerSpec(),
          },
        ],
      })
    );
    const p = await runtimeOf(fake).executeRead(
      call("live_get_clip", { clip: "track:0:Keys/clip:0:Chords" })
    );
    expect(p.isError).toBeUndefined();
    const data = body(p);
    expect(data.className).toBe("MidiClip");
    expect(data.notes).toEqual(notes);
    // Audio-only fields must be absent on a MIDI clip.
    expect("warping" in data).toBe(false);
    expect("filePath" in data).toBe(false);
  });

  it("executor_getClip_audioClip_returnsWarpFields", async () => {
    const fake = tagged(
      makeFakeContext({
        tracks: [
          {
            className: "AudioTrack",
            name: "Drums",
            children: {
              arrangementClips: [
                {
                  className: "AudioClip",
                  name: "Loop",
                  warping: true,
                  warpMode: 4,
                },
              ],
            },
            mixer: mixerSpec(),
          },
        ],
      })
    );
    const p = await runtimeOf(fake).executeRead(
      call("live_get_clip", { clip: "track:0:Drums/clip:0:Loop" })
    );
    expect(p.isError).toBeUndefined();
    const data = body(p);
    expect(data.className).toBe("AudioClip");
    expect(data.warping).toBe(true);
    expect(data.warpMode).toBe(4);
    // notes is a MIDI-only field.
    expect("notes" in data).toBe(false);
  });

  it("executor_getClip_missingRefArg_returnsInvalidArgs", async () => {
    const p = await runtimeOf(makeFakeContext()).executeRead(
      call("live_get_clip", {})
    );
    expect(p.isError).toBe(true);
    expect(body(p).error).toBe("invalid_args");
  });
});

describe("read executors — live_get_device_params (lazy getValue)", () => {
  it("executor_getDeviceParams_returnsParamsWithValues", async () => {
    const fake = tagged(
      makeFakeContext({
        tracks: [
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
                      {
                        className: "DeviceParameter",
                        name: "Decay",
                        param: { min: 0, max: 10, value: 3 },
                      },
                      {
                        className: "DeviceParameter",
                        name: "Dry/Wet",
                        param: { min: 0, max: 1, value: 0.5 },
                      },
                    ],
                  },
                },
              ],
            },
            mixer: mixerSpec(),
          },
        ],
      })
    );
    const p = await runtimeOf(fake).executeRead(
      call("live_get_device_params", {
        device: "track:0:Bass/device:0:Reverb",
      })
    );
    expect(p.isError).toBeUndefined();
    const data = body(p);
    const params = data.parameters as Array<Record<string, unknown>>;
    expect(params).toHaveLength(2);
    expect(params[0]).toMatchObject({
      name: "Decay",
      value: 3,
      min: 0,
      max: 10,
    });
    expect(params[1]).toMatchObject({ name: "Dry/Wet", value: 0.5 });
  });

  it("executor_getDeviceParams_callsGetValueOnDemandNotEagerly", async () => {
    // Spy on getValue: it must be called exactly once per param of THIS device
    // (lazy on-demand fan-out, §15) — never eagerly across the whole Set.
    const fake = makeFakeContext({
      tracks: [
        {
          className: "AudioTrack",
          name: "A",
          children: {
            devices: [
              {
                className: "Reverb",
                name: "Reverb",
                children: {
                  parameters: [
                    {
                      className: "DeviceParameter",
                      name: "P0",
                      param: { value: 1 },
                    },
                    {
                      className: "DeviceParameter",
                      name: "P1",
                      param: { value: 2 },
                    },
                  ],
                },
              },
            ],
          },
          mixer: mixerSpec(),
        },
        // A SECOND track whose device params must NOT be read.
        {
          className: "AudioTrack",
          name: "B",
          children: {
            devices: [
              {
                className: "Reverb",
                name: "Other",
                children: {
                  parameters: [
                    {
                      className: "DeviceParameter",
                      name: "Q0",
                      param: { value: 9 },
                    },
                  ],
                },
              },
            ],
          },
          mixer: mixerSpec(),
        },
      ],
    });
    tagged(fake);

    // Spy on getValue by wrapping the RESOLVED device's `parameters` getter: the
    // executor reads `device.parameters` and calls `getValue()` per param. Each
    // wrapped param increments the spy, so the count proves the fan-out is scoped
    // to THIS device (the §15 on-demand fan-out) and is not eager across the Set.
    const spy = vi.fn();
    const origGet = fake.getObjectFromHandle.bind(fake);
    fake.getObjectFromHandle = <T>(
      handle: { id: bigint },
      type: unknown
    ): T => {
      const obj: unknown = origGet(handle, type as never);
      const desc =
        obj !== null && typeof obj === "object"
          ? Object.getOwnPropertyDescriptor(obj, "parameters")
          : undefined;
      // Only the device proxy exposes a `parameters` array getter.
      if (obj !== null && typeof obj === "object" && desc?.get) {
        const innerGetter = desc.get.bind(obj);
        Object.defineProperty(obj, "parameters", {
          configurable: true,
          enumerable: true,
          get() {
            const params = innerGetter() as Array<{
              getValue: () => Promise<number>;
            }>;
            return params.map((param) => {
              const original = param.getValue.bind(param);
              return Object.assign(param, {
                getValue: (): Promise<number> => {
                  spy();
                  return original();
                },
              });
            });
          },
        });
      }
      return obj as T;
    };

    const p = await runtimeOf(fake).executeRead(
      call("live_get_device_params", { device: "track:0:A/device:0:Reverb" })
    );
    expect(p.isError).toBeUndefined();
    const data = body(p);
    const params = data.parameters as Array<Record<string, unknown>>;
    expect(params.map((x) => x.value)).toEqual([1, 2]);
    // getValue fired only for the two params of the requested device.
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("read executors — live_render_audio is deferred (not a fake success)", () => {
  it("executor_renderAudio_returnsDeferredError", async () => {
    const p = await runtimeOf(makeFakeContext()).executeRead(
      call("live_render_audio", {
        track: "track:0:Drums",
        startTime: 0,
        endTime: 4,
      })
    );
    expect(p.isError).toBe(true);
    expect(body(p).error).toBe("deferred");
  });
});

// ---------------------------------------------------------------------------
// Mutation executors via flushMutations — transaction discipline (§7)
// ---------------------------------------------------------------------------

describe("mutation batching — one transaction per flush (§7)", () => {
  it("executor_flushMutations_batchesAllIntoOneCommittedTransaction", async () => {
    const fake = makeFakeContext();
    const calls: ToolCall[] = [
      call("live_update_track", { track: "track:0:Drums", name: "Kick" }, "a"),
      call("live_update_track", { track: "track:1:Bass", mute: true }, "b"),
      call("live_update_track", { track: "track:2:Keys", solo: true }, "c"),
    ];
    const results = await runtimeOf(fake).flushMutations(calls);
    // Exactly ONE committed transaction for the whole batch — the load-bearing
    // §7 assertion.
    expect(fake.transactions).toEqual([{ committed: true, rolledBack: false }]);
    expect(fake.committedCount).toBe(1);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.isError === undefined)).toBe(true);
  });

  it("executor_flushMutations_returnsOnePayloadPerCallInOrder", async () => {
    const fake = makeFakeContext();
    const calls: ToolCall[] = [
      call("live_update_track", { track: "track:0:Drums", name: "X" }, "first"),
      call("live_update_track", { track: "track:1:Bass", name: "Y" }, "second"),
      call("live_update_track", { track: "track:2:Keys", name: "Z" }, "third"),
    ];
    const results = await runtimeOf(fake).flushMutations(calls);
    expect(results.map((r) => r.toolUseId)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("executor_flushMutations_emptyBatch_opensNoTransaction", async () => {
    const fake = makeFakeContext();
    const results = await runtimeOf(fake).flushMutations([]);
    expect(results).toEqual([]);
    expect(fake.transactions).toEqual([]);
  });

  it("executor_flushMutations_mixedErrorAndOk_appliesOkAndKeepsErrorPayload", async () => {
    const fake = makeFakeContext();
    const calls: ToolCall[] = [
      call("live_update_track", { track: "track:0:Drums", name: "OK" }, "ok"),
      // A bad ref → prepare-error; should NOT abort the batch's runnable plan.
      call("live_update_track", { track: "track:9:Ghost" }, "bad"),
    ];
    const results = await runtimeOf(fake).flushMutations(calls);
    expect(results[0].isError).toBeUndefined();
    expect(results[1].isError).toBe(true);
    expect(body(results[1]).error).toBe("ref_unresolved");
    // The one runnable mutation still committed in a single transaction.
    expect(fake.transactions).toEqual([{ committed: true, rolledBack: false }]);
    expect(fake.application.song.tracks[0].name).toBe("OK");
  });
});

describe("mutation executors — live_update_track / live_update_clip", () => {
  it("executor_updateTrack_appliesSyncSetters", async () => {
    const fake = makeFakeContext();
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_update_track", {
        track: "track:0:Drums",
        name: "Beats",
        mute: true,
        solo: true,
        arm: true,
      }),
    ]);
    expect(r.isError).toBeUndefined();
    const t = fake.application.song.tracks[0];
    expect(t.name).toBe("Beats");
    expect(t.mute).toBe(true);
    expect(t.solo).toBe(true);
    expect(t.arm).toBe(true);
    expect(body(r).updated).toEqual(["name", "mute", "solo", "arm"]);
  });

  it("executor_updateTrack_wrongTypeField_returnsInvalidArgs", async () => {
    const fake = makeFakeContext();
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_update_track", { track: "track:0:Drums", mute: "yes" }),
    ]);
    expect(r.isError).toBe(true);
    expect(body(r).error).toBe("invalid_args");
    // A pure prepare-error batch opens NO transaction.
    expect(fake.transactions).toEqual([]);
  });

  it("executor_updateClip_appliesNameColorLooping", async () => {
    const fake = tagged(makeFakeContext());
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_update_clip", {
        clip: "track:0:Drums/clipSlot:0/clip:0:Loop A",
        name: "Loop B",
        color: 255,
        looping: true,
      }),
    ]);
    expect(r.isError).toBeUndefined();
    const clip = fake.application.song.tracks[0].clipSlots[0].clip;
    expect(clip?.name).toBe("Loop B");
    expect(clip?.color).toBe(255);
    expect(clip?.looping).toBe(true);
  });

  it("executor_updateClip_warpOnMidiClip_returnsUnsupported", async () => {
    const fake = tagged(
      makeFakeContext({
        tracks: [
          {
            className: "MidiTrack",
            name: "Keys",
            children: {
              arrangementClips: [
                { className: "MidiClip", name: "Chords", notes: [] },
              ],
            },
            mixer: mixerSpec(),
          },
        ],
      })
    );
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_update_clip", {
        clip: "track:0:Keys/clip:0:Chords",
        warping: true,
      }),
    ]);
    expect(r.isError).toBe(true);
    expect(body(r).error).toBe("unsupported");
  });

  it("executor_updateClip_unknownWarpMode_returnsInvalidArgs", async () => {
    const fake = tagged(
      makeFakeContext({
        tracks: [
          {
            className: "AudioTrack",
            name: "Drums",
            children: {
              arrangementClips: [
                {
                  className: "AudioClip",
                  name: "Loop",
                  warping: false,
                  warpMode: 0,
                },
              ],
            },
            mixer: mixerSpec(),
          },
        ],
      })
    );
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_update_clip", {
        clip: "track:0:Drums/clip:0:Loop",
        warpMode: "Bogus",
      }),
    ]);
    expect(r.isError).toBe(true);
    expect(body(r).error).toBe("invalid_args");
  });

  it("executor_updateClip_audioWarpMode_appliesEnumValue", async () => {
    const fake = tagged(
      makeFakeContext({
        tracks: [
          {
            className: "AudioTrack",
            name: "Drums",
            children: {
              arrangementClips: [
                {
                  className: "AudioClip",
                  name: "Loop",
                  warping: false,
                  warpMode: 0,
                },
              ],
            },
            mixer: mixerSpec(),
          },
        ],
      })
    );
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_update_clip", {
        clip: "track:0:Drums/clip:0:Loop",
        warping: true,
        warpMode: "ComplexPro",
      }),
    ]);
    expect(r.isError).toBeUndefined();
    const clip = fake.application.song.tracks[0].arrangementClips[0];
    expect(clip.warping).toBe(true);
    // "ComplexPro" maps to the SDK enum value 6.
    expect(clip.warpMode).toBe(6);
  });
});

describe("mutation executors — live_set_param (clamp / quantize / mixer routing)", () => {
  function paramSet(): SetSpec {
    return {
      tracks: [
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
                    {
                      className: "DeviceParameter",
                      name: "Decay",
                      param: { min: 0, max: 10, value: 1 },
                    },
                    {
                      className: "DeviceParameter",
                      name: "Mode",
                      param: {
                        min: 0,
                        max: 3,
                        isQuantized: true,
                        value: 0,
                        valueItems: [
                          { name: "A", shortName: "A" },
                          { name: "B", shortName: "B" },
                          { name: "C", shortName: "C" },
                          { name: "D", shortName: "D" },
                        ],
                      },
                    },
                  ],
                },
              },
            ],
          },
          mixer: mixerSpec(["Send A", "Send B"]),
        },
      ],
    };
  }

  it("executor_setParam_device_clampsAboveMax", async () => {
    const fake = tagged(makeFakeContext(paramSet()));
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_set_param", {
        target: {
          type: "device",
          device: "track:0:Bass/device:0:Reverb",
          param: "track:0:Bass/device:0:Reverb/param:0:Decay",
        },
        value: 999,
      }),
    ]);
    expect(r.isError).toBeUndefined();
    expect(fake.paramValueOf("tracks[0]/devices[0]/parameters[0]")).toBe(10);
    expect(body(r)).toMatchObject({ value: 10, clampedFrom: 999 });
  });

  it("executor_setParam_device_clampsBelowMin", async () => {
    const fake = tagged(makeFakeContext(paramSet()));
    await runtimeOf(fake).flushMutations([
      call("live_set_param", {
        target: {
          type: "device",
          device: "track:0:Bass/device:0:Reverb",
          param: "track:0:Bass/device:0:Reverb/param:0:Decay",
        },
        value: -5,
      }),
    ]);
    expect(fake.paramValueOf("tracks[0]/devices[0]/parameters[0]")).toBe(0);
  });

  it("executor_setParam_quantized_snapsToNearestStep", async () => {
    const fake = tagged(makeFakeContext(paramSet()));
    await runtimeOf(fake).flushMutations([
      call("live_set_param", {
        target: {
          type: "device",
          device: "track:0:Bass/device:0:Reverb",
          param: "track:0:Bass/device:0:Reverb/param:1:Mode",
        },
        value: 2.4,
      }),
    ]);
    // 2.4 → rounds to 2 (within [0,3]).
    expect(fake.paramValueOf("tracks[0]/devices[0]/parameters[1]")).toBe(2);
  });

  it("executor_setParam_mixerVolume_routesToMixerParam", async () => {
    const fake = tagged(makeFakeContext(paramSet()));
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_set_param", {
        target: {
          type: "mixer",
          track: "track:0:Bass",
          mixer: { kind: "volume" },
        },
        value: 0.7,
      }),
    ]);
    expect(r.isError).toBeUndefined();
    expect(fake.paramValueOf("tracks[0]/mixer/volume")).toBeCloseTo(0.7);
  });

  it("executor_setParam_mixerSendIndex_routesToSend", async () => {
    const fake = tagged(makeFakeContext(paramSet()));
    await runtimeOf(fake).flushMutations([
      call("live_set_param", {
        target: {
          type: "mixer",
          track: "track:0:Bass",
          mixer: { kind: "send", index: 1 },
        },
        value: 0.25,
      }),
    ]);
    expect(fake.paramValueOf("tracks[0]/mixer/sends[1]")).toBeCloseTo(0.25);
  });

  it("executor_setParam_nonNumericValue_returnsInvalidArgs", async () => {
    const fake = tagged(makeFakeContext(paramSet()));
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_set_param", {
        target: {
          type: "mixer",
          track: "track:0:Bass",
          mixer: { kind: "volume" },
        },
        value: "loud",
      }),
    ]);
    expect(r.isError).toBe(true);
    expect(body(r).error).toBe("invalid_args");
  });

  it("executor_setParam_badMixerSelector_returnsInvalidArgs", async () => {
    const fake = tagged(makeFakeContext(paramSet()));
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_set_param", {
        target: {
          type: "mixer",
          track: "track:0:Bass",
          mixer: { kind: "send" }, // missing index
        },
        value: 0.5,
      }),
    ]);
    expect(r.isError).toBe(true);
    expect(body(r).error).toBe("invalid_args");
  });
});

// ---------------------------------------------------------------------------
// live_edit_midi_notes
// ---------------------------------------------------------------------------

describe("mutation executors — live_edit_midi_notes", () => {
  function midiSet(notes: FakeNoteDescription[]): SetSpec {
    return {
      tracks: [
        {
          className: "MidiTrack",
          name: "Keys",
          children: {
            arrangementClips: [
              { className: "MidiClip", name: "Chords", notes },
            ],
          },
          mixer: mixerSpec(),
        },
      ],
    };
  }
  const clipRef = "track:0:Keys/clip:0:Chords";

  it("executor_editMidiNotes_replace_setsNotes", async () => {
    const fake = tagged(makeFakeContext(midiSet([])));
    const notes = [
      { pitch: 60, startTime: 0, duration: 1, velocity: 100 },
      { pitch: 67, startTime: 1, duration: 1, velocity: 80 },
    ];
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_edit_midi_notes", { clip: clipRef, op: "replace", notes }),
    ]);
    expect(r.isError).toBeUndefined();
    expect(fake.notesOf("tracks[0]/arrangementClips[0]")).toEqual(notes);
    expect(body(r)).toMatchObject({
      op: "replace",
      noteCount: 2,
      destructive: false,
    });
  });

  it("executor_editMidiNotes_transpose_shiftsPitch", async () => {
    const fake = tagged(
      makeFakeContext(
        midiSet([{ pitch: 60, startTime: 0, duration: 1, velocity: 100 }])
      )
    );
    await runtimeOf(fake).flushMutations([
      call("live_edit_midi_notes", {
        clip: clipRef,
        op: "transpose",
        semitones: 12,
      }),
    ]);
    expect(fake.notesOf("tracks[0]/arrangementClips[0]")[0].pitch).toBe(72);
  });

  it("executor_editMidiNotes_quantize_snapsStartToGrid", async () => {
    const fake = tagged(
      makeFakeContext(
        midiSet([{ pitch: 60, startTime: 0.23, duration: 1, velocity: 100 }])
      )
    );
    await runtimeOf(fake).flushMutations([
      call("live_edit_midi_notes", {
        clip: clipRef,
        op: "quantize",
        grid: 0.25,
        strength: 1,
      }),
    ]);
    // 0.23 → nearest 0.25 grid → 0.25 at full strength.
    expect(
      fake.notesOf("tracks[0]/arrangementClips[0]")[0].startTime
    ).toBeCloseTo(0.25);
  });

  it("executor_editMidiNotes_humanize_isDeterministic", async () => {
    const seed = [{ pitch: 60, startTime: 1, duration: 1, velocity: 100 }];
    const make = () => tagged(makeFakeContext(midiSet(seed)));
    const editCall = call("live_edit_midi_notes", {
      clip: clipRef,
      op: "humanize",
      timingAmount: 0.1,
      velocityAmount: 10,
    });
    const fakeA = make();
    await runtimeOf(fakeA).flushMutations([editCall]);
    const fakeB = make();
    await runtimeOf(fakeB).flushMutations([editCall]);
    // Identity-seeded jitter → identical output across runs (no wall-clock RNG).
    expect(fakeA.notesOf("tracks[0]/arrangementClips[0]")).toEqual(
      fakeB.notesOf("tracks[0]/arrangementClips[0]")
    );
  });

  it("executor_editMidiNotes_filter_isDestructiveAndRemovesNotes", async () => {
    const fake = tagged(
      makeFakeContext(
        midiSet([
          { pitch: 40, startTime: 0, duration: 1, velocity: 100 },
          { pitch: 70, startTime: 1, duration: 1, velocity: 100 },
        ])
      )
    );
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_edit_midi_notes", {
        clip: clipRef,
        op: "filter",
        filter: { pitchMin: 60, pitchMax: 127 },
      }),
    ]);
    expect(r.isError).toBeUndefined();
    expect(body(r).destructive).toBe(true);
    const remaining = fake.notesOf("tracks[0]/arrangementClips[0]");
    expect(remaining.map((n) => n.pitch)).toEqual([70]);
  });

  it("executor_editMidiNotes_onAudioClip_returnsUnsupported", async () => {
    const fake = tagged(
      makeFakeContext({
        tracks: [
          {
            className: "AudioTrack",
            name: "Drums",
            children: {
              arrangementClips: [
                {
                  className: "AudioClip",
                  name: "Loop",
                  warping: false,
                  warpMode: 0,
                },
              ],
            },
            mixer: mixerSpec(),
          },
        ],
      })
    );
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_edit_midi_notes", {
        clip: "track:0:Drums/clip:0:Loop",
        op: "transpose",
        semitones: 1,
      }),
    ]);
    expect(r.isError).toBe(true);
    expect(body(r).error).toBe("unsupported");
  });

  it("executor_editMidiNotes_badOp_returnsInvalidArgs", async () => {
    const fake = tagged(makeFakeContext(midiSet([])));
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_edit_midi_notes", { clip: clipRef, op: "groove" }),
    ]);
    expect(r.isError).toBe(true);
    expect(body(r).error).toBe("invalid_args");
  });
});

// ---------------------------------------------------------------------------
// live_create — mints a fresh ref; object is live in the parent collection
// ---------------------------------------------------------------------------

describe("mutation executors — live_create", () => {
  it("executor_create_audioTrack_mintsFreshRefAndIsLive", async () => {
    const fake = makeFakeContext();
    const before = fake.application.song.tracks.length;
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_create", { kind: "audio_track" }),
    ]);
    expect(r.isError).toBeUndefined();
    const data = body(r);
    expect(data.created).toBe("audio track");
    expect(typeof data.ref).toBe("string");
    // The new track is live in the song collection at the minted index.
    expect(fake.application.song.tracks.length).toBe(before + 1);
    expect(data.ref).toBe(`track:${before}:`);
    expect(fake.transactions).toEqual([{ committed: true, rolledBack: false }]);
  });

  it("executor_create_midiTrack_mintsFreshRef", async () => {
    const fake = makeFakeContext();
    const before = fake.application.song.tracks.length;
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_create", { kind: "midi_track" }),
    ]);
    expect(body(r).created).toBe("MIDI track");
    expect(fake.application.song.tracks.length).toBe(before + 1);
  });

  it("executor_create_scene_appendsAndMintsRef", async () => {
    const fake = makeFakeContext();
    const before = fake.application.song.scenes.length;
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_create", { kind: "scene" }),
    ]);
    expect(body(r).created).toBe("scene");
    expect(fake.application.song.scenes.length).toBe(before + 1);
  });

  it("executor_create_cuePoint_requiresTime", async () => {
    const fake = makeFakeContext();
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_create", { kind: "cue_point" }),
    ]);
    expect(r.isError).toBe(true);
    expect(body(r).error).toBe("invalid_args");
  });

  it("executor_create_cuePoint_withTime_creates", async () => {
    const fake = makeFakeContext();
    const before = fake.application.song.cuePoints.length;
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_create", { kind: "cue_point", time: 8 }),
    ]);
    expect(body(r).created).toBe("cuePoint");
    expect(fake.application.song.cuePoints.length).toBe(before + 1);
  });

  it("executor_create_takeLane_mintsChildRefUnderTrack", async () => {
    const fake = tagged(makeFakeContext());
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_create", {
        kind: "take_lane",
        takeLaneTrack: "track:0:Drums",
      }),
    ]);
    expect(r.isError).toBeUndefined();
    const data = body(r);
    expect(data.created).toBe("take lane");
    // The minted ref is anchored under the parent track.
    expect(String(data.ref)).toContain("track:0:Drums/takeLane:");
    // Live: track 0 now has 2 take lanes (seed had 1).
    expect(fake.application.song.tracks[0].takeLanes.length).toBe(2);
  });

  it("executor_create_unknownKind_returnsInvalidArgs", async () => {
    const fake = makeFakeContext();
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_create", { kind: "group_track" }),
    ]);
    expect(r.isError).toBe(true);
    expect(body(r).error).toBe("invalid_args");
  });
});

// ---------------------------------------------------------------------------
// live_create — full-honor `name` via create-then-configure (§7)
//
// No SDK create method accepts a name at creation, so a named `live_create`
// applies the name ITSELF in a SECOND shared transaction after the create
// transaction settles. These tests pin: the name lands per kind, the ref's name
// segment reflects it, the batch costs exactly TWO undo steps (one shared rename
// txn no matter how many names), an unnamed create stays at ONE, mixed
// async-create + sync-update batches distribute results correctly, and the
// cancel/throw paths return an honest un-renamed SUCCESS with the right note.
// ---------------------------------------------------------------------------

describe("mutation executors — live_create honors `name` (create-then-configure §7)", () => {
  /** The last segment of a `/`-joined ref (kind:index:name). */
  function leafSegment(ref: unknown): string {
    const s = String(ref);
    const parts = s.split("/");
    return parts[parts.length - 1];
  }

  // --- Item 1: named create applies the name — per kind ---

  it("executor_create_audioTrack_named_appliesNameAndMintsNamedRef", async () => {
    const fake = makeFakeContext();
    const before = fake.application.song.tracks.length;
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_create", { kind: "audio_track", name: "Vox" }),
    ]);
    expect(r.isError).toBeUndefined();
    const data = body(r);
    expect(data.created).toBe("audio track");
    // The live object carries the applied name.
    expect(fake.application.song.tracks[before].name).toBe("Vox");
    // The minted ref's name segment reflects the applied name (minted post-rename).
    expect(data.ref).toBe(`track:${before}:Vox`);
    // No "not applied" note when the name landed.
    expect(data.note).toBeUndefined();
  });

  it("executor_create_midiTrack_named_appliesNameAndMintsNamedRef", async () => {
    const fake = makeFakeContext();
    const before = fake.application.song.tracks.length;
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_create", { kind: "midi_track", name: "Lead" }),
    ]);
    expect(r.isError).toBeUndefined();
    expect(fake.application.song.tracks[before].name).toBe("Lead");
    expect(body(r).ref).toBe(`track:${before}:Lead`);
  });

  it("executor_create_scene_named_appliesNameAndMintsNamedRef", async () => {
    const fake = makeFakeContext();
    const before = fake.application.song.scenes.length;
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_create", { kind: "scene", name: "Bridge" }),
    ]);
    expect(r.isError).toBeUndefined();
    expect(fake.application.song.scenes[before].name).toBe("Bridge");
    expect(body(r).ref).toBe(`scene:${before}:Bridge`);
  });

  it("executor_create_cuePoint_named_appliesNameAndMintsNamedRef", async () => {
    const fake = makeFakeContext();
    const before = fake.application.song.cuePoints.length;
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_create", { kind: "cue_point", time: 8, name: "Verse 2" }),
    ]);
    expect(r.isError).toBeUndefined();
    expect(fake.application.song.cuePoints[before].name).toBe("Verse 2");
    expect(body(r).ref).toBe(`cuePoint:${before}:Verse 2`);
  });

  it("executor_create_takeLane_named_appliesNameAndMintsNamedChildRef", async () => {
    const fake = tagged(makeFakeContext());
    const beforeLanes = fake.application.song.tracks[0].takeLanes.length;
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_create", {
        kind: "take_lane",
        takeLaneTrack: "track:0:Drums",
        name: "Comp B",
      }),
    ]);
    expect(r.isError).toBeUndefined();
    const data = body(r);
    expect(data.created).toBe("take lane");
    // The live take lane carries the applied name.
    const lanes = fake.application.song.tracks[0].takeLanes;
    expect(lanes.length).toBe(beforeLanes + 1);
    expect(lanes[beforeLanes].name).toBe("Comp B");
    // The child ref is anchored under the track and its leaf reflects the name.
    expect(String(data.ref)).toBe(
      `track:0:Drums/takeLane:${beforeLanes}:Comp B`
    );
  });

  // --- Item 2: single named create ⇒ exactly TWO committed transactions ---

  it("executor_create_named_opensExactlyTwoTransactions", async () => {
    const fake = makeFakeContext();
    await runtimeOf(fake).flushMutations([
      call("live_create", { kind: "audio_track", name: "Vox" }),
    ]);
    // One create txn + one rename txn — both committed (create-then-configure §7).
    expect(fake.transactions).toEqual([
      { committed: true, rolledBack: false },
      { committed: true, rolledBack: false },
    ]);
    expect(fake.committedCount).toBe(2);
  });

  // --- Item 3: unnamed create ⇒ exactly ONE transaction (regression guard) ---

  it("executor_create_unnamed_opensExactlyOneTransaction", async () => {
    const fake = makeFakeContext();
    await runtimeOf(fake).flushMutations([
      call("live_create", { kind: "audio_track" }),
    ]);
    // No name ⇒ the rename transaction block is skipped entirely (one undo step).
    expect(fake.transactions).toEqual([{ committed: true, rolledBack: false }]);
    expect(fake.committedCount).toBe(1);
  });

  // --- Item 4: multi-named-create batch ⇒ AT MOST TWO transactions total ---

  it("executor_create_multipleNamed_shareOneRenameTransaction", async () => {
    const fake = makeFakeContext();
    const beforeTracks = fake.application.song.tracks.length;
    const beforeScenes = fake.application.song.scenes.length;
    const results = await runtimeOf(fake).flushMutations([
      call("live_create", { kind: "audio_track", name: "A1" }, "a"),
      call("live_create", { kind: "midi_track", name: "A2" }, "b"),
      call("live_create", { kind: "scene", name: "S1" }, "c"),
    ]);
    // Exactly TWO transactions: one shared create txn + one SHARED rename txn for
    // all three names — NOT N+1.
    expect(fake.transactions).toEqual([
      { committed: true, rolledBack: false },
      { committed: true, rolledBack: false },
    ]);
    expect(fake.committedCount).toBe(2);
    // All three names applied to the live objects.
    const tracks = fake.application.song.tracks;
    expect(tracks[beforeTracks].name).toBe("A1");
    expect(tracks[beforeTracks + 1].name).toBe("A2");
    expect(fake.application.song.scenes[beforeScenes].name).toBe("S1");
    // Every returned ref is name-bearing (leaf segment ends with the applied name).
    expect(results.every((r) => r.isError === undefined)).toBe(true);
    expect(leafSegment(body(results[0]).ref).endsWith(":A1")).toBe(true);
    expect(leafSegment(body(results[1]).ref).endsWith(":A2")).toBe(true);
    expect(leafSegment(body(results[2]).ref).endsWith(":S1")).toBe(true);
  });

  // --- Item 5: P5-2 mixed batch (async create + sync update in one flush) ---

  it("executor_create_mixedWithSyncUpdate_distributesResultsAndCountsTxns", async () => {
    const fake = makeFakeContext();
    const beforeTracks = fake.application.song.tracks.length;
    // A sync update (slotToIndex negative-encoded) interleaved with an async named
    // create (slotToIndex positive) — pins the registry's positive/negative slot
    // distribution stays correct across the mixed batch.
    const results = await runtimeOf(fake).flushMutations([
      call(
        "live_update_track",
        { track: "track:0:Drums", name: "Kick" },
        "upd"
      ),
      call("live_create", { kind: "audio_track", name: "New" }, "cre"),
    ]);
    expect(results.map((r) => r.toolUseId)).toEqual(["upd", "cre"]);
    // The sync update landed on its own call id.
    expect(results[0].isError).toBeUndefined();
    expect(body(results[0]).updated).toEqual(["name"]);
    expect(fake.application.song.tracks[0].name).toBe("Kick");
    // The async create landed on its own call id, named, with a name-bearing ref.
    expect(results[1].isError).toBeUndefined();
    expect(body(results[1]).created).toBe("audio track");
    expect(fake.application.song.tracks[beforeTracks].name).toBe("New");
    expect(body(results[1]).ref).toBe(`track:${beforeTracks}:New`);
    // 1 create+update txn + 1 rename txn = 2 committed.
    expect(fake.transactions).toEqual([
      { committed: true, rolledBack: false },
      { committed: true, rolledBack: false },
    ]);
    expect(fake.committedCount).toBe(2);
  });

  // --- Item 6: abort between create and rename ---

  it("executor_create_named_abortedBetweenCreateAndRename_succeedsUnrenamed", async () => {
    const fake = makeFakeContext();
    const before = fake.application.song.tracks.length;
    const controller = new AbortController();
    // Abort AFTER the create transaction (#1) commits but BEFORE applyPendingRenames
    // checks the signal — the registry then skips the rename transaction. We do NOT
    // pre-abort (the defensive check before the CREATE txn would otherwise skip the
    // create entirely).
    fake.onCommit((committedCount) => {
      if (committedCount === 1) {
        controller.abort();
      }
    });
    const [r] = await runtimeOf(
      fake,
      new ReferenceTable(),
      controller.signal
    ).flushMutations([
      call("live_create", { kind: "audio_track", name: "Vox" }),
    ]);
    // Honest SUCCESS (NOT an error) — the object WAS created (txn #1 committed, R5).
    expect(r.isError).toBeUndefined();
    const data = body(r);
    expect(data.created).toBe("audio track");
    // Un-renamed ref (empty name segment) + the cancel-path note.
    expect(data.ref).toBe(`track:${before}:`);
    expect(data.note).toBe(
      "created, but name not applied — cancelled before configure"
    );
    // The live object kept its default (un-renamed) name.
    expect(fake.application.song.tracks[before].name).toBe("");
    // Only the create transaction committed; the rename txn was skipped.
    expect(fake.transactions).toEqual([{ committed: true, rolledBack: false }]);
    expect(fake.committedCount).toBe(1);
  });

  // --- Item 7: rename transaction throws (R5 rollback) ---

  it("executor_create_named_renameTransactionThrows_succeedsUnrenamedWithFailureNote", async () => {
    const fake = makeFakeContext();
    const before = fake.application.song.tracks.length;
    // Make the name setter throw INSIDE the rename transaction → R5 atomic rollback.
    fake.failNameSets("name setter exploded");
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_create", { kind: "audio_track", name: "Vox" }),
    ]);
    // Honest SUCCESS — NOT isError, NOT an sdk_error: the object was created; only
    // the rename rolled back (a bare error would hide the created object, §9).
    expect(r.isError).toBeUndefined();
    const data = body(r);
    expect(data.error).toBeUndefined();
    expect(data.created).toBe("audio track");
    // Un-renamed ref + a "naming failed: <message>" note carrying the thrown message.
    expect(data.ref).toBe(`track:${before}:`);
    expect(data.note).toBe(
      "created, but name not applied — naming failed: name setter exploded"
    );
    // The object exists, un-renamed.
    expect(fake.application.song.tracks.length).toBe(before + 1);
    expect(fake.application.song.tracks[before].name).toBe("");
    // The create txn committed; the rename txn rolled back atomically (R5).
    expect(fake.transactions).toEqual([
      { committed: true, rolledBack: false },
      { committed: false, rolledBack: true },
    ]);
    expect(fake.committedCount).toBe(1);
  });

  // --- Item 8: index-ignored note (tracks/take-lane) vs honored (scene) ---

  it("executor_create_audioTrack_withIndex_reportsIndexIgnored", async () => {
    const fake = makeFakeContext();
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_create", { kind: "audio_track", index: 1 }),
    ]);
    expect(r.isError).toBeUndefined();
    expect(body(r).note).toBe(
      "index ignored — new tracks are appended after the selected track; the SDK has no positional insert"
    );
  });

  it("executor_create_midiTrack_withIndex_reportsIndexIgnored", async () => {
    const fake = makeFakeContext();
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_create", { kind: "midi_track", index: 0 }),
    ]);
    expect(r.isError).toBeUndefined();
    expect(body(r).note).toBe(
      "index ignored — new tracks are appended after the selected track; the SDK has no positional insert"
    );
  });

  it("executor_create_takeLane_withIndex_reportsIndexIgnored", async () => {
    const fake = tagged(makeFakeContext());
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_create", {
        kind: "take_lane",
        takeLaneTrack: "track:0:Drums",
        index: 3,
      }),
    ]);
    expect(r.isError).toBeUndefined();
    expect(body(r).note).toBe(
      "index ignored — take lanes are appended to the end of the track's take lanes; the SDK has no positional insert"
    );
  });

  it("executor_create_cuePoint_withIndex_reportsIndexIgnored", async () => {
    const fake = makeFakeContext();
    const before = fake.application.song.cuePoints.length;
    const [r] = await runtimeOf(fake).flushMutations([
      // A cue point is positioned by `time` (beats); a stray `index` is ignored.
      call("live_create", { kind: "cue_point", time: 8, index: 2 }),
    ]);
    expect(r.isError).toBeUndefined();
    expect(body(r).note).toBe(
      "index ignored — a cue point is positioned by 'time' (beats), not index"
    );
    // The cue point is still created (the index note never blocks creation).
    expect(fake.application.song.cuePoints.length).toBe(before + 1);
  });

  it("executor_create_scene_withIndex_honorsPositionAndAddsNoIgnoredNote", async () => {
    const fake = makeFakeContext();
    // Seed names so we can prove the new scene landed at the requested index.
    const beforeNames = fake.application.song.scenes.map((s) => s.name);
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_create", { kind: "scene", index: 1, name: "Inserted" }),
    ]);
    expect(r.isError).toBeUndefined();
    const data = body(r);
    // The index IS honored: the new scene is at position 1.
    expect(data.ref).toBe("scene:1:Inserted");
    expect(fake.application.song.scenes[1].name).toBe("Inserted");
    // Earlier scenes shifted; the original scene[1] moved to scene[2].
    expect(fake.application.song.scenes[0].name).toBe(beforeNames[0]);
    expect(fake.application.song.scenes[2].name).toBe(beforeNames[1]);
    // NO index-ignored note for scenes.
    expect(data.note).toBeUndefined();
  });

  it("executor_create_scene_withNegativeIndex_appendsAndAddsNoIgnoredNote", async () => {
    const fake = makeFakeContext();
    const before = fake.application.song.scenes.length;
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_create", { kind: "scene", index: -1, name: "Appended" }),
    ]);
    expect(r.isError).toBeUndefined();
    const data = body(r);
    // -1 appends (SDK semantics).
    expect(data.ref).toBe(`scene:${before}:Appended`);
    expect(fake.application.song.scenes[before].name).toBe("Appended");
    expect(data.note).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// live_create_clip — MIDI works; AUDIO is deferred
// ---------------------------------------------------------------------------

describe("mutation executors — live_create_clip", () => {
  it("executor_createClip_midiOnClipSlot_creates", async () => {
    const fake = tagged(
      makeFakeContext({
        tracks: [
          {
            className: "MidiTrack",
            name: "Keys",
            children: {
              clipSlots: [{ className: "ClipSlot", clip: null }],
            },
            mixer: mixerSpec(),
          },
        ],
      })
    );
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_create_clip", {
        location: "track:0:Keys/clipSlot:0",
        type: "midi",
        duration: 4,
      }),
    ]);
    expect(r.isError).toBeUndefined();
    expect(body(r).created).toBe("midi clip");
    expect(fake.application.song.tracks[0].clipSlots[0].clip).not.toBeNull();
  });

  it("executor_createClip_midiOnTrack_arrangement_creates", async () => {
    const fake = tagged(
      makeFakeContext({
        tracks: [
          {
            className: "MidiTrack",
            name: "Keys",
            children: { arrangementClips: [] },
            mixer: mixerSpec(),
          },
        ],
      })
    );
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_create_clip", {
        location: "track:0:Keys",
        type: "midi",
        startTime: 0,
        duration: 8,
      }),
    ]);
    expect(r.isError).toBeUndefined();
    expect(fake.application.song.tracks[0].arrangementClips.length).toBe(1);
  });

  it("executor_createClip_audioType_returnsDeferred", async () => {
    const fake = tagged(makeFakeContext());
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_create_clip", {
        location: "track:0:Drums",
        type: "audio",
        filePath: "/managed/loop.wav",
      }),
    ]);
    expect(r.isError).toBe(true);
    expect(body(r).error).toBe("deferred");
    // A deferred (prepare-error) batch opens NO transaction.
    expect(fake.transactions).toEqual([]);
  });

  it("executor_createClip_clipSlot_missingDuration_returnsInvalidArgs", async () => {
    const fake = tagged(
      makeFakeContext({
        tracks: [
          {
            className: "MidiTrack",
            name: "Keys",
            children: { clipSlots: [{ className: "ClipSlot", clip: null }] },
            mixer: mixerSpec(),
          },
        ],
      })
    );
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_create_clip", {
        location: "track:0:Keys/clipSlot:0",
        type: "midi",
      }),
    ]);
    expect(r.isError).toBe(true);
    expect(body(r).error).toBe("invalid_args");
  });
});

// ---------------------------------------------------------------------------
// live_insert_device / live_modify_device_chain
// ---------------------------------------------------------------------------

describe("mutation executors — live_insert_device", () => {
  it("executor_insertDevice_addsDeviceToTrack", async () => {
    const fake = tagged(makeFakeContext());
    const before = fake.application.song.tracks[1].devices.length;
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_insert_device", {
        location: "track:1:Bass",
        deviceName: "EQ Eight",
        index: 0,
      }),
    ]);
    expect(r.isError).toBeUndefined();
    expect(body(r).inserted).toBe("EQ Eight");
    expect(fake.application.song.tracks[1].devices.length).toBe(before + 1);
  });

  it("executor_insertDevice_emptyName_returnsInvalidArgs", async () => {
    const fake = tagged(makeFakeContext());
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_insert_device", {
        location: "track:1:Bass",
        deviceName: "   ",
        index: 0,
      }),
    ]);
    expect(r.isError).toBe(true);
    expect(body(r).error).toBe("invalid_args");
  });

  it("executor_insertDevice_negativeIndex_returnsInvalidArgs", async () => {
    const fake = tagged(makeFakeContext());
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_insert_device", {
        location: "track:1:Bass",
        deviceName: "Reverb",
        index: -1,
      }),
    ]);
    expect(r.isError).toBe(true);
    expect(body(r).error).toBe("invalid_args");
  });
});

describe("mutation executors — live_modify_device_chain", () => {
  it("executor_modifyChain_duplicate_copiesDevice", async () => {
    const fake = tagged(makeFakeContext());
    const before = fake.application.song.tracks[1].devices.length;
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_modify_device_chain", {
        location: "track:1:Bass",
        op: "duplicate",
        device: "track:1:Bass/device:0:Reverb",
      }),
    ]);
    expect(r.isError).toBeUndefined();
    expect(body(r).duplicated).toContain("device:0:Reverb");
    expect(fake.application.song.tracks[1].devices.length).toBe(before + 1);
  });

  it("executor_modifyChain_insertChain_addsChainToRack", async () => {
    const fake = tagged(makeFakeContext());
    const rack = fake.application.song.tracks[1].devices[1];
    const before = rack.chains?.length ?? 0;
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_modify_device_chain", {
        location: "track:1:Bass/device:1:Rack",
        op: "insert_chain",
        index: 0,
      }),
    ]);
    expect(r.isError).toBeUndefined();
    expect(body(r).insertedChainInto).toContain("device:1:Rack");
    const after =
      fake.application.song.tracks[1].devices[1].chains?.length ?? 0;
    expect(after).toBe(before + 1);
  });

  it("executor_modifyChain_insertChainOnNonRack_returnsUnsupported", async () => {
    const fake = tagged(makeFakeContext());
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_modify_device_chain", {
        location: "track:1:Bass/device:0:Reverb",
        op: "insert_chain",
        index: 0,
      }),
    ]);
    expect(r.isError).toBe(true);
    expect(body(r).error).toBe("unsupported");
  });

  it("executor_modifyChain_badOp_returnsInvalidArgs", async () => {
    const fake = tagged(makeFakeContext());
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_modify_device_chain", {
        location: "track:1:Bass",
        op: "rewire",
      }),
    ]);
    expect(r.isError).toBe(true);
    expect(body(r).error).toBe("invalid_args");
  });
});

// ---------------------------------------------------------------------------
// live_delete — type-routed; invalidateAndShift; siblings shift live
// ---------------------------------------------------------------------------

describe("mutation executors — live_delete", () => {
  it("executor_delete_track_removesAndShiftsSiblings", async () => {
    const fake = tagged(makeFakeContext());
    const refs = new ReferenceTable();
    // Seed two refs that should shift after deleting track:1.
    refs.mint("track:1:Bass");
    refs.mint("track:2:Keys");
    const [r] = await runtimeOf(fake, refs).flushMutations([
      call("live_delete", { target: "track:1:Bass" }),
    ]);
    expect(r.isError).toBeUndefined();
    const data = body(r);
    expect(data.deleted).toBe("track");
    expect(data.destructive).toBe(true);
    // track:2:Keys shifted down to track:1:Keys; deleted ref dropped.
    expect(data.affectedRefs).toContain("track:1:Keys");
    expect(data.affectedRefs).not.toContain("track:1:Bass");
    // Live: the song lost a track and Keys is now at index 1.
    expect(fake.application.song.tracks[1].name).toBe("Keys");
  });

  it("executor_delete_scene_routesToDeleteScene", async () => {
    const fake = tagged(makeFakeContext());
    const before = fake.application.song.scenes.length;
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_delete", { target: "scene:0:Intro" }),
    ]);
    expect(body(r).deleted).toBe("scene");
    expect(fake.application.song.scenes.length).toBe(before - 1);
  });

  it("executor_delete_cuePoint_routesToDeleteCuePoint", async () => {
    const fake = tagged(makeFakeContext());
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_delete", { target: "cuePoint:0:Start" }),
    ]);
    expect(body(r).deleted).toBe("cuePoint");
    expect(fake.application.song.cuePoints.length).toBe(0);
  });

  it("executor_delete_sessionClip_routesToSlotDeleteClip", async () => {
    const fake = tagged(makeFakeContext());
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_delete", {
        target: "track:0:Drums/clipSlot:0/clip:0:Loop A",
      }),
    ]);
    expect(r.isError).toBeUndefined();
    expect(body(r).deleted).toBe("clip");
    expect(fake.application.song.tracks[0].clipSlots[0].clip).toBeNull();
  });

  it("executor_delete_arrangementClip_routesToTrackDeleteClip", async () => {
    const fake = tagged(makeFakeContext());
    const before = fake.application.song.tracks[0].arrangementClips.length;
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_delete", { target: "track:0:Drums/clip:0:Verse" }),
    ]);
    expect(body(r).deleted).toBe("clip");
    expect(fake.application.song.tracks[0].arrangementClips.length).toBe(
      before - 1
    );
  });

  it("executor_delete_device_routesToHostDeleteDevice", async () => {
    const fake = tagged(makeFakeContext());
    const before = fake.application.song.tracks[1].devices.length;
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_delete", { target: "track:1:Bass/device:0:Reverb" }),
    ]);
    expect(body(r).deleted).toBe("device");
    expect(fake.application.song.tracks[1].devices.length).toBe(before - 1);
  });

  it("executor_delete_missingTarget_returnsInvalidArgs", async () => {
    const fake = tagged(makeFakeContext());
    const [r] = await runtimeOf(fake).flushMutations([call("live_delete", {})]);
    expect(r.isError).toBe(true);
    expect(body(r).error).toBe("invalid_args");
  });
});

// ---------------------------------------------------------------------------
// Audio tools deferred — never a fake success (§9)
// ---------------------------------------------------------------------------

describe("mutation executors — audio tools are deferred (§9 honesty)", () => {
  it("executor_replaceSample_returnsDeferred", async () => {
    const fake = makeFakeContext();
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_replace_sample", {
        simpler: "track:0:Drums/device:0:Kit",
        filePath: "/managed/kick.wav",
      }),
    ]);
    expect(r.isError).toBe(true);
    expect(body(r).error).toBe("deferred");
    expect(fake.transactions).toEqual([]);
  });

  it("executor_importAudio_returnsDeferred", async () => {
    const fake = makeFakeContext();
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_import_audio", { source: "https://example.com/loop.wav" }),
    ]);
    expect(r.isError).toBe(true);
    expect(body(r).error).toBe("deferred");
  });
});

// ---------------------------------------------------------------------------
// Ref-error surfacing — resolver err returned verbatim (§6)
// ---------------------------------------------------------------------------

describe("ref-error surfacing — resolver errors flow through executors (§6)", () => {
  it("executor_refUnresolved_surfacedVerbatim", async () => {
    const fake = tagged(makeFakeContext());
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_update_track", { track: "track:0:Ghost", name: "X" }),
    ]);
    expect(r.isError).toBe(true);
    const e = body(r);
    expect(e.error).toBe("ref_unresolved");
    expect(e.ref).toBe("track:0:Ghost");
    expect(typeof e.hint).toBe("string");
  });

  it("executor_refAmbiguous_surfacedVerbatim", async () => {
    // The default Set has two tracks named "Dup" (indices 3 and 4): a wrong index
    // forces a name search that finds two → ref_ambiguous.
    const fake = tagged(makeFakeContext());
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_update_track", { track: "track:0:Dup", name: "X" }),
    ]);
    expect(r.isError).toBe(true);
    expect(body(r).error).toBe("ref_ambiguous");
  });

  it("executor_resolverError_surfacedVerbatimAsJsonBody", async () => {
    // The §6 contract: an executor returns the resolver's structured error
    // UNCHANGED. We prove verbatim pass-through by comparing the executor's
    // emitted JSON body to the resolver's own error object for the same ref/ctx
    // (both go through the identical default-SDK-token resolver path).
    const fake = tagged(makeFakeContext());
    const ref = "track:0:T/device:0:Ghost";
    const direct = resolveRef(ctxOf(fake), ref);
    expect(direct.ok).toBe(false);
    const [r] = await runtimeOf(fake).flushMutations([
      call("live_delete", { target: ref }),
    ]);
    expect(r.isError).toBe(true);
    if (!direct.ok) {
      // The executor's JSON body equals the resolver's structured error verbatim.
      expect(body(r)).toEqual(
        JSON.parse(JSON.stringify(direct.err)) as Record<string, unknown>
      );
    }
    expect(fake.transactions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Abort — aborted signal: error per call, NO transaction (§7 / R5)
// ---------------------------------------------------------------------------

describe("abort — aborted signal yields no transaction (§7 / R5)", () => {
  it("executor_flushMutations_abortedBeforeOpen_returnsAbortedPerCall", async () => {
    const fake = makeFakeContext();
    const controller = new AbortController();
    controller.abort();
    const calls: ToolCall[] = [
      call("live_update_track", { track: "track:0:Drums", name: "X" }, "one"),
      call("live_update_track", { track: "track:1:Bass", name: "Y" }, "two"),
    ];
    const results = await runtimeOf(
      fake,
      new ReferenceTable(),
      controller.signal
    ).flushMutations(calls);
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.isError).toBe(true);
      expect(body(r).error).toBe("aborted");
    }
    // No transaction was opened; nothing was applied.
    expect(fake.transactions).toEqual([]);
    expect(fake.application.song.tracks[0].name).toBe("Drums");
  });

  it("executor_flushMutations_abortedPreservesPrepareErrors", async () => {
    const fake = makeFakeContext();
    const controller = new AbortController();
    controller.abort();
    const calls: ToolCall[] = [
      // This one prepare-errors regardless of abort.
      call("live_update_track", { track: "track:0:Drums", mute: "no" }, "bad"),
      call("live_update_track", { track: "track:1:Bass", name: "Y" }, "ok"),
    ];
    const results = await runtimeOf(
      fake,
      new ReferenceTable(),
      controller.signal
    ).flushMutations(calls);
    // The prepare-error keeps its own payload; the other reports aborted.
    expect(body(results[0]).error).toBe("invalid_args");
    expect(body(results[1]).error).toBe("aborted");
    expect(fake.transactions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Argument-validation error branches (every executor: never throws / no-ops)
// ---------------------------------------------------------------------------

describe("argument validation — per-field wrong-type rejection", () => {
  /** Run one mutation call and return its single payload. */
  async function one(
    fake: FakeExtensionContext,
    c: ToolCall
  ): Promise<ToolResultPayload> {
    const [r] = await runtimeOf(fake).flushMutations([c]);
    return r;
  }

  it("executor_updateTrack_nonObjectInput_invalidArgs", async () => {
    const r = await one(makeFakeContext(), call("live_update_track", 42));
    expect(body(r).error).toBe("invalid_args");
  });

  it("executor_updateTrack_missingTrackRef_invalidArgs", async () => {
    const r = await one(makeFakeContext(), call("live_update_track", {}));
    expect(body(r).error).toBe("invalid_args");
  });

  it("executor_updateTrack_eachFieldWrongType_invalidArgs", async () => {
    const fake = makeFakeContext();
    for (const bad of [
      { track: "track:0:Drums", name: 1 },
      { track: "track:0:Drums", solo: "x" },
      { track: "track:0:Drums", arm: "x" },
    ]) {
      const r = await one(fake, call("live_update_track", bad));
      expect(body(r).error).toBe("invalid_args");
    }
  });

  it("executor_updateClip_nonObjectAndMissingRef_invalidArgs", async () => {
    const fake = tagged(makeFakeContext());
    expect(body(await one(fake, call("live_update_clip", 1))).error).toBe(
      "invalid_args"
    );
    expect(body(await one(fake, call("live_update_clip", {}))).error).toBe(
      "invalid_args"
    );
  });

  it("executor_updateClip_eachFieldWrongType_invalidArgs", async () => {
    const fake = tagged(makeFakeContext());
    const refClip = "track:0:Drums/clipSlot:0/clip:0:Loop A";
    for (const bad of [
      { clip: refClip, name: 1 },
      { clip: refClip, color: "red" },
      { clip: refClip, looping: "x" },
      { clip: refClip, muted: "x" },
      { clip: refClip, warping: "x" },
      { clip: refClip, warpMode: 4 },
    ]) {
      const r = await one(fake, call("live_update_clip", bad));
      expect(body(r).error).toBe("invalid_args");
    }
  });

  it("executor_setParam_nonObjectInput_invalidArgs", async () => {
    expect(
      body(await one(makeFakeContext(), call("live_set_param", 5))).error
    ).toBe("invalid_args");
  });

  it("executor_setParam_targetNotObject_invalidArgs", async () => {
    const r = await one(
      makeFakeContext(),
      call("live_set_param", { target: "x", value: 1 })
    );
    expect(body(r).error).toBe("invalid_args");
  });

  it("executor_setParam_deviceTargetMissingParam_invalidArgs", async () => {
    const r = await one(
      makeFakeContext(),
      call("live_set_param", {
        target: { type: "device", device: "track:0:Drums/device:0:Kit" },
        value: 1,
      })
    );
    expect(body(r).error).toBe("invalid_args");
  });

  it("executor_setParam_mixerTargetMissingTrack_invalidArgs", async () => {
    const r = await one(
      makeFakeContext(),
      call("live_set_param", {
        target: { type: "mixer", mixer: { kind: "volume" } },
        value: 1,
      })
    );
    expect(body(r).error).toBe("invalid_args");
  });

  it("executor_setParam_unknownTargetType_invalidArgs", async () => {
    const r = await one(
      makeFakeContext(),
      call("live_set_param", {
        target: { type: "send_chain" },
        value: 1,
      })
    );
    expect(body(r).error).toBe("invalid_args");
  });

  it("executor_setParam_mixerPan_routesToPanParam", async () => {
    const fake = tagged(makeFakeContext());
    const r = await one(
      fake,
      call("live_set_param", {
        target: {
          type: "mixer",
          track: "track:0:Drums",
          mixer: { kind: "pan" },
        },
        value: 0.5,
      })
    );
    expect(r.isError).toBeUndefined();
    expect(fake.paramValueOf("tracks[0]/mixer/panning")).toBeCloseTo(0.5);
  });

  it("executor_setParam_resolvedTargetNotAParam_invalidArgs", async () => {
    // Resolve a device ref as a param target → the resolved object has no
    // setValue → "not a settable parameter".
    const fake = tagged(makeFakeContext());
    const r = await one(
      fake,
      call("live_set_param", {
        target: {
          type: "device",
          device: "track:0:Drums/device:0:Kit",
          param: "track:0:Drums/device:0:Kit", // a device, not a param
        },
        value: 1,
      })
    );
    expect(body(r).error).toBe("invalid_args");
  });

  it("executor_editMidiNotes_nonObjectAndMissingClip_invalidArgs", async () => {
    const fake = tagged(makeFakeContext());
    expect(body(await one(fake, call("live_edit_midi_notes", 1))).error).toBe(
      "invalid_args"
    );
    expect(
      body(await one(fake, call("live_edit_midi_notes", { op: "transpose" })))
        .error
    ).toBe("invalid_args");
  });

  it("executor_editMidiNotes_replaceWithBadNotes_invalidArgs", async () => {
    const fake = tagged(
      makeFakeContext({
        tracks: [
          {
            className: "MidiTrack",
            name: "Keys",
            children: {
              arrangementClips: [
                { className: "MidiClip", name: "C", notes: [] },
              ],
            },
            mixer: mixerSpec(),
          },
        ],
      })
    );
    const ref = "track:0:Keys/clip:0:C";
    // notes not an array
    expect(
      body(
        await one(
          fake,
          call("live_edit_midi_notes", { clip: ref, op: "replace" })
        )
      ).error
    ).toBe("invalid_args");
    // a note that is not an object
    expect(
      body(
        await one(
          fake,
          call("live_edit_midi_notes", {
            clip: ref,
            op: "replace",
            notes: [5],
          })
        )
      ).error
    ).toBe("invalid_args");
    // a note missing required numeric fields
    expect(
      body(
        await one(
          fake,
          call("live_edit_midi_notes", {
            clip: ref,
            op: "replace",
            notes: [{ pitch: 60 }],
          })
        )
      ).error
    ).toBe("invalid_args");
  });

  it("executor_editMidiNotes_replace_carriesOptionalNoteFields", async () => {
    const fake = tagged(
      makeFakeContext({
        tracks: [
          {
            className: "MidiTrack",
            name: "Keys",
            children: {
              arrangementClips: [
                { className: "MidiClip", name: "C", notes: [] },
              ],
            },
            mixer: mixerSpec(),
          },
        ],
      })
    );
    const note = {
      pitch: 60,
      startTime: 0,
      duration: 1,
      velocity: 90,
      muted: true,
      probability: 0.8,
      velocityDeviation: 5,
      releaseVelocity: 40,
    };
    const r = await one(
      fake,
      call("live_edit_midi_notes", {
        clip: "track:0:Keys/clip:0:C",
        op: "replace",
        notes: [note],
      })
    );
    expect(r.isError).toBeUndefined();
    expect(fake.notesOf("tracks[0]/arrangementClips[0]")[0]).toMatchObject(
      note
    );
  });

  it("executor_editMidiNotes_transposeMissingSemitones_invalidArgs", async () => {
    const fake = tagged(
      makeFakeContext({
        tracks: [
          {
            className: "MidiTrack",
            name: "K",
            children: {
              arrangementClips: [
                { className: "MidiClip", name: "C", notes: [] },
              ],
            },
            mixer: mixerSpec(),
          },
        ],
      })
    );
    const ref = "track:0:K/clip:0:C";
    expect(
      body(
        await one(
          fake,
          call("live_edit_midi_notes", { clip: ref, op: "transpose" })
        )
      ).error
    ).toBe("invalid_args");
    expect(
      body(
        await one(
          fake,
          call("live_edit_midi_notes", { clip: ref, op: "quantize", grid: 0 })
        )
      ).error
    ).toBe("invalid_args");
    expect(
      body(
        await one(
          fake,
          call("live_edit_midi_notes", {
            clip: ref,
            op: "humanize",
            timingAmount: "x",
          })
        )
      ).error
    ).toBe("invalid_args");
    expect(
      body(
        await one(
          fake,
          call("live_edit_midi_notes", { clip: ref, op: "filter" })
        )
      ).error
    ).toBe("invalid_args");
  });

  it("executor_create_nonObjectInput_invalidArgs", async () => {
    expect(
      body(await one(makeFakeContext(), call("live_create", 3))).error
    ).toBe("invalid_args");
  });

  it("executor_create_nameWrongType_invalidArgs", async () => {
    // The `name` type guard rejects a non-string before any create runs (§9 — never
    // a fake success, never a no-op). No transaction is opened.
    const fake = makeFakeContext();
    const r = await one(
      fake,
      call("live_create", { kind: "audio_track", name: 123 })
    );
    expect(r.isError).toBe(true);
    expect(body(r).error).toBe("invalid_args");
    expect(fake.transactions).toEqual([]);
  });

  it("executor_create_takeLaneMissingTrack_invalidArgs", async () => {
    const r = await one(
      makeFakeContext(),
      call("live_create", { kind: "take_lane" })
    );
    expect(body(r).error).toBe("invalid_args");
  });

  it("executor_create_takeLaneOnNonTrack_invalidArgs", async () => {
    // Resolve a scene as the take-lane track → it has no createTakeLane.
    const r = await one(
      tagged(makeFakeContext()),
      call("live_create", { kind: "take_lane", takeLaneTrack: "scene:0:Intro" })
    );
    expect(body(r).error).toBe("invalid_args");
  });

  it("executor_create_sceneAtIndex_creates", async () => {
    const fake = makeFakeContext();
    const r = await one(fake, call("live_create", { kind: "scene", index: 0 }));
    expect(body(r).created).toBe("scene");
    expect(fake.application.song.scenes.length).toBe(3);
  });

  it("executor_createClip_nonObjectAndMissingLocation_invalidArgs", async () => {
    const fake = tagged(makeFakeContext());
    expect(body(await one(fake, call("live_create_clip", 1))).error).toBe(
      "invalid_args"
    );
    expect(
      body(await one(fake, call("live_create_clip", { type: "midi" }))).error
    ).toBe("invalid_args");
  });

  it("executor_createClip_unknownType_invalidArgs", async () => {
    const r = await one(
      tagged(makeFakeContext()),
      call("live_create_clip", { location: "track:0:Drums", type: "video" })
    );
    expect(body(r).error).toBe("invalid_args");
  });

  it("executor_createClip_arrangementMissingStartTime_invalidArgs", async () => {
    const fake = tagged(
      makeFakeContext({
        tracks: [
          {
            className: "MidiTrack",
            name: "K",
            children: { arrangementClips: [] },
            mixer: mixerSpec(),
          },
        ],
      })
    );
    expect(
      body(
        await one(
          fake,
          call("live_create_clip", {
            location: "track:0:K",
            type: "midi",
            duration: 4,
          })
        )
      ).error
    ).toBe("invalid_args");
  });

  it("executor_createClip_onLocationThatCannotCreate_unsupported", async () => {
    // A scene exposes no createMidiClip → unsupported for an arrangement MIDI clip.
    // (The fake's track proxies all carry createMidiClip, so a non-track location
    // is the faithful way to exercise this branch.)
    const fake = tagged(makeFakeContext());
    const r = await one(
      fake,
      call("live_create_clip", {
        location: "scene:0:Intro",
        type: "midi",
        startTime: 0,
        duration: 4,
      })
    );
    expect(body(r).error).toBe("unsupported");
  });

  it("executor_insertDevice_nonObjectAndMissingLocation_invalidArgs", async () => {
    const fake = tagged(makeFakeContext());
    expect(body(await one(fake, call("live_insert_device", 1))).error).toBe(
      "invalid_args"
    );
    expect(
      body(
        await one(
          fake,
          call("live_insert_device", { deviceName: "Reverb", index: 0 })
        )
      ).error
    ).toBe("invalid_args");
  });

  it("executor_insertDevice_onNonHost_unsupported", async () => {
    // A scene cannot host a device.
    const r = await one(
      tagged(makeFakeContext()),
      call("live_insert_device", {
        location: "scene:0:Intro",
        deviceName: "Reverb",
        index: 0,
      })
    );
    expect(body(r).error).toBe("unsupported");
  });

  it("executor_modifyChain_nonObjectAndMissingLocation_invalidArgs", async () => {
    const fake = tagged(makeFakeContext());
    expect(
      body(await one(fake, call("live_modify_device_chain", 1))).error
    ).toBe("invalid_args");
    expect(
      body(
        await one(fake, call("live_modify_device_chain", { op: "duplicate" }))
      ).error
    ).toBe("invalid_args");
  });

  it("executor_modifyChain_duplicateMissingDevice_invalidArgs", async () => {
    const r = await one(
      tagged(makeFakeContext()),
      call("live_modify_device_chain", {
        location: "track:1:Bass",
        op: "duplicate",
      })
    );
    expect(body(r).error).toBe("invalid_args");
  });

  it("executor_modifyChain_duplicateOnNonHost_unsupported", async () => {
    // host = a scene (cannot duplicateDevice); device = a real device.
    const r = await one(
      tagged(makeFakeContext()),
      call("live_modify_device_chain", {
        location: "scene:0:Intro",
        op: "duplicate",
        device: "track:1:Bass/device:0:Reverb",
      })
    );
    expect(body(r).error).toBe("unsupported");
  });

  it("executor_modifyChain_insertChainBadIndex_invalidArgs", async () => {
    const r = await one(
      tagged(makeFakeContext()),
      call("live_modify_device_chain", {
        location: "track:1:Bass/device:1:Rack",
        op: "insert_chain",
        index: -1,
      })
    );
    expect(body(r).error).toBe("invalid_args");
  });

  it("executor_delete_nonObjectInput_invalidArgs", async () => {
    expect(
      body(await one(makeFakeContext(), call("live_delete", 1))).error
    ).toBe("invalid_args");
  });

  it("executor_delete_unsupportedKind_unsupported", async () => {
    // A take lane is not a deletable kind via live_delete → unsupported.
    const r = await one(
      tagged(makeFakeContext()),
      call("live_delete", { target: "track:0:Drums/takeLane:0:Take 1" })
    );
    expect(body(r).error).toBe("unsupported");
  });
});

// ---------------------------------------------------------------------------
// Read executor error/catch + base-clip branches
// ---------------------------------------------------------------------------

describe("read executors — error and base-clip branches", () => {
  it("executor_getProject_nonObjectInput_stillReads", async () => {
    // live_get_project ignores input entirely.
    const p = await runtimeOf(makeFakeContext()).executeRead(
      call("live_get_project", "ignored")
    );
    expect(p.isError).toBeUndefined();
  });

  it("executor_getClip_baseClipBranch_whenClassNotTagged", async () => {
    // WITHOUT the className tag shim, the resolver reports the base "Clip" class,
    // so the executor falls into the base-Clip branch (no notes / no warp fields).
    const fake = makeFakeContext();
    const p = await runtimeOf(fake).executeRead(
      call("live_get_clip", { clip: "track:0:Drums/clipSlot:0/clip:0:Loop A" })
    );
    expect(p.isError).toBeUndefined();
    const data = body(p);
    expect(data.className).toBe("Clip");
    expect("notes" in data).toBe(false);
    expect("warping" in data).toBe(false);
  });

  it("executor_getClip_unresolvedRef_surfacesError", async () => {
    const p = await runtimeOf(makeFakeContext()).executeRead(
      call("live_get_clip", { clip: "track:0:Drums/clip:9:Nope" })
    );
    expect(p.isError).toBe(true);
    expect(body(p).error).toBe("ref_unresolved");
  });

  it("executor_getDeviceParams_nonObjectAndMissingRef_invalidArgs", async () => {
    const fake = makeFakeContext();
    expect(
      body(await runtimeOf(fake).executeRead(call("live_get_device_params", 1)))
        .error
    ).toBe("invalid_args");
    expect(
      body(
        await runtimeOf(fake).executeRead(call("live_get_device_params", {}))
      ).error
    ).toBe("invalid_args");
  });

  it("executor_getDeviceParams_unresolvedRef_surfacesError", async () => {
    const p = await runtimeOf(makeFakeContext()).executeRead(
      call("live_get_device_params", { device: "track:9:Ghost/device:0:X" })
    );
    expect(p.isError).toBe(true);
    expect(body(p).error).toBe("ref_unresolved");
  });
});

/**
 * Wrap `getObjectFromHandle` so the RESOLVED leaf object's named getter throws.
 * The resolver returns a leaf without reading these child getters, so the throw
 * lands in the EXECUTOR's data-building try/catch (the defensive `invalid_args`
 * mapping — executors never let a getter surprise escape as a rejection).
 */
function throwOnGetter(
  fake: FakeExtensionContext,
  getterKey: string
): FakeExtensionContext {
  const raw = fake.getObjectFromHandle.bind(fake);
  fake.getObjectFromHandle = <T>(handle: { id: bigint }, type: unknown): T => {
    const obj: unknown = raw(handle, type as never);
    if (
      obj !== null &&
      typeof obj === "object" &&
      getterKey in (obj as Record<string, unknown>)
    ) {
      Object.defineProperty(obj, getterKey, {
        configurable: true,
        get() {
          throw new Error(`getter '${getterKey}' exploded`);
        },
      });
    }
    return obj as T;
  };
  return fake;
}

describe("read executors — getter-throw lands in the executor catch (§9 no-throw)", () => {
  it("executor_getTrack_getterThrows_returnsInvalidArgs", async () => {
    const fake = throwOnGetter(makeFakeContext(), "devices");
    const p = await runtimeOf(fake).executeRead(
      call("live_get_track", { track: "track:0:Drums" })
    );
    expect(p.isError).toBe(true);
    expect(body(p).error).toBe("invalid_args");
  });

  it("executor_getClip_getterThrows_returnsInvalidArgs", async () => {
    const fake = throwOnGetter(makeFakeContext(), "color");
    const p = await runtimeOf(fake).executeRead(
      call("live_get_clip", { clip: "track:0:Drums/clipSlot:0/clip:0:Loop A" })
    );
    expect(p.isError).toBe(true);
    expect(body(p).error).toBe("invalid_args");
  });

  it("executor_getDeviceParams_getterThrows_returnsInvalidArgs", async () => {
    const fake = throwOnGetter(makeFakeContext(), "parameters");
    const p = await runtimeOf(fake).executeRead(
      call("live_get_device_params", { device: "track:0:Drums/device:0:Kit" })
    );
    expect(p.isError).toBe(true);
    expect(body(p).error).toBe("invalid_args");
  });

  it("executor_getDeviceParams_getValueRejects_yieldsNullValue", async () => {
    // A param whose async getValue rejects must surface a null value (the
    // executor swallows the per-param getValue rejection, §15), never throw.
    const fake = makeFakeContext({
      tracks: [
        {
          className: "AudioTrack",
          name: "A",
          children: {
            devices: [
              {
                className: "Reverb",
                name: "R",
                children: {
                  parameters: [
                    {
                      className: "DeviceParameter",
                      name: "P",
                      param: { value: 1 },
                    },
                  ],
                },
              },
            ],
          },
          mixer: mixerSpec(),
        },
      ],
    });
    tagged(fake);
    const raw = fake.getObjectFromHandle.bind(fake);
    fake.getObjectFromHandle = <T>(
      handle: { id: bigint },
      type: unknown
    ): T => {
      const obj: unknown = raw(handle, type as never);
      const desc =
        obj !== null && typeof obj === "object"
          ? Object.getOwnPropertyDescriptor(obj, "parameters")
          : undefined;
      if (obj !== null && typeof obj === "object" && desc?.get) {
        const inner = desc.get.bind(obj);
        Object.defineProperty(obj, "parameters", {
          configurable: true,
          enumerable: true,
          get() {
            const params = inner() as Array<{
              getValue: () => Promise<number>;
            }>;
            return params.map((param) =>
              Object.assign(param, {
                getValue: (): Promise<number> =>
                  Promise.reject(new Error("getValue failed")),
              })
            );
          },
        });
      }
      return obj as T;
    };

    const p = await runtimeOf(fake).executeRead(
      call("live_get_device_params", { device: "track:0:A/device:0:R" })
    );
    expect(p.isError).toBeUndefined();
    const params = body(p).parameters as Array<Record<string, unknown>>;
    expect(params[0].value).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// shared.ts — unit conversion + payload-builder edges
// ---------------------------------------------------------------------------

describe("shared helpers — unit conversion (§16 beats↔seconds)", () => {
  it("shared_beatsToSeconds_atTempo", () => {
    // 4 beats at 120 BPM = 4 * 60/120 = 2 s.
    expect(beatsToSeconds(4, 120)).toBeCloseTo(2);
  });

  it("shared_secondsToBeats_roundTrips", () => {
    expect(secondsToBeats(2, 120)).toBeCloseTo(4);
    expect(secondsToBeats(beatsToSeconds(7, 90), 90)).toBeCloseTo(7);
  });
});
