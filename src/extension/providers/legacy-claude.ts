import type Anthropic from "@anthropic-ai/sdk";

import type {
  CompletedTurn,
  CompletedTurnBlock,
  OpaqueProviderValue,
  ProviderToolDefinition,
  ProviderTurnInput,
  ProviderTurnResult,
  ToolResultPayload,
  ToolRuntime,
  TurnProvider,
} from "../../shared/provider.js";
import type { ClaudeClient } from "../claude-client.js";

export const LEGACY_PROVIDER = "legacy_claude";
export type LegacyMessages = Anthropic.MessageParam[];
export type LegacyToolResultContent = NonNullable<
  Anthropic.ToolResultBlockParam["content"]
>;
export type LegacyToolResultPayload =
  ToolResultPayload<LegacyToolResultContent>;
export type LegacyToolRuntime = ToolRuntime<
  Anthropic.ToolUnion,
  LegacyToolResultContent
>;

export interface LegacyRunOptions {
  client: ClaudeClient;
  system: Anthropic.TextBlockParam[];
  messages: LegacyMessages;
}

function opaque(value: unknown): OpaqueProviderValue {
  return { type: "opaque", provider: LEGACY_PROVIDER, value };
}

/** Only text and client tool_use are projected. The original ordered content
 * is retained intact: text citations, thinking, redacted thinking, server
 * tool uses, web search/fetch, code/bash/text-editor execution results,
 * tool search results and container uploads are not local tool calls. */
export function projectLegacyTurn(
  message: Anthropic.Messages.Message
): CompletedTurn {
  const blocks: CompletedTurnBlock[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      blocks.push({
        type: "tool_call",
        call: { id: block.id, name: block.name, input: block.input },
      });
    }
  }
  return {
    stopReason: message.stop_reason ?? "end_turn",
    blocks,
    continuation: opaque(message.content),
  };
}

/** Compatibility facade bound to the existing transcript, not a new history
 * format. The existing client still owns exact request/cache/stream behavior.
 * Opaque values are recognized by identity; no foreign continuation or result
 * can be decoded by guessing its provider tag. */
export class LegacyClaudeProvider implements TurnProvider {
  private readonly assistantBlocks = new WeakMap<
    OpaqueProviderValue,
    Anthropic.ContentBlock[]
  >();
  private readonly opaqueDefinitions = new WeakMap<
    OpaqueProviderValue,
    Anthropic.ToolUnion
  >();
  private readonly opaqueResults = new WeakMap<
    OpaqueProviderValue,
    LegacyToolResultContent
  >();

  constructor(private readonly options: LegacyRunOptions) {}

  /** Preserve the old runtime seam without leaking its SDK types to the loop. */
  bindRuntime(runtime: LegacyToolRuntime): ToolRuntime {
    const projectDefinition = (
      tool: Anthropic.ToolUnion
    ): ProviderToolDefinition => {
      // All 17 registered custom definitions are already structural, retaining
      // their exact keys/values/order. Keep other legacy definitions opaque.
      if ("input_schema" in tool) return tool;
      const value = opaque(tool);
      this.opaqueDefinitions.set(value, tool);
      return value;
    };
    const projectResult = (
      payload: LegacyToolResultPayload
    ): ToolResultPayload => {
      if (typeof payload.content === "string")
        return { ...payload, content: payload.content };
      // Preserve every permitted legacy content block and its metadata:
      // text, image, search_result, document and tool_reference.
      const value = opaque(payload.content);
      this.opaqueResults.set(value, payload.content);
      return { ...payload, content: value };
    };
    return {
      toolDefinitions: () => runtime.toolDefinitions().map(projectDefinition),
      classify: (name) => runtime.classify(name),
      executeRead: async (call) =>
        projectResult(await runtime.executeRead(call)),
      flushMutations: async (calls) =>
        (await runtime.flushMutations(calls)).map(projectResult),
    };
  }

  async runTurn(input: ProviderTurnInput): Promise<ProviderTurnResult> {
    const tools: Anthropic.ToolUnion[] = [];
    for (const tool of input.tools) {
      if ("input_schema" in tool) {
        tools.push(tool);
        continue;
      }
      const definition = this.opaqueDefinitions.get(tool);
      if (!definition || tool.provider !== LEGACY_PROVIDER)
        return {
          ok: false,
          err: {
            error: "stream_error",
            detail: "unrecognized provider-bound tool definition",
            hint: "use tool definitions from the current provider runtime",
          },
        };
      tools.push(definition);
    }
    const result = await this.options.client.runTurn({
      ...input,
      tools,
      system: this.options.system,
      messages: this.options.messages,
    });
    if (!result.ok) return result;
    const turn = projectLegacyTurn(result.message);
    this.assistantBlocks.set(turn.continuation, result.message.content);
    return { ok: true, turn };
  }

  appendAssistant(turn: CompletedTurn): void {
    const content = this.assistantBlocks.get(turn.continuation);
    if (!content || turn.continuation.provider !== LEGACY_PROVIDER)
      throw new Error("Unknown legacy continuation");
    this.options.messages.push({ role: "assistant", content });
  }

  appendToolResults(results: ToolResultPayload[]): void {
    const content = results.map((payload): Anthropic.ToolResultBlockParam => {
      const value =
        typeof payload.content === "string"
          ? payload.content
          : payload.content.provider === LEGACY_PROVIDER
            ? this.opaqueResults.get(payload.content)
            : undefined;
      if (value === undefined) throw new Error("Unknown legacy tool result");
      return {
        type: "tool_result",
        tool_use_id: payload.toolUseId,
        content: value,
        ...(payload.isError ? { is_error: true } : {}),
      };
    });
    this.options.messages.push({ role: "user", content });
  }
}
