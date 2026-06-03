/**
 * FakeToolRuntime — a scriptable stand-in for the {@link ToolRuntime} seam the
 * agent loop consumes (Phase 4, ARCHITECTURE §4, §7, §8). The real runtime
 * (Phase 5/6) wraps the SDK + transaction batching; this fake lets loop tests
 * assert ordering and batching deterministically with no SDK.
 *
 * It records an ordered {@link callLog} of every read execution and every
 * mutation flush so a test can prove:
 *  - reads run immediately and in request order (one `read` entry per call);
 *  - ALL mutations of one assistant iteration arrive in ONE `flushMutations`
 *    call (one `flush` entry carrying the whole batch) — the §7 single-undo
 *    seam.
 *
 * Classification, read results, and flush results are all scriptable, including
 * structured-error (`isError`) payloads.
 */

import type {
  ToolCall,
  ToolResultPayload,
  ToolRuntime,
} from "../../src/extension/agent-loop.js";

// Minimal type-only handle on the SDK tool-union for `toolDefinitions()`.
import type Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Call-log shapes
// ---------------------------------------------------------------------------

/** One recorded interaction with the runtime, in execution order. */
export type RuntimeCall =
  | { phase: "read"; calls: ToolCall[] }
  | { phase: "flush"; calls: ToolCall[] };

/** Options for a {@link FakeToolRuntime}. */
export interface FakeToolRuntimeOptions {
  /**
   * Map of tool name → kind. Tools absent from the map fall back to
   * {@link FakeToolRuntimeOptions.defaultKind} (default `"read"`).
   */
  classifier?: Record<string, "read" | "mutation">;
  /** Kind for any tool not present in `classifier`. */
  defaultKind?: "read" | "mutation";
  /**
   * Scripted result for a read tool, keyed by `tool_use_id` then by tool name.
   * A missing entry yields a generic success payload echoing the tool name.
   */
  readResults?: Record<string, Partial<ToolResultPayload>>;
  /**
   * Scripted result for a mutation, keyed by `tool_use_id`. A missing entry
   * yields a generic success payload.
   */
  mutationResults?: Record<string, Partial<ToolResultPayload>>;
  /** Tool definitions returned by `toolDefinitions()` (default `[]`). */
  toolDefs?: Anthropic.ToolUnion[];
}

// ---------------------------------------------------------------------------
// FakeToolRuntime
// ---------------------------------------------------------------------------

/** A scriptable, call-logging {@link ToolRuntime}. */
export class FakeToolRuntime implements ToolRuntime {
  private readonly classifier: Record<string, "read" | "mutation">;
  private readonly defaultKind: "read" | "mutation";
  private readonly readResults: Record<string, Partial<ToolResultPayload>>;
  private readonly mutationResults: Record<string, Partial<ToolResultPayload>>;
  private readonly toolDefs: Anthropic.ToolUnion[];

  /** Ordered record of every read execution and mutation flush. */
  public readonly callLog: RuntimeCall[] = [];

  constructor(opts: FakeToolRuntimeOptions = {}) {
    this.classifier = opts.classifier ?? {};
    this.defaultKind = opts.defaultKind ?? "read";
    this.readResults = opts.readResults ?? {};
    this.mutationResults = opts.mutationResults ?? {};
    this.toolDefs = opts.toolDefs ?? [];
  }

  /** Number of distinct `flushMutations` calls (each is one undo boundary). */
  get flushCount(): number {
    return this.callLog.filter((c) => c.phase === "flush").length;
  }

  toolDefinitions(): Anthropic.ToolUnion[] {
    return this.toolDefs;
  }

  classify(toolName: string): "read" | "mutation" {
    return this.classifier[toolName] ?? this.defaultKind;
  }

  executeRead(call: ToolCall): Promise<ToolResultPayload> {
    this.callLog.push({ phase: "read", calls: [call] });
    return Promise.resolve(this.payloadFor(call, this.readResults));
  }

  flushMutations(calls: ToolCall[]): Promise<ToolResultPayload[]> {
    // Record the WHOLE batch as a single entry — the assertion seam for §7.
    this.callLog.push({ phase: "flush", calls: [...calls] });
    return Promise.resolve(
      calls.map((call) => this.payloadFor(call, this.mutationResults))
    );
  }

  /** Build a payload for a call, applying any scripted override. */
  private payloadFor(
    call: ToolCall,
    overrides: Record<string, Partial<ToolResultPayload>>
  ): ToolResultPayload {
    const override = overrides[call.id];
    return {
      toolUseId: call.id,
      content: override?.content ?? `ok:${call.name}`,
      ...(override?.isError !== undefined ? { isError: override.isError } : {}),
      ...(override?.summary !== undefined ? { summary: override.summary } : {}),
    };
  }
}
