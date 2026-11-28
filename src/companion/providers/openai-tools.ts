import { isDeepStrictEqual } from "node:util";
import type OpenAI from "openai";

import type {
  ProviderToolDefinition,
  ToolDefinition,
} from "../../shared/provider.js";
import { isToolName, TOOL_BY_NAME, type ToolName } from "../../shared/tools.js";

export const OPENAI_TOOL_NAMESPACE = "live" as const;
const canonicalRegistry = structuredClone(TOOL_BY_NAME);

export class OpenAiToolsFault extends Error {
  constructor(
    readonly code:
      | "foreign_definition"
      | "unknown_tool"
      | "duplicate_tool"
      | "invalid_definition"
  ) {
    super(code);
    this.name = "OpenAiToolsFault";
  }
}

export interface OpenAiToolSet {
  /** The unchanged logical definitions, including their original metadata. */
  readonly definitions: ToolDefinition[];
  /** The documented Responses wire envelope; never carries legacy metadata. */
  readonly wireTools: OpenAI.Responses.NamespaceTool[];
  /** Only an exact offered namespace/name may reach the local dispatcher. */
  resolveLocalToolName(namespace: unknown, name: unknown): ToolName | undefined;
}

/** Map the canonical registered tools without changing their schema or applying
 * another provider's strict-schema rules. Each returned array is a detached copy.
 * Empty/subset offers are valid but cannot resolve a name that was not offered. */
export function buildOpenAiTools(
  definitions: readonly ProviderToolDefinition[]
): OpenAiToolSet {
  const offered = new Set<ToolName>();
  const canonical: ToolDefinition[] = [];
  const functions: OpenAI.Responses.NamespaceTool.Function[] = [];
  for (const definition of definitions) {
    if (
      !definition ||
      typeof definition !== "object" ||
      ("type" in definition && definition.type === "opaque") ||
      !("input_schema" in definition)
    )
      throw new OpenAiToolsFault("foreign_definition");
    const name = definition.name;
    if (typeof name !== "string" || !isToolName(name))
      throw new OpenAiToolsFault("unknown_tool");
    if (offered.has(name)) throw new OpenAiToolsFault("duplicate_tool");
    if (!isDeepStrictEqual(definition, canonicalRegistry[name]))
      throw new OpenAiToolsFault("invalid_definition");
    offered.add(name);
    canonical.push(structuredClone(definition));
    functions.push({
      type: "function",
      name,
      description: definition.description,
      parameters: structuredClone(definition.input_schema),
      strict: false,
    });
  }
  return Object.freeze({
    get definitions() {
      return structuredClone(canonical);
    },
    get wireTools(): OpenAI.Responses.NamespaceTool[] {
      return functions.length === 0
        ? []
        : [
            {
              type: "namespace",
              name: OPENAI_TOOL_NAMESPACE,
              description:
                "Local Ableton Live tools, executed only by the extension.",
              tools: structuredClone(functions),
            },
          ];
    },
    resolveLocalToolName(namespace: unknown, name: unknown) {
      return namespace === OPENAI_TOOL_NAMESPACE &&
        typeof name === "string" &&
        isToolName(name) &&
        offered.has(name)
        ? name
        : undefined;
    },
  });
}
