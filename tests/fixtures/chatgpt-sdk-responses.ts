import { vi } from "vitest";

import { RESPONSES_ENDPOINT } from "../../src/extension/feasibility/signin-contracts.js";
import type { InferenceContext } from "../../src/extension/feasibility/responses.js";
import { eventFrame, makeConnection, APPROVED } from "./chatgpt-signin.js";

export const SDK_SENTINEL = "synthetic-sdk-private-value";
export const SDK_MODEL = "synthetic-catalog-model";
export const SDK_MARKER = "p15_3";

/** Fully synthetic gated context, no account lookup or ambient credentials. */
export function sdkContext(
  overrides: Partial<InferenceContext> = {}
): InferenceContext {
  return {
    connection: makeConnection(),
    modelSlug: SDK_MODEL,
    authorization: {
      ...APPROVED,
      planOnlyConfirmed: true,
      creditFallbackDisabled: true,
    },
    ...overrides,
  };
}

/** Actual standard Response bodies for use by the real pinned SDK parser. */
export function sdkStream(
  frames: string | Uint8Array,
  mime: string | null = "text/event-stream",
  chunkSize = 13
) {
  const bytes =
    typeof frames === "string" ? new TextEncoder().encode(frames) : frames;
  let offset = 0;
  const cancellation = vi.fn();
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (offset === bytes.length) controller.close();
        else {
          const end = Math.min(offset + chunkSize, bytes.length);
          controller.enqueue(bytes.subarray(offset, end));
          offset = end;
        }
      },
      cancel: cancellation,
    },
    { highWaterMark: 0 }
  );
  const headers = new Headers({
    "X-Request-Id": SDK_SENTINEL,
    "X-Synthetic-Private": SDK_SENTINEL,
  });
  if (mime !== null) headers.set("Content-Type", mime);
  return {
    response: new Response(body, { status: 200, headers }),
    body,
    cancellation,
  };
}

/** Finite first event then a stalled stream. Test owns late data and closure. */
export function stalledSdkStream(first = "") {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const readStarted = Promise.withResolvers<void>();
  const cancelled = vi.fn();
  let read = false;
  const body = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
      },
      pull() {
        if (first && !read) {
          read = true;
          controller.enqueue(new TextEncoder().encode(first));
        } else readStarted.resolve();
      },
      cancel: cancelled,
    },
    { highWaterMark: 0 }
  );
  const response = new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
  });
  return {
    response,
    body,
    cancelled,
    readStarted: readStarted.promise,
    completeLate(frame: string) {
      try {
        controller.enqueue(new TextEncoder().encode(frame));
        controller.close();
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function sdkCompleted(text = SDK_MARKER, status = "completed") {
  return eventFrame("response.completed", {
    response: {
      id: SDK_SENTINEL,
      status,
      output: [
        {
          type: "message",
          id: SDK_SENTINEL,
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
      usage: { input_tokens: 20, output_tokens: 3, total_tokens: 23 },
    },
  });
}

export function sdkDelta(text = SDK_SENTINEL) {
  return eventFrame("response.output_text.delta", {
    delta: text,
    item_id: SDK_SENTINEL,
    output_index: 0,
    content_index: 0,
  });
}

export function sdkFailure(
  type: "response.failed" | "response.incomplete" | "error",
  code = SDK_SENTINEL
) {
  return eventFrame(type, {
    code,
    message: SDK_SENTINEL,
    response: {
      id: SDK_SENTINEL,
      status: type === "response.incomplete" ? "incomplete" : "failed",
      error: { code, message: SDK_SENTINEL },
    },
  });
}

/** Fail-closed injected Fetch: never invokes real Fetch; tracks every attempt
 * including invalid destinations and duplicate/retried requests. */
export function sdkFetch(
  reply: Response | ((request: Request) => Response | Promise<Response>)
) {
  const requests: Request[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.url !== RESPONSES_ENDPOINT || requests.length !== 1)
      throw new Error("Unexpected synthetic SDK request");
    return typeof reply === "function" ? await reply(request) : reply;
  });
  return { fetch, requests };
}
