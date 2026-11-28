import { describe, expect, it } from "vitest";

import {
  COMPANION_CHANNEL_LIMITS as limits,
  ChannelFault,
  channelEnvelope,
  channelFaultCode,
  decodeClientMessage,
  decodeServerMessage,
  sameChannelBinding,
  validateChannelSelection,
} from "../src/shared/companion-channel.js";
import { TOOL_DEFINITIONS } from "../src/shared/tools.js";

const selection = {
  pairSessionId: "pair_fixture",
  epoch: 1,
  conversationId: "conversation_fixture",
  accountRevision: 2,
  model: "fixture-model",
};
const envelope = (body: unknown) => ({
  version: 1,
  pairSessionId: selection.pairSessionId,
  epoch: selection.epoch,
  conversationId: selection.conversationId,
  accountRevision: selection.accountRevision,
  requestId: "request_fixture",
  sequence: 1,
  body,
});
const tools = () => structuredClone([...TOOL_DEFINITIONS]);
const call = (id = "call_fixture") => ({
  type: "tool_call",
  call: { id, name: TOOL_DEFINITIONS[0].name, input: {} },
});
const completion = (blocks: unknown[], stopReason = "tool_use") => ({
  type: "completed",
  continuationId: "continuation_fixture",
  stopReason,
  blocks,
});
const result = (toolUseId = "call_fixture", content = "{}") => ({
  toolUseId,
  content,
});
const expectInvalid = (decoder: (value: unknown) => unknown, value: unknown) =>
  expect(() => decoder(value)).toThrow(ChannelFault);

describe("C1 companion channel bounded protocol", () => {
  it("copies and freezes selection, and compares all bound fields", () => {
    const supplied = { ...selection };
    const checked = validateChannelSelection(supplied);
    supplied.epoch++;
    expect(checked).toEqual(selection);
    expect(Object.isFrozen(checked)).toBe(true);
    expect(sameChannelBinding(checked, supplied)).toBe(false);
    expect(
      sameChannelBinding(checked, { ...selection, accountRevision: 3 })
    ).toBe(false);
    expect(
      sameChannelBinding(checked, { ...selection, conversationId: "other" })
    ).toBe(false);
    expect(
      sameChannelBinding(checked, { ...selection, pairSessionId: "other" })
    ).toBe(false);
    expect(sameChannelBinding(checked, selection)).toBe(true);
    expect(() =>
      validateChannelSelection({ ...selection, extra: true })
    ).toThrow(ChannelFault);
  });

  it.each([
    { type: "open", model: selection.model },
    { type: "append_user_text", text: "fixture" },
    {
      type: "run_turn",
      tools: tools(),
      snapshot: "s".repeat(limits.snapshotChars),
    },
    { type: "commit_assistant", continuationId: "continuation_fixture" },
    {
      type: "append_tool_results",
      results: [
        result(),
        { ...result("second"), isError: true, summary: "declined" },
      ],
    },
    { type: "cancel", targetRequestId: "request_fixture" },
    { type: "status" },
    { type: "close" },
  ])("accepts only the canonical client shape for $type", (body) => {
    const wire = envelope(body);
    const decoded = decodeClientMessage(wire);
    expect(decoded).toEqual(wire);
    expect(decoded.body).not.toBe(body);
    expectInvalid(decodeClientMessage, envelope({ ...body, extra: true }));
  });

  it.each([
    { type: "ack", operation: "open" },
    { type: "delta", text: "synthetic display" },
    completion([{ type: "text", text: "fixture" }, call()]),
    completion([{ type: "text", text: "fixture" }], "end_turn"),
    { type: "failure", code: "provider_failed" },
    { type: "status", state: "ready" },
  ])("accepts only the canonical server shape for $type", (body) => {
    const wire = envelope(body);
    const decoded = decodeServerMessage(wire);
    expect(decoded).toEqual(wire);
    expect(decoded.body).not.toBe(body);
    expectInvalid(decodeServerMessage, envelope({ ...body, extra: true }));
  });

  it("does not copy the model into the envelope binding", () => {
    expect(
      channelEnvelope(selection, "request_fixture", 1, { type: "status" })
    ).toEqual(envelope({ type: "status" }));
  });

  it.each([
    { version: 0 },
    { version: 2 },
    { requestId: "" },
    { requestId: "not an id" },
    { requestId: "r".repeat(129) },
    { sequence: 0 },
    { sequence: 1.5 },
    { sequence: limits.messages + 1 },
    { sequence: Number.NaN },
    { epoch: -1 },
    { accountRevision: Number.MAX_SAFE_INTEGER + 1 },
    { conversationId: "" },
    { pairSessionId: "" },
    { model: selection.model },
    { body: null },
  ])("rejects malformed envelope fields %j in both directions", (patch) => {
    expectInvalid(decodeClientMessage, {
      ...envelope({ type: "status" }),
      ...patch,
    });
    expectInvalid(decodeServerMessage, {
      ...envelope({ type: "status", state: "ready" }),
      ...patch,
    });
  });

  it.each([
    { type: "append_user_text", text: "" },
    { type: "append_user_text", text: "t".repeat(limits.textChars + 1) },
    { type: "open", model: "" },
    {
      type: "run_turn",
      tools: [],
      snapshot: "s".repeat(limits.snapshotChars + 1),
    },
    { type: "run_turn", tools: [...tools(), TOOL_DEFINITIONS[0]] },
    { type: "run_turn", tools: [TOOL_DEFINITIONS[0], TOOL_DEFINITIONS[0]] },
    {
      type: "run_turn",
      tools: [{ ...TOOL_DEFINITIONS[0], description: "changed" }],
    },
    {
      type: "run_turn",
      tools: [{ ...TOOL_DEFINITIONS[0], name: "unregistered" }],
    },
    { type: "run_turn", tools: [], snapshot: 42 },
    { type: "append_tool_results", results: [] },
    { type: "append_tool_results", results: [result(), result()] },
    {
      type: "append_tool_results",
      results: [result("call_fixture", "r".repeat(limits.resultChars + 1))],
    },
    {
      type: "append_tool_results",
      results: [{ ...result(), summary: "s".repeat(limits.summaryChars + 1) }],
    },
    {
      type: "append_tool_results",
      results: [{ ...result(), isError: "true" }],
    },
    {
      type: "append_tool_results",
      results: [{ ...result(), content: { type: "opaque" } }],
    },
    {
      type: "append_tool_results",
      results: Array.from({ length: limits.calls + 1 }, (_, i) =>
        result("id_" + String(i))
      ),
    },
    { type: "commit_assistant", continuationId: "" },
    { type: "unknown" },
    { type: "delta", text: "display" },
  ])("rejects invalid client body of type $type (%#)", (body) => {
    expectInvalid(decodeClientMessage, envelope(body));
  });

  it.each([
    { type: "ack", operation: "run_turn" },
    { type: "delta", text: "d".repeat(limits.textChars + 1) },
    { type: "failure", code: "unrecognized" },
    { type: "status", state: "unknown" },
    completion([call(), call()]),
    completion([call()], "end_turn"),
    completion([{ type: "text", text: "fixture" }]),
    completion([{ type: "text", text: 42 }], "end_turn"),
    completion(
      [{ type: "text", text: "x".repeat(limits.textChars + 1) }],
      "end_turn"
    ),
    completion([
      { type: "tool_call", call: { id: "a", name: "unregistered", input: {} } },
    ]),
    completion([
      {
        type: "tool_call",
        call: { id: "a", name: TOOL_DEFINITIONS[0].name, input: [] },
      },
    ]),
    completion(
      Array.from({ length: limits.calls + 1 }, (_, i) =>
        call("call_" + String(i))
      )
    ),
    completion(
      Array.from({ length: limits.blocks + 1 }, () => ({
        type: "text",
        text: "",
      })),
      "end_turn"
    ),
    { type: "append_user_text", text: "fixture" },
  ])("rejects invalid server body of type $type (%#)", (body) => {
    expectInvalid(decodeServerMessage, envelope(body));
  });

  it("accepts exact text, result, summary and sequence endpoints", () => {
    expect(
      decodeClientMessage({
        ...envelope({
          type: "append_user_text",
          text: "x".repeat(limits.textChars),
        }),
        sequence: limits.messages,
      }).sequence
    ).toBe(limits.messages);
    const body = {
      type: "append_tool_results",
      results: [
        {
          ...result("one", "x".repeat(limits.resultChars)),
          summary: "x".repeat(limits.summaryChars),
        },
      ],
    };
    expect(decodeClientMessage(envelope(body)).body).toEqual(body);
  });

  it("rejects aggregate size even when individual text blocks fit", () => {
    const blocks = Array.from({ length: 9 }, () => ({
      type: "text",
      text: "x".repeat(limits.textChars),
    }));
    expect(() =>
      decodeServerMessage(envelope(completion(blocks, "end_turn")))
    ).toThrow("limit_exceeded");
  });

  it("rejects excessively deep JSON and non-JSON values", () => {
    let nested: unknown = {};
    for (let i = 0; i <= limits.jsonDepth; i++) nested = { nested };
    const frame = (input: unknown) =>
      envelope(
        completion([
          {
            type: "tool_call",
            call: { id: "one", name: TOOL_DEFINITIONS[0].name, input },
          },
        ])
      );
    expect(() => decodeServerMessage(frame(nested))).toThrow("limit_exceeded");
    for (const input of [
      { value: undefined },
      { value: Infinity },
      { value: new Date(0) },
    ])
      expectInvalid(decodeServerMessage, frame(input));
  });

  it("bounds the aggregate number of JSON nodes", () => {
    const input = {
      values: Array.from({ length: limits.jsonNodes }, () => null),
    };
    expect(() =>
      decodeServerMessage(
        envelope(
          completion([
            {
              type: "tool_call",
              call: { id: "one", name: TOOL_DEFINITIONS[0].name, input },
            },
          ])
        )
      )
    ).toThrow(ChannelFault);
  });

  it("sanitizes arbitrary provider exceptions", () => {
    expect(channelFaultCode(new Error("synthetic private detail"))).toBe(
      "provider_failed"
    );
    expect(channelFaultCode(new ChannelFault("invalid_results"))).toBe(
      "invalid_results"
    );
  });
});
