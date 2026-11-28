import type { CompletedTurn, TurnProvider } from "../../shared/provider.js";
import {
  ChannelFault,
  COMPANION_CHANNEL_LIMITS,
  channelEnvelope,
  channelFaultCode,
  decodeClientMessage,
  decodeServerMessage,
  sameChannelBinding,
  validateChannelSelection,
  type ChannelClientMessage,
  type ChannelFaultCode,
  type ChannelMessage,
  type ChannelSelection,
  type ChannelServerBody,
  type ChannelState,
  type CompanionChannelEndpoint,
} from "../../shared/companion-channel.js";

/** The injected provider alone owns its history and raw continuations.
 * No credential loader, Live runtime, network or persistence is used here. */
export interface CompanionSessionProvider extends TurnProvider {
  appendUserText(text: string): void;
  dispose(): void;
}

export interface CompanionSessionOptions {
  selection: ChannelSelection;
  endpoint: CompanionChannelEndpoint;
  provider: CompanionSessionProvider;
  timeoutMs?: number;
}

interface Operation {
  requestId: string;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  deltaChars: number;
  offeredTools: Set<string>;
}

interface PendingCompletion {
  continuationId: string;
  turn: CompletedTurn;
  continuation: CompletedTurn["continuation"];
  projection: Extract<ChannelServerBody, { type: "completed" }>;
  controller: AbortController;
  callIds: string[];
}

/** A single bound conversation over an already paired synthetic endpoint.
 * Rejection, cancellation, timeout or selection change is terminal; a new
 * pairing must construct a new session and provider, not resume this one. */
export class CompanionChannelSession {
  readonly #selection: ChannelSelection;
  readonly #provider: CompanionSessionProvider;
  readonly #endpoint: CompanionChannelEndpoint;
  readonly #timeoutMs: number;
  #state: ChannelState = "unopened";
  #incomingSequence = 0;
  #outgoingSequence = 0;
  #requestIds = new Set<string>();
  #callIds = new Set<string>();
  #snapshotAllowed = false;
  #operation?: Operation;
  #lastRun?: string;
  #completion?: PendingCompletion;
  #expectedResults: string[] = [];
  #unsubscribe?: () => void;

  constructor(options: CompanionSessionOptions) {
    this.#selection = validateChannelSelection(options.selection);
    this.#provider = options.provider;
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
      () => this.dispose("invalid")
    );
  }

  /** Sanitized state only; no selected account details or provider output. */
  status(): ChannelState {
    return this.#state;
  }

  /** Selection is server-owned. Changes invalidate rather than silently
   * rebinding the old provider or forwarding its context to another account. */
  updateSelection(selection: ChannelSelection): void {
    try {
      const next = validateChannelSelection(selection);
      if (
        sameChannelBinding(next, this.#selection) &&
        next.model === this.#selection.model
      )
        return;
    } catch {
      // Invalid selection is also a binding change.
    }
    this.disconnect();
  }

  /** Terminate an in-flight generation and destroy provider state once. */
  disconnect(): void {
    this.dispose("invalid");
    this.disconnectEndpoint();
  }

  private isTerminal(): boolean {
    return this.#state === "invalid" || this.#state === "closed";
  }

  private disconnectEndpoint(): void {
    try {
      this.#endpoint.disconnect();
    } catch {
      // Local disposal is authoritative even if the transport cannot close.
    }
  }

  private dispose(state: "invalid" | "closed"): void {
    if (this.isTerminal()) return;
    this.#state = state;
    const operation = this.#operation;
    const completion = this.#completion;
    this.#operation = undefined;
    this.#completion = undefined;
    this.#expectedResults = [];
    this.#requestIds.clear();
    this.#callIds.clear();
    if (operation) {
      clearTimeout(operation.timer);
      operation.controller.abort();
    }
    completion?.controller.abort();
    try {
      this.#unsubscribe?.();
    } catch {
      // State and generation are already terminal.
    }
    this.#unsubscribe = undefined;
    try {
      this.#provider.dispose();
    } catch {
      // No provider error text or private state crosses the channel.
    }
  }

  private send(requestId: string, body: ChannelServerBody): void {
    const sequence = this.#outgoingSequence + 1;
    const message = decodeServerMessage(
      channelEnvelope(this.#selection, requestId, sequence, body)
    );
    this.#outgoingSequence = sequence;
    this.#endpoint.send(message);
  }

  private fail(code: ChannelFaultCode, requestId?: string): void {
    if (this.isTerminal()) return;
    this.dispose("invalid");
    if (requestId) {
      try {
        this.send(requestId, { type: "failure", code });
      } catch {
        // Failure delivery may be uncertain: always close, never replay.
      }
    }
    this.disconnectEndpoint();
  }

  private require(state: ChannelState): void {
    if (this.#state !== state) throw new ChannelFault("invalid_state");
  }

  private receive(raw: unknown): void {
    if (this.isTerminal()) return;
    let message: ChannelClientMessage | undefined;
    try {
      message = decodeClientMessage(raw);
      if (!sameChannelBinding(message, this.#selection)) {
        this.fail("binding_mismatch");
        return;
      }
      if (message.sequence !== this.#incomingSequence + 1)
        throw new ChannelFault("sequence_mismatch");
      if (this.#requestIds.has(message.requestId))
        throw new ChannelFault("duplicate_request");
      this.#incomingSequence = message.sequence;
      this.#requestIds.add(message.requestId);
      this.dispatch(message);
    } catch (error) {
      this.fail(channelFaultCode(error), message?.requestId);
    }
  }

  private dispatch({ requestId, body }: ChannelClientMessage): void {
    if (this.#state === "running" && body.type !== "cancel")
      throw new ChannelFault("invalid_state");
    switch (body.type) {
      case "open":
        this.require("unopened");
        if (body.model !== this.#selection.model)
          throw new ChannelFault("binding_mismatch");
        this.#state = "ready";
        break;
      case "append_user_text":
        this.require("ready");
        this.#provider.appendUserText(body.text);
        this.require("ready");
        this.#snapshotAllowed = true;
        this.#state = "request_ready";
        break;
      case "run_turn":
        this.require("request_ready");
        if (body.snapshot !== undefined && !this.#snapshotAllowed)
          throw new ChannelFault("invalid_state");
        this.#snapshotAllowed = false;
        this.#state = "running";
        this.#lastRun = requestId;
        void this.run(requestId, body);
        return;
      case "commit_assistant": {
        this.require("completed");
        const pending = this.#completion;
        if (!pending || body.continuationId !== pending.continuationId)
          throw new ChannelFault("invalid_continuation");
        // The provider's private continuation remains local. Its public
        // projection must still be the exact one issued to the client.
        const current = decodeServerMessage(
          channelEnvelope(this.#selection, requestId, 1, {
            type: "completed",
            continuationId: pending.continuationId,
            stopReason: pending.turn.stopReason as "end_turn" | "tool_use",
            blocks: pending.turn.blocks,
          })
        ).body;
        if (
          pending.turn.continuation !== pending.continuation ||
          JSON.stringify(current) !== JSON.stringify(pending.projection)
        )
          throw new ChannelFault("invalid_continuation");
        this.#provider.appendAssistant(pending.turn);
        this.require("completed");
        this.#completion = undefined;
        this.#expectedResults = pending.callIds;
        // A successfully committed terminal completion is no longer a
        // cancellable request, even if delivery of its ACK is uncertain.
        if (!pending.callIds.length) this.#lastRun = undefined;
        this.#state = pending.callIds.length ? "awaiting_results" : "ready";
        break;
      }
      case "append_tool_results":
        this.require("awaiting_results");
        if (
          body.results.length !== this.#expectedResults.length ||
          body.results.some(
            (result, index) => result.toolUseId !== this.#expectedResults[index]
          )
        )
          throw new ChannelFault("invalid_results");
        this.#provider.appendToolResults(body.results);
        this.require("awaiting_results");
        this.#expectedResults = [];
        this.#state = "request_ready";
        break;
      case "cancel":
        if (body.targetRequestId !== this.#lastRun)
          throw new ChannelFault("invalid_state");
        this.dispose("invalid");
        try {
          this.send(requestId, { type: "ack", operation: "cancel" });
        } finally {
          this.disconnectEndpoint();
        }
        return;
      case "status":
        this.send(requestId, { type: "status", state: this.#state });
        return;
      case "close":
        if (this.#state === "unopened") throw new ChannelFault("invalid_state");
        this.dispose("closed");
        try {
          this.send(requestId, { type: "ack", operation: "close" });
        } finally {
          this.disconnectEndpoint();
        }
        return;
    }
    this.send(requestId, { type: "ack", operation: body.type });
  }

  private async run(
    requestId: string,
    body: Extract<ChannelClientMessage["body"], { type: "run_turn" }>
  ): Promise<void> {
    const operation: Operation = {
      requestId,
      controller: new AbortController(),
      deltaChars: 0,
      offeredTools: new Set(body.tools.map((tool) => tool.name)),
    };
    this.#operation = operation;
    operation.timer = setTimeout(() => {
      if (this.#operation === operation) this.fail("timeout", requestId);
    }, this.#timeoutMs);
    try {
      const result = await this.#provider.runTurn({
        tools: body.tools,
        snapshot: body.snapshot,
        model: this.#selection.model,
        signal: operation.controller.signal,
        onDelta: (text) => {
          if (
            this.#operation !== operation ||
            operation.controller.signal.aborted
          )
            return;
          try {
            if (typeof text !== "string")
              throw new ChannelFault("invalid_message");
            operation.deltaChars += text.length;
            if (operation.deltaChars > COMPANION_CHANNEL_LIMITS.messageChars)
              throw new ChannelFault("limit_exceeded");
            this.send(requestId, { type: "delta", text });
          } catch (error) {
            this.fail(channelFaultCode(error), requestId);
          }
        },
      });
      if (this.#operation !== operation || operation.controller.signal.aborted)
        return;
      if (!result.ok) {
        this.fail(
          result.err.error === "aborted" ? "aborted" : "provider_failed",
          requestId
        );
        return;
      }
      const turn = result.turn;
      if (
        !turn.continuation ||
        turn.continuation.type !== "opaque" ||
        typeof turn.continuation.provider !== "string"
      )
        throw new ChannelFault("invalid_continuation");
      // Only a bounded detached validated projection crosses the channel.
      // Never serialize or reconstruct the provider's exact continuation.
      const continuationId = "c_" + String(this.#incomingSequence);
      const completion = decodeServerMessage(
        channelEnvelope(
          this.#selection,
          requestId,
          this.#outgoingSequence + 1,
          {
            type: "completed",
            continuationId,
            stopReason: turn.stopReason as "end_turn" | "tool_use",
            blocks: turn.blocks,
          }
        )
      ).body;
      if (completion.type !== "completed")
        throw new ChannelFault("invalid_message");
      const callIds = completion.blocks.flatMap((block) => {
        if (block.type !== "tool_call") return [];
        if (
          !operation.offeredTools.has(block.call.name) ||
          this.#callIds.has(block.call.id)
        )
          throw new ChannelFault("invalid_message");
        return [block.call.id];
      });
      for (const id of callIds) this.#callIds.add(id);
      this.#completion = {
        continuationId,
        turn,
        continuation: turn.continuation,
        projection: completion,
        controller: operation.controller,
        callIds,
      };
      this.#state = "completed";
      this.#operation = undefined;
      this.send(requestId, completion);
    } catch (error) {
      this.fail(channelFaultCode(error), requestId);
    } finally {
      clearTimeout(operation.timer);
      if (this.#operation === operation) this.#operation = undefined;
    }
  }
}

interface Receiver {
  receive(message: unknown): void;
  disconnected(): void;
}

/** Deterministic, synchronous, one-pair transport for offline proofs only.
 * It does not implement authentication or even open a socket. Subscribers
 * cannot be replaced on a prior pairing, and a disconnect cannot be undone. */
export function createInMemoryCompanionChannel(): {
  client: CompanionChannelEndpoint;
  server: CompanionChannelEndpoint;
} {
  let disconnected = false;
  const receivers: [Receiver | undefined, Receiver | undefined] = [
    undefined,
    undefined,
  ];
  const subscribed = [false, false];
  const disconnect = (): void => {
    if (disconnected) return;
    disconnected = true;
    const pending = [...receivers];
    receivers[0] = receivers[1] = undefined;
    for (const receiver of pending) {
      try {
        receiver?.disconnected();
      } catch {
        // Notify both sides even if one receiver fails.
      }
    }
  };
  function endpoint(side: 0 | 1): CompanionChannelEndpoint {
    return {
      send(message: ChannelMessage): void {
        const peer = receivers[side === 0 ? 1 : 0];
        if (disconnected || !peer) throw new ChannelFault("disconnected");
        peer.receive(message);
      },
      subscribe(receive, onDisconnect): () => void {
        if (disconnected || subscribed[side])
          throw new ChannelFault("invalid_state");
        subscribed[side] = true;
        receivers[side] = { receive, disconnected: onDisconnect };
        return () => {
          receivers[side] = undefined;
        };
      },
      disconnect,
    };
  }
  return { client: endpoint(0), server: endpoint(1) };
}
