import type {
  CompletedTurn,
  ProviderError,
  ProviderTurnInput,
  ProviderTurnResult,
  ToolResultPayload,
  TurnProvider,
} from "../../shared/provider.js";
import {
  OpenAiHistory,
  OpenAiHistoryFault,
  type OpenAiHistoryBinding,
  type OpenAiHistoryLimits,
  type OpenAiHistoryRequest,
  type OpenAiHistoryStatus,
} from "./openai-history.js";
import { buildOpenAiTools, OpenAiToolsFault } from "./openai-tools.js";
import {
  classifyOpenAiFailure,
  consumeOpenAiStream,
  OpenAiStreamFault,
  type OpenAiFaultCode,
  type OpenAiStreamDependencies,
  type OpenAiStreamPayload,
} from "./openai-stream.js";

export const OPENAI_PLAN_SCOPE = "chatgpt.tokens.use.direct";
const MAX_DEVELOPER_BYTES = 64 * 1024;

/** Only a verified selected OAuth credential supplied by the host accessor.
 * Never an environment API key, refresh token, email or alternate account. */
export interface OpenAiSelectedCredential {
  accountBinding: string;
  model: string;
  accessToken: string;
  expiresAt: number;
  scopes: readonly string[];
  planOnlyConfirmed: boolean;
  creditFallbackDisabled: boolean;
}

export interface OpenAiResponsesDependencies extends OpenAiStreamDependencies {
  loadCredential(): OpenAiSelectedCredential | undefined;
}

export interface OpenAiResponsesOptions {
  binding: OpenAiHistoryBinding;
  developerInstructions: string;
  historyLimits?: Partial<OpenAiHistoryLimits>;
}

interface Operation {
  request: OpenAiHistoryRequest;
  credential: OpenAiSelectedCredential;
  controller: AbortController;
  callerSignal?: AbortSignal;
  onAbort: () => void;
  turn?: CompletedTurn;
}

const apiFailures: ReadonlySet<OpenAiFaultCode> = new Set([
  "response_failed",
  "network_failed",
  "http_rejected",
  "usage_limited",
  "temporary_failure",
  "plan_required",
  "credential_invalid",
  "redirect_rejected",
]);

function codeOf(error: unknown): OpenAiFaultCode {
  if (error instanceof OpenAiHistoryFault) {
    if (error.code === "history_limit") return "history_limit";
    if (error.code === "binding_mismatch" || error.code === "invalid_binding")
      return "credential_invalid";
    if (error.code === "invalid_output") return "invalid_response";
    return "invalid_request";
  }
  if (error instanceof OpenAiToolsFault) return "invalid_request";
  return classifyOpenAiFailure(error);
}

function failure(code: OpenAiFaultCode): ProviderTurnResult {
  const err: ProviderError = {
    error:
      code === "aborted" || code === "disposed"
        ? "aborted"
        : apiFailures.has(code)
          ? "api_error"
          : "stream_error",
    detail: code,
    hint: "No request is retried automatically.",
  };
  return { ok: false, err };
}

function validBearer(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 32768 &&
    [...value].every(
      (char) => char.charCodeAt(0) >= 33 && char.charCodeAt(0) <= 126
    )
  );
}

/** Offline composition seam only: the actual official SDK is used through
 * injected capabilities. No native factory, stored credentials, sign-in,
 * persistence or Live execution is implemented here. */
export class OpenAiResponsesProvider implements TurnProvider {
  readonly #binding: Readonly<OpenAiHistoryBinding>;
  readonly #instructions: string;
  readonly #deps: OpenAiResponsesDependencies;
  readonly #history: OpenAiHistory;
  #operation?: Operation;
  #disposed = false;

  constructor(
    options: OpenAiResponsesOptions,
    deps: OpenAiResponsesDependencies
  ) {
    if (
      typeof options.developerInstructions !== "string" ||
      options.developerInstructions.length === 0 ||
      options.developerInstructions.length > MAX_DEVELOPER_BYTES ||
      Buffer.byteLength(options.developerInstructions, "utf8") >
        MAX_DEVELOPER_BYTES ||
      typeof deps.fetch !== "function" ||
      typeof deps.AbortController !== "function" ||
      typeof deps.loadCredential !== "function" ||
      typeof deps.clock?.now !== "function" ||
      typeof deps.clock.setTimeout !== "function" ||
      typeof deps.clock.clearTimeout !== "function"
    )
      throw new OpenAiStreamFault("invalid_request");
    this.#history = new OpenAiHistory(options.binding, options.historyLimits);
    this.#binding = Object.freeze({
      provider: options.binding.provider,
      accountBinding: options.binding.accountBinding,
      conversationId: options.binding.conversationId,
      model: options.binding.model,
    });
    this.#instructions = options.developerInstructions;
    this.#deps = Object.freeze({
      fetch: deps.fetch,
      AbortController: deps.AbortController,
      loadCredential: deps.loadCredential.bind(deps),
      clock: Object.freeze({
        now: deps.clock.now.bind(deps.clock),
        setTimeout: deps.clock.setTimeout.bind(deps.clock),
        clearTimeout: deps.clock.clearTimeout.bind(deps.clock),
      }),
    });
  }

  appendUserText(text: string): void {
    this.#history.appendUserText(text);
  }

  /** B1's sanitized history counts only, never model, binding or bearer. */
  status(): OpenAiHistoryStatus {
    return this.#history.status();
  }

  private selectedCredential(): OpenAiSelectedCredential {
    let value: OpenAiSelectedCredential | undefined;
    try {
      value = this.#deps.loadCredential();
    } catch {
      throw new OpenAiStreamFault("credential_invalid");
    }
    const now = this.#deps.clock.now();
    if (
      !value ||
      value.accountBinding !== this.#binding.accountBinding ||
      value.model !== this.#binding.model ||
      !validBearer(value.accessToken) ||
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= now
    )
      throw new OpenAiStreamFault("credential_invalid");
    if (
      value.planOnlyConfirmed !== true ||
      value.creditFallbackDisabled !== true ||
      !Array.isArray(value.scopes) ||
      !value.scopes.includes(OPENAI_PLAN_SCOPE)
    )
      throw new OpenAiStreamFault("plan_required");
    return {
      accountBinding: value.accountBinding,
      model: value.model,
      accessToken: value.accessToken,
      expiresAt: value.expiresAt,
      scopes: [OPENAI_PLAN_SCOPE],
      planOnlyConfirmed: true,
      creditFallbackDisabled: true,
    };
  }

  private checkOperation(operation: Operation): void {
    if (
      this.#disposed ||
      this.#operation !== operation ||
      operation.controller.signal.aborted ||
      operation.callerSignal?.aborted
    )
      throw new OpenAiStreamFault("aborted");
    this.#history.assertBinding(this.#binding);
    const current = this.selectedCredential();
    if (
      current.accessToken !== operation.credential.accessToken ||
      current.expiresAt !== operation.credential.expiresAt
    )
      throw new OpenAiStreamFault("credential_invalid");
  }

  private clearOperation(operation: Operation): void {
    operation.callerSignal?.removeEventListener("abort", operation.onAbort);
    if (this.#operation === operation) this.#operation = undefined;
  }

  /** Run one request, never implicitly append its output or retry a failure. */
  async runTurn(input: ProviderTurnInput): Promise<ProviderTurnResult> {
    if (this.#disposed) return failure("disposed");
    if (this.#operation) return failure("operation_busy");
    let request: OpenAiHistoryRequest | undefined;
    let operation: Operation | undefined;
    try {
      if (
        !input ||
        typeof input !== "object" ||
        !Array.isArray(input.tools) ||
        (input.onDelta !== undefined && typeof input.onDelta !== "function")
      )
        throw new OpenAiStreamFault("invalid_request");
      if (
        input.maxTokens !== undefined ||
        Object.keys(input).some(
          (key) =>
            ![
              "tools",
              "snapshot",
              "model",
              "maxTokens",
              "signal",
              "onDelta",
            ].includes(key)
        )
      )
        throw new OpenAiStreamFault("unsupported_option");
      if (input.signal?.aborted) throw new OpenAiStreamFault("aborted");
      if (input.model !== undefined && input.model !== this.#binding.model)
        throw new OpenAiStreamFault("credential_invalid");
      const credential = this.selectedCredential();
      const tools = buildOpenAiTools(input.tools);
      const controller = new this.#deps.AbortController();
      request = this.#history.beginRequest(this.#binding, input.snapshot);
      const current: Operation = {
        request,
        credential,
        controller,
        callerSignal: input.signal,
        onAbort: () => {
          try {
            controller.abort();
          } catch {
            /* The caller signal still gates append. */
          }
          // A cancellation arriving after terminal delivery but before
          // canonical append invalidates that exact issued continuation.
          if (current.turn && this.#operation === current) {
            this.#history.failRequest(current.request);
            this.clearOperation(current);
          }
        },
      };
      operation = current;
      this.#operation = current;
      input.signal?.addEventListener("abort", current.onAbort, { once: true });
      this.checkOperation(current);
      const payload: OpenAiStreamPayload = {
        model: this.#binding.model,
        store: false,
        stream: true,
        input: [
          { type: "message", role: "developer", content: this.#instructions },
          ...request.input,
        ],
        tools: tools.wireTools,
      };
      const completed = await consumeOpenAiStream({
        deps: this.#deps,
        payload,
        accessToken: credential.accessToken,
        tools,
        signal: controller.signal,
        check: () => this.checkOperation(current),
        onDelta: input.onDelta,
      });
      this.checkOperation(current);
      const turn = this.#history.completeRequest(
        request,
        completed.output,
        completed.blocks
      );
      current.turn = turn;
      return { ok: true, turn };
    } catch (error) {
      if (request) this.#history.failRequest(request);
      if (operation) this.clearOperation(operation);
      return failure(
        this.#disposed || input?.signal?.aborted ? "aborted" : codeOf(error)
      );
    }
  }

  /** Reject stale, foreign, cancelled or account-switched completions before
   * the canonical loop can dispatch even a read tool. */
  appendAssistant(turn: CompletedTurn): void {
    const operation = this.#operation;
    if (!operation || operation.turn !== turn)
      throw new OpenAiHistoryFault("invalid_continuation");
    try {
      this.checkOperation(operation);
      this.#history.appendAssistant(turn);
    } catch (error) {
      this.#history.failRequest(operation.request);
      throw new OpenAiStreamFault(codeOf(error));
    } finally {
      this.clearOperation(operation);
    }
  }

  appendToolResults(results: ToolResultPayload[]): void {
    this.#history.appendToolResults(results);
  }

  /** Dispose the bound instance; in-flight or late output cannot revive it. */
  dispose(): void {
    this.#disposed = true;
    const operation = this.#operation;
    if (operation) {
      this.clearOperation(operation);
      try {
        operation.controller.abort();
      } catch {
        /* No late append is possible. */
      }
    }
    this.#history.dispose();
  }
}
