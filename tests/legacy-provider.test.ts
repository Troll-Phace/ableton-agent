import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ClaudeClient,
  type MessageStreamLike,
  type MessagesClient,
} from "../src/extension/claude-client.js";
import {
  LegacyClaudeProvider,
  LEGACY_PROVIDER,
  projectLegacyTurn,
} from "../src/extension/providers/legacy-claude.js";
import { runAgentLoop, type AgentEvents } from "../src/extension/agent-loop.js";
import type {
  OpaqueProviderValue,
  ToolResultPayload,
} from "../src/shared/provider.js";
import { TOOL_DEFINITIONS } from "../src/shared/tools.js";
import {
  FakeMessagesClient,
  buildMessage,
  errorTurn,
  abortTurn,
  textTurn,
} from "./fixtures/fake-anthropic-client.js";
import { FakeToolRuntime } from "./fixtures/fake-tool-runtime.js";

const USER = {
  role: "user",
  content: "synthetic user turn",
} satisfies Anthropic.MessageParam;
const THINKING = {
  type: "thinking",
  thinking: "synthetic private continuation",
  signature: "synthetic-signature",
} satisfies Anthropic.ThinkingBlock;
const REDACTED = {
  type: "redacted_thinking",
  data: "synthetic-opaque-redacted",
} satisfies Anthropic.RedactedThinkingBlock;
const TEXT = {
  type: "text",
  text: "Read then change.",
  citations: [
    {
      type: "char_location",
      cited_text: "synthetic-citation",
      document_index: 0,
      document_title: "Synthetic document",
      file_id: null,
      start_char_index: 0,
      end_char_index: 18,
    },
  ],
} satisfies Anthropic.TextBlock;
const READ = {
  type: "tool_use",
  id: "synthetic-read-id",
  name: "live_get_project",
  input: {},
  caller: { type: "direct" },
} satisfies Anthropic.ToolUseBlock;
const WRITE = {
  type: "tool_use",
  id: "synthetic-write-id",
  name: "live_update_track",
  input: { track: "track:0:Synthetic", name: "Renamed" },
  caller: { type: "direct" },
} satisfies Anthropic.ToolUseBlock;
const FINAL = {
  type: "text",
  text: "Synthetic done.",
  citations: null,
} satisfies Anthropic.TextBlock;

/** Exhaustive legacy output block inventory from the installed Anthropic
 * SDK type union. These are inert synthetic data; no server or local tools
 * corresponding to these opaque blocks are ever requested or dispatched. */
const OTHER_BLOCKS = [
  {
    type: "server_tool_use",
    id: "synthetic-server",
    name: "web_search",
    input: { query: "synthetic" },
    caller: { type: "direct" },
  },
  {
    type: "web_search_tool_result",
    tool_use_id: "synthetic-server",
    caller: { type: "direct" },
    content: [
      {
        type: "web_search_result",
        encrypted_content: "opaque-search",
        page_age: null,
        title: "Synthetic",
        url: "https://example.invalid/test",
      },
    ],
  },
  {
    type: "web_fetch_tool_result",
    tool_use_id: "synthetic-fetch",
    caller: { type: "direct" },
    content: { type: "web_fetch_tool_result_error", error_code: "unavailable" },
  },
  {
    type: "code_execution_tool_result",
    tool_use_id: "synthetic-code",
    content: {
      type: "code_execution_tool_result_error",
      error_code: "unavailable",
    },
  },
  {
    type: "bash_code_execution_tool_result",
    tool_use_id: "synthetic-bash",
    content: {
      type: "bash_code_execution_tool_result_error",
      error_code: "unavailable",
    },
  },
  {
    type: "text_editor_code_execution_tool_result",
    tool_use_id: "synthetic-editor",
    content: {
      type: "text_editor_code_execution_tool_result_error",
      error_code: "unavailable",
      error_message: "synthetic failure",
    },
  },
  {
    type: "tool_search_tool_result",
    tool_use_id: "synthetic-search",
    content: {
      type: "tool_search_tool_result_error",
      error_code: "unavailable",
      error_message: null,
    },
  },
  { type: "container_upload", file_id: "synthetic-file-id" },
] satisfies Anthropic.ContentBlock[];

const STRUCTURED_RESULT = [
  {
    type: "text",
    text: "structured text",
    cache_control: { type: "ephemeral" },
  },
  {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "AA==" },
  },
  {
    type: "search_result",
    content: [{ type: "text", text: "synthetic search snippet" }],
    source: "synthetic source",
    title: "Synthetic result",
    citations: { enabled: true },
  },
  {
    type: "document",
    source: {
      type: "text",
      media_type: "text/plain",
      data: "synthetic document",
    },
    title: "Synthetic document",
    citations: { enabled: true },
  },
  {
    type: "tool_reference",
    tool_name: "synthetic_reference",
    cache_control: { type: "ephemeral" },
  },
] satisfies NonNullable<Anthropic.ToolResultBlockParam["content"]>;

function message(
  content: Anthropic.ContentBlock[],
  stop: Anthropic.Message["stop_reason"] = "tool_use"
): Anthropic.Message {
  return { ...buildMessage({}), stop_reason: stop, content };
}

/** Test-only stream double: directly control exact assembled provider blocks,
 * and record wire params. The real production ClaudeClient/legacy facade runs
 * above this boundary. No SDK client or network access. */
function streams(
  ...scripted: { result: Anthropic.Message; deltas?: string[] }[]
) {
  const captured: Anthropic.MessageStreamParams[] = [];
  const client: MessagesClient = {
    stream(params) {
      const item = scripted[captured.length];
      captured.push(structuredClone(params));
      if (!item) throw new Error("Unexpected synthetic stream");
      let text: ((value: string) => void) | undefined;
      class Stream implements MessageStreamLike {
        on(event: "text", listener: (value: string) => void): unknown;
        on(event: "error", listener: (error: unknown) => void): unknown;
        on(event: "text" | "error", listener: (value: never) => void): unknown {
          if (event === "text") text = listener as (value: string) => void;
          return this;
        }
        finalMessage(): Promise<Anthropic.Message> {
          for (const delta of item.deltas ?? []) text?.(delta);
          return Promise.resolve(item.result);
        }
        abort(): void {}
      }
      return new Stream();
    },
  };
  return { client, captured };
}

function events() {
  return {
    assistantDelta: vi.fn<AgentEvents["assistantDelta"]>(),
    toolActivity: vi.fn<AgentEvents["toolActivity"]>(),
    assistantDone: vi.fn<AgentEvents["assistantDone"]>(),
    error: vi.fn<AgentEvents["error"]>(),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("legacy Claude provider facade — lossless canonical projection and opaque continuation", () => {
  it("projects only ordered executable client calls/text and preserves every otherwise opaque legacy output block", () => {
    const content = [
      THINKING,
      TEXT,
      OTHER_BLOCKS[0],
      READ,
      ...OTHER_BLOCKS.slice(1),
      REDACTED,
      WRITE,
      FINAL,
    ];
    const turn = projectLegacyTurn(message(content));
    expect(turn).toEqual({
      stopReason: "tool_use",
      blocks: [
        { type: "text", text: TEXT.text },
        {
          type: "tool_call",
          call: { id: READ.id, name: READ.name, input: READ.input },
        },
        {
          type: "tool_call",
          call: { id: WRITE.id, name: WRITE.name, input: WRITE.input },
        },
        { type: "text", text: FINAL.text },
      ],
      continuation: {
        type: "opaque",
        provider: LEGACY_PROVIDER,
        value: content,
      },
    });
    expect(turn.continuation.value).toBe(content);
  });

  it.each([
    "end_turn",
    "max_tokens",
    "stop_sequence",
    "pause_turn",
    "refusal",
    "tool_use",
    null,
  ] as const)(
    "preserves stop reason %s including legacy null-to-end_turn behavior",
    (stop) => {
      expect(projectLegacyTurn(message([FINAL], stop)).stopReason).toBe(
        stop ?? "end_turn"
      );
    }
  );

  it("keeps exact legacy request defaults, cache stamps, custom and opaque definitions, model overrides and uncached snapshot", async () => {
    const fake = new FakeMessagesClient([
      textTurn("synthetic answer", { deltas: ["synthetic ", "answer"] }),
    ]);
    const system: Anthropic.TextBlockParam[] = [
      { type: "text", text: "first system" },
      { type: "text", text: "second system" },
    ];
    const history: Anthropic.MessageParam[] = [USER];
    const server = {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 1,
    } satisfies Anthropic.ToolUnion;
    const defs: Anthropic.ToolUnion[] = [...TOOL_DEFINITIONS, server];
    const runtime = new FakeToolRuntime({ toolDefs: defs });
    const provider = new LegacyClaudeProvider({
      client: new ClaudeClient(fake),
      system,
      messages: history,
    });
    const bound = provider.bindRuntime(runtime);
    const tools = bound.toolDefinitions();
    expect(tools.slice(0, 17)).toEqual(TOOL_DEFINITIONS);
    expect(tools[17]).toEqual({
      type: "opaque",
      provider: LEGACY_PROVIDER,
      value: server,
    });
    const delta = vi.fn();
    const result = await provider.runTurn({
      tools,
      model: "claude-sonnet-4-6",
      maxTokens: 777,
      snapshot: '{"synthetic":"snapshot"}',
      onDelta: delta,
    });
    expect(result.ok).toBe(true);
    expect(fake.capturedParams).toEqual([
      {
        model: "claude-sonnet-4-6",
        max_tokens: 777,
        system: [
          system[0],
          { ...system[1], cache_control: { type: "ephemeral" } },
        ],
        tools: [
          ...TOOL_DEFINITIONS,
          { ...server, cache_control: { type: "ephemeral" } },
        ],
        messages: [
          USER,
          {
            role: "user",
            content: [{ type: "text", text: '{"synthetic":"snapshot"}' }],
          },
        ],
      },
    ]);
    expect(delta.mock.calls).toEqual([["synthetic "], ["answer"]]);
    expect(history).toEqual([USER]);
    expect(system).toEqual([
      { type: "text", text: "first system" },
      { type: "text", text: "second system" },
    ]);
    expect(runtime.toolDefinitions()).toEqual(defs);
  });

  it("round-trips all structured legacy result types, error flags and narration through provider-owned identity instead of stringifying", async () => {
    const history: Anthropic.MessageParam[] = [USER];
    const provider = new LegacyClaudeProvider({
      client: new ClaudeClient(new FakeMessagesClient([textTurn("done")])),
      system: [],
      messages: history,
    });
    const runtime = new FakeToolRuntime({
      readResults: {
        [READ.id]: {
          content: STRUCTURED_RESULT,
          isError: true,
          summary: "Synthetic rich error",
        },
      },
      mutationResults: {
        [WRITE.id]: { content: "synthetic string", summary: "Synthetic write" },
      },
    });
    const bound = provider.bindRuntime(runtime);
    const first = await bound.executeRead({
      id: READ.id,
      name: READ.name,
      input: READ.input,
    });
    const second = await bound.flushMutations([
      { id: WRITE.id, name: WRITE.name, input: WRITE.input },
    ]);
    expect(first).toEqual({
      toolUseId: READ.id,
      content: {
        type: "opaque",
        provider: LEGACY_PROVIDER,
        value: STRUCTURED_RESULT,
      },
      isError: true,
      summary: "Synthetic rich error",
    });
    expect(second).toEqual([
      {
        toolUseId: WRITE.id,
        content: "synthetic string",
        summary: "Synthetic write",
      },
    ]);
    provider.appendToolResults([first, ...second]);
    expect(history).toEqual([
      USER,
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: READ.id,
            content: STRUCTURED_RESULT,
            is_error: true,
          },
          {
            type: "tool_result",
            tool_use_id: WRITE.id,
            content: "synthetic string",
          },
        ],
      },
    ]);
  });

  it("does not decode foreign/copied continuation or result by tag and does not append partially on rejection", async () => {
    const history: Anthropic.MessageParam[] = [USER];
    const f = streams({ result: message([READ]) });
    const provider = new LegacyClaudeProvider({
      client: new ClaudeClient(f.client),
      system: [],
      messages: history,
    });
    const other = new LegacyClaudeProvider({
      client: new ClaudeClient(new FakeMessagesClient([textTurn("other")])),
      system: [],
      messages: [],
    });
    const result = await provider.runTurn({ tools: [] });
    if (!result.ok) throw new Error("Expected synthetic completion");
    expect(() =>
      provider.appendAssistant({
        ...result.turn,
        continuation: { ...result.turn.continuation },
      })
    ).toThrow();
    expect(() => other.appendAssistant(result.turn)).toThrow();
    expect(history).toEqual([USER]);
    provider.appendAssistant(result.turn);
    const bound = provider.bindRuntime(
      new FakeToolRuntime({
        readResults: { [READ.id]: { content: STRUCTURED_RESULT } },
      })
    );
    const projected = await bound.executeRead({
      id: READ.id,
      name: READ.name,
      input: READ.input,
    });
    if (typeof projected.content === "string")
      throw new Error("Expected opaque result");
    const before = structuredClone(history);
    const forged: OpaqueProviderValue = { ...projected.content };
    const forgedResult: ToolResultPayload = { ...projected, content: forged };
    expect(() =>
      provider.appendToolResults([
        { toolUseId: WRITE.id, content: "synthetic" },
        forgedResult,
      ])
    ).toThrow();
    expect(() => other.appendToolResults([projected])).toThrow();
    expect(history).toEqual(before);
    provider.appendToolResults([projected]);
    expect(history).toHaveLength(3);
  });

  it("passes structured legacy stream/API/abort failures unchanged without fabricating assistant history", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const cases = [
      errorTurn(new Error("synthetic stream failure")),
      abortTurn(),
      errorTurn(
        new Anthropic.APIError(
          400,
          { error: { message: "synthetic" } },
          "synthetic rejection",
          new Headers()
        )
      ),
      { throwOnStream: new Error("synthetic opening failure") },
    ];
    try {
      for (const scripted of cases) {
        const direct = await new ClaudeClient(
          new FakeMessagesClient([scripted])
        ).runTurn({ system: [], tools: [], messages: [USER] });
        const history: Anthropic.MessageParam[] = [USER];
        const provider = new LegacyClaudeProvider({
          client: new ClaudeClient(new FakeMessagesClient([scripted])),
          system: [],
          messages: history,
        });
        expect(await provider.runTurn({ tools: [] })).toEqual(direct);
        expect(history).toEqual([USER]);
      }
    } finally {
      log.mockRestore();
    }
  });
});

describe("legacy public agent loop uses canonical boundary without altering transcript, UI or executor order", () => {
  it("legacy stream failure after displayed deltas cannot execute promised tool blocks or fabricate an assistant transcript", async () => {
    const fake = new FakeMessagesClient([
      {
        textDeltas: ["synthetic partial tool intent"],
        toolUses: [
          {
            id: "never-execute",
            name: "live_delete",
            input: { target: "track:0:Synthetic" },
          },
        ],
        stopReason: "tool_use",
        rejectWith: new Error("synthetic incomplete stream"),
      },
    ]);
    const runtime = new FakeToolRuntime({ defaultKind: "mutation" });
    const history: Anthropic.MessageParam[] = [USER];
    const e = events();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await runAgentLoop({
        client: new ClaudeClient(fake),
        runtime,
        events: e,
        system: [],
        messages: history,
      });
      expect(result).toMatchObject({
        ok: false,
        err: { error: "stream_error", detail: "synthetic incomplete stream" },
        messages: [USER],
      });
      expect(history).toEqual([USER]);
      expect(runtime.callLog).toEqual([]);
      expect(e.assistantDelta.mock.calls).toEqual([
        ["synthetic partial tool intent"],
      ]);
      expect(e.assistantDone).not.toHaveBeenCalled();
      expect(e.toolActivity).not.toHaveBeenCalled();
      expect(e.error.mock.calls).toEqual([["synthetic incomplete stream"]]);
      expect(fake.capturedParams).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });

  it("retains complete ordered assistant output, cached request history and matched read/failure/mutation results", async () => {
    const read2 = {
      ...READ,
      id: "synthetic-read-error",
      name: "live_get_track",
      input: { track: "unknown" },
    };
    const firstContent = [
      THINKING,
      TEXT,
      READ,
      WRITE,
      ...OTHER_BLOCKS,
      REDACTED,
      read2,
    ];
    const terminal = [REDACTED, FINAL];
    const f = streams(
      { result: message(firstContent), deltas: ["Read ", "then change."] },
      { result: message(terminal, "end_turn"), deltas: ["Synthetic done."] }
    );
    const current: Anthropic.MessageParam[] = [USER];
    const runtime = new FakeToolRuntime({
      classifier: {
        [READ.name]: "read",
        [WRITE.name]: "mutation",
        [read2.name]: "read",
      },
      readResults: {
        [READ.id]: { content: STRUCTURED_RESULT, summary: "Read rich result" },
        [read2.id]: {
          content:
            '{"error":"ref_unresolved","detail":"synthetic","hint":"refresh"}',
          isError: true,
          summary: "Missing track",
        },
      },
      mutationResults: {
        [WRITE.id]: { content: "synthetic changed", summary: "Track changed" },
      },
    });
    const e = events();
    const result = await runAgentLoop({
      client: new ClaudeClient(f.client),
      runtime,
      events: e,
      system: [],
      messages: current,
      snapshot: "synthetic snapshot",
    });
    const resultBlocks: Anthropic.ToolResultBlockParam[] = [
      { type: "tool_result", tool_use_id: READ.id, content: STRUCTURED_RESULT },
      {
        type: "tool_result",
        tool_use_id: WRITE.id,
        content: "synthetic changed",
      },
      {
        type: "tool_result",
        tool_use_id: read2.id,
        content:
          '{"error":"ref_unresolved","detail":"synthetic","hint":"refresh"}',
        is_error: true,
      },
    ];
    const expected: Anthropic.MessageParam[] = [
      USER,
      { role: "assistant", content: firstContent },
      { role: "user", content: resultBlocks },
      { role: "assistant", content: terminal },
    ];
    expect(result).toEqual({
      ok: true,
      stopReason: "end_turn",
      text: FINAL.text,
      messages: expected,
    });
    expect(current).toEqual(expected);
    expect(f.captured[0]?.messages).toEqual([
      USER,
      { role: "user", content: [{ type: "text", text: "synthetic snapshot" }] },
    ]);
    expect(f.captured[1]?.messages).toEqual(expected.slice(0, 3));
    expect(runtime.callLog).toEqual([
      {
        phase: "read",
        calls: [{ id: READ.id, name: READ.name, input: READ.input }],
      },
      {
        phase: "read",
        calls: [{ id: read2.id, name: read2.name, input: read2.input }],
      },
      {
        phase: "flush",
        calls: [{ id: WRITE.id, name: WRITE.name, input: WRITE.input }],
      },
    ]);
    expect(e.assistantDelta.mock.calls).toEqual([
      ["Read "],
      ["then change."],
      ["Synthetic done."],
    ]);
    expect(
      e.toolActivity.mock.calls.map(([tool, , state]) => [tool, state])
    ).toEqual([
      [READ.name, "started"],
      [READ.name, "ok"],
      [read2.name, "started"],
      [read2.name, "error"],
      [WRITE.name, "started"],
      [WRITE.name, "ok"],
    ]);
    expect(e.toolActivity).toHaveBeenCalledWith(
      READ.name,
      "Read rich result",
      "ok"
    );
    expect(e.toolActivity).toHaveBeenCalledWith(
      read2.name,
      "Missing track",
      "error"
    );
    expect(e.toolActivity).toHaveBeenCalledWith(
      WRITE.name,
      "Track changed",
      "ok"
    );
    expect(e.assistantDone.mock.calls).toEqual([["end_turn"]]);
    expect(e.error).not.toHaveBeenCalled();
  });
});
