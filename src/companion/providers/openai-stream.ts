import { isDeepStrictEqual } from "node:util";
import OpenAI from "openai";

import type { AssistantDeltaSink } from "../../shared/provider.js";
import {
  OpenAiOutputFault,
  OpenAiOutputValidator,
  responseRecord,
  type ValidatedOpenAiOutput,
} from "./openai-output.js";
import type { OpenAiToolSet } from "./openai-tools.js";

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
export const OPENAI_STREAM_TIMEOUT_MS = 60_000;
export const OPENAI_CLEANUP_TIMEOUT_MS = 5_000;
export const OPENAI_STREAM_MAX_BYTES = 1024 * 1024;
const MAX_CHUNKS = 10_000;
const MAX_EVENTS = 10_000;

export interface OpenAiClock {
  now(): number;
  setTimeout(
    callback: () => void,
    delay: number
  ): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export interface OpenAiStreamDependencies {
  fetch: typeof globalThis.fetch;
  AbortController: typeof globalThis.AbortController;
  clock: OpenAiClock;
}

export type OpenAiFaultCode =
  | "aborted"
  | "timeout"
  | "cleanup_failed"
  | "invalid_request"
  | "invalid_response"
  | "invalid_arguments"
  | "response_limit"
  | "response_failed"
  | "response_incomplete"
  | "premature_eof"
  | "redirect_rejected"
  | "network_failed"
  | "http_rejected"
  | "usage_limited"
  | "temporary_failure"
  | "plan_required"
  | "credential_invalid"
  | "operation_busy"
  | "unsupported_option"
  | "disposed"
  | "history_limit";

/** Fixed classifications only. SDK/provider error text never crosses here. */
export class OpenAiStreamFault extends Error {
  constructor(readonly code: OpenAiFaultCode) {
    super(code);
    this.name = "OpenAiStreamFault";
  }
}

export interface OpenAiStreamPayload {
  model: string;
  input: OpenAI.Responses.ResponseInput;
  tools: OpenAI.Responses.NamespaceTool[];
  store: false;
  stream: true;
}

function providerFailure(value: unknown): OpenAiFaultCode {
  switch (value) {
    case "subscription_sharing_usage_limit_exceeded":
      return "usage_limited";
    case "subscription_sharing_usage_unavailable":
    case "temporarily_unavailable":
      return "temporary_failure";
    case "invalid_scope":
    case "insufficient_scope":
      return "plan_required";
    default:
      return "response_failed";
  }
}

export function classifyOpenAiFailure(error: unknown): OpenAiFaultCode {
  if (error instanceof OpenAiStreamFault || error instanceof OpenAiOutputFault)
    return error.code;
  if (error instanceof OpenAI.APIConnectionTimeoutError) return "timeout";
  if (error instanceof OpenAI.APIUserAbortError) return "aborted";
  if (error instanceof SyntaxError) return "invalid_response";
  if (error instanceof OpenAI.APIError) {
    const code = providerFailure(error.code);
    if (code !== "response_failed") return code;
    if (error.status === 401) return "credential_invalid";
    if (error.status === 403) return "plan_required";
    if (error.status === 429) return "usage_limited";
    if (typeof error.status === "number" && error.status >= 500)
      return "temporary_failure";
    if (typeof error.status === "number") return "http_rejected";
    return error instanceof OpenAI.APIConnectionError
      ? "network_failed"
      : "response_failed";
  }
  return "network_failed";
}

/** Application deadline independent of the SDK's own native timeout. */
class Deadline {
  readonly #interruption: Promise<never>;
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #onAbort: () => void;
  #reason?: OpenAiStreamFault;

  constructor(
    private readonly clock: OpenAiClock,
    duration: number,
    private readonly signal?: AbortSignal,
    interrupt?: () => void
  ) {
    let reject: (error: OpenAiStreamFault) => void = () => undefined;
    this.#interruption = new Promise<never>((_resolve, fail) => {
      reject = fail;
    });
    void this.#interruption.catch(() => undefined);
    const stop = (code: "aborted" | "timeout") => {
      if (this.#reason) return;
      this.#reason = new OpenAiStreamFault(code);
      try {
        interrupt?.();
      } catch {
        /* Interruption still settles. */
      }
      reject(this.#reason);
    };
    this.#timer = clock.setTimeout(() => stop("timeout"), duration);
    this.#onAbort = () => stop("aborted");
    if (signal?.aborted) this.#onAbort();
    else signal?.addEventListener("abort", this.#onAbort, { once: true });
  }
  check(): void {
    if (this.#reason) throw this.#reason;
  }
  async wait<T>(task: PromiseLike<T>): Promise<T> {
    return await Promise.race([task, this.#interruption]);
  }
  close(): void {
    this.clock.clearTimeout(this.#timer);
    this.signal?.removeEventListener("abort", this.#onAbort);
  }
}

interface OpenAiStreamOptions {
  deps: OpenAiStreamDependencies;
  payload: OpenAiStreamPayload;
  accessToken: string;
  tools: OpenAiToolSet;
  signal: AbortSignal;
  /** Reverify the exact current credential/binding, never read ambient data. */
  check(): void;
  onDelta?: AssistantDeltaSink;
}

/** One SDK streaming request through the explicitly injected Fetch. The SDK
 * alone parses SSE, including a missing Content-Type; the wrapper only bounds
 * and owns the raw body. A completed value is returned after bounded cleanup. */
export async function consumeOpenAiStream(
  options: OpenAiStreamOptions
): Promise<ValidatedOpenAiOutput> {
  const { deps, payload, accessToken, signal, tools, onDelta } = options;
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded, "utf8") > OPENAI_STREAM_MAX_BYTES)
    throw new OpenAiStreamFault("history_limit");
  const expected: unknown = JSON.parse(encoded);
  const controller = new deps.AbortController();
  const deadline = new Deadline(
    deps.clock,
    OPENAI_STREAM_TIMEOUT_MS,
    signal,
    () => controller.abort()
  );
  const validator = new OpenAiOutputValidator(tools);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let rawBody: ReadableStream<Uint8Array> | null | undefined;
  let cleanupTask: Promise<void> | undefined;
  let cleanupFailed = false;
  let transportFailure: OpenAiFaultCode | undefined;
  let fetched = false;
  let ended = false;
  let bytes = 0;
  let chunks = 0;
  const check = () => {
    deadline.check();
    if (ended || signal.aborted) throw new OpenAiStreamFault("aborted");
    options.check();
  };
  const closeReader = (): Promise<void> => {
    if (cleanupTask) return cleanupTask;
    const owned = reader;
    if (!owned && !rawBody) return Promise.resolve();
    cleanupTask = (async () => {
      let pending: Promise<void> | undefined;
      try {
        pending = owned ? owned.cancel() : rawBody?.cancel();
      } catch (error) {
        if (!(error instanceof Error && error.name === "AbortError"))
          cleanupFailed = true;
      }
      try {
        owned?.releaseLock();
      } catch {
        cleanupFailed = true;
      }
      try {
        await pending;
      } catch (error) {
        if (!(error instanceof Error && error.name === "AbortError"))
          cleanupFailed = true;
      }
      reader = undefined;
      rawBody = undefined;
    })();
    return cleanupTask;
  };
  const guardedFetch: typeof globalThis.fetch = async (url, init) => {
    try {
      check();
      const destination =
        typeof url === "string"
          ? url
          : url instanceof URL
            ? url.href
            : undefined;
      if (
        fetched ||
        destination !== OPENAI_RESPONSES_URL ||
        init?.method !== "POST" ||
        typeof init.body !== "string" ||
        !isDeepStrictEqual(JSON.parse(init.body) as unknown, expected) ||
        new Headers(init.headers).get("authorization") !==
          `Bearer ${accessToken}`
      )
        throw new OpenAiStreamFault("invalid_request");
    } catch (error) {
      transportFailure =
        error instanceof SyntaxError
          ? "invalid_request"
          : classifyOpenAiFailure(error);
      throw new OpenAiStreamFault(transportFailure);
    }
    fetched = true;
    const response = await deps.fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: encoded,
      signal: controller.signal,
    });
    rawBody = response.body;
    if (ended || controller.signal.aborted) {
      await closeReader();
      throw new OpenAiStreamFault("aborted");
    }
    if (
      response.redirected ||
      (response.url && response.url !== OPENAI_RESPONSES_URL) ||
      (response.status >= 300 && response.status < 400)
    ) {
      transportFailure = "redirect_rejected";
      await closeReader();
      throw new OpenAiStreamFault(transportFailure);
    }
    if (!rawBody) return response;
    reader = rawBody.getReader();
    const owned = reader;
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(sink) {
          try {
            check();
            const next = await deadline.wait(owned.read());
            check();
            if (next.done) {
              sink.close();
              return;
            }
            if (!(next.value instanceof Uint8Array))
              throw new OpenAiStreamFault("invalid_response");
            bytes += next.value.byteLength;
            chunks++;
            if (bytes > OPENAI_STREAM_MAX_BYTES || chunks > MAX_CHUNKS)
              throw new OpenAiStreamFault("response_limit");
            sink.enqueue(next.value);
          } catch (error) {
            transportFailure ??= classifyOpenAiFailure(error);
            sink.error(new OpenAiStreamFault(transportFailure));
          }
        },
        cancel() {
          return closeReader();
        },
      },
      { highWaterMark: 0 }
    );
    return new Response(body, {
      status: response.status,
      headers: response.headers,
    });
  };

  const work = (async (): Promise<ValidatedOpenAiOutput> => {
    check();
    const client = new OpenAI({
      apiKey: accessToken,
      adminAPIKey: null,
      organization: null,
      project: null,
      webhookSecret: null,
      baseURL: "https://api.openai.com/v1",
      maxRetries: 0,
      timeout: OPENAI_STREAM_TIMEOUT_MS,
      logLevel: "off",
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      fetchOptions: { redirect: "error" },
      fetch: guardedFetch,
    });
    const stream = await client.responses.create(payload, {
      signal: controller.signal,
      maxRetries: 0,
    });
    let events = 0;
    let completed: ValidatedOpenAiOutput | undefined;
    for await (const raw of stream) {
      check();
      if (++events > MAX_EVENTS) throw new OpenAiStreamFault("response_limit");
      const event = responseRecord(raw);
      if (!event || typeof event.type !== "string" || completed)
        throw new OpenAiStreamFault("invalid_response");
      if (event.type === "response.failed" || event.type === "error") {
        const error =
          responseRecord(responseRecord(event.response)?.error) ??
          responseRecord(event.error);
        throw new OpenAiStreamFault(providerFailure(error?.code ?? event.code));
      }
      if (event.type === "response.incomplete")
        throw new OpenAiStreamFault("response_incomplete");
      if (event.type === "response.completed") {
        const terminal = responseRecord(event.response);
        if (
          !terminal ||
          terminal.status !== "completed" ||
          terminal.error != null ||
          terminal.incomplete_details != null
        )
          throw new OpenAiStreamFault("invalid_response");
        completed = validator.complete(terminal.output);
      } else {
        const delta = validator.observe(event);
        if (delta !== undefined) onDelta?.(delta);
      }
    }
    check();
    if (transportFailure) throw new OpenAiStreamFault(transportFailure);
    if (controller.signal.aborted || stream.controller.signal.aborted)
      throw new OpenAiStreamFault("aborted");
    if (!completed) throw new OpenAiStreamFault("premature_eof");
    return completed;
  })();
  const settled = work.then(
    () => undefined,
    () => undefined
  );
  let result: ValidatedOpenAiOutput | undefined;
  let failure: OpenAiFaultCode | undefined;
  try {
    result = await deadline.wait(work);
    check();
  } catch (error) {
    failure = transportFailure ?? classifyOpenAiFailure(error);
    try {
      deadline.check();
    } catch (interruption) {
      failure = classifyOpenAiFailure(interruption);
    }
  } finally {
    ended = true;
    deadline.close();
    try {
      controller.abort();
    } catch {
      cleanupFailed = true;
    }
    const cleanup = new Deadline(deps.clock, OPENAI_CLEANUP_TIMEOUT_MS);
    try {
      await cleanup.wait(Promise.all([settled, closeReader()]));
    } catch {
      cleanupFailed = true;
    } finally {
      cleanup.close();
      validator.clear();
    }
  }
  if (signal.aborted) throw new OpenAiStreamFault("aborted");
  if (cleanupFailed) throw new OpenAiStreamFault("cleanup_failed");
  if (failure || !result)
    throw new OpenAiStreamFault(failure ?? "invalid_response");
  options.check();
  return result;
}
