import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ClaudeClient,
  MAX_TOKENS,
  MODEL,
  createClaudeClient,
  type RunTurnInput,
} from "../src/extension/claude-client.js";
import {
  FakeMessagesClient,
  abortTurn,
  errorTurn,
  textTurn,
  toolUseTurn,
} from "./fixtures/fake-anthropic-client.js";

/**
 * Phase 4 Claude-client suite — the streamed-turn wrapper in
 * `src/extension/claude-client.ts`, driven against the scripted
 * {@link FakeMessagesClient} (no network). Covers factory key discipline,
 * delta streaming, the §15.1 cache_control placement, and the structured-error
 * contract (abort + SDK/stream errors never throw to the caller).
 */

/** Minimal valid turn input; tests override individual fields. */
function baseInput(over: Partial<RunTurnInput> = {}): RunTurnInput {
  return {
    system: [],
    tools: [],
    messages: [{ role: "user", content: "hi" }],
    ...over,
  };
}

describe("createClaudeClient — key discipline", () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    if (savedKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  it("claudeClient_createClaudeClient_returnsStructuredErrorWhenNoKey", () => {
    const result = createClaudeClient();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err.error).toBe("api_error");
      expect(result.err.detail).not.toContain("sk-");
    }
  });

  it("claudeClient_createClaudeClient_returnsStructuredErrorWhenEmptyKey", () => {
    const result = createClaudeClient("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err.error).toBe("api_error");
    }
  });

  it("claudeClient_createClaudeClient_okWhenKeyPassed", () => {
    const result = createClaudeClient("test-key-not-real");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.client).toBeInstanceOf(ClaudeClient);
    }
  });

  it("claudeClient_createClaudeClient_okFromEnvFallback", () => {
    process.env.ANTHROPIC_API_KEY = "env-key-not-real";
    const result = createClaudeClient();
    expect(result.ok).toBe(true);
  });

  it("claudeClient_createClaudeClient_okWithCustomDefaultModel", () => {
    const result = createClaudeClient("test-key-not-real", "claude-opus-4-1");
    expect(result.ok).toBe(true);
  });
});

describe("ClaudeClient.runTurn — streaming + assembly", () => {
  it("claudeClient_runTurn_streamsDeltasInOrder", async () => {
    const fake = new FakeMessagesClient([
      textTurn("ignored", { deltas: ["Hel", "lo ", "world"] }),
    ]);
    const client = new ClaudeClient(fake);
    const received: string[] = [];

    const result = await client.runTurn(
      baseInput({ onDelta: (d) => received.push(d) })
    );

    expect(received).toEqual(["Hel", "lo ", "world"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.content[0]).toMatchObject({
        type: "text",
        text: "Hello world",
      });
      expect(result.message.stop_reason).toBe("end_turn");
    }
  });

  it("claudeClient_runTurn_assemblesToolUseFinalMessage", async () => {
    const fake = new FakeMessagesClient([
      toolUseTurn([{ id: "tu_1", name: "live_get_project", input: {} }]),
    ]);
    const client = new ClaudeClient(fake);

    const result = await client.runTurn(baseInput());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.stop_reason).toBe("tool_use");
      expect(result.message.content).toContainEqual(
        expect.objectContaining({ type: "tool_use", id: "tu_1" })
      );
    }
  });

  it("claudeClient_runTurn_omitsDeltaSinkWhenAbsent", async () => {
    // No onDelta provided — must not throw and still resolve.
    const fake = new FakeMessagesClient([
      textTurn("hi", { deltas: ["h", "i"] }),
    ]);
    const client = new ClaudeClient(fake);
    const result = await client.runTurn(baseInput());
    expect(result.ok).toBe(true);
  });

  it("claudeClient_runTurn_surfacesUsageWithCacheFields", async () => {
    const fake = new FakeMessagesClient([
      {
        textDeltas: ["ok"],
        stopReason: "end_turn",
        usage: { cache_read_input_tokens: 42, cache_creation_input_tokens: 7 },
      },
    ]);
    const client = new ClaudeClient(fake);
    const result = await client.runTurn(baseInput());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.usage.cache_read_input_tokens).toBe(42);
      expect(result.message.usage.cache_creation_input_tokens).toBe(7);
    }
  });
});

describe("ClaudeClient.runTurn — request building (defaults + overrides)", () => {
  it("claudeClient_runTurn_usesDefaultModelAndMaxTokens", async () => {
    const fake = new FakeMessagesClient([textTurn("ok")]);
    const client = new ClaudeClient(fake);
    await client.runTurn(baseInput());
    const params = fake.capturedParams[0];
    expect(params.model).toBe(MODEL);
    expect(params.max_tokens).toBe(MAX_TOKENS);
  });

  it("claudeClient_runTurn_honorsInputModelAndMaxTokens", async () => {
    const fake = new FakeMessagesClient([textTurn("ok")]);
    const client = new ClaudeClient(fake);
    await client.runTurn(
      baseInput({ model: "claude-opus-4-1", maxTokens: 256 })
    );
    const params = fake.capturedParams[0];
    expect(params.model).toBe("claude-opus-4-1");
    expect(params.max_tokens).toBe(256);
  });

  it("claudeClient_runTurn_usesConstructorDefaultModel", async () => {
    const fake = new FakeMessagesClient([textTurn("ok")]);
    const client = new ClaudeClient(fake, "claude-opus-4-1");
    await client.runTurn(baseInput());
    expect(fake.capturedParams[0].model).toBe("claude-opus-4-1");
  });
});

describe("ClaudeClient.runTurn — cache_control placement (§15.1)", () => {
  it("claudeClient_runTurn_cachesLastSystemBlockOnly", async () => {
    const fake = new FakeMessagesClient([textTurn("ok")]);
    const client = new ClaudeClient(fake);
    await client.runTurn(
      baseInput({
        system: [
          { type: "text", text: "first" },
          { type: "text", text: "last" },
        ],
      })
    );
    const system = fake.capturedParams[0].system;
    expect(Array.isArray(system)).toBe(true);
    if (Array.isArray(system)) {
      expect(system[0].cache_control).toBeUndefined();
      expect(system[1].cache_control).toEqual({ type: "ephemeral" });
    }
  });

  it("claudeClient_runTurn_cachesLastToolOnly", async () => {
    const fake = new FakeMessagesClient([textTurn("ok")]);
    const client = new ClaudeClient(fake);
    const tools: Anthropic.ToolUnion[] = [
      { name: "a", input_schema: { type: "object" } },
      { name: "b", input_schema: { type: "object" } },
    ];
    await client.runTurn(baseInput({ tools }));
    const sentTools = fake.capturedParams[0].tools;
    expect(sentTools).toBeDefined();
    if (sentTools) {
      expect(sentTools[0].cache_control).toBeUndefined();
      expect(sentTools[1].cache_control).toEqual({ type: "ephemeral" });
    }
  });

  it("claudeClient_runTurn_snapshotBlockIsUncached", async () => {
    const fake = new FakeMessagesClient([textTurn("ok")]);
    const client = new ClaudeClient(fake);
    await client.runTurn(
      baseInput({
        messages: [{ role: "user", content: "hi" }],
        snapshot: "PROJECT SNAPSHOT",
      })
    );
    const sent = fake.capturedParams[0].messages;
    // The snapshot is appended as a separate trailing user block.
    const last = sent[sent.length - 1];
    expect(last.role).toBe("user");
    expect(Array.isArray(last.content)).toBe(true);
    if (Array.isArray(last.content)) {
      const block = last.content[0];
      expect(block).toMatchObject({ type: "text", text: "PROJECT SNAPSHOT" });
      expect((block as Anthropic.TextBlockParam).cache_control).toBeUndefined();
    }
  });

  it("claudeClient_runTurn_omitsSnapshotBlockWhenAbsent", async () => {
    const fake = new FakeMessagesClient([textTurn("ok")]);
    const client = new ClaudeClient(fake);
    await client.runTurn(
      baseInput({ messages: [{ role: "user", content: "hi" }] })
    );
    const sent = fake.capturedParams[0].messages;
    expect(sent).toHaveLength(1);
  });

  it("claudeClient_runTurn_emptySystemAndToolsPassThrough", async () => {
    const fake = new FakeMessagesClient([textTurn("ok")]);
    const client = new ClaudeClient(fake);
    await client.runTurn(baseInput({ system: [], tools: [] }));
    const params = fake.capturedParams[0];
    expect(params.system).toEqual([]);
    expect(params.tools).toEqual([]);
  });
});

describe("ClaudeClient.runTurn — AbortSignal", () => {
  it("claudeClient_runTurn_preAbortedShortCircuitsBeforeStreaming", async () => {
    const fake = new FakeMessagesClient([textTurn("ok")]);
    const client = new ClaudeClient(fake);
    const controller = new AbortController();
    controller.abort();

    const result = await client.runTurn(
      baseInput({ signal: controller.signal })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err.error).toBe("aborted");
    }
    // No stream was ever opened.
    expect(fake.streamCallCount).toBe(0);
  });

  it("claudeClient_runTurn_midStreamAbortCallsStreamAbortAndReturnsAborted", async () => {
    // The turn rejects with an APIUserAbortError; we also fire the signal so the
    // wrapper's onAbort handler invokes stream.abort().
    const fake = new FakeMessagesClient([abortTurn()]);
    const client = new ClaudeClient(fake);
    const controller = new AbortController();

    const promise = client.runTurn(baseInput({ signal: controller.signal }));
    controller.abort();
    const result = await promise;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err.error).toBe("aborted");
    }
    expect(fake.streams[0].aborted).toBe(true);
  });

  it("claudeClient_runTurn_apiUserAbortErrorMapsToAbortedWithoutSignal", async () => {
    // finalMessage rejects with an abort error even though no signal aborted.
    const fake = new FakeMessagesClient([abortTurn()]);
    const client = new ClaudeClient(fake);
    const result = await client.runTurn(baseInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err.error).toBe("aborted");
    }
  });
});

describe("ClaudeClient.runTurn — structured error mapping", () => {
  it("claudeClient_runTurn_apiErrorMapsToApiError", async () => {
    const apiError = new Anthropic.APIError(
      500,
      undefined,
      "internal failure",
      undefined
    );
    const fake = new FakeMessagesClient([errorTurn(apiError)]);
    const client = new ClaudeClient(fake);

    const result = await client.runTurn(baseInput());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err.error).toBe("api_error");
      expect(result.err.detail).toContain("500");
    }
  });

  it("claudeClient_runTurn_genericErrorMapsToStreamError", async () => {
    const fake = new FakeMessagesClient([errorTurn(new Error("socket reset"))]);
    const client = new ClaudeClient(fake);

    const result = await client.runTurn(baseInput());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err.error).toBe("stream_error");
      expect(result.err.detail).toContain("socket reset");
    }
  });

  it("claudeClient_runTurn_nonErrorThrowMapsToStreamError", async () => {
    const fake = new FakeMessagesClient([errorTurn("a bare string failure")]);
    const client = new ClaudeClient(fake);
    const result = await client.runTurn(baseInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err.error).toBe("stream_error");
      expect(result.err.detail).toBe("unknown stream error");
    }
  });

  it("claudeClient_runTurn_throwOnStreamOpenMapsToStructuredError", async () => {
    const fake = new FakeMessagesClient([
      { throwOnStream: new Error("could not open stream") },
    ]);
    const client = new ClaudeClient(fake);
    const result = await client.runTurn(baseInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err.error).toBe("stream_error");
    }
  });

  it("claudeClient_runTurn_streamErrorEventStillResolvesStructured", async () => {
    // An emitted `error` event (handled via finalMessage rejection) must not
    // leave an unhandled rejection and must surface a structured error.
    const fake = new FakeMessagesClient([
      { emitErrorEvent: new Error("mid-stream error event") },
    ]);
    const client = new ClaudeClient(fake);
    const result = await client.runTurn(baseInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err.error).toBe("stream_error");
    }
  });
});
