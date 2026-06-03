import { describe, expect, it } from "vitest";

import { TOOL_DEFINITIONS } from "../src/shared/tools.js";

/**
 * Wire-shape invariant suite for the tool JSON Schemas in `src/shared/tools.ts`
 * (ARCHITECTURE §8). Anthropic's strict tool-use validation rejects any
 * `"type": "object"` schema node that does not explicitly set
 * `additionalProperties: false` — the top-level `input_schema` AND every nested
 * object (object-typed properties, each object branch inside
 * `oneOf`/`anyOf`/`allOf`, and array `items` that are objects). The API reports
 * only the first offending tool, so a per-literal omission would surface one
 * tool at a time on live calls. This single recursive invariant protects all 17
 * tools and any future tool, and the per-tool top-level assertions point a
 * failure straight at the offending tool by name.
 *
 * The suite also encodes the *combinator* and *strict-budget* rules we confirmed
 * empirically against the live API (via `scripts/validate-tool-schemas.ts`), so
 * future tools cannot reintroduce them offline:
 *
 *  - A combinator node (`anyOf`/`allOf`) must be **pure** — it may carry ONLY the
 *    combinator keyword (plus `description`). Sibling `type` /
 *    `additionalProperties` / `properties` / `required` are rejected
 *    (`tools.N.custom: For 'anyOf', '…' is not supported`); they belong on each
 *    BRANCH, never the wrapper.
 *  - Every `anyOf`/`allOf` branch is itself a valid object node
 *    (`type:"object"` + `additionalProperties:false`).
 *  - Strict tool-use compiles every `strict` schema into a grammar and caps the
 *    **combined** total across all strict schemas at **20 strict tools**,
 *    **24 optional parameters**, and **16 union-typed parameters**
 *    (platform.claude.com structured-outputs → "Schema complexity limits"). We
 *    assert each aggregate stays under its cap (with headroom for the separate
 *    "compiled grammar is too large" guard that fires before the numeric caps).
 *
 * These tests inspect the schema *shape* only; they touch no SDK and no Live
 * model. Schemas are plain JSON values, so we walk them as `unknown` and narrow.
 */

/** A schema node we descend into; the wire is JSON, so values are unknown. */
type SchemaNode = Record<string, unknown>;

/** Narrow an unknown value to a plain (non-array) object we can index. */
function isObjectNode(value: unknown): value is SchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Collect every JSON-Schema node reachable from `root` that declares
 * `"type": "object"`, paired with a human-readable JSON path for diagnostics.
 * Descends through `properties`, `items` (single or tuple), `$defs`/`definitions`,
 * and the `oneOf`/`anyOf`/`allOf` combinator branches.
 */
function collectObjectNodes(
  root: unknown,
  path: string,
  acc: Array<{ path: string; node: SchemaNode }>
): void {
  if (!isObjectNode(root)) {
    return;
  }

  if (root.type === "object") {
    acc.push({ path, node: root });
  }

  // Object-typed (and any other) properties.
  if (isObjectNode(root.properties)) {
    for (const [key, child] of Object.entries(root.properties)) {
      collectObjectNodes(child, `${path}.properties.${key}`, acc);
    }
  }

  // Array `items`: a single schema or a tuple of schemas.
  if (Array.isArray(root.items)) {
    root.items.forEach((child, i) =>
      collectObjectNodes(child, `${path}.items[${i}]`, acc)
    );
  } else if (root.items !== undefined) {
    collectObjectNodes(root.items, `${path}.items`, acc);
  }

  // Reusable subschema buckets.
  for (const defsKey of ["$defs", "definitions"] as const) {
    if (isObjectNode(root[defsKey])) {
      for (const [key, child] of Object.entries(root[defsKey])) {
        collectObjectNodes(child, `${path}.${defsKey}.${key}`, acc);
      }
    }
  }

  // Combinator branches.
  for (const combinator of ["oneOf", "anyOf", "allOf"] as const) {
    const branches = root[combinator];
    if (Array.isArray(branches)) {
      branches.forEach((child, i) =>
        collectObjectNodes(child, `${path}.${combinator}[${i}]`, acc)
      );
    }
  }
}

/**
 * JSON-Schema keywords Anthropic's strict tool-use validation does NOT accept.
 * Sending any of these on any node returns a 400 (`invalid_request_error`),
 * and the API reports only the first offending tool — so a stray keyword on a
 * single tool surfaces one-at-a-time across successive live calls. Source of
 * truth: platform.claude.com structured-outputs "JSON Schema limitations"
 * (linked from the strict-tool-use page) — supported set is type / properties /
 * required / additionalProperties / enum / const / anyOf / allOf / $ref / $defs /
 * description / items; `oneOf` is NOT supported (use `anyOf`), and all numeric,
 * string, and array *constraint* keywords are rejected. We also deny `pattern`,
 * `format`, and `default` (technically accepted but unused here) to keep the
 * schemas portable and the guard maximally strict.
 */
const UNSUPPORTED_KEYWORDS = [
  // numeric constraints
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  // string constraints
  "minLength",
  "maxLength",
  "pattern",
  "format",
  // array constraints
  "minItems",
  "maxItems",
  "uniqueItems",
  // combinators / misc not in the supported subset
  "oneOf",
  "default",
] as const;

/**
 * Collect every node reachable from `root` (regardless of `type`), paired with
 * a JSON path. Unlike {@link collectObjectNodes} this does not filter to
 * `"type": "object"` — an unsupported keyword can sit on a `string`/`integer`/
 * `array` leaf (e.g. `minimum` on an integer, `minItems` on an array), so the
 * deny-list walker must visit every node.
 */
function collectAllNodes(
  root: unknown,
  path: string,
  acc: Array<{ path: string; node: SchemaNode }>
): void {
  if (!isObjectNode(root)) {
    return;
  }

  acc.push({ path, node: root });

  if (isObjectNode(root.properties)) {
    for (const [key, child] of Object.entries(root.properties)) {
      collectAllNodes(child, `${path}.properties.${key}`, acc);
    }
  }

  if (Array.isArray(root.items)) {
    root.items.forEach((child, i) =>
      collectAllNodes(child, `${path}.items[${i}]`, acc)
    );
  } else if (root.items !== undefined) {
    collectAllNodes(root.items, `${path}.items`, acc);
  }

  for (const defsKey of ["$defs", "definitions"] as const) {
    if (isObjectNode(root[defsKey])) {
      for (const [key, child] of Object.entries(root[defsKey])) {
        collectAllNodes(child, `${path}.${defsKey}.${key}`, acc);
      }
    }
  }

  for (const combinator of ["oneOf", "anyOf", "allOf"] as const) {
    const branches = root[combinator];
    if (Array.isArray(branches)) {
      branches.forEach((child, i) =>
        collectAllNodes(child, `${path}.${combinator}[${i}]`, acc)
      );
    }
  }
}

describe("tool schemas — strict-tool-use unsupported-keyword deny-list", () => {
  it.each(TOOL_DEFINITIONS.map((t) => [t.name, t] as const))(
    "%s — no node carries an unsupported JSON-Schema keyword",
    (name, tool) => {
      const nodes: Array<{ path: string; node: SchemaNode }> = [];
      collectAllNodes(tool.input_schema, name, nodes);

      const offenders: string[] = [];
      for (const { path, node } of nodes) {
        for (const kw of UNSUPPORTED_KEYWORDS) {
          if (Object.prototype.hasOwnProperty.call(node, kw)) {
            offenders.push(`${path} → "${kw}"`);
          }
        }
      }
      expect(
        offenders,
        `${name}: these nodes carry keywords strict tool-use rejects`
      ).toEqual([]);
    }
  );
});

describe("tool schemas — additionalProperties:false invariant (strict tool-use)", () => {
  it("every tool's input_schema is an object that forbids additionalProperties", () => {
    for (const tool of TOOL_DEFINITIONS) {
      const schema = tool.input_schema as SchemaNode;
      expect(schema.type, `${tool.name}: input_schema must be an object`).toBe(
        "object"
      );
      expect(
        schema.additionalProperties,
        `${tool.name}: top-level input_schema must set additionalProperties:false`
      ).toBe(false);
    }
  });

  it.each(TOOL_DEFINITIONS.map((t) => [t.name, t] as const))(
    "%s — every nested object node sets additionalProperties:false",
    (name, tool) => {
      const nodes: Array<{ path: string; node: SchemaNode }> = [];
      collectObjectNodes(tool.input_schema, name, nodes);

      // Sanity: the top-level object must itself be discovered.
      expect(
        nodes.length,
        `${name}: expected at least the top-level object node`
      ).toBeGreaterThan(0);

      const offenders = nodes.filter(
        ({ node }) => node.additionalProperties !== false
      );
      expect(
        offenders.map((o) => o.path),
        `${name}: these object nodes are missing additionalProperties:false`
      ).toEqual([]);
    }
  );

  it("guards all 17 tools (15 §8.1/§8.2 + report_limitation honesty tool)", () => {
    expect(TOOL_DEFINITIONS).toHaveLength(17);
  });
});

/**
 * Keywords that make a node a "combinator" (a schema that composes branches).
 * Strict tool-use accepts `anyOf` and `allOf` (NOT `oneOf` — see the deny-list
 * above); whichever is present, the node must be pure.
 */
const COMBINATOR_KEYWORDS = ["anyOf", "allOf"] as const;

/**
 * Keywords that must NOT sit as siblings of a combinator. A combinator node is
 * "pure" if it carries only the combinator (plus an optional `description`);
 * structural keywords belong on each branch, never the wrapper. Sending them on
 * the wrapper returns `tools.N.custom: For 'anyOf', '<keys>' is not supported`.
 */
const COMBINATOR_FORBIDDEN_SIBLINGS = [
  "type",
  "additionalProperties",
  "properties",
  "required",
] as const;

/**
 * Collect every node carrying a combinator keyword (`anyOf`/`allOf`), with its
 * JSON path, walking the same structure as {@link collectAllNodes}.
 */
function collectCombinatorNodes(
  root: unknown,
  path: string,
  acc: Array<{ path: string; node: SchemaNode; combinator: string }>
): void {
  const all: Array<{ path: string; node: SchemaNode }> = [];
  collectAllNodes(root, path, all);
  for (const { path: p, node } of all) {
    for (const combinator of COMBINATOR_KEYWORDS) {
      if (Array.isArray(node[combinator])) {
        acc.push({ path: p, node, combinator });
      }
    }
  }
}

describe("tool schemas — combinator nodes must be pure (strict tool-use)", () => {
  it.each(TOOL_DEFINITIONS.map((t) => [t.name, t] as const))(
    "%s — no anyOf/allOf node carries a forbidden structural sibling",
    (name, tool) => {
      const nodes: Array<{
        path: string;
        node: SchemaNode;
        combinator: string;
      }> = [];
      collectCombinatorNodes(tool.input_schema, name, nodes);

      const offenders: string[] = [];
      for (const { path, node, combinator } of nodes) {
        for (const sibling of COMBINATOR_FORBIDDEN_SIBLINGS) {
          if (Object.prototype.hasOwnProperty.call(node, sibling)) {
            offenders.push(`${path} (${combinator}) → sibling "${sibling}"`);
          }
        }
      }
      expect(
        offenders,
        `${name}: these combinator nodes carry siblings strict tool-use rejects on the wrapper`
      ).toEqual([]);
    }
  );

  it.each(TOOL_DEFINITIONS.map((t) => [t.name, t] as const))(
    "%s — every anyOf/allOf branch is a closed object node",
    (name, tool) => {
      const nodes: Array<{
        path: string;
        node: SchemaNode;
        combinator: string;
      }> = [];
      collectCombinatorNodes(tool.input_schema, name, nodes);

      const offenders: string[] = [];
      for (const { path, node, combinator } of nodes) {
        const branches = node[combinator] as unknown[];
        branches.forEach((branch, i) => {
          const branchPath = `${path}.${combinator}[${i}]`;
          if (!isObjectNode(branch)) {
            offenders.push(`${branchPath} (not an object)`);
            return;
          }
          if (branch.type !== "object") {
            offenders.push(`${branchPath} (type !== "object")`);
          }
          if (branch.additionalProperties !== false) {
            offenders.push(`${branchPath} (additionalProperties !== false)`);
          }
        });
      }
      expect(
        offenders,
        `${name}: every combinator branch must be a complete {type:"object", additionalProperties:false} node`
      ).toEqual([]);
    }
  );
});

/**
 * Count the optional parameters in one schema node and its descendants: every
 * `properties` key not listed in that node's `required`, summed recursively
 * through nested objects, array `items`, and combinator branches.
 */
function countOptionalParams(root: unknown): number {
  if (!isObjectNode(root)) {
    return 0;
  }
  let count = 0;
  if (root.type === "object" && isObjectNode(root.properties)) {
    const required = new Set(
      Array.isArray(root.required) ? (root.required as string[]) : []
    );
    for (const key of Object.keys(root.properties)) {
      if (!required.has(key)) {
        count += 1;
      }
      count += countOptionalParams(root.properties[key]);
    }
  }
  if (Array.isArray(root.items)) {
    for (const item of root.items) {
      count += countOptionalParams(item);
    }
  } else if (root.items !== undefined) {
    count += countOptionalParams(root.items);
  }
  for (const combinator of COMBINATOR_KEYWORDS) {
    if (Array.isArray(root[combinator])) {
      for (const branch of root[combinator] as unknown[]) {
        count += countOptionalParams(branch);
      }
    }
  }
  return count;
}

/**
 * Count the union-typed parameters in one schema node and its descendants: a
 * property whose value is itself a combinator (`anyOf`/`allOf`) node counts
 * once. Recurses through nested objects, array `items`, and combinator branches.
 */
function countUnionParams(root: unknown): number {
  if (!isObjectNode(root)) {
    return 0;
  }
  let count = 0;
  if (isObjectNode(root.properties)) {
    for (const value of Object.values(root.properties)) {
      if (
        isObjectNode(value) &&
        COMBINATOR_KEYWORDS.some((c) => Array.isArray(value[c]))
      ) {
        count += 1;
      }
      count += countUnionParams(value);
    }
  }
  if (Array.isArray(root.items)) {
    for (const item of root.items) {
      count += countUnionParams(item);
    }
  } else if (root.items !== undefined) {
    count += countUnionParams(root.items);
  }
  for (const combinator of COMBINATOR_KEYWORDS) {
    if (Array.isArray(root[combinator])) {
      for (const branch of root[combinator] as unknown[]) {
        count += countUnionParams(branch);
      }
    }
  }
  return count;
}

/** A tool is strict when it sets `strict: true`. */
function isStrict(tool: (typeof TOOL_DEFINITIONS)[number]): boolean {
  return tool.strict === true;
}

describe("tool schemas — aggregate strict-budget caps (strict tool-use)", () => {
  const strictTools = TOOL_DEFINITIONS.filter(isStrict);

  it("at most 20 strict tools across the request", () => {
    expect(
      strictTools.length,
      `strict tools: ${strictTools.map((t) => t.name).join(", ")}`
    ).toBeLessThanOrEqual(20);
  });

  it("at most 24 optional parameters across all strict schemas", () => {
    const total = strictTools.reduce(
      (sum, tool) => sum + countOptionalParams(tool.input_schema),
      0
    );
    expect(
      total,
      "combined optional parameters across strict schemas (Anthropic cap: 24)"
    ).toBeLessThanOrEqual(24);
  });

  it("at most 16 union-typed parameters across all strict schemas", () => {
    const total = strictTools.reduce(
      (sum, tool) => sum + countUnionParams(tool.input_schema),
      0
    );
    expect(
      total,
      "combined union-typed parameters across strict schemas (Anthropic cap: 16)"
    ).toBeLessThanOrEqual(16);
  });
});
