import { TextDecoder } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProbeCancellation } from "../src/extension/feasibility/contracts.js";
import { CredentialStore } from "../src/extension/feasibility/credential-store.js";
import {
  parseModelCatalog,
  SseFramer,
  SyntheticResponses,
  type InferenceContext,
} from "../src/extension/feasibility/responses.js";
import {
  MODELS_ENDPOINT,
  RESPONSES_ENDPOINT,
  SigninFault,
} from "../src/extension/feasibility/signin-contracts.js";
import {
  ACCESS,
  APPROVED,
  chunkedSse,
  DETAIL,
  eventFrame,
  fakeHttp,
  json,
  makeConnection,
  makeStorage,
  NOW,
  pendingSse,
  REFRESH,
  sseText,
} from "./fixtures/chatgpt-signin.js";

const disposals: (() => void)[] = [];
function storage() {
  const f = makeStorage();
  disposals.push(f.dispose);
  return f;
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dispose of disposals.splice(0)) dispose();
});

const MODELS = {
  models: [
    {
      visibility: "list",
      slug: "synthetic-first",
      display_name: "Synthetic First",
    },
    { visibility: "hidden", slug: "synthetic-hidden", display_name: "Hidden" },
    {
      visibility: "list",
      slug: "synthetic-second",
      display_name: "Synthetic Second",
    },
  ],
};
const CALL = {
  type: "function_call",
  id: "synthetic-item",
  call_id: "synthetic-call",
  name: "echo",
  namespace: "feasibility",
  arguments: '{"value":"p15_3"}',
  status: "completed",
};
const REASON = {
  type: "reasoning",
  id: "synthetic-reason",
  summary: [{ type: "summary_text", text: "Synthetic reasoning €" }],
  encrypted_content: "synthetic-opaque-reasoning",
};
const MESSAGE = {
  type: "message",
  id: "synthetic-message",
  status: "completed",
  role: "assistant",
  content: [{ type: "output_text", text: "p15_3", annotations: [] }],
};
const USAGE = {
  input_tokens: 20,
  output_tokens: 5,
  total_tokens: 25,
  input_tokens_details: { cached_tokens: 4 },
};
const complete = (output: unknown[], usage: unknown = USAGE) =>
  eventFrame("response.completed", {
    response: { status: "completed", output, usage },
  });
const callFrames = () =>
  eventFrame("response.output_item.added", {
    output_index: 1,
    item: { ...CALL, status: "in_progress", arguments: "" },
  }) +
  eventFrame("response.function_call_arguments.delta", {
    output_index: 1,
    item_id: CALL.id,
    delta: '{"value":',
  }) +
  eventFrame("response.function_call_arguments.delta", {
    output_index: 1,
    item_id: CALL.id,
    delta: '"p15_3"}',
  }) +
  eventFrame("response.function_call_arguments.done", {
    output_index: 1,
    item_id: CALL.id,
    arguments: CALL.arguments,
  }) +
  eventFrame("response.output_item.done", { output_index: 1, item: CALL }) +
  complete([REASON, CALL]);
const ackFrames = () =>
  eventFrame("response.output_text.delta", { delta: "p15_3" }) +
  complete([MESSAGE]);

const INFERENCE_APPROVED = {
  ...APPROVED,
  planOnlyConfirmed: true,
  creditFallbackDisabled: true,
};
function fixture() {
  const s = storage();
  const connection = makeConnection();
  s.store.saveConnection(connection);
  const network = fakeHttp();
  const responses = new SyntheticResponses({
    http: network.http,
    store: s.store,
    TextDecoder,
    clock: network.deps.clock,
  });
  const context: InferenceContext = {
    connection,
    modelSlug: "synthetic-first",
    authorization: INFERENCE_APPROVED,
  };
  const load = async () => {
    network.enqueue(MODELS_ENDPOINT, json(MODELS));
    return await responses.loadCatalog({ connection, authorization: APPROVED });
  };
  const roundtrip = async () => {
    network.enqueue(RESPONSES_ENDPOINT, chunkedSse(callFrames(), 13).response);
    network.enqueue(RESPONSES_ENDPOINT, chunkedSse(ackFrames(), 9).response);
    return await responses.runRoundTrip(context);
  };
  const requests = () =>
    network.calls.filter((row) => row.url === RESPONSES_ENDPOINT);
  return {
    s,
    connection,
    network,
    responses,
    context,
    load,
    roundtrip,
    requests,
  };
}
function readRequest(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string")
    throw new Error("Expected scripted JSON request");
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe("S5 model catalog", () => {
  it("preserves visible catalog ordering; never chooses a default or hidden model", () => {
    expect(parseModelCatalog(MODELS)).toEqual([
      { slug: "synthetic-first", displayName: "Synthetic First" },
      { slug: "synthetic-second", displayName: "Synthetic Second" },
    ]);
  });
  it.each([
    null,
    { models: [] },
    { models: [{ visibility: "hidden", slug: "synthetic-hidden" }] },
    { models: [{ visibility: "list", slug: "", display_name: "Model" }] },
    {
      models: [
        { visibility: "list", slug: "bad model", display_name: "Model" },
      ],
    },
    {
      models: [
        { visibility: "list", slug: "synthetic-model", display_name: "" },
      ],
    },
    {
      models: [
        { visibility: "list", slug: "synthetic-model", display_name: "One" },
        { visibility: "list", slug: "synthetic-model", display_name: "Two" },
      ],
    },
    {
      models: [
        { visibility: "list", slug: "synthetic-model", display_name: ACCESS },
      ],
    },
  ])("rejects invalid/empty or private display catalog %#", (catalog) => {
    expect(() => parseModelCatalog(catalog, [ACCESS, REFRESH])).toThrow(
      "catalog_invalid"
    );
  });
  it("catalog is bound to the exact persisted connection, and rejects stale/expired/missing entitlements", async () => {
    const f = fixture();
    const stale = makeConnection({ accessToken: "synthetic-stale-token" });
    await expect(
      f.responses.loadCatalog({ connection: stale, authorization: APPROVED })
    ).rejects.toMatchObject({ code: "reconnect_required" });
    f.s.store.saveConnection(makeConnection({ expiresAt: NOW }));
    await expect(
      f.responses.loadCatalog({
        connection: f.connection,
        authorization: APPROVED,
      })
    ).rejects.toMatchObject({ code: "reconnect_required" });
    f.s.store.saveConnection(makeConnection({ scopes: ["openid"] }));
    await expect(
      f.responses.loadCatalog({
        connection: f.connection,
        authorization: APPROVED,
      })
    ).rejects.toMatchObject({ code: "plan_disabled" });
    expect(f.network.calls).toHaveLength(0);
  });
});

describe("S5 bounded SSE framing and complete output assembly", () => {
  it("frames multiline CRLF SSE and split UTF-8 at each possible byte boundary", () => {
    const bytes = new TextEncoder().encode(
      ': comment\r\nevent: response.output_text.delta\r\ndata: {"type":"response.output_text.delta",\r\ndata: "delta":"€"}\r\n\r\n'
    );
    for (let at = 1; at < bytes.length; at++) {
      const framer = new SseFramer(TextDecoder);
      const events = [
        ...framer.push(bytes.subarray(0, at)),
        ...framer.push(bytes.subarray(at)),
      ];
      framer.finish();
      expect(events).toEqual([
        {
          type: "response.output_text.delta",
          payload: { type: "response.output_text.delta", delta: "€" },
        },
      ]);
      expect(framer.events).toBe(1);
      expect(framer.bytes).toBe(bytes.length);
    }
  });
  it.each([
    "invalid_json",
    "mismatched_event",
    "invalid_utf8",
    "unfinished",
    "event_limit",
    "total_limit",
    "event_count",
  ] as const)("rejects invalid or unbounded framing %s", (kind) => {
    const framer = new SseFramer(TextDecoder);
    const bytes = (text: string) => new TextEncoder().encode(text);
    const action = () => {
      if (kind === "invalid_json") framer.push(bytes("data: {broken}\n\n"));
      else if (kind === "mismatched_event")
        framer.push(bytes('event: one\ndata: {"type":"two"}\n\n'));
      else if (kind === "invalid_utf8")
        framer.push(new Uint8Array([0xff, 10, 10]));
      else if (kind === "unfinished") {
        framer.push(bytes('data: {"type":"one"}'));
        framer.finish();
      } else if (kind === "event_limit")
        framer.push(bytes("data: " + "x".repeat(131073)));
      else if (kind === "total_limit") framer.push(new Uint8Array(1048577));
      else framer.push(bytes('data: {"type":"x"}\n\n'.repeat(10001)));
    };
    expect(action).toThrow(
      kind === "unfinished"
        ? "premature_eof"
        : kind.includes("limit") || kind === "event_count"
          ? "response_limit"
          : "malformed_sse"
    );
  });

  it.each([
    [
      "premature EOF",
      eventFrame("response.output_item.added", {
        output_index: 0,
        item: { ...CALL, arguments: "" },
      }),
      "premature_eof",
    ],
    [
      "failed after delta",
      eventFrame("response.output_text.delta", { delta: "synthetic partial" }) +
        eventFrame("response.failed", {
          response: { error: { message: DETAIL } },
        }),
      "response_failed",
    ],
    [
      "incomplete after delta",
      eventFrame("response.output_text.delta", { delta: "synthetic partial" }) +
        eventFrame("response.incomplete"),
      "response_incomplete",
    ],
    [
      "duplicate calls",
      complete([
        CALL,
        {
          ...CALL,
          id: "synthetic-second-item",
          call_id: "synthetic-second-call",
        },
      ]),
      "duplicate_call",
    ],
    [
      "unknown namespace",
      complete([{ ...CALL, namespace: "other" }]),
      "invalid_function_call",
    ],
    [
      "unknown function",
      complete([{ ...CALL, name: "other" }]),
      "invalid_function_call",
    ],
    [
      "partial args",
      complete([{ ...CALL, arguments: '{"value":' }]),
      "argument_mismatch",
    ],
    [
      "extra argument",
      complete([{ ...CALL, arguments: '{"value":"p15_3","extra":false}' }]),
      "argument_mismatch",
    ],
    [
      "wrong marker",
      complete([{ ...CALL, arguments: '{"value":"wrong"}' }]),
      "argument_mismatch",
    ],
    [
      "duplicate keys",
      complete([{ ...CALL, arguments: '{"value":"p15_3","value":"p15_3"}' }]),
      "argument_mismatch",
    ],
    ["missing call", complete([REASON]), "invalid_function_call"],
    [
      "mismatched streamed call",
      eventFrame("response.output_item.added", {
        output_index: 0,
        item: { ...CALL, arguments: "" },
      }) + complete([{ ...CALL, call_id: "synthetic-different" }]),
      "argument_mismatch",
    ],
    [
      "contradictory terminal",
      complete([CALL]) + eventFrame("response.failed"),
      "malformed_sse",
    ],
  ] as const)(
    "fails closed with no second request on %s",
    async (_name, frames, code) => {
      const f = fixture();
      await f.load();
      const sse = chunkedSse(frames, 17);
      f.network.enqueue(RESPONSES_ENDPOINT, sse.response);
      const result = await f.responses.runRoundTrip(f.context);
      expect(result).toMatchObject({
        outcome: "failed",
        code,
        attempts: 1,
        functionEchoValidated: false,
        finalMarkerAcknowledged: false,
      });
      expect(result.first?.code).toBe(code);
      expect(f.requests()).toHaveLength(1);
      expect(f.s.store.getBudget().attempts).toBe(1);
      expect(sse.body.locked).toBe(false);
      expect(JSON.stringify(result)).not.toContain(DETAIL);
      expect((await f.responses.runRoundTrip(f.context)).code).toBe(
        "attempt_order_invalid"
      );
      expect(f.requests()).toHaveLength(1);
    }
  );
  it.each([
    [
      "wrong acknowledgement",
      complete([
        { ...MESSAGE, content: [{ type: "output_text", text: "wrong" }] },
      ]),
      "missing_acknowledgement",
    ],
    ["extra call", complete([CALL]), "unexpected_function_call"],
    ["terminal failed", eventFrame("response.failed"), "response_failed"],
    [
      "EOF",
      eventFrame("response.output_text.delta", { delta: "p15_3" }),
      "premature_eof",
    ],
  ] as const)(
    "rejects second response %s without third request",
    async (_name, frames, code) => {
      const f = fixture();
      await f.load();
      f.network.enqueue(RESPONSES_ENDPOINT, sseText(callFrames()));
      f.network.enqueue(RESPONSES_ENDPOINT, sseText(frames));
      const result = await f.responses.runRoundTrip(f.context);
      expect(result).toMatchObject({
        outcome: "failed",
        code,
        attempts: 2,
        functionEchoValidated: true,
        finalMarkerAcknowledged: false,
      });
      expect((await f.responses.runCancellation(f.context)).code).toBe(
        "roundtrip_required"
      );
      expect(f.requests()).toHaveLength(2);
    }
  );
});

describe("S5 exact synthetic request, durable budget and cancellation", () => {
  it("sends exact explicit input and complete returned history, reserves before fetch, then proves only third-request cancellation", async () => {
    const f = fixture();
    await f.load();
    const first = chunkedSse(callFrames(), 11);
    const second = chunkedSse(ackFrames(), 5);
    f.network.enqueue(RESPONSES_ENDPOINT, () => {
      expect(f.s.store.getBudget().attempts).toBe(1);
      return first.response;
    });
    f.network.enqueue(RESPONSES_ENDPOINT, () => {
      expect(f.s.store.getBudget().attempts).toBe(2);
      return second.response;
    });
    const result = await f.responses.runRoundTrip(f.context);
    expect(result).toMatchObject({
      outcome: "pass",
      code: "roundtrip_complete",
      attempts: 2,
      functionEchoValidated: true,
      finalMarkerAcknowledged: true,
      first: {
        terminal: "completed",
        usage: {
          inputTokens: 20,
          outputTokens: 5,
          totalTokens: 25,
          cachedInputTokens: 4,
        },
      },
      second: { terminal: "completed" },
    });
    const [one, two] = f.requests().map((row) => readRequest(row.init));
    expect(Object.keys(one ?? {}).sort()).toEqual([
      "input",
      "model",
      "store",
      "stream",
      "tools",
    ]);
    expect(one).toMatchObject({
      model: f.context.modelSlug,
      store: false,
      stream: true,
      tools: [
        {
          type: "namespace",
          name: "feasibility",
          tools: [
            {
              type: "function",
              name: "echo",
              strict: true,
              parameters: {
                type: "object",
                properties: { value: { type: "string", enum: ["p15_3"] } },
                required: ["value"],
                additionalProperties: false,
              },
            },
          ],
        },
      ],
    });
    const original = one?.input;
    expect(original).toHaveLength(2);
    if (!Array.isArray(original)) throw new Error("Expected explicit input");
    expect(
      original.map((entry: unknown) => {
        if (
          typeof entry !== "object" ||
          entry === null ||
          !("role" in entry) ||
          !("content" in entry)
        )
          throw new Error("Invalid input shape");
        expect(typeof entry.content).toBe("string");
        return entry.role;
      })
    ).toEqual(["developer", "user"]);
    expect(two?.input).toEqual([
      ...(one?.input as unknown[]),
      REASON,
      CALL,
      {
        type: "function_call_output",
        call_id: CALL.call_id,
        output: '{"ok":true,"value":"p15_3"}',
      },
    ]);
    expect(two?.tools).toEqual(one?.tools);
    expect(first.body.locked).toBe(false);
    expect(second.body.locked).toBe(false);
    let pending: ReturnType<typeof pendingSse> | undefined;
    f.network.enqueue(RESPONSES_ENDPOINT, (init) => {
      expect(f.s.store.getBudget().attempts).toBe(3);
      if (!init?.signal) throw new Error("Missing synthetic request signal");
      pending = pendingSse(
        init.signal,
        eventFrame("response.output_text.delta", { delta: "Synthetic €" })
      );
      return pending.response;
    });
    const cancel = await f.responses.runCancellation(f.context);
    expect(cancel).toMatchObject({
      outcome: "pass",
      code: "cancellation_demonstrated",
      attempts: 3,
      textDeltaObserved: true,
      abortRequested: true,
      pendingReadRejected: true,
      cleanupVerified: true,
    });
    expect(pending?.aborted).toHaveBeenCalledTimes(1);
    expect(pending?.body.locked).toBe(false);
    expect(readRequest(f.requests()[2]?.init)).toMatchObject({
      store: false,
      stream: true,
      tools: [],
    });
    expect((await f.responses.runCancellation(f.context)).code).toBe(
      "budget_exhausted"
    );
    expect(f.requests()).toHaveLength(3);
    expect(new CredentialStore(f.s.base, f.s.deps).getBudget().attempts).toBe(
      3
    );
    const projected = JSON.stringify({ result, cancel });
    for (const v of [
      ACCESS,
      REFRESH,
      CALL.call_id,
      CALL.id,
      REASON.encrypted_content,
      "Synthetic reasoning",
    ])
      expect(projected).not.toContain(v);
    expect(f.network.unexpected).toEqual([]);
  });
  it.each([
    ["eligible", { eligible: false }, "eligibility_pending"],
    ["operator", { operatorStarted: false }, "operator_required"],
    ["plan only", { planOnlyConfirmed: false }, "plan_only_required"],
    [
      "credit fallback",
      { creditFallbackDisabled: false },
      "plan_only_required",
    ],
  ] as const)(
    "does not reserve or send with failed %s gate",
    async (_name, change, code) => {
      const f = fixture();
      await f.load();
      const result = await f.responses.runRoundTrip({
        ...f.context,
        authorization: { ...INFERENCE_APPROVED, ...change },
      });
      expect(result).toMatchObject({ outcome: "blocked", code });
      expect(f.s.store.getBudget().attempts).toBe(0);
      expect(f.requests()).toHaveLength(0);
    }
  );
  it("blocks no catalog, hidden model and cancellation-before-roundtrip with no request", async () => {
    const f = fixture();
    expect((await f.responses.runRoundTrip(f.context)).code).toBe(
      "catalog_required"
    );
    await f.load();
    expect(
      (
        await f.responses.runRoundTrip({
          ...f.context,
          modelSlug: "synthetic-hidden",
        })
      ).code
    ).toBe("model_not_selected");
    expect((await f.responses.runCancellation(f.context)).code).toBe(
      "roundtrip_required"
    );
    expect(f.s.store.getBudget().attempts).toBe(0);
    expect(f.requests()).toHaveLength(0);
  });
  it("does not send when durable reservation fails", async () => {
    const f = fixture();
    await f.load();
    vi.spyOn(f.s.store, "reserveInferenceAttempt").mockImplementationOnce(
      () => {
        throw new SigninFault("storage_failed");
      }
    );
    expect(await f.responses.runRoundTrip(f.context)).toMatchObject({
      code: "storage_failed",
      outcome: "blocked",
      attempts: null,
    });
    expect(f.requests()).toHaveLength(0);
    expect(f.s.store.getBudget().attempts).toBe(0);
  });
  it.each([401, 429, 503])(
    "reserves an uncertain or rejected HTTP %d request, never retries",
    async (status) => {
      const f = fixture();
      await f.load();
      f.network.enqueue(
        RESPONSES_ENDPOINT,
        json({ error: { message: DETAIL } }, status)
      );
      const result = await f.responses.runRoundTrip(f.context);
      expect(result.code).toBe(
        status === 401
          ? "reconnect_required"
          : status === 429
            ? "usage_limited"
            : "temporary_failure"
      );
      expect(f.s.store.getBudget().attempts).toBe(1);
      expect(f.requests()).toHaveLength(1);
      expect((await f.responses.runRoundTrip(f.context)).code).toBe(
        "attempt_order_invalid"
      );
      expect(f.requests()).toHaveLength(1);
    }
  );
  it("reserves an ambiguous network failure permanently across restart and never replays", async () => {
    const f = fixture();
    await f.load();
    f.network.enqueue(RESPONSES_ENDPOINT, () =>
      Promise.reject(new Error(DETAIL))
    );
    expect(await f.responses.runRoundTrip(f.context)).toMatchObject({
      code: "network_failed",
      attempts: 1,
    });
    const restartedStore = new CredentialStore(f.s.base, f.s.deps);
    const restarted = new SyntheticResponses({
      http: f.network.http,
      store: restartedStore,
      TextDecoder,
      clock: f.network.deps.clock,
    });
    f.network.enqueue(MODELS_ENDPOINT, json(MODELS));
    await restarted.loadCatalog({
      connection: f.connection,
      authorization: APPROVED,
    });
    expect((await restarted.runRoundTrip(f.context)).code).toBe(
      "attempt_order_invalid"
    );
    expect(f.requests()).toHaveLength(1);
  });
  it("does not accept cancellation proof if completed response is buffered with the delta", async () => {
    const f = fixture();
    await f.load();
    await f.roundtrip();
    f.network.enqueue(RESPONSES_ENDPOINT, sseText(ackFrames()));
    const result = await f.responses.runCancellation(f.context);
    expect(result).toMatchObject({
      outcome: "failed",
      code: "cancellation_not_demonstrated",
      attempts: 3,
      abortRequested: false,
      pendingReadRejected: false,
      cleanupVerified: true,
    });
    expect((await f.responses.runCancellation(f.context)).code).toBe(
      "budget_exhausted"
    );
    expect(f.requests()).toHaveLength(3);
  });
  it("never treats an unrelated reader failure as successful cancellation", async () => {
    const f = fixture();
    await f.load();
    await f.roundtrip();
    f.network.enqueue(RESPONSES_ENDPOINT, (init) => {
      if (!init?.signal) throw new Error("Missing synthetic request signal");
      return pendingSse(
        init.signal,
        eventFrame("response.output_text.delta", { delta: "Synthetic text" }),
        "other"
      ).response;
    });
    expect(await f.responses.runCancellation(f.context)).toMatchObject({
      outcome: "blocked",
      code: "cleanup_failed",
      evidence: { code: "cancellation_not_demonstrated" },
      attempts: 3,
      pendingReadRejected: false,
      cleanupVerified: false,
    });
    expect(f.requests()).toHaveLength(3);
  });
  it("does not count a reader that rejected before abort as pending-read proof", async () => {
    const f = fixture();
    await f.load();
    await f.roundtrip();
    let alreadyRejectedBeforeAbort = false;
    const read = vi.fn();
    const cancel = vi.fn(() => Promise.resolve());
    const releaseLock = vi.fn();
    f.network.enqueue(RESPONSES_ENDPOINT, (init) => {
      read.mockResolvedValueOnce({
        done: false,
        value: new TextEncoder().encode(
          eventFrame("response.output_text.delta", { delta: "Synthetic text" })
        ),
      });
      read.mockImplementationOnce(() => {
        alreadyRejectedBeforeAbort = init?.signal?.aborted === false;
        return Promise.reject(new DOMException(DETAIL, "AbortError"));
      });
      return {
        status: 200,
        headers: new Headers({ "Content-Type": "text/event-stream" }),
        body: { getReader: () => ({ read, cancel, releaseLock }) },
      } as unknown as Response;
    });
    const result = await f.responses.runCancellation(f.context);
    expect(alreadyRejectedBeforeAbort).toBe(true);
    expect(result).toMatchObject({
      outcome: "failed",
      code: "cancellation_not_demonstrated",
      pendingReadRejected: false,
      attempts: 3,
    });
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });
  it("times out an ignored native abort without counting it as proof or reopening budget", async () => {
    const f = fixture();
    await f.load();
    await f.roundtrip();
    vi.useFakeTimers();
    const seen = Promise.withResolvers<void>();
    let pending: ReturnType<typeof pendingSse> | undefined;
    f.network.enqueue(RESPONSES_ENDPOINT, (init) => {
      if (!init?.signal) throw new Error("Missing synthetic signal");
      init.signal.addEventListener("abort", () => seen.resolve(), {
        once: true,
      });
      pending = pendingSse(
        init.signal,
        eventFrame("response.output_text.delta", { delta: "Synthetic text" }),
        "ignored"
      );
      return pending.response;
    });
    const run = f.responses.runCancellation(f.context);
    await vi.advanceTimersByTimeAsync(1);
    await seen.promise;
    await vi.advanceTimersByTimeAsync(60000);
    const result = await run;
    expect(result).toMatchObject({
      outcome: "blocked",
      code: "timeout",
      attempts: 3,
      pendingReadRejected: false,
      cleanupVerified: false,
    });
    expect(pending?.aborted).toHaveBeenCalledTimes(1);
    expect(pending?.body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect((await f.responses.runCancellation(f.context)).code).toBe(
      "budget_exhausted"
    );
    expect(f.requests()).toHaveLength(3);
  });

  it("operator cancellation before request leaves the budget untouched", async () => {
    const f = fixture();
    await f.load();
    const cancellation = createProbeCancellation();
    cancellation.cancel();
    expect(
      (await f.responses.runRoundTrip({ ...f.context, cancellation })).code
    ).toBe("cancelled");
    expect(f.requests()).toHaveLength(0);
    expect(f.s.store.getBudget().attempts).toBe(0);
  });
  it("budget remains exhausted even after clearing transient state, sign-out and a fresh store", async () => {
    const f = fixture();
    for (let i = 0; i < 3; i++) f.s.store.reserveInferenceAttempt();
    f.responses.clearTransient();
    f.s.store.clearAllCredentials();
    f.s.store.saveConnection(f.connection);
    await f.load();
    expect((await f.responses.runRoundTrip(f.context)).code).toBe(
      "budget_exhausted"
    );
    expect(f.requests()).toHaveLength(0);
  });
});
