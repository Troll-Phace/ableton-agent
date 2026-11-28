import { TextDecoder } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProbeCancellation } from "../src/extension/feasibility/contracts.js";
import type { OfficialRequest } from "../src/extension/feasibility/official-http.js";
import { OAuthLifecycle } from "../src/extension/feasibility/oauth.js";
import { SigninSession } from "../src/extension/feasibility/signin-session.js";
import {
  ResponseDiagnostics,
  safeResponseDiagnostics,
} from "../src/extension/feasibility/response-diagnostics.js";
import {
  collectCompletedResponse,
  failedResponseEvidence,
  finalizeResponseEvidence,
  responsesErrorCode,
  SyntheticResponses,
} from "../src/extension/feasibility/responses.js";
import {
  MODELS_ENDPOINT,
  RESPONSES_ENDPOINT,
  TOKEN_ENDPOINT,
} from "../src/extension/feasibility/signin-contracts.js";
import {
  ACCESS,
  APPROVED,
  eventFrame,
  fakeHttp,
  json,
  makeConnection,
  makeOAuthFixture,
  makeStorage,
  tokenPayload,
} from "./fixtures/chatgpt-signin.js";
import {
  completedText,
  diagnosticWire,
  encode,
  PRIVATE_SENTINEL,
  textDelta,
} from "./fixtures/chatgpt-response-diagnostics.js";

const request = {
  bearer: ACCESS,
  json: {
    model: "synthetic-model",
    store: false,
    stream: true,
    input: "p15_3",
  },
};
const secretFree = (value: unknown) => {
  const encoded = JSON.stringify(value);
  expect(encoded).not.toContain(PRIVATE_SENTINEL);
  expect(encoded).not.toContain(ACCESS);
  expect(encoded).not.toContain(RESPONSES_ENDPOINT);
};

async function consume(
  network: ReturnType<typeof fakeHttp>,
  input: OfficialRequest = request
) {
  const diagnostics = new ResponseDiagnostics();
  try {
    const captured = await network.http.requestStream(
      input,
      (body) =>
        collectCompletedResponse(
          body,
          TextDecoder,
          "acknowledgement",
          undefined,
          diagnostics
        ),
      diagnostics
    );
    return finalizeResponseEvidence(captured.evidence, diagnostics);
  } catch (error) {
    return failedResponseEvidence(responsesErrorCode(error), diagnostics);
  }
}

afterEach(() => vi.useRealTimers());

describe("D2 actual HTTP and completed-response diagnostic boundaries", () => {
  it("distinguishes request serialization failure from a request that reached Fetch", async () => {
    const network = fakeHttp();
    const result = await consume(network, {
      ...request,
      json: {
        ...request.json,
        toJSON() {
          throw new Error(PRIVATE_SENTINEL);
        },
      },
    });
    expect(network.calls).toHaveLength(0);
    expect(result).toMatchObject({
      bytes: null,
      events: null,
      diagnostics: {
        stages: {
          requestPreparation: "failed",
          fetch: "not_started",
          reader: "not_started",
          consumer: "not_started",
        },
        responseReceived: false,
        httpStatus: null,
        mimeCategory: "unobserved",
        transportBytes: null,
        transportChunks: null,
        parserBytes: null,
        framedEvents: null,
        consumerEvents: null,
        firstRead: "not_started",
        firstReadSettled: false,
        primaryFailureStage: "requestPreparation",
      },
    });
    secretFree(result);
  });

  it("retains rejected Fetch evidence without fabricating zero counts", async () => {
    const network = fakeHttp();
    network.enqueue(RESPONSES_ENDPOINT, () => {
      throw new Error(PRIVATE_SENTINEL);
    });
    const result = await consume(network);
    expect(network.calls).toHaveLength(1);
    expect(result).toMatchObject({
      bytes: null,
      events: null,
      diagnostics: {
        stages: {
          requestPreparation: "passed",
          fetch: "failed",
          consumer: "not_started",
        },
        responseReceived: false,
        httpStatus: null,
        transportBytes: null,
        parserBytes: null,
        primaryFailureStage: "fetch",
        firstReadSettled: false,
      },
    });
    secretFree(result);
  });

  it("records a resolved response with an invalid status without accepting it", async () => {
    const network = fakeHttp();
    const wire = diagnosticWire([], { status: 999 });
    network.enqueue(RESPONSES_ENDPOINT, wire.asResponse());
    expect(await consume(network)).toMatchObject({
      code: "invalid_response",
      diagnostics: {
        responseReceived: true,
        httpStatus: null,
        primaryFailureStage: "status",
        transportBytes: null,
      },
    });
    expect(wire.reader.read).not.toHaveBeenCalled();
  });

  it.each([
    [null, "missing"],
    ["application/json", "json"],
    [`application/${PRIVATE_SENTINEL}`, "other"],
    [PRIVATE_SENTINEL, "invalid"],
  ] as const)(
    "classifies non-SSE MIME %s without consuming a success body",
    async (mime, category) => {
      const network = fakeHttp();
      const wire = diagnosticWire([encode(completedText())], { mime });
      network.enqueue(RESPONSES_ENDPOINT, wire.asResponse());
      const result = await consume(network);
      expect(result).toMatchObject({
        code: "invalid_response",
        bytes: null,
        events: null,
        diagnostics: {
          httpStatus: 200,
          mimeCategory: category,
          parserBytes: null,
          consumerEvents: null,
          firstRead: "not_started",
          primaryFailureStage: "headers",
        },
      });
      expect(wire.reader.read).not.toHaveBeenCalled();
      secretFree(result);
    }
  );

  it("records inaccessible content type without exposing the exception", async () => {
    const network = fakeHttp();
    const wire = diagnosticWire();
    wire.response.headers.get.mockImplementation(() => {
      throw new Error(PRIVATE_SENTINEL);
    });
    network.enqueue(RESPONSES_ENDPOINT, wire.asResponse());
    const result = await consume(network);
    expect(result.diagnostics).toMatchObject({
      httpStatus: 200,
      mimeCategory: "invalid",
      primaryFailureStage: "headers",
      parserBytes: null,
    });
    expect(wire.reader.read).not.toHaveBeenCalled();
    secretFree(result);
  });

  it("distinguishes no body from an allocated reader returning empty EOF", async () => {
    const missing = fakeHttp();
    const absent = diagnosticWire();
    missing.enqueue(RESPONSES_ENDPOINT, {
      ...absent.response,
      body: null,
    } as unknown as Response);
    expect(await consume(missing)).toMatchObject({
      diagnostics: {
        bodyPresent: false,
        transportBytes: null,
        transportChunks: null,
        firstRead: "not_started",
        firstReadSettled: false,
      },
    });
    expect(absent.body.getReader).not.toHaveBeenCalled();
    const network = fakeHttp();
    const wire = diagnosticWire();
    network.enqueue(RESPONSES_ENDPOINT, wire.asResponse());
    expect(await consume(network)).toMatchObject({
      code: "premature_eof",
      bytes: 0,
      events: 0,
      diagnostics: {
        bodyPresent: true,
        transportBytes: 0,
        transportChunks: 0,
        parserBytes: 0,
        framedEvents: 0,
        consumerEvents: 0,
        firstRead: "eof",
        firstReadSettled: true,
        observedTerminal: "not_observed",
      },
    });
    expect(wire.reader.read).toHaveBeenCalledTimes(1);
  });

  it.each(["throws", "invalid"])(
    "leaves counters unobserved when reader acquisition %s",
    async (kind) => {
      const network = fakeHttp();
      const wire = diagnosticWire();
      wire.body.getReader.mockImplementation(() => {
        if (kind === "throws") throw new Error(PRIVATE_SENTINEL);
        return undefined as unknown as typeof wire.reader;
      });
      network.enqueue(RESPONSES_ENDPOINT, wire.asResponse());
      expect((await consume(network)).diagnostics).toMatchObject({
        bodyPresent: true,
        transportBytes: null,
        parserBytes: null,
        firstRead: "not_started",
        primaryFailureStage: "reader",
      });
    }
  );

  it("records first read rejection separately from EOF", async () => {
    const network = fakeHttp();
    const wire = diagnosticWire([], { readError: true });
    network.enqueue(RESPONSES_ENDPOINT, wire.asResponse());
    expect((await consume(network)).diagnostics).toMatchObject({
      firstRead: "rejected",
      firstReadSettled: true,
      transportBytes: 0,
      transportChunks: 0,
      parserBytes: 0,
      observedTerminal: "not_observed",
      primaryFailureStage: "read",
    });
  });

  it.each([
    [new Uint8Array([0xff, 10, 10]), "malformed_sse"],
    [encode("data: {invalid}\n\n"), "malformed_sse"],
    [encode('event: one\ndata: {"type":"two"}\n\n'), "malformed_sse"],
    [encode('data: {"type":"response.created"}'), "premature_eof"],
  ] as const)(
    "preserves nonempty bytes on malformed or truncated wire %#",
    async (bytes, code) => {
      const network = fakeHttp();
      network.enqueue(RESPONSES_ENDPOINT, diagnosticWire([bytes]).asResponse());
      const evidence = await consume(network);
      expect(evidence).toMatchObject({
        code,
        bytes: bytes.byteLength,
        diagnostics: {
          transportBytes: bytes.byteLength,
          transportChunks: 1,
          parserBytes: bytes.byteLength,
          consumerEvents: 0,
          firstRead: "bytes",
          firstReadSettled: true,
          observedTerminal: "not_observed",
        },
      });
    }
  );

  it("retains completed frame and consumer counts on subsequent semantic invalid_response", async () => {
    const network = fakeHttp();
    const frames = [encode(textDelta()), encode(textDelta(42))];
    network.enqueue(RESPONSES_ENDPOINT, diagnosticWire(frames).asResponse());
    const evidence = await consume(network);
    expect(evidence).toMatchObject({
      code: "invalid_response",
      terminal: "malformed",
      events: 2,
      diagnostics: {
        transportBytes: frames[0].length + frames[1].length,
        framedEvents: 2,
        consumerEvents: 2,
        primaryFailureStage: "semantic",
        observedTerminal: "not_observed",
      },
    });
    secretFree(evidence);
  });

  it("accepts SSE parameters and exact completed acknowledgement, not arbitrary text", async () => {
    const network = fakeHttp();
    const frames = [encode(textDelta()), encode(completedText())];
    network.enqueue(
      RESPONSES_ENDPOINT,
      diagnosticWire(frames, {
        mime: `text/event-stream; charset=utf-8; synthetic=${PRIVATE_SENTINEL}`,
      }).asResponse()
    );
    const result = await consume(network);
    expect(result).toMatchObject({
      code: "response_completed",
      terminal: "completed",
      events: 2,
      diagnostics: {
        mimeCategory: "sse",
        observedTerminal: "completed",
        consumerEvents: 2,
        primaryFailureCode: null,
        cleanupFailureCode: null,
        stages: { terminal: "passed", cleanup: "passed" },
      },
    });
    secretFree(result);
    const other = fakeHttp();
    other.enqueue(
      RESPONSES_ENDPOINT,
      diagnosticWire([encode(completedText(PRIVATE_SENTINEL))]).asResponse()
    );
    expect(await consume(other)).toMatchObject({
      code: "missing_acknowledgement",
      terminal: "malformed",
      diagnostics: { observedTerminal: "completed" },
    });
  });

  it.each([
    ["response.failed", "failed", "response_failed"],
    ["response.incomplete", "incomplete", "response_incomplete"],
  ] as const)(
    "retains actual observed terminal %s",
    async (type, terminal, code) => {
      const network = fakeHttp();
      network.enqueue(
        RESPONSES_ENDPOINT,
        diagnosticWire([
          encode(
            eventFrame(type, {
              response: { status: terminal, id: PRIVATE_SENTINEL },
            })
          ),
        ]).asResponse()
      );
      expect(await consume(network)).toMatchObject({
        code,
        terminal,
        diagnostics: { observedTerminal: terminal, primaryFailureCode: code },
      });
    }
  );

  it.each([
    ["subscription_sharing_usage_limit_exceeded", "usage_limited"],
    ["subscription_sharing_usage_unavailable", "temporary_failure"],
  ] as const)(
    "allowlists documented stream failure %s without retry",
    async (providerCode, code) => {
      const network = fakeHttp();
      network.enqueue(
        RESPONSES_ENDPOINT,
        diagnosticWire([
          encode(
            eventFrame("response.failed", {
              response: {
                status: "failed",
                error: { code: providerCode, message: PRIVATE_SENTINEL },
              },
            })
          ),
        ]).asResponse()
      );
      const result = await consume(network);
      expect(result).toMatchObject({
        code,
        terminal: "failed",
        diagnostics: {
          observedTerminal: "failed",
          providerErrorCode: providerCode,
        },
      });
      expect(network.calls).toHaveLength(1);
      secretFree(result);
    }
  );

  it.each([PRIVATE_SENTINEL, "subscription_sharing_usage_limit_exceeded"])(
    "rejects unknown or conflicting stream codes",
    async (code) => {
      const network = fakeHttp();
      network.enqueue(
        RESPONSES_ENDPOINT,
        diagnosticWire([
          encode(
            eventFrame("response.failed", {
              response: { status: "failed", error: { code } },
              error: { code: PRIVATE_SENTINEL },
            })
          ),
        ]).asResponse()
      );
      const result = await consume(network);
      expect(result).toMatchObject({
        code: "response_failed",
        diagnostics: { providerErrorCode: null, observedTerminal: "failed" },
      });
      secretFree(result);
    }
  );

  it.each([
    [JSON.stringify({ error: { message: PRIVATE_SENTINEL } }), "error"],
    [JSON.stringify({ detail: PRIVATE_SENTINEL }), "detail"],
    [JSON.stringify({ unrelated: PRIVATE_SENTINEL }), "other"],
    [PRIVATE_SENTINEL, "unreadable"],
  ])(
    "classifies only the existing bounded HTTP error-body shape %#",
    async (raw, shape) => {
      const network = fakeHttp();
      const wire = diagnosticWire([encode(raw)], {
        status: 403,
        mime: "application/json",
      });
      network.enqueue(RESPONSES_ENDPOINT, wire.asResponse());
      const result = await consume(network);
      expect(result).toMatchObject({
        code: "plan_disabled",
        diagnostics: {
          httpStatus: 403,
          mimeCategory: "json",
          transportBytes: encode(raw).length,
          errorBodyShape: shape,
          parserBytes: null,
          consumerEvents: null,
        },
      });
      expect(wire.reader.read).toHaveBeenCalledTimes(2);
      secretFree(result);
    }
  );

  it("maps arbitrary event types to other and exposes immutable fixed evidence", async () => {
    const network = fakeHttp();
    network.enqueue(
      RESPONSES_ENDPOINT,
      diagnosticWire([
        encode(eventFrame(PRIVATE_SENTINEL, { data: PRIVATE_SENTINEL })),
      ]).asResponse()
    );
    const result = await consume(network);
    expect(result.diagnostics).toMatchObject({
      lastEventCategory: "other",
      observedTerminal: "not_observed",
    });
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
    expect(Object.isFrozen(result.diagnostics?.stages)).toBe(true);
    secretFree(result);
    const raw = {
      ...result.diagnostics!,
      providerErrorCode: PRIVATE_SENTINEL,
      lastEventCategory: PRIVATE_SENTINEL,
      transportBytes: Infinity,
      secret: PRIVATE_SENTINEL,
    };
    const safe = safeResponseDiagnostics(
      raw as unknown as NonNullable<typeof result.diagnostics>
    );
    expect(safe).toMatchObject({
      providerErrorCode: null,
      lastEventCategory: null,
      transportBytes: null,
    });
    secretFree(safe);
  });

  it("records bounded transport overrun before the parser accepts any bytes", async () => {
    const network = fakeHttp();
    network.enqueue(
      RESPONSES_ENDPOINT,
      diagnosticWire([new Uint8Array(1048578)]).asResponse()
    );
    const result = await consume(network);
    expect(result).toMatchObject({
      code: "response_limit",
      diagnostics: {
        transportBytes: 1048577,
        transportChunks: 1,
        parserBytes: 0,
        framedEvents: 0,
      },
    });
  });

  it("retains consumption and primary failure through the real SyntheticResponses outer catch and cleanup failure", async () => {
    const storage = makeStorage();
    try {
      const connection = makeConnection();
      storage.store.saveConnection(connection);
      const network = fakeHttp();
      const responses = new SyntheticResponses({
        http: network.http,
        store: storage.store,
        TextDecoder,
        clock: network.deps.clock,
      });
      network.enqueue(
        MODELS_ENDPOINT,
        json({
          models: [
            {
              visibility: "list",
              slug: "synthetic-model",
              display_name: "Synthetic model",
            },
          ],
        })
      );
      await responses.loadCatalog({ connection, authorization: APPROVED });
      const frames = [encode(textDelta()), encode(textDelta(42))];
      const wire = diagnosticWire(frames, { releaseError: true });
      network.enqueue(RESPONSES_ENDPOINT, wire.asResponse());
      const result = await responses.runRoundTrip({
        connection,
        modelSlug: "synthetic-model",
        authorization: {
          ...APPROVED,
          planOnlyConfirmed: true,
          creditFallbackDisabled: true,
        },
      });
      expect(result).toMatchObject({
        attempts: 1,
        code: "cleanup_failed",
        functionEchoValidated: false,
        first: { events: 2, bytes: frames[0].length + frames[1].length },
      });
      expect(result.first?.diagnostics).toMatchObject({
        primaryFailureStage: "semantic",
        primaryFailureCode: "invalid_response",
        cleanupFailureCode: "cleanup_failed",
        consumerEvents: 2,
        stages: { readerRelease: "failed", cleanup: "failed" },
      });
      expect(
        network.calls.filter((call) => call.url === RESPONSES_ENDPOINT)
      ).toHaveLength(1);
      secretFree(result);
    } finally {
      storage.dispose();
    }
  });

  it.each([false, true])(
    "preserves nullable counters and observed progress through the actual session projection (consume=%s)",
    async (consumed) => {
      const storage = makeStorage();
      try {
        storage.store.saveConnection(makeConnection());
        const f = makeOAuthFixture(storage);
        const responses = new SyntheticResponses({
          http: f.network.http,
          store: storage.store,
          TextDecoder,
          clock: f.network.deps.clock,
        });
        const session = new SigninSession({
          eligibilityBasisReady: true,
          clock: f.network.deps.clock,
          oauth: new OAuthLifecycle(f.deps),
          responses,
          store: storage.store,
          hostPreflight: () =>
            Promise.resolve({
              nativeTransport: true,
              callbackBinding: true,
              privateStorage: true,
              bundledVerifier: true,
            }),
        });
        const action = { operatorStarted: true };
        f.network.enqueueDiscovery();
        f.network.enqueueJwks();
        expect(await session.preflight(action)).toMatchObject({
          preflightReady: true,
        });
        f.network.enqueue(
          TOKEN_ENDPOINT,
          json(tokenPayload({ id_token: undefined }))
        );
        expect(await session.refresh(action)).toMatchObject({
          refreshVerified: true,
        });
        f.network.enqueue(
          MODELS_ENDPOINT,
          json({
            models: [
              {
                visibility: "list",
                slug: "synthetic-model",
                display_name: "Synthetic model",
              },
            ],
          })
        );
        expect(await session.loadModels(action)).toMatchObject({
          code: "models_loaded",
        });
        expect(session.selectModel("synthetic-model", action)).toMatchObject({
          selectedModelSlug: "synthetic-model",
        });
        expect(
          session.confirmPlanOnly({
            ...action,
            planOnlyConfirmed: true,
            creditFallbackDisabled: true,
          })
        ).toMatchObject({
          planOnlyConfirmed: true,
          creditFallbackDisabled: true,
        });
        const frames = [encode(textDelta()), encode(textDelta(42))];
        f.network.enqueue(RESPONSES_ENDPOINT, () => {
          if (!consumed) throw new Error(PRIVATE_SENTINEL);
          return diagnosticWire(frames, { releaseError: true }).asResponse();
        });
        const snapshot = await session.runRoundTrip(action);
        const bytes = consumed
          ? frames.reduce((sum, frame) => sum + frame.length, 0)
          : null;
        expect(snapshot).toMatchObject({
          attempts: 1,
          roundtrip: {
            first: {
              bytes,
              events: consumed ? 2 : null,
              diagnostics: {
                transportBytes: bytes,
                parserBytes: bytes,
                cleanupFailureCode: consumed ? "cleanup_failed" : null,
              },
            },
          },
        });
        expect(session.snapshot().roundtrip).toEqual(snapshot.roundtrip);
        secretFree(snapshot);
      } finally {
        storage.dispose();
      }
    }
  );

  it("records a pending first read, cancellation and timeout without a replay", async () => {
    vi.useFakeTimers();
    for (const reason of ["cancelled", "timeout"] as const) {
      const network = fakeHttp();
      const wire = diagnosticWire();
      wire.reader.read.mockImplementation(() => new Promise(() => {}));
      const cancellation = createProbeCancellation();
      const diagnostics = new ResponseDiagnostics();
      network.enqueue(RESPONSES_ENDPOINT, wire.asResponse());
      const task = network.http.requestStream(
        { ...request, cancellation },
        (body) =>
          collectCompletedResponse(
            body,
            TextDecoder,
            "acknowledgement",
            cancellation,
            diagnostics
          ),
        diagnostics
      );
      const assertion = expect(task).rejects.toMatchObject({ code: reason });
      await vi.advanceTimersByTimeAsync(0);
      expect(wire.reader.read).toHaveBeenCalledTimes(1);
      expect(diagnostics.snapshot()).toMatchObject({
        firstRead: "started",
        firstReadSettled: false,
      });
      if (reason === "cancelled") cancellation.cancel();
      else await vi.advanceTimersByTimeAsync(60000);
      await assertion;
      expect(diagnostics.snapshot()).toMatchObject({
        primaryFailureCode: reason,
        firstRead: "started",
        firstReadSettled: false,
        transportBytes: 0,
        cleanupFailureCode: null,
      });
      expect(network.calls).toHaveLength(1);
    }
  });
});
