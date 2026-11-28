import { vi } from "vitest";
import type OpenAI from "openai";

import { eventFrame } from "./chatgpt-signin.js";
import { sdkStream, stalledSdkStream } from "./chatgpt-sdk-responses.js";
import type { OpenAiHistoryBinding } from "../../src/companion/providers/openai-history.js";
import {
  OpenAiResponsesProvider,
  type OpenAiSelectedCredential,
} from "../../src/companion/providers/openai-responses.js";

// Synthetic-only constants: never consult environment, account or user data.
export const ENDPOINT = "https://api.openai.com/v1/responses";
export const BEARER = "synthetic-private-bearer";
export const ACCOUNT = "synthetic-private-account";
export const CONVERSATION = "synthetic-private-conversation";
export const MODEL = "synthetic-catalog-model";
export const INSTRUCTIONS = "Synthetic fixed developer instructions.";
export const USER = "Synthetic user message.";
export const SNAPSHOT = "Synthetic snapshot.";
export const NOW = 1_800_000_000_000;
export const PRIVATE = "synthetic-private-provider-value";
export const FINAL = "Synthetic final response €";

export const binding = (): OpenAiHistoryBinding => ({
  provider: "openai_responses",
  accountBinding: ACCOUNT,
  conversationId: CONVERSATION,
  model: MODEL,
});

export const reasoning = (id = `${PRIVATE}-reasoning`) =>
  ({
    type: "reasoning" as const,
    id,
    summary: [{ type: "summary_text" as const, text: `${PRIVATE}-summary` }],
    encrypted_content: `${PRIVATE}-encrypted`,
    status: "completed" as const,
  }) satisfies OpenAI.Responses.ResponseReasoningItem;

export const message = (text = FINAL, id = "synthetic-message") =>
  ({
    type: "message" as const,
    id,
    status: "completed" as const,
    role: "assistant" as const,
    phase: "final_answer" as const,
    content: [{ type: "output_text" as const, text, annotations: [] }],
  }) satisfies OpenAI.Responses.ResponseOutputMessage;

export const refusal = (text = "Synthetic refusal") =>
  ({
    ...message(),
    content: [{ type: "refusal" as const, refusal: text }],
  }) satisfies OpenAI.Responses.ResponseOutputMessage;

export const liveCall = (id: string, name: string, input: unknown = {}) =>
  ({
    type: "function_call" as const,
    id: `synthetic-item-${id}`,
    call_id: id,
    namespace: "live",
    name,
    arguments: JSON.stringify(input),
    status: "completed" as const,
  }) satisfies OpenAI.Responses.ResponseFunctionToolCall;

export function terminal(output: unknown[], status = "completed") {
  return eventFrame("response.completed", {
    response: {
      id: `${PRIVATE}-response`,
      status,
      output,
      usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
    },
  });
}

export function delta(text: string, id = "synthetic-message") {
  return eventFrame("response.output_text.delta", {
    delta: text,
    item_id: id,
    output_index: 0,
    content_index: 0,
  });
}

export function callFragments(call: ReturnType<typeof liveCall>, index = 0) {
  const split = Math.floor(call.arguments.length / 2);
  return (
    eventFrame("response.output_item.added", {
      output_index: index,
      item: { ...call, arguments: "", status: "in_progress" },
    }) +
    eventFrame("response.function_call_arguments.delta", {
      output_index: index,
      item_id: call.id,
      delta: call.arguments.slice(0, split),
    }) +
    eventFrame("response.function_call_arguments.delta", {
      output_index: index,
      item_id: call.id,
      delta: call.arguments.slice(split),
    }) +
    eventFrame("response.function_call_arguments.done", {
      output_index: index,
      item_id: call.id,
      arguments: call.arguments,
    }) +
    eventFrame("response.output_item.done", { output_index: index, item: call })
  );
}

export function unsuccessful(
  type: "response.failed" | "response.incomplete" | "error"
) {
  return eventFrame(type, {
    code: PRIVATE,
    message: PRIVATE,
    response: {
      id: PRIVATE,
      status: type === "response.incomplete" ? "incomplete" : "failed",
      error: { code: PRIVATE, message: PRIVATE },
    },
  });
}

export function completedResponse(
  output: unknown[] = [message()],
  mime: string | null = "text/event-stream"
) {
  return sdkStream(terminal(output), mime).response;
}

export { sdkStream as stream, stalledSdkStream as stalled };

export type Reply =
  | Response
  | ((request: Request) => Response | Promise<Response>);

/** Actual SDK requests are captured and answered only by synthetic Fetch. An
 * unexpected destination, retry, or extra request fails closed. */
export function scriptedFetch(...replies: Reply[]) {
  const requests: Request[] = [];
  const bodies: unknown[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = new Request(input, init);
    const index = requests.length;
    requests.push(request);
    const reply = replies[index];
    if (request.url !== ENDPOINT || request.method !== "POST" || !reply)
      throw new Error("Unexpected synthetic Responses request");
    bodies.push(await request.clone().json());
    return typeof reply === "function" ? await reply(request) : reply;
  });
  return { fetch, requests, bodies };
}

export function makeProvider(...replies: Reply[]) {
  const wire = scriptedFetch(...replies);
  const selected: OpenAiSelectedCredential = {
    accountBinding: ACCOUNT,
    model: MODEL,
    accessToken: BEARER,
    expiresAt: NOW + 3_600_000,
    scopes: ["chatgpt.tokens.use.direct"],
    planOnlyConfirmed: true,
    creditFallbackDisabled: true,
  };
  const credential = vi.fn<() => OpenAiSelectedCredential | undefined>(
    () => selected
  );
  const clock = {
    now: vi.fn(() => NOW),
    setTimeout: (callback: () => void, delay: number) =>
      setTimeout(callback, delay),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  };
  const options = { binding: binding(), developerInstructions: INSTRUCTIONS };
  const provider = new OpenAiResponsesProvider(options, {
    fetch: wire.fetch,
    AbortController,
    clock,
    loadCredential: credential,
  });
  provider.appendUserText(USER);
  return { ...wire, provider, credential, clock, selected, options };
}
