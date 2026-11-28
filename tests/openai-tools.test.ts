import { describe, expect, it } from "vitest";
import { build } from "esbuild";

import type {
  ProviderToolDefinition,
  ToolDefinition,
} from "../src/shared/provider.js";
import { TOOL_DEFINITIONS, TOOL_NAMES, classify } from "../src/shared/tools.js";
import {
  buildOpenAiTools,
  OpenAiToolsFault,
  OPENAI_TOOL_NAMESPACE,
} from "../src/companion/providers/openai-tools.js";

// The 15.4A provider-contract suite independently fingerprints the complete
// original wire definitions. These tests prove the new mapping preserves them
// exactly, except for the deliberately non-strict Responses wire hint.
const EXPECTED_NAMES = [
  "live_get_project",
  "live_get_track",
  "live_get_clip",
  "live_get_device_params",
  "live_render_audio",
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
  "live_import_audio",
  "report_limitation",
] as const;
const STRICT_NAMES = [
  "live_update_track",
  "live_set_param",
  "live_create",
  "live_insert_device",
  "live_modify_device_chain",
  "live_replace_sample",
  "live_delete",
  "live_import_audio",
];
const READ_NAMES = [
  "live_get_project",
  "live_get_track",
  "live_get_clip",
  "live_get_device_params",
  "live_render_audio",
  "report_limitation",
];

function definitions(): ToolDefinition[] {
  return structuredClone([...TOOL_DEFINITIONS]);
}
function freeze(value: unknown): void {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
}

describe("15.4B1 canonical Live tools → one Responses namespace", () => {
  it("B1 provider modules and OpenAI SDK are not wired into the legacy production bundle", async () => {
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
          path.includes("/companion/") ||
          path.includes("/companion-feasibility/") ||
          path.includes("/feasibility/") ||
          path.includes("/openai/") ||
          path.includes("/jsonwebtoken/")
      )
    ).toEqual([]);
  });

  it("maps all 17 exact names, descriptions, full parameter schemas and ordering, with explicit strict:false wire and retained canonical metadata", () => {
    const supplied = definitions();
    const original = structuredClone(supplied);
    freeze(supplied);
    const mapped = buildOpenAiTools(supplied);
    expect(TOOL_NAMES).toEqual(EXPECTED_NAMES);
    expect(mapped.wireTools).toHaveLength(1);
    const namespace = mapped.wireTools[0];
    expect(namespace).toMatchObject({ type: "namespace", name: "live" });
    expect(OPENAI_TOOL_NAMESPACE).toBe("live");
    expect(namespace?.description).toEqual(expect.any(String));
    expect(namespace?.tools).toHaveLength(17);
    const rows = supplied.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
      strict: false,
    }));
    expect(namespace?.tools).toEqual(rows);
    expect(namespace?.tools.map((tool) => tool.name)).toEqual(EXPECTED_NAMES);
    expect(mapped.definitions).toEqual(original);
    expect(supplied).toEqual(original);
    expect(TOOL_DEFINITIONS).toEqual(original);
    expect(
      mapped.definitions
        .filter((tool) => tool.strict === true)
        .map((tool) => tool.name)
    ).toEqual(STRICT_NAMES);
    expect(
      mapped.definitions
        .filter((tool) => classify(tool.name) === "read")
        .map((tool) => tool.name)
    ).toEqual(READ_NAMES);
    expect(JSON.stringify(mapped.wireTools)).not.toContain('"input_examples"');
    expect(JSON.stringify(mapped.wireTools)).not.toContain('"cache_control"');
  });

  it("only exact live namespace and an offered function map to the unchanged local dispatch name", () => {
    const mapped = buildOpenAiTools(definitions());
    for (const name of EXPECTED_NAMES)
      expect(mapped.resolveLocalToolName("live", name)).toBe(name);
    for (const [namespace, name] of [
      ["other", "live_get_project"],
      ["Live", "live_get_project"],
      ["live", "get_project"],
      ["live", "live.live_get_project"],
      ["live", "live_unknown"],
      ["live", " live_get_project"],
      ["", "live_get_project"],
    ])
      expect(mapped.resolveLocalToolName(namespace, name)).toBeUndefined();
  });

  it("empty and subset offers never resolve a registered tool that was not offered", () => {
    const empty = buildOpenAiTools([]);
    expect(empty.wireTools).toEqual([]);
    expect(empty.definitions).toEqual([]);
    for (const name of EXPECTED_NAMES)
      expect(empty.resolveLocalToolName("live", name)).toBeUndefined();
    const [first, second] = definitions();
    const subset = buildOpenAiTools([second, first]);
    expect(subset.wireTools[0]?.tools.map((tool) => tool.name)).toEqual([
      second.name,
      first.name,
    ]);
    expect(subset.definitions).toEqual([second, first]);
    expect(subset.resolveLocalToolName("live", second.name)).toBe(second.name);
    expect(subset.resolveLocalToolName("live", "live_delete")).toBeUndefined();
    for (const [namespace, name] of [
      [null, first.name],
      ["live", null],
      ["live", { name: first.name }],
    ])
      expect(subset.resolveLocalToolName(namespace, name)).toBeUndefined();
  });

  it("rejects duplicated or unknown names and provider-bound opaque tool definitions before producing a wire offer", () => {
    const original = definitions();
    const first = original[0];
    const cases: [ProviderToolDefinition[], OpenAiToolsFault["code"]][] = [
      [[...original, structuredClone(first)], "duplicate_tool"],
      [[{ ...first, name: "arbitrary_unknown" }], "unknown_tool"],
      [[{ ...first, name: "live.live_get_project" }], "unknown_tool"],
      [
        [{ type: "opaque", provider: "legacy_claude", value: first }],
        "foreign_definition",
      ],
      [
        [{ type: "opaque", provider: "openai_responses", value: first }],
        "foreign_definition",
      ],
      [
        [
          ...original.slice(0, -1),
          { type: "opaque", provider: "legacy_claude", value: original.at(-1) },
        ],
        "foreign_definition",
      ],
    ];
    for (const [candidate, code] of cases) {
      const before = structuredClone(candidate);
      expect(() => buildOpenAiTools(candidate)).toThrow(code);
      expect(candidate).toEqual(before);
    }
    expect(TOOL_DEFINITIONS).toEqual(original);
  });

  it("does not accept an altered schema, description or strictness under a registered local name", () => {
    const first = definitions()[0];
    const changed: ToolDefinition[] = [
      { ...first, description: "Synthetic unauthorized description" },
      {
        ...first,
        input_schema: {
          type: "object",
          properties: { arbitrary: { type: "string" } },
          required: ["arbitrary"],
        },
      },
      { ...first, strict: true },
      { ...first, input_examples: [{ arbitrary: "synthetic replacement" }] },
    ];
    for (const tool of changed)
      expect(() => buildOpenAiTools([tool])).toThrow("invalid_definition");
  });

  it("a caller modifying its supplied definition after mapping cannot change the request-ready schema or retained metadata", () => {
    const supplied = definitions();
    const original = structuredClone(supplied);
    const mapped = buildOpenAiTools(supplied);
    supplied[0].name = "untrusted_later_name";
    supplied[0].description = "untrusted later description";
    supplied[0].input_schema.required = ["untrusted later parameter"];
    expect(mapped.wireTools[0]?.tools[0]).toEqual({
      type: "function",
      name: original[0].name,
      description: original[0].description,
      parameters: original[0].input_schema,
      strict: false,
    });
    expect(mapped.definitions).toEqual(original);
    expect(mapped.resolveLocalToolName("live", "live_get_project")).toBe(
      "live_get_project"
    );
    expect(
      mapped.resolveLocalToolName("live", "untrusted_later_name")
    ).toBeUndefined();
  });

  it("detached wire and metadata getters cannot be used to mutate later requests or offered-name resolution", () => {
    const mapped = buildOpenAiTools(definitions());
    const wire = mapped.wireTools;
    const defs = mapped.definitions;
    const expectedWire = structuredClone(wire);
    const expectedDefs = structuredClone(defs);
    wire[0].name = "wrong";
    wire[0].tools[0].name = "wrong";
    defs[0].input_schema.required = ["wrong"];
    defs.splice(0, 1);
    expect(mapped.wireTools).toEqual(expectedWire);
    expect(mapped.definitions).toEqual(expectedDefs);
    expect(mapped.resolveLocalToolName("live", "live_get_project")).toBe(
      "live_get_project"
    );
    expect(mapped.resolveLocalToolName("live", "wrong")).toBeUndefined();
  });
});
