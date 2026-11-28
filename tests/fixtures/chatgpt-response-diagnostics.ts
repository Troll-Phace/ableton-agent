import { vi } from "vitest";
import { eventFrame } from "./chatgpt-signin.js";

export const PRIVATE_SENTINEL = "synthetic-diagnostic-private-sentinel";
export const encode = (text: string) => new TextEncoder().encode(text);

/** Scripted native-response boundary, including failures impossible to construct
 * with the standard Response constructor. No real Fetch or sockets. */
export function diagnosticWire(
  chunks: Uint8Array[] = [],
  options: {
    status?: number;
    mime?: string | null;
    readError?: boolean;
    cancelError?: boolean;
    releaseError?: boolean;
  } = {}
) {
  const fail = () => new Error(PRIVATE_SENTINEL);
  let index = 0;
  const reader = {
    read: vi.fn(
      (): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> => {
        if (index < chunks.length)
          return Promise.resolve({ done: false, value: chunks[index++] });
        if (options.readError) return Promise.reject(fail());
        return Promise.resolve({ done: true, value: undefined });
      }
    ),
    cancel: vi.fn(() =>
      options.cancelError ? Promise.reject(fail()) : Promise.resolve()
    ),
    releaseLock: vi.fn(() => {
      if (options.releaseError) throw fail();
    }),
  };
  const body = {
    getReader: vi.fn(() => reader),
    cancel: vi.fn(() => Promise.resolve()),
  };
  const response = {
    status: options.status ?? 200,
    headers: {
      get: vi.fn(() =>
        options.mime === undefined ? "text/event-stream" : options.mime
      ),
    },
    body,
  };
  return {
    reader,
    body,
    response,
    asResponse: () => response as unknown as Response,
  };
}

export const textDelta = (delta: unknown = PRIVATE_SENTINEL) =>
  eventFrame("response.output_text.delta", { delta });

export const completedText = (text = "p15_3") =>
  eventFrame("response.completed", {
    response: {
      status: "completed",
      id: PRIVATE_SENTINEL,
      output: [
        {
          type: "message",
          id: PRIVATE_SENTINEL,
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text }],
        },
      ],
    },
  });
