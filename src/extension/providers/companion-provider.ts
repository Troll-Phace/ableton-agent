import type {
  AssistantDeltaSink,
  CompletedTurn,
  ProviderTurnInput,
  ProviderTurnResult,
  ToolResultPayload,
  TurnProvider,
} from "../../shared/provider.js";
import {
  ChannelFault,
  COMPANION_CHANNEL_LIMITS,
  channelEnvelope,
  channelFaultCode,
  decodeClientMessage,
  decodeServerMessage,
  freezeChannelValue,
  sameChannelBinding,
  validateChannelSelection,
  type ChannelClientBody,
  type ChannelFaultCode,
  type ChannelSelection,
  type ChannelServerBody,
  type ChannelState,
  type CompanionChannelEndpoint,
} from "../../shared/companion-channel.js";

export const COMPANION_PROVIDER = "companion_channel";

export interface CompanionProviderOptions {
  selection: ChannelSelection;
  endpoint: CompanionChannelEndpoint;
  timeoutMs?: number;
}

type StagedBody = Extract<
  ChannelClientBody,
  { type: "append_user_text" | "commit_assistant" | "append_tool_results" }
>;

interface Pending {
  requestId: string;
  body: ChannelClientBody;
  timer?: ReturnType<typeof setTimeout>;
  staged: boolean;
  resolve?: (body: ChannelServerBody) => void;
  reject?: (fault: ChannelFault) => void;
  onDelta?: AssistantDeltaSink;
  deltaChars: number;
}

interface Waiter {
  resolve(): void;
  reject(fault: ChannelFault): void;
}

function failure(code: ChannelFaultCode): ProviderTurnResult {
  return {
    ok: false,
    err: {
      error:
        code === "aborted"
          ? "aborted"
          : code === "provider_failed"
            ? "api_error"
            : "stream_error",
      detail: code,
      hint: "The conversation cannot resume. Local actions may have completed; do not replay them.",
    },
  };
}

/** Extension-side canonical TurnProvider proxy, isolated from the production
 * graph. Synchronous appends stage detached local data in exact order. A
 * subsequent turn awaits all acknowledgements before sending another request.
 * Call flush() after a final assistant append to verify its remote commit,
 * including when the canonical loop returns without another runTurn(). */
export class CompanionProvider implements TurnProvider {
  readonly #selection: ChannelSelection;
  readonly #endpoint: CompanionChannelEndpoint;
  readonly #timeoutMs: number;
  #state: ChannelState = "unopened";
  #failure?: ChannelFaultCode;
  #incomingSequence = 0;
  #outgoingSequence = 0;
  #pending?: Pending;
  #queue: StagedBody[] = [];
  #waiters: Waiter[] = [];
  #unsubscribe?: () => void;
  #signal?: AbortSignal;
  #onAbort?: () => void;
  #runBusy = false;
  #controlBusy = false;
  #issued?: { turn: CompletedTurn; continuationId: string; callIds: string[] };
  #expectedResults: string[] = [];
  #seenContinuations = new Set<string>();
  #seenCalls = new Set<string>();
  #lastRun?: string;
  #finalCommitId?: string;
  #snapshotAllowed = false;

  constructor(options: CompanionProviderOptions) {
    this.#selection = validateChannelSelection(options.selection);
    this.#endpoint = options.endpoint;
    this.#timeoutMs = options.timeoutMs ?? COMPANION_CHANNEL_LIMITS.timeoutMs;
    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs < 1 ||
      this.#timeoutMs > COMPANION_CHANNEL_LIMITS.timeoutMs
    )
      throw new ChannelFault("invalid_message");
    this.#unsubscribe = this.#endpoint.subscribe(
      (message) => this.receive(message),
      () => this.invalidate("disconnected")
    );
  }

  /** Sanitized local state, including the staged (not necessarily ACKed) state. */
  status(): {
    state: ChannelState;
    pending: boolean;
    queued: number;
    failure?: ChannelFaultCode;
  } {
    return {
      state: this.#state,
      pending: this.#pending !== undefined,
      queued: this.#queue.length,
      ...(this.#failure ? { failure: this.#failure } : {}),
    };
  }

  private isTerminal(): boolean {
    return this.#state === "invalid" || this.#state === "closed";
  }

  private requireLive(): void {
    if (this.isTerminal())
      throw new ChannelFault(this.#failure ?? "invalid_state");
  }

  private require(state: ChannelState): void {
    this.requireLive();
    if (this.#state !== state || this.#controlBusy || this.#runBusy)
      throw new ChannelFault("invalid_state");
  }

  private disconnectEndpoint(): void {
    try {
      this.#endpoint.disconnect();
    } catch {
      // Local state remains permanently invalid.
    }
  }

  private cleanupSignal(): void {
    if (this.#signal && this.#onAbort)
      this.#signal.removeEventListener("abort", this.#onAbort);
    this.#signal = undefined;
    this.#onAbort = undefined;
  }

  private cleanupSubscription(): void {
    try {
      this.#unsubscribe?.();
    } catch {
      // Terminal state has already rejected future messages.
    }
    this.#unsubscribe = undefined;
  }

  private invalidate(code: ChannelFaultCode, disconnect = true): void {
    if (this.isTerminal()) return;
    this.#state = "invalid";
    this.#failure = code;
    this.cleanupSignal();
    this.cleanupSubscription();
    this.#issued = undefined;
    this.#finalCommitId = undefined;
    this.#lastRun = undefined;
    this.#expectedResults = [];
    this.#seenCalls.clear();
    this.#seenContinuations.clear();
    this.#queue = [];
    const pending = this.#pending;
    this.#pending = undefined;
    clearTimeout(pending?.timer);
    const fault = new ChannelFault(code);
    pending?.reject?.(fault);
    for (const waiter of this.#waiters.splice(0)) waiter.reject(fault);
    if (disconnect) this.disconnectEndpoint();
  }

  /** Local teardown; no reconnect, queued append replay or implicit new chat. */
  dispose(): void {
    this.invalidate("disconnected");
  }

  private abort(): void {
    if (this.isTerminal()) return;
    const target = this.#lastRun;
    // Invalidate before signalling the peer so late deltas/completions cannot
    // be displayed or issued even during synchronous reentrant delivery.
    this.invalidate("aborted", false);
    try {
      if (target) {
        const seq = ++this.#outgoingSequence;
        this.#endpoint.send(
          decodeClientMessage(
            channelEnvelope(this.#selection, "r_" + String(seq), seq, {
              type: "cancel",
              targetRequestId: target,
            })
          )
        );
      }
    } catch {
      // Cancellation delivery is best effort; the conversation stays invalid.
    } finally {
      this.disconnectEndpoint();
    }
  }

  private bindSignal(signal?: AbortSignal): void {
    this.cleanupSignal();
    this.#signal = signal;
    this.#onAbort = () => this.abort();
    signal?.addEventListener("abort", this.#onAbort, { once: true });
    if (signal?.aborted) this.abort();
  }

  private receive(raw: unknown): void {
    if (this.isTerminal()) return;
    try {
      const message = decodeServerMessage(raw);
      if (!sameChannelBinding(message, this.#selection))
        throw new ChannelFault("binding_mismatch");
      if (message.sequence !== this.#incomingSequence + 1)
        throw new ChannelFault("sequence_mismatch");
      const pending = this.#pending;
      if (!pending || pending.requestId !== message.requestId)
        throw new ChannelFault("invalid_state");
      this.#incomingSequence = message.sequence;
      const body = message.body;
      if (body.type === "failure") {
        this.invalidate(body.code);
        return;
      }
      if (pending.body.type === "run_turn") {
        if (body.type === "delta") {
          pending.deltaChars += body.text.length;
          if (pending.deltaChars > COMPANION_CHANNEL_LIMITS.messageChars)
            throw new ChannelFault("limit_exceeded");
          pending.onDelta?.(body.text);
          return;
        }
        if (body.type !== "completed")
          throw new ChannelFault("invalid_message");
      } else if (pending.body.type === "status") {
        if (body.type !== "status") throw new ChannelFault("invalid_message");
      } else if (body.type !== "ack" || body.operation !== pending.body.type) {
        throw new ChannelFault("invalid_message");
      }
      this.#pending = undefined;
      clearTimeout(pending.timer);
      if (
        pending.body.type === "commit_assistant" &&
        pending.body.continuationId === this.#finalCommitId
      ) {
        // Only an exact final commit ACK ends the cancellation generation.
        // A locally staged commit (or a tool-bearing commit) is not enough.
        this.#finalCommitId = undefined;
        this.#lastRun = undefined;
        this.cleanupSignal();
      }
      if (pending.body.type === "close") {
        this.#state = "closed";
        this.cleanupSignal();
        this.cleanupSubscription();
        this.#issued = undefined;
        this.#finalCommitId = undefined;
        this.#lastRun = undefined;
        this.#expectedResults = [];
        this.#seenCalls.clear();
        this.#seenContinuations.clear();
      }
      pending.resolve?.(body);
      this.pump();
      this.settleFlush();
    } catch (error) {
      this.invalidate(channelFaultCode(error));
    }
  }

  private send(
    body: ChannelClientBody,
    staged: boolean,
    resolve?: Pending["resolve"],
    reject?: Pending["reject"],
    onDelta?: AssistantDeltaSink
  ): void {
    try {
      this.requireLive();
      if (this.#pending) throw new ChannelFault("invalid_state");
      const sequence = ++this.#outgoingSequence;
      const requestId = "r_" + String(sequence);
      const message = decodeClientMessage(
        channelEnvelope(this.#selection, requestId, sequence, body)
      );
      const pending: Pending = {
        requestId,
        body: message.body,
        staged,
        resolve,
        reject,
        onDelta,
        deltaChars: 0,
      };
      this.#pending = pending;
      pending.timer = setTimeout(() => {
        if (this.#pending === pending) this.invalidate("timeout");
      }, this.#timeoutMs);
      if (body.type === "run_turn") this.#lastRun = requestId;
      this.#endpoint.send(message);
    } catch (error) {
      const code = channelFaultCode(error);
      this.invalidate(code);
      // A rejection before establishing pending must still wake the caller.
      reject?.(new ChannelFault(code));
    }
  }

  private exchange(
    body: ChannelClientBody,
    onDelta?: AssistantDeltaSink
  ): Promise<ChannelServerBody> {
    return new Promise((resolve, reject) => {
      this.send(body, false, resolve, reject, onDelta);
    });
  }

  private pump(): void {
    if (this.isTerminal() || this.#pending || !this.#queue.length) return;
    const body = this.#queue.shift();
    if (body) this.send(body, true);
  }

  private settleFlush(): void {
    if (this.#pending || this.#queue.length) return;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve();
  }

  private enqueue(body: StagedBody): void {
    if (
      this.#queue.length + (this.#pending?.staged ? 1 : 0) >=
      COMPANION_CHANNEL_LIMITS.queue
    )
      throw new ChannelFault("limit_exceeded");
    // Validate/detach at append time, before a caller can mutate staged data.
    const copy = decodeClientMessage(
      channelEnvelope(this.#selection, "stage", 1, body)
    ).body as StagedBody;
    this.#queue.push(copy);
    this.pump();
    this.requireLive();
  }

  /** Await ACKs without starting another provider request. A missing ACK or
   * rejection permanently invalidates the conversation; no append is retried. */
  async flush(): Promise<void> {
    if (this.#state === "closed") return;
    this.requireLive();
    if (!this.#pending && !this.#queue.length) return;
    if (this.#waiters.length >= COMPANION_CHANNEL_LIMITS.queue) {
      this.invalidate("limit_exceeded");
      throw new ChannelFault("limit_exceeded");
    }
    await new Promise<void>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
    if (this.#state === "invalid") this.requireLive();
  }

  /** Explicitly open one bound conversation with the server-selected model. */
  async open(): Promise<void> {
    try {
      this.require("unopened");
      this.#controlBusy = true;
      await this.exchange({ type: "open", model: this.#selection.model });
      this.requireLive();
      this.#state = "ready";
    } catch (error) {
      this.invalidate(channelFaultCode(error));
      throw new ChannelFault(this.#failure ?? channelFaultCode(error));
    } finally {
      this.#controlBusy = false;
    }
  }

  /** Optional sanitized status roundtrip, after all staged writes are ACKed. */
  async remoteStatus(): Promise<ChannelState> {
    try {
      this.requireLive();
      if (this.#controlBusy || this.#runBusy || this.#state === "unopened")
        throw new ChannelFault("invalid_state");
      this.#controlBusy = true;
      await this.flush();
      const response = await this.exchange({ type: "status" });
      this.requireLive();
      if (response.type !== "status" || response.state !== this.#state)
        throw new ChannelFault("invalid_state");
      return response.state;
    } catch (error) {
      this.invalidate(channelFaultCode(error));
      throw new ChannelFault(this.#failure ?? channelFaultCode(error));
    } finally {
      this.#controlBusy = false;
    }
  }

  /** Close only after pending appends settle; never claim a lost ACK succeeded. */
  async close(): Promise<void> {
    if (this.#state === "closed") return;
    try {
      this.requireLive();
      if (this.#controlBusy || this.#runBusy || this.#state === "unopened")
        throw new ChannelFault("invalid_state");
      this.#controlBusy = true;
      await this.flush();
      await this.exchange({ type: "close" });
      if (this.status().state !== "closed")
        throw new ChannelFault("disconnected");
    } catch (error) {
      this.invalidate(channelFaultCode(error));
      throw new ChannelFault(this.#failure ?? channelFaultCode(error));
    } finally {
      this.#controlBusy = false;
    }
  }

  /** Stage one new text message; a next request waits for its ACK. */
  appendUserText(text: string): void {
    try {
      this.require("ready");
      // A new text append can be staged behind an unacknowledged final
      // commit. Keep its previous cancellation generation until that ACK.
      this.#snapshotAllowed = true;
      this.#state = "request_ready";
      this.enqueue({ type: "append_user_text", text });
    } catch (error) {
      this.invalidate(channelFaultCode(error));
      throw new ChannelFault(this.#failure ?? channelFaultCode(error));
    }
  }

  /** Request one completed turn; delta messages never supply a continuation. */
  async runTurn(input: ProviderTurnInput): Promise<ProviderTurnResult> {
    try {
      this.require("request_ready");
      this.#runBusy = true;
      if (
        !input ||
        !Array.isArray(input.tools) ||
        input.maxTokens !== undefined ||
        (input.model !== undefined && input.model !== this.#selection.model) ||
        (input.onDelta !== undefined && typeof input.onDelta !== "function") ||
        (input.snapshot !== undefined && !this.#snapshotAllowed) ||
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
        throw new ChannelFault("invalid_message");
      // Take a detached exact tool/snapshot copy before awaiting any ACKs.
      const request = decodeClientMessage(
        channelEnvelope(this.#selection, "stage", 1, {
          type: "run_turn",
          tools: input.tools as Extract<
            ChannelClientBody,
            { type: "run_turn" }
          >["tools"],
          ...(input.snapshot === undefined ? {} : { snapshot: input.snapshot }),
        })
      ).body;
      if (request.type !== "run_turn")
        throw new ChannelFault("invalid_message");
      // Keep the previous generation's cancellation binding until its
      // final commit ACK. A new caller can also cancel while waiting for
      // staged writes, but retiring the prior binding must not remove it.
      const signal = input.signal;
      const onWaitingAbort = () => this.abort();
      signal?.addEventListener("abort", onWaitingAbort, { once: true });
      try {
        if (signal?.aborted) this.abort();
        this.requireLive();
        await this.flush();
        this.requireLive();
      } finally {
        signal?.removeEventListener("abort", onWaitingAbort);
      }
      this.bindSignal(signal);
      this.requireLive();
      this.#snapshotAllowed = false;
      this.#state = "running";
      const response = await this.exchange(request, input.onDelta);
      this.requireLive();
      if (
        response.type !== "completed" ||
        this.#seenContinuations.has(response.continuationId)
      )
        throw new ChannelFault("invalid_continuation");
      const offered = new Set(request.tools.map((tool) => tool.name));
      const callIds = response.blocks.flatMap((block) => {
        if (block.type !== "tool_call") return [];
        if (!offered.has(block.call.name) || this.#seenCalls.has(block.call.id))
          throw new ChannelFault("invalid_message");
        return [block.call.id];
      });
      for (const id of callIds) this.#seenCalls.add(id);
      this.#seenContinuations.add(response.continuationId);
      const turn: CompletedTurn = freezeChannelValue({
        stopReason: response.stopReason,
        blocks: response.blocks,
        continuation: {
          type: "opaque",
          provider: COMPANION_PROVIDER,
          value: {},
        },
      });
      this.#issued = { turn, continuationId: response.continuationId, callIds };
      this.#state = "completed";
      return { ok: true, turn };
    } catch (error) {
      this.invalidate(channelFaultCode(error));
      return failure(this.#failure ?? channelFaultCode(error));
    } finally {
      this.#runBusy = false;
    }
  }

  /** Commit only this provider instance's exact issued completion, once. */
  appendAssistant(turn: CompletedTurn): void {
    try {
      this.require("completed");
      const issued = this.#issued;
      if (!issued || issued.turn !== turn)
        throw new ChannelFault("invalid_continuation");
      this.#issued = undefined;
      this.#expectedResults = issued.callIds;
      this.#state = issued.callIds.length ? "awaiting_results" : "ready";
      if (!issued.callIds.length) this.#finalCommitId = issued.continuationId;
      this.enqueue({
        type: "commit_assistant",
        continuationId: issued.continuationId,
      });
    } catch (error) {
      this.invalidate(channelFaultCode(error));
      throw new ChannelFault(this.#failure ?? channelFaultCode(error));
    }
  }

  /** Stage exact ordered local tool results; never forward opaque provider data. */
  appendToolResults(results: ToolResultPayload[]): void {
    try {
      this.require("awaiting_results");
      if (
        !Array.isArray(results) ||
        results.length !== this.#expectedResults.length ||
        results.some(
          (result, index) =>
            result.toolUseId !== this.#expectedResults[index] ||
            typeof result.content !== "string"
        )
      )
        throw new ChannelFault("invalid_results");
      const localResults = results.map((result) => {
        if (
          typeof result.content !== "string" ||
          Object.keys(result).some(
            (key) =>
              !["toolUseId", "content", "isError", "summary"].includes(key)
          )
        )
          throw new ChannelFault("invalid_results");
        return {
          toolUseId: result.toolUseId,
          content: result.content,
          ...(result.isError === undefined ? {} : { isError: result.isError }),
          ...(result.summary === undefined ? {} : { summary: result.summary }),
        };
      });
      this.#expectedResults = [];
      this.#state = "request_ready";
      this.enqueue({ type: "append_tool_results", results: localResults });
    } catch (error) {
      this.invalidate(channelFaultCode(error));
      throw new ChannelFault(this.#failure ?? channelFaultCode(error));
    }
  }
}
