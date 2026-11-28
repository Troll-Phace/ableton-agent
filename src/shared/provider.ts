/** Provider-neutral completed-turn and local tool contracts. No provider SDK,
 * host SDK, persistence, or transport belongs on this boundary. */

export interface ToolDefinition {
  name: string;
  description?: string;
  input_schema: {
    type: "object";
    properties?: unknown;
    required?: string[] | null;
    [key: string]: unknown;
  };
  strict?: boolean;
  input_examples?: Array<Record<string, unknown>>;
}

/** Provider-bound data is carried intact, not interpreted by the local loop.
 * A different provider must not assume it can consume this data. */
export interface OpaqueProviderValue {
  type: "opaque";
  provider: string;
  value: unknown;
}

export type ProviderToolDefinition = ToolDefinition | OpaqueProviderValue;
export interface ToolCall {
  id: string;
  name: string;
  /** Untrusted, fully assembled input; the executor validates it. */
  input: unknown;
}

/** Local executors produce serialized text. Provider-specific structured
 * content may cross the boundary only as an opaque provider-bound value. */
export type ToolResultContent = string | OpaqueProviderValue;
export interface ToolResultPayload<Content = ToolResultContent> {
  toolUseId: string;
  content: Content;
  isError?: boolean;
  summary?: string;
}
/** The existing Live executor's JSON-text result, usable with either provider. */
export type LocalToolResultPayload = ToolResultPayload<string>;

export interface ToolRuntime<
  Definition = ProviderToolDefinition,
  Content = ToolResultContent,
> {
  toolDefinitions(): Definition[];
  classify(toolName: string): "read" | "mutation";
  executeRead(call: ToolCall): Promise<ToolResultPayload<Content>>;
  flushMutations(calls: ToolCall[]): Promise<ToolResultPayload<Content>[]>;
}

/** Streamed deltas are for display only. Only a completed turn can supply calls. */
export type AssistantDeltaSink = (textDelta: string) => void;
export type CompletedTurnBlock =
  | { type: "text"; text: string }
  | { type: "tool_call"; call: ToolCall };

export interface CompletedTurn {
  stopReason: string;
  /** Executable/displayable projection, in provider output order. */
  blocks: CompletedTurnBlock[];
  /** Lossless provider-owned continuation, including unprojected blocks. */
  continuation: OpaqueProviderValue;
}

export interface ProviderError {
  error: "aborted" | "api_error" | "stream_error";
  detail: string;
  hint: string;
}

export type ProviderTurnResult =
  | { ok: true; turn: CompletedTurn }
  | { ok: false; err: ProviderError };

export interface ProviderTurnInput {
  tools: ProviderToolDefinition[];
  snapshot?: string;
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  onDelta?: AssistantDeltaSink;
}

/** A provider with its own bound conversation context/history representation.
 * Only completed turns and matched local results are committed to history. */
export interface TurnProvider {
  runTurn(input: ProviderTurnInput): Promise<ProviderTurnResult>;
  appendAssistant(turn: CompletedTurn): void;
  appendToolResults(results: ToolResultPayload[]): void;
}
