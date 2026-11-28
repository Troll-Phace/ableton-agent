import { vi } from "vitest";
import { RESPONSES_ENDPOINT } from "../../src/extension/feasibility/signin-contracts.js";
import { eventFrame } from "./chatgpt-signin.js";
import {
  SDK_MARKER,
  SDK_MODEL,
  SDK_SENTINEL,
} from "./chatgpt-sdk-responses.js";

export const TOOL_CALL_ID = "synthetic-sdk-private-call-id";
export const TOOL_ITEM_ID = "synthetic-sdk-private-item-id";
export const REASON_ID = "synthetic-sdk-private-reasoning-id";
export const REASON_TEXT = "synthetic-sdk private reasoning €";
export const ENCRYPTED_REASON = "synthetic-sdk-opaque-reasoning";
export const FUNCTION_ARGS = '{"value":"p15_3"}';
export const FUNCTION_OUTPUT = '{"ok":true,"value":"p15_3"}';

export function echoCall(overrides: Record<string, unknown> = {}) {
  return {
    type: "function_call",
    id: TOOL_ITEM_ID,
    call_id: TOOL_CALL_ID,
    name: "echo",
    namespace: "feasibility",
    arguments: FUNCTION_ARGS,
    status: "completed",
    ...overrides,
  };
}

export const reasoning = () => ({
  type: "reasoning",
  id: REASON_ID,
  summary: [{ type: "summary_text", text: REASON_TEXT }],
  encrypted_content: ENCRYPTED_REASON,
});
export const markerMessage = (text = SDK_MARKER) => ({
  type: "message",
  id: `${SDK_SENTINEL}-message`,
  status: "completed",
  role: "assistant",
  content: [{ type: "output_text", text, annotations: [] }],
});

export function roundtripTerminal(output: unknown[], status = "completed") {
  return eventFrame("response.completed", {
    response: {
      id: SDK_SENTINEL,
      status,
      output,
      usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
    },
  });
}

/** Streamed call fragments intentionally do not constitute a terminal call. */
export function callFragments(call = echoCall()) {
  const args = call.arguments;
  const id = call.id;
  const split = Math.floor(args.length / 2);
  return (
    eventFrame("response.output_item.added", {
      output_index: 1,
      item: { ...call, arguments: "", status: "in_progress" },
    }) +
    eventFrame("response.function_call_arguments.delta", {
      output_index: 1,
      item_id: id,
      delta: args.slice(0, split),
    }) +
    eventFrame("response.function_call_arguments.delta", {
      output_index: 1,
      item_id: id,
      delta: args.slice(split),
    }) +
    eventFrame("response.function_call_arguments.done", {
      output_index: 1,
      item_id: id,
      arguments: args,
    }) +
    eventFrame("response.output_item.done", { output_index: 1, item: call })
  );
}

export function callCompleted(call = echoCall()) {
  return callFragments(call) + roundtripTerminal([reasoning(), call]);
}

export function expectedTools() {
  return [
    {
      type: "namespace",
      name: "feasibility",
      description: "Synthetic feasibility function only.",
      tools: [
        {
          type: "function",
          name: "echo",
          description: "Return the fixed in-memory marker.",
          strict: true,
          parameters: {
            type: "object",
            properties: { value: { type: "string", enum: [SDK_MARKER] } },
            required: ["value"],
            additionalProperties: false,
          },
        },
      ],
    },
  ];
}

export function expectedInput() {
  return [
    {
      role: "developer",
      content:
        "This is a fixed synthetic feasibility probe. Call feasibility.echo exactly once with value p15_3. After receiving its output, reply with exactly p15_3 and do not call any function again.",
    },
    {
      role: "user",
      content:
        "Call feasibility.echo with value p15_3, then acknowledge its result.",
    },
  ];
}

export function firstRequest() {
  return {
    model: SDK_MODEL,
    store: false,
    stream: true,
    input: expectedInput(),
    tools: expectedTools(),
  };
}

export type RoundtripReply =
  | Response
  | ((request: Request) => Response | Promise<Response>);
/** Only the queued synthetic responses can be dispatched. Captures forbidden
 * retry or third-request attempts without ever touching ambient Fetch. */
export function roundtripFetch(...replies: RoundtripReply[]) {
  const requests: Request[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const next = replies[requests.length - 1];
    if (request.url !== RESPONSES_ENDPOINT || !next || requests.length > 2)
      throw new Error("Unexpected synthetic roundtrip request");
    return typeof next === "function" ? await next(request) : next;
  });
  return { requests, fetch };
}
