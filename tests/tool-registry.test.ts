import { describe, expect, it } from "vitest";

import type { ExtensionContext, ApiVersion } from "@ableton-extensions/sdk";

import { LiveToolRuntime } from "../src/extension/tool-registry.js";
import { ReferenceTable } from "../src/extension/references.js";
import type {
  ToolCall,
  ToolResultPayload,
} from "../src/extension/agent-loop.js";
import {
  TOOL_CLASS,
  TOOL_DEFINITIONS,
  TOOL_NAMES,
  classify,
} from "../src/shared/tools.js";
import {
  makeFakeContext,
  type FakeExtensionContext,
} from "./fixtures/fake-extension-context.js";

/**
 * Phase 5 Task 6 — registry/classification suite for
 * {@link LiveToolRuntime} (`src/extension/tool-registry.ts`,
 * ARCHITECTURE §8, §7, §4). Drives the runtime against the
 * {@link FakeExtensionContext}; the deeper per-executor behavior lives in
 * `executors.test.ts`. Here we pin the wire-facing contract:
 *  - `toolDefinitions()` returns every §8 def (the 15 §8.1/§8.2 tools + the §8.3
 *    `report_limitation` honesty tool = 17) and stamps NO `cache_control`
 *    (the client owns the breakpoint, §15.1);
 *  - `classify()` matches the shared `classify` for every tool name and defaults
 *    unknown names to `"mutation"` (the safe side, §4 step 5c);
 *  - the runtime never throws — unknown tools surface as structured errors.
 */

/** Cast the fake to the SDK context type at the documented seam (one place). */
function ctxOf(fake: FakeExtensionContext): ExtensionContext<ApiVersion> {
  return fake as unknown as ExtensionContext<ApiVersion>;
}

/** Build a runtime over a fresh fake Set with its own turn-scoped table. */
function makeRuntime(
  fake: FakeExtensionContext = makeFakeContext(),
  signal?: AbortSignal
): LiveToolRuntime<ApiVersion> {
  return new LiveToolRuntime(ctxOf(fake), new ReferenceTable(), signal);
}

/** A {@link ToolCall} factory with a deterministic id. */
function call(name: string, input: unknown, id = `id_${name}`): ToolCall {
  return { id, name, input };
}

/** Parse a payload's JSON content (success or structured error). */
function body(p: ToolResultPayload): Record<string, unknown> {
  return JSON.parse(p.content as string) as Record<string, unknown>;
}

describe("tool-registry — definitions", () => {
  it("toolRegistry_toolDefinitions_returnsAllSeventeenDefs", () => {
    const defs = makeRuntime().toolDefinitions();
    // 15 §8.1/§8.2 tools + the §8.3 `report_limitation` honesty tool = 17. The
    // length assertion is pinned to the shared source so it never drifts.
    expect(defs).toHaveLength(17);
    expect(defs).toHaveLength(TOOL_DEFINITIONS.length);
    const names = defs.map((d) => d.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
    // The honesty tool is part of the wire surface.
    expect(names).toContain("report_limitation");
  });

  it("toolRegistry_toolDefinitions_stampsNoCacheControl", () => {
    const defs = makeRuntime().toolDefinitions();
    for (const def of defs) {
      // `cache_control` is the client's breakpoint (§15.1); the registry must not
      // pre-stamp it on any tool.
      expect(
        (def as { cache_control?: unknown }).cache_control
      ).toBeUndefined();
    }
  });

  it("toolRegistry_toolDefinitions_returnsAFreshCopy", () => {
    const rt = makeRuntime();
    const a = rt.toolDefinitions();
    const b = rt.toolDefinitions();
    // A shallow copy each call — mutating the returned array must not poison the
    // shared source (the client may stamp the last element's cache_control).
    expect(a).not.toBe(b);
    a.pop();
    expect(rt.toolDefinitions()).toHaveLength(TOOL_DEFINITIONS.length);
  });
});

describe("tool-registry — classify", () => {
  it("toolRegistry_classify_readForReadTools", () => {
    const rt = makeRuntime();
    for (const name of [
      "live_get_project",
      "live_get_track",
      "live_get_clip",
      "live_get_device_params",
      "live_render_audio",
      // §8.3 honesty tool: runs in the read partition so it executes immediately
      // and is NEVER queued into a transaction (the high-risk wiring detail, §9).
      "report_limitation",
    ]) {
      expect(rt.classify(name)).toBe("read");
    }
  });

  it("toolRegistry_classify_reportLimitationIsReadViaSharedTable", () => {
    // Pin the classification at BOTH seams: the runtime's `classify` AND the
    // shared `TOOL_CLASS` table the runtime delegates to. If `TOOL_CLASS` ever
    // dropped report_limitation, classify() would fall to the "mutation" default
    // and route it to prepare() → unknown_tool (the §9 honesty-tool failure mode).
    expect(makeRuntime().classify("report_limitation")).toBe("read");
    expect(TOOL_CLASS.report_limitation).toBe("read");
  });

  it("toolRegistry_classify_mutationForMutationTools", () => {
    const rt = makeRuntime();
    for (const name of [
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
    ]) {
      expect(rt.classify(name)).toBe("mutation");
    }
  });

  it("toolRegistry_classify_mutationForImportAudioSideEffect", () => {
    // §8.3 side-effect tool changes project state → batched like a mutation.
    expect(makeRuntime().classify("live_import_audio")).toBe("mutation");
  });

  it("toolRegistry_classify_unknownNameDefaultsToMutation", () => {
    // Unknown → the SAFE side: batched + abort-gated, never run eagerly.
    expect(makeRuntime().classify("live_nonexistent")).toBe("mutation");
  });

  it("toolRegistry_classify_matchesSharedClassifyForEveryName", () => {
    const rt = makeRuntime();
    for (const name of TOOL_NAMES) {
      expect(rt.classify(name)).toBe(classify(name));
    }
  });
});

describe("tool-registry — unknown-tool routing never throws", () => {
  it("toolRegistry_executeRead_unknownTool_returnsStructuredError", async () => {
    const p = await makeRuntime().executeRead(call("live_not_a_read_tool", {}));
    expect(p.isError).toBe(true);
    expect(body(p).error).toBe("unknown_tool");
    expect(p.toolUseId).toBe("id_live_not_a_read_tool");
  });

  it("toolRegistry_flushMutations_unknownTool_returnsStructuredError", async () => {
    const fake = makeFakeContext();
    const p = await makeRuntime(fake).flushMutations([
      call("live_not_a_mutation_tool", {}),
    ]);
    expect(p).toHaveLength(1);
    expect(p[0].isError).toBe(true);
    expect(body(p[0]).error).toBe("unknown_tool");
    // An all-errored batch opens NO transaction.
    expect(fake.transactions).toEqual([]);
  });

  it("toolRegistry_executeRead_passingAMutationName_returnsStructuredError", async () => {
    // executeRead is the read partition only; a mutation name is "not a read tool".
    const p = await makeRuntime().executeRead(call("live_update_track", {}));
    expect(p.isError).toBe(true);
    expect(body(p).error).toBe("unknown_tool");
  });
});

describe("tool-registry — report_limitation routes through the READ partition (§8.3/§9)", () => {
  it("toolRegistry_executeRead_reportLimitation_acknowledgesHonestly", async () => {
    // The honesty tool dispatches through executeRead and returns a non-error
    // acknowledgment — never a fake success, never an unknown_tool error.
    const p = await makeRuntime().executeRead(
      call("report_limitation", {
        requested: "draw automation",
        reason: "live_set_param only sets a static value (§9)",
        alternative: "set a single static value",
      })
    );
    expect(p.isError).toBeUndefined();
    const data = body(p);
    expect(data.acknowledged).toBe(true);
    expect(data.requested).toBe("draw automation");
  });

  it("toolRegistry_flushMutations_reportLimitation_hitsUnknownToolNotAMutation", async () => {
    // The lock-in for the high-risk wiring detail: if report_limitation were EVER
    // routed to the mutation flush (e.g. classify defaulting to "mutation"), the
    // mutation switch has no case for it and would surface `unknown_tool` and open
    // NO transaction. Proving that here demonstrates the read classification is
    // exactly what makes the honesty tool work — and that the safety net holds even
    // if it were misrouted.
    const fake = makeFakeContext();
    const [p] = await makeRuntime(fake).flushMutations([
      call("report_limitation", {
        requested: "x",
        reason: "y",
      }),
    ]);
    expect(p.isError).toBe(true);
    expect(body(p).error).toBe("unknown_tool");
    // A misrouted honesty tool must never open a transaction (no phantom undo step).
    expect(fake.transactions).toEqual([]);
  });
});

describe("tool-registry — named live_create create-then-configure transaction count (§7)", () => {
  it("toolRegistry_flushMutations_namedCreate_opensTwoTransactions", async () => {
    // A single named create costs at most TWO undo steps: one create txn + one
    // shared rename txn (create-then-configure, §7). The registry owns the second
    // (rename) transaction.
    const fake = makeFakeContext();
    await makeRuntime(fake).flushMutations([
      call("live_create", { kind: "audio_track", name: "Vox" }),
    ]);
    expect(fake.transactions).toEqual([
      { committed: true, rolledBack: false },
      { committed: true, rolledBack: false },
    ]);
    expect(fake.committedCount).toBe(2);
  });

  it("toolRegistry_flushMutations_unnamedCreate_opensOneTransaction", async () => {
    // No name ⇒ the registry never opens the rename transaction (one undo step).
    const fake = makeFakeContext();
    await makeRuntime(fake).flushMutations([
      call("live_create", { kind: "audio_track" }),
    ]);
    expect(fake.transactions).toEqual([{ committed: true, rolledBack: false }]);
    expect(fake.committedCount).toBe(1);
  });

  it("toolRegistry_flushMutations_manyNamedCreates_shareOneRenameTransaction", async () => {
    // N named creates in one flush ⇒ still exactly TWO transactions, NOT N+1: a
    // single shared rename transaction applies every queued name.
    const fake = makeFakeContext();
    const results = await makeRuntime(fake).flushMutations([
      call("live_create", { kind: "audio_track", name: "A" }, "a"),
      call("live_create", { kind: "midi_track", name: "B" }, "b"),
      call("live_create", { kind: "scene", name: "C" }, "c"),
    ]);
    expect(fake.committedCount).toBe(2);
    expect(fake.transactions).toHaveLength(2);
    expect(results.every((r) => r.isError === undefined)).toBe(true);
    // Every ref is name-bearing (ends with the applied name).
    expect(String(body(results[0]).ref).endsWith(":A")).toBe(true);
    expect(String(body(results[1]).ref).endsWith(":B")).toBe(true);
    expect(String(body(results[2]).ref).endsWith(":C")).toBe(true);
  });

  it("toolRegistry_flushMutations_namedCreate_renameThrow_succeedsUnrenamed", async () => {
    // The rename transaction throwing rolls back atomically (R5): the create txn
    // stays committed, the rename is reported rolled back, and the call is an honest
    // SUCCESS with the un-renamed ref + a "naming failed" note (never an sdk_error,
    // which would hide the created object, §9).
    const fake = makeFakeContext();
    fake.failNameSets("boom");
    const [r] = await makeRuntime(fake).flushMutations([
      call("live_create", { kind: "audio_track", name: "Vox" }),
    ]);
    expect(r.isError).toBeUndefined();
    expect(body(r).error).toBeUndefined();
    expect(body(r).note).toBe(
      "created, but name not applied — naming failed: boom"
    );
    expect(fake.transactions).toEqual([
      { committed: true, rolledBack: false },
      { committed: false, rolledBack: true },
    ]);
    expect(fake.committedCount).toBe(1);
  });
});

describe("tool-registry — transaction throw maps the batch to sdk_error (§7 / R5)", () => {
  it("toolRegistry_flushMutations_syncThrowInTransaction_rollsBackAndFailsBatch", async () => {
    // Make a track's `name` sync setter throw: it runs INSIDE the transaction, so
    // the throw triggers R5 atomic rollback. The runtime must map every runnable
    // call to an sdk_error (the rolled-back batch), never let the throw escape.
    const fake = makeFakeContext();
    const realTracks = Object.getOwnPropertyDescriptor(
      fake.application.song,
      "tracks"
    );
    // Wrap getObjectFromHandle so the resolved track's `name` setter throws.
    const raw = fake.getObjectFromHandle.bind(fake);
    fake.getObjectFromHandle = <T>(
      handle: { id: bigint },
      type: unknown
    ): T => {
      const obj: unknown = raw(handle, type as never);
      if (
        obj !== null &&
        typeof obj === "object" &&
        "name" in (obj as Record<string, unknown>)
      ) {
        Object.defineProperty(obj, "name", {
          configurable: true,
          get() {
            return "x";
          },
          set() {
            throw new Error("boom in setter");
          },
        });
      }
      return obj as T;
    };
    void realTracks;

    const results = await makeRuntime(fake).flushMutations([
      call("live_update_track", { track: "track:0:Drums", name: "New" }, "one"),
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(true);
    expect(body(results[0]).error).toBe("sdk_error");
    // R5: the transaction attempt rolled back (no commit recorded).
    expect(fake.transactions).toEqual([{ committed: false, rolledBack: true }]);
    expect(fake.committedCount).toBe(0);
  });
});
