import { describe, expect, it } from "vitest";

import type { ExtensionContext, ApiVersion } from "@ableton-extensions/sdk";

import { LiveToolRuntime } from "../src/extension/tool-registry.js";
import { ReferenceTable } from "../src/extension/references.js";
import type {
  ToolCall,
  ToolResultPayload,
} from "../src/extension/agent-loop.js";
import { TOOL_DEFINITIONS, TOOL_NAMES, classify } from "../src/shared/tools.js";
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
 *  - `toolDefinitions()` returns all 16 §8 defs and stamps NO `cache_control`
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
  it("toolRegistry_toolDefinitions_returnsAllSixteenDefs", () => {
    const defs = makeRuntime().toolDefinitions();
    expect(defs).toHaveLength(16);
    expect(defs).toHaveLength(TOOL_DEFINITIONS.length);
    const names = defs.map((d) => d.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
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
    expect(rt.toolDefinitions()).toHaveLength(16);
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
    ]) {
      expect(rt.classify(name)).toBe("read");
    }
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
