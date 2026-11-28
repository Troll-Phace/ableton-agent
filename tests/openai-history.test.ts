import type OpenAI from "openai";
import { describe, expect, it } from "vitest";

import type {
  CompletedTurnBlock,
  ToolResultPayload,
} from "../src/shared/provider.js";
import {
  OpenAiHistory,
  OpenAiHistoryFault,
  type OpenAiHistoryBinding,
  type OpenAiHistoryFaultCode,
  type OpenAiHistoryOutputItem,
} from "../src/companion/providers/openai-history.js";

const ACCOUNT = "synthetic-private-account-binding";
const CONVERSATION = "synthetic-private-conversation-id";
const MODEL = "synthetic-catalog-model";
const REASONING_ID = "synthetic-private-reasoning-id";
const REASONING_TEXT = "synthetic-private-reasoning-summary";
const ENCRYPTED_REASONING = "synthetic-private-encrypted-context";
const CALL_ITEM_ID = "synthetic-private-function-item-id";
const CALL_A = "synthetic-call-a";
const CALL_B = "synthetic-call-b";
const USER_TEXT = "synthetic user text";
const SNAPSHOT = '{"synthetic":"project snapshot"}';
const FINAL_TEXT = "Synthetic answer.";

const binding = (
  overrides: Partial<OpenAiHistoryBinding> = {}
): OpenAiHistoryBinding => ({
  provider: "openai_responses",
  accountBinding: ACCOUNT,
  conversationId: CONVERSATION,
  model: MODEL,
  ...overrides,
});

const reasoning = () =>
  ({
    type: "reasoning" as const,
    id: REASONING_ID,
    summary: [{ type: "summary_text" as const, text: REASONING_TEXT }],
    encrypted_content: ENCRYPTED_REASONING,
    status: "completed" as const,
  }) satisfies OpenAI.Responses.ResponseInputItem;

const assistant = (
  text = "Synthetic first response.",
  id = "synthetic-message-id"
) =>
  ({
    type: "message" as const,
    id,
    role: "assistant" as const,
    status: "completed" as const,
    content: [{ type: "output_text" as const, text, annotations: [] }],
    phase: "commentary" as const,
  }) satisfies OpenAI.Responses.ResponseInputItem;

const callA = () =>
  ({
    type: "function_call" as const,
    id: CALL_ITEM_ID,
    call_id: CALL_A,
    namespace: "live",
    name: "live_get_project",
    arguments: "{ }",
    status: "completed" as const,
  }) satisfies OpenAI.Responses.ResponseInputItem;

const callB = () =>
  ({
    type: "function_call" as const,
    id: "synthetic-private-second-function-item-id",
    call_id: CALL_B,
    namespace: "live",
    name: "live_update_track",
    arguments: '{"track":"track:0:Synthetic","mute":true}',
    status: "completed" as const,
  }) satisfies OpenAI.Responses.ResponseInputItem;

const output = () => [reasoning(), callA(), assistant(), callB()];
const blocks = (): CompletedTurnBlock[] => [
  {
    type: "tool_call",
    call: { id: CALL_A, name: "live_get_project", input: {} },
  },
  { type: "text", text: "Synthetic first response." },
  {
    type: "tool_call",
    call: {
      id: CALL_B,
      name: "live_update_track",
      input: { track: "track:0:Synthetic", mute: true },
    },
  },
];
const results = (): ToolResultPayload<string>[] => [
  {
    toolUseId: CALL_A,
    content: ' {"synthetic": "exact JSON-looking string"} \n',
    summary: "synthetic-local-narration",
  },
  {
    toolUseId: CALL_B,
    content: '{"error":"user_declined","detail":"synthetic failure"}',
    isError: true,
    summary: "synthetic-local-error-narration",
  },
];

function noPrivatePublic(value: unknown) {
  const encoded = JSON.stringify(value);
  for (const privateValue of [
    ACCOUNT,
    CONVERSATION,
    MODEL,
    REASONING_ID,
    REASONING_TEXT,
    ENCRYPTED_REASONING,
    CALL_ITEM_ID,
    "synthetic-local-narration",
    "synthetic-local-error-narration",
  ])
    expect(encoded).not.toContain(privateValue);
}

const user = (content: string) => ({
  type: "message" as const,
  role: "user" as const,
  content,
});

function fault(action: () => unknown, code: OpenAiHistoryFaultCode) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(OpenAiHistoryFault);
    expect(error).toMatchObject({ code, message: code });
    noPrivatePublic(String(error));
    return;
  }
  throw new Error(`Expected history fault ${code}`);
}

function started(history = new OpenAiHistory(binding())) {
  history.appendUserText(USER_TEXT);
  return { history, request: history.beginRequest(binding(), SNAPSHOT) };
}

function pending(history = new OpenAiHistory(binding())) {
  const startedState = started(history);
  const turn = history.completeRequest(
    startedState.request,
    output(),
    blocks()
  );
  return { ...startedState, turn };
}

function awaiting(history = new OpenAiHistory(binding())) {
  const state = pending(history);
  history.appendAssistant(state.turn);
  return state;
}

describe("15.4B1 bound Responses history", () => {
  it("binds provider/account/conversation/model immutably and exposes only sanitized status", () => {
    const selected = binding();
    const history = new OpenAiHistory(selected);
    selected.accountBinding = "other-selected-account";
    selected.conversationId = "other-selected-conversation";
    selected.model = "other-selected-model";
    expect(() => history.assertBinding(binding())).not.toThrow();
    history.appendUserText(USER_TEXT);
    const before = history.status();
    const foreign = [
      binding({ accountBinding: selected.accountBinding }),
      binding({ conversationId: selected.conversationId }),
      binding({ model: selected.model }),
      {
        ...binding(),
        provider: "legacy_claude",
      } as unknown as OpenAiHistoryBinding,
    ];
    for (const wrong of foreign) {
      fault(() => history.beginRequest(wrong, SNAPSHOT), "binding_mismatch");
      expect(history.status()).toEqual(before);
    }
    expect(history.beginRequest(binding(), SNAPSHOT).input).toEqual([
      user(USER_TEXT),
      user(SNAPSHOT),
    ]);
    noPrivatePublic(history.status());
    expect(JSON.stringify(history)).toBe("{}");
  });

  it.each([
    "synthetic@example.invalid",
    "synthetic token with spaces",
    "",
    "x".repeat(129),
  ])("rejects non-opaque account handles (%j)", (accountBinding) => {
    fault(
      () => new OpenAiHistory(binding({ accountBinding })),
      "invalid_binding"
    );
  });

  it("stages snapshot and completed output until the issued assistant continuation is appended", () => {
    const { history, request } = started();
    expect(history.status()).toMatchObject({
      state: "request_in_flight",
      items: 1,
      expectedResults: 0,
      requestReady: false,
    });
    const raw = output();
    const projection = blocks();
    const turn = history.completeRequest(request, raw, projection);
    expect(turn).toEqual({
      stopReason: "tool_use",
      blocks: projection,
      continuation: { type: "opaque", provider: "openai_responses", value: {} },
    });
    expect(history.status()).toMatchObject({
      state: "completed_pending_append",
      items: 1,
      expectedResults: 0,
      requestReady: false,
    });
    noPrivatePublic(turn);
    noPrivatePublic(history.status());

    raw[0].id = "caller-mutated-id";
    projection.splice(0);
    expect(turn.blocks).toEqual(blocks());
    history.appendAssistant(turn);
    fault(() => request.input, "invalid_request");
    expect(history.status()).toMatchObject({
      state: "awaiting_results",
      items: 6,
      expectedResults: 2,
      requestReady: false,
    });
    history.appendToolResults(results());
    const following = history.beginRequest(binding());
    expect(following.input).toEqual([
      user(USER_TEXT),
      user(SNAPSHOT),
      ...output(),
      {
        type: "function_call_output",
        call_id: CALL_A,
        output: results()[0].content,
      },
      {
        type: "function_call_output",
        call_id: CALL_B,
        output: JSON.stringify({
          is_error: true,
          content: results()[1].content,
        }),
      },
    ]);
    expect(JSON.stringify(following.input)).not.toContain("synthetic-local-");
    expect(Object.isFrozen(following.input)).toBe(true);
    expect(Object.isFrozen(following.input[2])).toBe(true);
    expect(() => following.input.push(user("injected"))).toThrow(TypeError);
    expect(JSON.stringify(following)).toBe("{}");
    const precedingInput = following.input;
    const final = history.completeRequest(
      following,
      [assistant(FINAL_TEXT, "final-message")],
      [{ type: "text", text: FINAL_TEXT }]
    );
    expect(final.stopReason).toBe("end_turn");
    history.appendAssistant(final);
    fault(() => following.input, "invalid_request");
    expect(history.status()).toMatchObject({
      state: "ready",
      items: 9,
      expectedResults: 0,
      requestReady: false,
    });
    history.appendUserText("Second synthetic question");
    const next = history.beginRequest(binding(), "Fresh snapshot");
    expect(next.input).toEqual([
      ...precedingInput,
      assistant(FINAL_TEXT, "final-message"),
      user("Second synthetic question"),
      user("Fresh snapshot"),
    ]);
  });

  it("requires the exact instance-issued turn, rejects copies, forged tokens, cross-instance turns and replay", () => {
    const { history, turn } = pending();
    const other = pending();
    const before = history.status();
    const forged = [
      structuredClone(turn),
      { ...turn },
      other.turn,
      { ...turn, blocks: [] },
      {
        ...turn,
        continuation: { ...turn.continuation, provider: "legacy_claude" },
      },
    ];
    for (const candidate of forged) {
      fault(() => history.appendAssistant(candidate), "invalid_continuation");
      expect(history.status()).toEqual(before);
    }
    expect(Object.isFrozen(turn.blocks)).toBe(true);
    expect(Object.isFrozen(turn.continuation)).toBe(true);
    expect(() => turn.blocks.splice(0)).toThrow(TypeError);
    history.appendAssistant(turn);
    fault(() => history.appendAssistant(turn), "invalid_continuation");
    other.history.appendAssistant(other.turn);
  });

  it("requires a current request handle; clones, stale and other-instance handles cannot complete or cancel it", () => {
    const { history, request } = started();
    const other = started();
    for (const forged of [structuredClone(request), other.request]) {
      expect(history.failRequest(forged)).toBe(false);
      fault(
        () => history.completeRequest(forged, output(), blocks()),
        "invalid_request"
      );
    }
    const turn = history.completeRequest(request, output(), blocks());
    fault(
      () => history.completeRequest(request, output(), blocks()),
      "invalid_state"
    );
    history.appendAssistant(turn);
    expect(history.failRequest(request)).toBe(false);
    fault(
      () => history.completeRequest(request, output(), blocks()),
      "invalid_request"
    );
  });

  it("validates every ordered result before any append; exact strings/errors survive and narration stays local", () => {
    const { history } = awaiting();
    const before = history.status();
    const [first, second] = results();
    const invalid: ToolResultPayload[][] = [
      [],
      [first],
      [first, second, first],
      [second, first],
      [first, first],
      [first, { ...second, toolUseId: "unrelated-call" }],
      [
        first,
        {
          ...second,
          content: {
            type: "opaque",
            provider: "legacy_claude",
            value: "synthetic foreign",
          },
        },
      ],
      [
        first,
        {
          ...second,
          content: {
            type: "opaque",
            provider: "openai_responses",
            value: "synthetic forged",
          },
        },
      ],
      [first, { ...second, isError: "true" as unknown as boolean }],
    ];
    for (const batch of invalid) {
      fault(() => history.appendToolResults(batch), "invalid_results");
      expect(history.status()).toEqual(before);
    }
    history.appendToolResults(results());
    expect(history.status()).toMatchObject({
      state: "ready",
      items: 8,
      expectedResults: 0,
      requestReady: true,
    });
    fault(() => history.appendToolResults(results()), "invalid_results");
    fault(() => history.beginRequest(binding(), SNAPSHOT), "invalid_snapshot");
    const input = history.beginRequest(binding()).input;
    expect(input.slice(-2)).toEqual([
      { type: "function_call_output", call_id: CALL_A, output: first.content },
      {
        type: "function_call_output",
        call_id: CALL_B,
        output: JSON.stringify({ is_error: true, content: second.content }),
      },
    ]);
    expect(
      input.filter((item) => item.type === "message" && item.role === "user")
    ).toEqual([user(USER_TEXT), user(SNAPSHOT)]);
  });

  it("blocks new user messages and requests during unresolved state transitions", () => {
    const history = new OpenAiHistory(binding());
    fault(() => history.beginRequest(binding()), "invalid_state");
    const { request } = started(history);
    const assertBlocked = () => {
      fault(() => history.beginRequest(binding()), "invalid_state");
      fault(
        () => history.appendUserText("unrelated new input"),
        "invalid_state"
      );
    };
    assertBlocked();
    fault(() => history.appendToolResults(results()), "invalid_results");
    const turn = history.completeRequest(request, output(), blocks());
    assertBlocked();
    fault(() => history.appendToolResults(results()), "invalid_results");
    history.appendAssistant(turn);
    assertBlocked();
    history.appendToolResults(results());
    fault(() => history.appendUserText("unrelated new input"), "invalid_state");
    expect(history.beginRequest(binding()).input).toHaveLength(8);
  });

  it.each(["in-flight", "completed pending append"])(
    "failure/cancel during %s drops staged output and snapshot and cannot auto-replay",
    (stage) => {
      const { history, request } = started();
      const turn =
        stage === "completed pending append"
          ? history.completeRequest(request, output(), blocks())
          : undefined;
      expect(history.failRequest(request)).toBe(true);
      fault(() => request.input, "invalid_request");
      expect(history.failRequest(request)).toBe(false);
      expect(history.status()).toMatchObject({
        state: "ready",
        items: 1,
        expectedResults: 0,
        requestReady: false,
      });
      fault(() => history.beginRequest(binding()), "invalid_state");
      fault(
        () => history.completeRequest(request, output(), blocks()),
        "invalid_request"
      );
      if (turn)
        fault(() => history.appendAssistant(turn), "invalid_continuation");
      history.appendUserText("Explicit different request");
      const next = history.beginRequest(binding());
      expect(next.input).toEqual([
        user(USER_TEXT),
        user("Explicit different request"),
      ]);
      expect(history.failRequest(request)).toBe(false);
    }
  );

  it.each(["in-flight", "completed pending append", "awaiting results"])(
    "disposal in %s drops private state and disallows late revival",
    (stage) => {
      const { history, request } = started();
      const turn =
        stage !== "in-flight"
          ? history.completeRequest(request, output(), blocks())
          : undefined;
      if (stage === "awaiting results") history.appendAssistant(turn!);
      history.dispose();
      history.dispose();
      fault(() => request.input, "invalid_request");
      expect(history.status()).toEqual({
        state: "disposed",
        items: 0,
        bytes: 2,
        expectedResults: 0,
        requestReady: false,
      });
      expect(history.failRequest(request)).toBe(false);
      fault(() => history.assertBinding(binding()), "invalid_state");
      fault(() => history.beginRequest(binding()), "invalid_state");
      fault(() => history.appendUserText("late user input"), "invalid_state");
      fault(
        () => history.completeRequest(request, output(), blocks()),
        "invalid_request"
      );
      if (turn)
        fault(() => history.appendAssistant(turn), "invalid_continuation");
      fault(() => history.appendToolResults(results()), "invalid_results");
      noPrivatePublic(history.status());
    }
  );

  it.each([
    ["mismatched projection", output(), blocks().slice(0, 1)],
    [
      "duplicate call",
      [...output(), { ...callA(), id: "distinct-id" }],
      [...blocks(), blocks()[0]],
    ],
    ["duplicate item", [...output(), reasoning()], blocks()],
    ["foreign namespace", [{ ...callA(), namespace: "other" }], [blocks()[0]]],
    ["incomplete call", [{ ...callA(), status: "in_progress" }], [blocks()[0]]],
    [
      "non-object call arguments",
      [{ ...callA(), arguments: "[]" }],
      [blocks()[0]],
    ],
    ["empty provider output", [], []],
  ] as [string, OpenAiHistoryOutputItem[], CompletedTurnBlock[]][])(
    "rejects %s without retaining partial output",
    (_label, raw, projected) => {
      const { history, request } = started();
      fault(
        () => history.completeRequest(request, raw, projected),
        "invalid_output"
      );
      expect(history.status()).toMatchObject({
        state: "ready",
        items: 1,
        requestReady: false,
        expectedResults: 0,
      });
      fault(() => history.beginRequest(binding()), "invalid_state");
      history.appendUserText("Next explicit request");
      expect(history.beginRequest(binding()).input).toEqual([
        user(USER_TEXT),
        user("Next explicit request"),
      ]);
    }
  );

  it("bounds new snapshots without consuming a valid user request", () => {
    const history = new OpenAiHistory(binding(), { maxSnapshotChars: 5 });
    history.appendUserText(USER_TEXT);
    const before = history.status();
    fault(() => history.beginRequest(binding(), "123456"), "invalid_snapshot");
    expect(history.status()).toEqual(before);
    expect(history.beginRequest(binding(), "12345").input).toEqual([
      user(USER_TEXT),
      user("12345"),
    ]);
  });

  it("a failed tool continuation retains the already committed result batch but cannot replay or reuse a prior call ID", () => {
    const { history } = awaiting();
    history.appendToolResults(results());
    const followup = history.beginRequest(binding());
    const committed = followup.input;
    const before = history.status();
    fault(
      () =>
        history.completeRequest(
          followup,
          [{ ...callA(), id: "different-new-item-id" }],
          [blocks()[0]]
        ),
      "invalid_output"
    );
    fault(() => followup.input, "invalid_request");
    expect(history.status()).toEqual({
      ...before,
      state: "ready",
      requestReady: false,
    });
    fault(() => history.beginRequest(binding()), "invalid_state");
    history.appendUserText("Explicit new user request");
    expect(history.beginRequest(binding()).input).toEqual([
      ...committed,
      user("Explicit new user request"),
    ]);
  });

  it("bounds raw required reasoning by bytes, never strips it to fit", () => {
    const { history, request } = started(
      new OpenAiHistory(binding(), { maxBytes: 600 })
    );
    const oversizedReasoning = {
      ...reasoning(),
      encrypted_content: "é".repeat(400),
    };
    fault(
      () =>
        history.completeRequest(
          request,
          [oversizedReasoning, assistant()],
          [{ type: "text", text: "Synthetic first response." }]
        ),
      "history_limit"
    );
    expect(history.status()).toMatchObject({
      state: "ready",
      items: 1,
      requestReady: false,
    });
    fault(() => history.beginRequest(binding()), "invalid_state");
  });

  it("bounds complete history items and rejects an oversized result batch atomically", () => {
    const { history } = awaiting(new OpenAiHistory(binding(), { maxItems: 7 }));
    const before = history.status();
    fault(() => history.appendToolResults(results()), "history_limit");
    expect(history.status()).toEqual(before);
    expect(history.status().expectedResults).toBe(2);
    fault(() => history.beginRequest(binding()), "invalid_state");
  });
});
