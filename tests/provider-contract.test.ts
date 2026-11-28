import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import type { ApiVersion, ExtensionContext } from "@ableton-extensions/sdk";

import {
  TOOL_DEFINITIONS,
  TOOL_NAMES,
  TOOL_BY_NAME,
  classify,
  isDestructiveCall,
} from "../src/shared/tools.js";
import { LiveToolRuntime } from "../src/extension/tool-registry.js";
import { ClaudeClient } from "../src/extension/claude-client.js";
import { runAgentLoop } from "../src/extension/agent-loop.js";
import {
  FakeMessagesClient,
  textTurn,
} from "./fixtures/fake-anthropic-client.js";
import { makeFakeContext } from "./fixtures/fake-extension-context.js";

/** Independent baseline from merged dc11dd7 before canonicalization. Hashes
 * cover each *entire* wire definition, including every description, required
 * field, schema nesting, enum, strict flag and example. Object-key sorting
 * ignores irrelevant property insertion order but preserves array order. */
const BASELINE = [
  [
    "live_get_project",
    "read",
    null,
    "4aae36d591baa97bef41958fbadb9cc9c9215cc80eef0963b8e4b7119fdfdbbe",
  ],
  [
    "live_get_track",
    "read",
    null,
    "e92fc2ee6f77511a670e159e9a29bdc0c6e7324a57fc9089a3b2a120c243bd61",
  ],
  [
    "live_get_clip",
    "read",
    null,
    "233bc9dfd60f2bf4797f07ef18810001aaedc4a3529a9d39815d7920e3260397",
  ],
  [
    "live_get_device_params",
    "read",
    null,
    "656cc40c468109bbb5b47a4e7a679ee176ea1e0e7005c234839ab9d2a408cda2",
  ],
  [
    "live_render_audio",
    "read",
    null,
    "c925b35632388f71c2fb190388bbf683e6d5488e156f8740b34abb21ddeb3174",
  ],
  [
    "live_update_track",
    "mutation",
    true,
    "9baed67c0cbf3d81f83275341f6dfe35f77963155844f59d8f6f4c6bf01d8e81",
  ],
  [
    "live_update_clip",
    "mutation",
    null,
    "7bb919edd5b3741bbe3585f440a083bede81d859fe6ea81d9591aaa8cb4bdbfb",
  ],
  [
    "live_edit_midi_notes",
    "mutation",
    null,
    "4c5c6cd6127640c040fc80992836b42c3db6b123f1426a38608d8c2a53a80354",
  ],
  [
    "live_set_param",
    "mutation",
    true,
    "00315263aee4d6544b122adcec12d8a12c4a8f7608277e2807fb894c09c3ee22",
  ],
  [
    "live_create",
    "mutation",
    true,
    "17c1ddf2f0a89d9399a5f612080533710281ecb173ec9ffc65b4391e463492db",
  ],
  [
    "live_create_clip",
    "mutation",
    null,
    "3a0101ab68c873a1684f6ee81559e90c3a8917390ac07d704fecdf076f5df1a4",
  ],
  [
    "live_insert_device",
    "mutation",
    true,
    "9c03397252915d74f49db405d311a9c3df99491dc3ce5919a14bd77d5c7e48bd",
  ],
  [
    "live_modify_device_chain",
    "mutation",
    true,
    "e632b9c20eeca92944821c3570c46fa64a80048990b2b1685146ad5e9476c900",
  ],
  [
    "live_replace_sample",
    "mutation",
    true,
    "04330c210cc0537114442872528decd8583efe1f33f002b89b0b8381698622b6",
  ],
  [
    "live_delete",
    "mutation",
    true,
    "48a01e8ab6c8560f436ea174ac30f21a46c46d6b4b079c64cc6eca0ce06aaff9",
  ],
  [
    "live_import_audio",
    "mutation",
    true,
    "2a723a3f3f92f6f32045910d401c645904471f0f0ba15cbcf45b5ee3de043b84",
  ],
  [
    "report_limitation",
    "read",
    null,
    "84f15db6b8ec58736f52e193ce3f9322c3c45dde9ed3114ddbaf7a7eee392c82",
  ],
] as const;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return (value as unknown[]).map(stable);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, stable(entry)])
    );
  return value;
}
function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

describe("15.4A canonical provider tool contract preserves legacy production surface", () => {
  it("shared registry remains exactly 17 ordered, uniquely named logical tools; classification and destructive predicate are unchanged", () => {
    const expected = BASELINE.map(([name]) => name);
    expect(TOOL_NAMES).toEqual(expected);
    expect(TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual(expected);
    expect(Object.keys(TOOL_BY_NAME)).toEqual(expected);
    const runtime = new LiveToolRuntime(
      makeFakeContext() as unknown as ExtensionContext<ApiVersion>
    );
    expect(runtime.toolDefinitions()).toEqual(TOOL_DEFINITIONS);
    expect(
      TOOL_DEFINITIONS.map((tool) => [
        tool.name,
        classify(tool.name),
        tool.strict ?? null,
        digest(tool),
      ])
    ).toEqual(BASELINE);
    for (const [name, kind] of BASELINE) {
      expect(classify(name)).toBe(kind);
      expect(runtime.classify(name)).toBe(kind);
      expect(TOOL_BY_NAME[name].name).toBe(name);
      expect(isDestructiveCall(name, {})).toBe(name === "live_delete");
      expect(isDestructiveCall(name, { op: "filter" })).toBe(
        name === "live_delete" || name === "live_edit_midi_notes"
      );
    }
    expect(runtime.classify("unrecognized_synthetic_tool")).toBe("mutation");
  });

  it("actual legacy loop/facade wire emits exact baseline definitions, preserving strictness, descriptions, schema and input examples", async () => {
    const runtime = new LiveToolRuntime(
      makeFakeContext() as unknown as ExtensionContext<ApiVersion>
    );
    const fake = new FakeMessagesClient([textTurn("synthetic done")]);
    const initial = structuredClone(TOOL_DEFINITIONS);
    const result = await runAgentLoop({
      client: new ClaudeClient(fake),
      runtime,
      events: {
        assistantDelta() {},
        toolActivity() {},
        assistantDone() {},
        error() {},
      },
      system: [],
      messages: [{ role: "user", content: "synthetic turn" }],
    });
    expect(result).toMatchObject({ ok: true, text: "synthetic done" });
    expect(fake.capturedParams).toHaveLength(1);
    const tools = fake.capturedParams[0]?.tools;
    expect(tools).toHaveLength(17);
    const fingerprints = (tools ?? []).map((tool, index) => {
      const { cache_control, ...wire } = tool;
      expect(cache_control).toEqual(
        index === 16 ? { type: "ephemeral" } : undefined
      );
      return [
        wire.name,
        runtime.classify(wire.name),
        "strict" in wire ? (wire.strict ?? null) : null,
        digest(wire),
      ];
    });
    expect(fingerprints).toEqual(BASELINE);
    expect(TOOL_DEFINITIONS).toEqual(initial);
  });

  it("canonical shared source and agent runner have no provider or Live SDK imports (including type imports)", () => {
    for (const path of [
      "src/shared/provider.ts",
      "src/shared/tools.ts",
      "src/extension/agent-loop.ts",
    ]) {
      const source = fs.readFileSync(path, "utf8");
      expect(source).not.toMatch(
        /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](?:@anthropic-ai\/sdk|@ableton-extensions\/sdk|openai)(?:\/[^"']*)?["']/u
      );
    }
  });

  it("production bundle includes the new legacy boundary but no companion, OAuth or OpenAI SDK inputs", async () => {
    const graph = await build({
      entryPoints: ["src/extension/index.ts"],
      bundle: true,
      platform: "node",
      format: "cjs",
      loader: { ".html": "text" },
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    const inputs = Object.keys(graph.metafile.inputs);
    expect(inputs).toContain("src/extension/providers/legacy-claude.ts");
    expect(
      inputs.filter(
        (path) =>
          path.includes("/companion-feasibility/") ||
          path.includes("/feasibility/") ||
          path.includes("/openai/") ||
          path.includes("/jsonwebtoken/")
      )
    ).toEqual([]);
  });
});
