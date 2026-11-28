import { describe, expect, it, vi } from "vitest";
import { build } from "esbuild";

import { TOOL_DEFINITIONS } from "../src/shared/tools.js";
import type {
  CompletedTurn,
  ProviderTurnInput,
  ProviderTurnResult,
} from "../src/shared/provider.js";
import { buildOpenAiTools } from "../src/companion/providers/openai-tools.js";
import { eventFrame } from "./fixtures/chatgpt-signin.js";
import {
  ACCOUNT,
  BEARER,
  callFragments,
  completedResponse,
  CONVERSATION,
  delta,
  ENDPOINT,
  FINAL,
  INSTRUCTIONS,
  liveCall,
  makeProvider,
  message,
  MODEL,
  NOW,
  PRIVATE,
  reasoning,
  refusal,
  SNAPSHOT,
  stalled,
  stream,
  terminal,
  unsuccessful,
  USER,
} from "./fixtures/fake-openai-responses.js";

const definitions = () => structuredClone([...TOOL_DEFINITIONS]);
const requestInput = (
  overrides: Partial<ProviderTurnInput> = {}
): ProviderTurnInput => ({ tools: definitions(), ...overrides });

function success(result: ProviderTurnResult): CompletedTurn {
  expect(result.ok).toBe(true);
  if (!result.ok)
    throw new Error(
      `Unexpected sanitized provider failure: ${result.err.error}`
    );
  return result.turn;
}

function failure(result: ProviderTurnResult) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Unexpected completed provider turn");
  expect(Object.keys(result.err).sort()).toEqual(["detail", "error", "hint"]);
  expect(result.err.error).toMatch(/^(api_error|stream_error|aborted)$/);
  expect(typeof result.err.detail).toBe("string");
  expect(typeof result.err.hint).toBe("string");
  for (const sentinel of [
    BEARER,
    ACCOUNT,
    CONVERSATION,
    MODEL,
    PRIVATE,
    USER,
    SNAPSHOT,
    INSTRUCTIONS,
  ])
    expect(JSON.stringify(result)).not.toContain(sentinel);
  return result.err;
}

function expectRequest(request: Request) {
  expect(request.url).toBe(ENDPOINT);
  expect(request.method).toBe("POST");
  expect(request.headers.get("authorization")).toBe(`Bearer ${BEARER}`);
  expect(request.headers.get("content-type")).toContain("application/json");
  expect(request.headers.has("openai-organization")).toBe(false);
  expect(request.headers.has("openai-project")).toBe(false);
  expect(request.headers.has("cookie")).toBe(false);
  expect(request.redirect).toBe("error");
  expect([...request.headers.keys()].sort()).toEqual([
    "accept",
    "authorization",
    "content-type",
  ]);
}

describe("15.4B2 official Responses SDK provider — synthetic Fetch only", () => {
  it("does not add the SDK or companion provider to the production extension bundle", async () => {
    const graph = await build({
      entryPoints: ["src/extension/index.ts"],
      bundle: true,
      platform: "node",
      format: "cjs",
      loader: { ".html": "text" },
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    const paths = Object.keys(graph.metafile.inputs);
    expect(paths).toContain("src/extension/providers/legacy-claude.ts");
    expect(
      paths.filter(
        (path) =>
          path.includes("/companion/") ||
          path.includes("/companion-feasibility/") ||
          path.includes("/feasibility/") ||
          path.includes("/openai/") ||
          path.includes("/jsonwebtoken/")
      )
    ).toEqual([]);
  });

  it.each(["text/event-stream", null])(
    "uses the exact fixed route, bearer, request and all 17 wire schemas; successful text with MIME %j",
    async (mime) => {
      const textDeltas = vi.fn();
      const f = makeProvider(
        stream(
          delta("Synthetic ") +
            delta("final response €") +
            terminal([message()]),
          mime,
          7
        ).response
      );
      const turn = success(
        await f.provider.runTurn(
          requestInput({
            model: MODEL,
            snapshot: SNAPSHOT,
            onDelta: textDeltas,
          })
        )
      );
      expect(f.requests).toHaveLength(1);
      expectRequest(f.requests[0]);
      expect(f.bodies[0]).toEqual({
        model: MODEL,
        store: false,
        stream: true,
        input: [
          { type: "message", role: "developer", content: INSTRUCTIONS },
          { type: "message", role: "user", content: USER },
          { type: "message", role: "user", content: SNAPSHOT },
        ],
        tools: buildOpenAiTools(definitions()).wireTools,
      });
      expect(textDeltas.mock.calls).toEqual([
        ["Synthetic "],
        ["final response €"],
      ]);
      expect(turn).toEqual({
        stopReason: "end_turn",
        blocks: [{ type: "text", text: FINAL }],
        continuation: {
          type: "opaque",
          provider: "openai_responses",
          value: {},
        },
      });
      expect(f.provider.status()).toMatchObject({
        state: "completed_pending_append",
        items: 1,
      });
      expect(JSON.stringify(turn)).not.toContain(PRIVATE);
      f.provider.appendAssistant(turn);
      expect(f.provider.status()).toMatchObject({
        state: "ready",
        requestReady: false,
      });
      failure(await f.provider.runTurn(requestInput()));
      expect(f.requests).toHaveLength(1);
    }
  );

  it("preserves terminal refusal as text and never invents a call", async () => {
    const f = makeProvider(completedResponse([refusal()]));
    const turn = success(await f.provider.runTurn(requestInput({ tools: [] })));
    expect(turn.stopReason).toBe("end_turn");
    expect(turn.blocks).toEqual([{ type: "text", text: "Synthetic refusal" }]);
    expect(f.bodies[0]).toMatchObject({ tools: [] });
    f.provider.appendAssistant(turn);
  });

  it("offers only the selected tools and preserves exact interleaved terminal blocks, raw reasoning and result strings across requests", async () => {
    const one = { ...liveCall("read", "live_get_project"), arguments: "{ }" };
    const two = liveCall("write", "live_update_track", {
      track: "track:0:Drums",
      mute: true,
    });
    const raw = [
      reasoning(),
      one,
      message("Intermediate", "intermediate"),
      two,
    ];
    const offered = definitions().filter((tool) =>
      [one.name, two.name].includes(tool.name)
    );
    const f = makeProvider(completedResponse(raw), completedResponse());
    const turn = success(
      await f.provider.runTurn(
        requestInput({ tools: offered, snapshot: SNAPSHOT })
      )
    );
    expect(f.bodies[0]).toMatchObject({
      tools: buildOpenAiTools(offered).wireTools,
    });
    expect(turn.stopReason).toBe("tool_use");
    expect(turn.blocks).toEqual([
      { type: "tool_call", call: { id: "read", name: one.name, input: {} } },
      { type: "text", text: "Intermediate" },
      {
        type: "tool_call",
        call: {
          id: "write",
          name: two.name,
          input: { track: "track:0:Drums", mute: true },
        },
      },
    ]);
    expect(JSON.stringify(turn)).not.toContain(PRIVATE);
    expect(JSON.stringify(f.provider.status())).not.toContain(PRIVATE);
    f.provider.appendAssistant(turn);
    const readOutput = ' {"synthetic":true} \n';
    const errorOutput = '{"error":"user_declined"}';
    f.provider.appendToolResults([
      { toolUseId: "read", content: readOutput, summary: `${PRIVATE}-local` },
      { toolUseId: "write", isError: true, content: errorOutput },
    ]);
    const final = success(
      await f.provider.runTurn(requestInput({ tools: offered }))
    );
    expect(final.blocks).toEqual([{ type: "text", text: FINAL }]);
    const first = f.bodies[0] as { input: unknown[] };
    expect(f.bodies[1]).toEqual({
      ...(f.bodies[0] as object),
      input: [
        ...first.input,
        ...raw,
        { type: "function_call_output", call_id: "read", output: readOutput },
        {
          type: "function_call_output",
          call_id: "write",
          output: JSON.stringify({ is_error: true, content: errorOutput }),
        },
      ],
    });
    expect(JSON.stringify(f.bodies[1])).not.toContain(`${PRIVATE}-local`);
    f.provider.appendAssistant(final);
    expect(f.requests).toHaveLength(2);
  });

  const call = liveCall("unique", "live_get_project");
  it.each([
    ["unknown local name", [{ ...call, name: "not_a_registered_live_tool" }]],
    ["wrong namespace", [{ ...call, namespace: "foreign" }]],
    ["missing namespace", [{ ...call, namespace: undefined }]],
    ["duplicated call ID", [call, { ...call, id: "different-item-id" }]],
    ["duplicated item ID", [call, { ...call, call_id: "different-call-id" }]],
    ["empty call ID", [{ ...call, call_id: "" }]],
    ["overlong call ID", [{ ...call, call_id: "x".repeat(257) }]],
    ["whitespace ID", [{ ...call, call_id: "invalid call id" }]],
    ["incomplete call", [{ ...call, status: "in_progress" }]],
    ["async call", [{ ...call, async: true }]],
    ["indirect call", [{ ...call, caller: { type: "code_mode" } }]],
    ["malformed JSON", [{ ...call, arguments: '{"x":' }]],
    ["JSON array", [{ ...call, arguments: "[]" }]],
    ["JSON null", [{ ...call, arguments: "null" }]],
    ["JSON scalar", [{ ...call, arguments: '"synthetic"' }]],
    ["duplicate argument key", [{ ...call, arguments: '{"x":1,"x":2}' }]],
    [
      "escaped duplicate key",
      [{ ...call, arguments: '{"track":"one","tr\\u0061ck":"two"}' }],
    ],
    [
      "nested duplicate key",
      [{ ...call, arguments: '{"nested":{"x":1,"x":2}}' }],
    ],
    ["refusal mixed with call", [refusal(), call]],
    [
      "unrecognized output",
      [
        {
          type: "web_search_call",
          id: "synthetic-hosted",
          status: "completed",
        },
      ],
    ],
    ["empty completed output", []],
    [
      "overlarge argument",
      [{ ...call, arguments: JSON.stringify({ x: "é".repeat(70_000) }) }],
    ],
    [
      "too many output items",
      Array.from({ length: 129 }, (_, i) => message("synthetic", `item-${i}`)),
    ],
  ] as [string, unknown[]][])(
    "rejects terminal %s atomically without replay",
    async (_case, output) => {
      const f = makeProvider(
        stream(terminal(output), "text/event-stream", 4096).response
      );
      failure(await f.provider.runTurn(requestInput({ snapshot: SNAPSHOT })));
      expect(f.provider.status()).toMatchObject({
        state: "ready",
        items: 1,
        requestReady: false,
      });
      failure(await f.provider.runTurn(requestInput()));
      expect(f.requests).toHaveLength(1);
    }
  );

  it("rejects a registered but unoffered function", async () => {
    const f = makeProvider(
      completedResponse([
        liveCall("write", "live_update_track", {
          track: "track:0:Drums",
          mute: true,
        }),
      ])
    );
    failure(
      await f.provider.runTurn(
        requestInput({
          tools: definitions().filter(
            (tool) => tool.name === "live_get_project"
          ),
        })
      )
    );
    expect(f.requests).toHaveLength(1);
  });

  it("accepts nonduplicate keys with escapes and repeated key names in different objects", async () => {
    const f = makeProvider(
      completedResponse([
        {
          ...call,
          arguments: '{"outer":{"x":1},"other":{"x":2},"uni\\u0063ode":"€"}',
        },
      ])
    );
    const turn = success(await f.provider.runTurn(requestInput()));
    expect(turn.blocks).toEqual([
      {
        type: "tool_call",
        call: {
          id: call.call_id,
          name: call.name,
          input: { outer: { x: 1 }, other: { x: 2 }, unicode: "€" },
        },
      },
    ]);
  });

  it.each([
    ["item-only then EOF", callFragments(call)],
    ["partial text then EOF", delta(PRIVATE)],
    ["failed terminal", callFragments(call) + unsuccessful("response.failed")],
    [
      "incomplete terminal",
      callFragments(call) + unsuccessful("response.incomplete"),
    ],
    ["error event", unsuccessful("error")],
    [
      "completed event with incomplete response",
      terminal([message()], "incomplete"),
    ],
    ["malformed SSE", "event: response.completed\ndata: {invalid\n\n"],
    ["plain JSON non-SSE", JSON.stringify({ error: PRIVATE })],
  ])(
    "fails closed for %s and never dispatches a retry",
    async (_case, frames) => {
      const f = makeProvider(stream(frames, null).response);
      failure(await f.provider.runTurn(requestInput({ snapshot: SNAPSHOT })));
      expect(f.provider.status()).toMatchObject({
        state: "ready",
        items: 1,
        requestReady: false,
      });
      failure(await f.provider.runTurn(requestInput()));
      expect(f.requests).toHaveLength(1);
    }
  );

  it("rejects contradictory completed-item evidence rather than inventing history", async () => {
    const f = makeProvider(
      stream(
        callFragments(call) +
          terminal([{ ...call, arguments: '{"different":true}' }])
      ).response
    );
    failure(await f.provider.runTurn(requestInput()));
    expect(f.requests).toHaveLength(1);
  });

  it("uses matching completed-item encrypted reasoning when the terminal omits only that provider continuation", async () => {
    const full = reasoning();
    const withoutEncrypted = { ...full, encrypted_content: undefined };
    const frames =
      eventFrame("response.output_item.done", { output_index: 0, item: full }) +
      terminal([withoutEncrypted, call]);
    const f = makeProvider(stream(frames).response, completedResponse());
    const turn = success(await f.provider.runTurn(requestInput()));
    expect(turn.blocks).toEqual([
      {
        type: "tool_call",
        call: { id: call.call_id, name: call.name, input: {} },
      },
    ]);
    f.provider.appendAssistant(turn);
    f.provider.appendToolResults([{ toolUseId: call.call_id, content: "{}" }]);
    success(await f.provider.runTurn(requestInput()));
    expect((f.bodies[1] as { input: unknown[] }).input).toContainEqual(full);
  });

  it.each(["missing", "conflicting"])(
    "fails closed if required reasoning is %s",
    async (kind) => {
      const full = reasoning();
      const frames =
        kind === "missing"
          ? terminal([{ ...full, encrypted_content: undefined }, call])
          : eventFrame("response.output_item.done", {
              output_index: 0,
              item: full,
            }) +
            terminal([
              { ...full, encrypted_content: "conflicting-private-reasoning" },
              call,
            ]);
      const f = makeProvider(stream(frames).response);
      failure(await f.provider.runTurn(requestInput()));
      expect(f.requests).toHaveLength(1);
      expect(f.provider.status()).toMatchObject({
        items: 1,
        requestReady: false,
      });
    }
  );

  it("does not retry retryable status or rejected Fetch and sanitizes diagnostics", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      for (const reply of [
        new Response(JSON.stringify({ error: { message: PRIVATE } }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "0" },
        }),
        new Response(PRIVATE, { status: 503 }),
        () => {
          throw new Error(PRIVATE);
        },
      ]) {
        const f = makeProvider(reply);
        failure(await f.provider.runTurn(requestInput()));
        expect(f.requests).toHaveLength(1);
      }
      const logs = JSON.stringify([
        ...log.mock.calls,
        ...warn.mock.calls,
        ...error.mock.calls,
      ]);
      for (const secret of [
        PRIVATE,
        BEARER,
        USER,
        ACCOUNT,
        CONVERSATION,
        INSTRUCTIONS,
      ])
        expect(logs).not.toContain(secret);
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("rejects unsupported model/options and invalid tool offers before Fetch", async () => {
    const bad: Partial<ProviderTurnInput>[] = [
      { model: "other-model" },
      { maxTokens: 200 },
      {
        previous_response_id: "synthetic-foreign-history",
      } as Partial<ProviderTurnInput>,
      { tools: [definitions()[0], definitions()[0]] },
      {
        tools: [{ type: "opaque", provider: "other_provider", value: PRIVATE }],
      },
      { tools: [{ ...definitions()[0], name: "unknown" }] },
    ];
    for (const options of bad) {
      const f = makeProvider();
      failure(await f.provider.runTurn(requestInput(options)));
      expect(f.requests).toHaveLength(0);
    }
  });

  it("rejects an already aborted signal before dispatch", async () => {
    const abort = new AbortController();
    abort.abort(PRIVATE);
    const f = makeProvider();
    expect(
      failure(await f.provider.runTurn(requestInput({ signal: abort.signal })))
        .error
    ).toBe("aborted");
    expect(f.requests).toHaveLength(0);
  });

  it.each([
    "missing",
    "wrong account",
    "wrong catalog model",
    "expired",
    "blank bearer",
    "missing plan scope",
    "plan only unconfirmed",
    "credit fallback enabled",
    "accessor failure",
  ])("checks %s credential before any dispatch", async (scenario) => {
    const f = makeProvider();
    const good = f.selected;
    if (scenario === "accessor failure")
      f.credential.mockImplementation(() => {
        throw new Error(PRIVATE);
      });
    else if (scenario === "missing") f.credential.mockReturnValue(undefined);
    else if (scenario === "wrong account")
      f.credential.mockReturnValue({
        ...good,
        accountBinding: "another-account",
      });
    else if (scenario === "expired")
      f.credential.mockReturnValue({ ...good, expiresAt: NOW });
    else if (scenario === "wrong catalog model")
      f.credential.mockReturnValue({ ...good, model: "other-catalog-model" });
    else if (scenario === "missing plan scope")
      f.credential.mockReturnValue({ ...good, scopes: [] });
    else if (scenario === "plan only unconfirmed")
      f.credential.mockReturnValue({ ...good, planOnlyConfirmed: false });
    else if (scenario === "credit fallback enabled")
      f.credential.mockReturnValue({ ...good, creditFallbackDisabled: false });
    else f.credential.mockReturnValue({ ...good, accessToken: "" });
    failure(await f.provider.runTurn(requestInput()));
    expect(f.requests).toHaveLength(0);
  });

  it("checks credential expiry and account binding anew for each tool followup", async () => {
    const f = makeProvider(completedResponse([call]));
    const turn = success(await f.provider.runTurn(requestInput()));
    f.provider.appendAssistant(turn);
    f.provider.appendToolResults([{ toolUseId: call.call_id, content: "{}" }]);
    f.credential.mockReturnValue({ ...f.selected, expiresAt: NOW });
    failure(await f.provider.runTurn(requestInput()));
    expect(f.requests).toHaveLength(1);
  });

  it("constructor copies the binding and fixed developer instructions; a copied or foreign turn cannot append", async () => {
    const f = makeProvider(completedResponse());
    f.options.binding.accountBinding = "other-account";
    f.options.binding.conversationId = "other-conversation";
    f.options.binding.model = "other-model";
    f.options.developerInstructions = "Not the constructor instructions";
    const turn = success(await f.provider.runTurn(requestInput()));
    expect(f.bodies[0]).toMatchObject({
      model: MODEL,
      input: [
        { type: "message", role: "developer", content: INSTRUCTIONS },
        { type: "message", role: "user", content: USER },
      ],
    });
    expect(() => f.provider.appendAssistant(structuredClone(turn))).toThrow(
      "invalid_continuation"
    );
    f.provider.appendAssistant(turn);
    expect(() => f.provider.appendAssistant(turn)).toThrow(
      "invalid_continuation"
    );
  });

  it.each(["cancel", "credential change", "dispose"])(
    "invalidates issued pending continuation on %s before canonical append",
    async (kind) => {
      const abort = new AbortController();
      const f = makeProvider(completedResponse([call]));
      const turn = success(
        await f.provider.runTurn(requestInput({ signal: abort.signal }))
      );
      if (kind === "cancel") abort.abort(PRIVATE);
      else if (kind === "credential change")
        f.credential.mockReturnValue({
          ...f.selected,
          accessToken: "different-synthetic-token",
        });
      else f.provider.dispose();
      expect(() => f.provider.appendAssistant(turn)).toThrow();
      expect(() =>
        f.provider.appendToolResults([
          { toolUseId: call.call_id, content: "{}" },
        ])
      ).toThrow("invalid_results");
      failure(await f.provider.runTurn(requestInput()));
      expect(f.requests).toHaveLength(1);
    }
  );

  it("60s overall timeout settles a stalled SDK stream, releases reader, and cannot replay", async () => {
    vi.useFakeTimers();
    try {
      const waiting = stalled(delta("Synthetic displayable fragment"));
      const f = makeProvider(waiting.response);
      const task = f.provider.runTurn(requestInput());
      await waiting.readStarted;
      await vi.advanceTimersByTimeAsync(59_999);
      expect(f.provider.status()).toMatchObject({ state: "request_in_flight" });
      await vi.advanceTimersByTimeAsync(5_001);
      failure(await task);
      expect(waiting.body.locked).toBe(false);
      expect(f.requests).toHaveLength(1);
      expect(f.provider.status()).toMatchObject({
        state: "ready",
        items: 1,
        requestReady: false,
      });
      failure(await f.provider.runTurn(requestInput()));
      expect(f.requests).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounded cleanup cannot hang on an uncooperative late Fetch; its eventual body is cancelled without publication", async () => {
    vi.useFakeTimers();
    try {
      const entered = Promise.withResolvers<void>();
      const late = Promise.withResolvers<Response>();
      const body = stalled();
      const onDelta = vi.fn();
      const f = makeProvider(() => {
        entered.resolve();
        return late.promise;
      });
      const task = f.provider.runTurn(requestInput({ onDelta }));
      await entered.promise;
      await vi.advanceTimersByTimeAsync(65_001);
      failure(await task);
      expect(f.requests).toHaveLength(1);
      expect(f.requests[0].signal.aborted).toBe(true);
      late.resolve(body.response);
      await vi.advanceTimersByTimeAsync(0);
      expect(body.cancelled).toHaveBeenCalledTimes(1);
      expect(body.body.locked).toBe(false);
      expect(onDelta).not.toHaveBeenCalled();
      failure(await f.provider.runTurn(requestInput()));
      expect(f.requests).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("credential changes during a pending stream cannot publish its terminal", async () => {
    const waiting = stalled(delta("Synthetic text before credential change"));
    const f = makeProvider(waiting.response);
    const task = f.provider.runTurn(requestInput());
    await waiting.readStarted;
    f.credential.mockReturnValue(undefined);
    waiting.completeLate(terminal([message()]));
    failure(await task);
    expect(waiting.body.locked).toBe(false);
    expect(f.requests).toHaveLength(1);
    expect(f.provider.status()).not.toMatchObject({
      state: "completed_pending_append",
    });
  });

  it("rejects a synthetic redirect without following any Location", async () => {
    const f = makeProvider(
      new Response(null, {
        status: 302,
        headers: { location: "https://example.invalid/synthetic" },
      })
    );
    failure(await f.provider.runTurn(requestInput()));
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].redirect).toBe("error");
  });

  it("overlapping request cannot replace the active turn, and cancellation drops its late terminal", async () => {
    const abort = new AbortController();
    const waiting = stalled(delta("Synthetic fragment"));
    const f = makeProvider(waiting.response);
    const task = f.provider.runTurn(
      requestInput({ signal: abort.signal, snapshot: SNAPSHOT })
    );
    await waiting.readStarted;
    failure(await f.provider.runTurn(requestInput()));
    expect(f.requests).toHaveLength(1);
    abort.abort(PRIVATE);
    expect(failure(await task).error).toBe("aborted");
    waiting.completeLate(terminal([message()]));
    expect(f.provider.status()).toMatchObject({
      state: "ready",
      items: 1,
      requestReady: false,
    });
    failure(await f.provider.runTurn(requestInput()));
    expect(waiting.body.locked).toBe(false);
    expect(f.requests).toHaveLength(1);
  });

  it("disposal during a stalled turn cancels the request and prevents late revival", async () => {
    const waiting = stalled(delta("Synthetic fragment"));
    const f = makeProvider(waiting.response);
    const task = f.provider.runTurn(requestInput());
    await waiting.readStarted;
    f.provider.dispose();
    failure(await task);
    waiting.completeLate(terminal([message()]));
    expect(f.provider.status()).toMatchObject({
      state: "disposed",
      items: 0,
      requestReady: false,
    });
    failure(await f.provider.runTurn(requestInput()));
    expect(f.requests).toHaveLength(1);
  });

  it("bounds an oversized snapshot and oversized completed raw reasoning before commit", async () => {
    const f = makeProvider();
    failure(
      await f.provider.runTurn(requestInput({ snapshot: "x".repeat(8001) }))
    );
    expect(f.requests).toHaveLength(0);
    const fat = makeProvider(
      stream(
        terminal([
          { ...reasoning(), encrypted_content: "x".repeat(1024 * 1024) },
          message(),
        ]),
        "text/event-stream",
        4096
      ).response
    );
    failure(await fat.provider.runTurn(requestInput()));
    expect(fat.requests).toHaveLength(1);
    expect(fat.provider.status()).toMatchObject({
      items: 1,
      requestReady: false,
    });
  });
});
