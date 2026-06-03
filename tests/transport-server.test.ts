/**
 * Phase 7 (T8) transport-server + session-glue integration suite — Spike R3
 * **Outcome D** (localhost full-duplex WebSocket; docs/ARCHITECTURE.md §11, §13).
 *
 * These run **headlessly** — no Live, no modal, no real Anthropic call. A real
 * Node `ws` client stands in for the webview, and a real {@link TransportServer}
 * binds loopback on an ephemeral port. The suite proves the transport contract
 * end-to-end over the wire:
 *  - bind/serve (GET / + 404), nonce-gated WS upgrade, inbound parse/drop,
 *    outbound serialize, single-client reconnect, clean idempotent shutdown;
 *  - the session glue's `ready → config_state` framing and the §10 **no-key-leak**
 *    guarantee (the API key never appears in any outbound frame), plus the
 *    no-key `user_message` path (`error` then `refs_updated`).
 *
 * Session-level frame-ordering for a *successful* turn (deltas → tool_activity →
 * assistant_done → refs_updated), the concurrent-turn rejection, and `cancel` /
 * `dispose` mid-turn ARE covered here via the `runTurn` injection seam on
 * `ChatSessionOptions`: a scripted fake runner drives a turn (emitting events
 * that become real socket frames) without a Claude client, API key, or Live.
 *
 * Every server/client handle is torn down in `afterEach`/`finally` so no test
 * leaks a port or an open socket.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WebSocket } from "ws";

import {
  message,
  parseEnvelope,
  serialize,
  type ProtocolMessage,
  type ServerMessage,
} from "../src/shared/protocol.js";
import {
  ChatSession,
  type TurnRunArgs,
  type TurnRunResult,
} from "../src/extension/transport/session.js";
import {
  TransportServer,
  type TransportStartInfo,
} from "../src/extension/transport/server.js";

import { makeFakeContext } from "./fixtures/fake-extension-context.js";

/** Absolute path to the served SPA fixture (passed as `webviewPath`). */
const WEBVIEW_FIXTURE = new URL("./fixtures/webview-stub.html", import.meta.url)
  .pathname;

/* -------------------------------------------------------------------------- */
/* Test helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Convert the nonce-bearing connect URL to its `ws://` equivalent. */
function toWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http:/, "ws:");
}

/**
 * Decode a `ws` inbound frame to a UTF-8 string. `RawData` is
 * `Buffer | ArrayBuffer | Buffer[]`; a naive `.toString()` on an `ArrayBuffer`
 * yields `[object ArrayBuffer]`, so route every case through `Buffer.from`
 * (mirrors the server's own `rawDataToString`).
 */
function decodeRaw(data: WebSocket.RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(new Uint8Array(data)).toString("utf8");
}

/** Resolve once a `ws` socket opens; reject on the first error/close-before-open. */
function waitOpen(socket: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    socket.once("open", () => {
      resolve();
    });
    socket.once("error", (err) => {
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

/**
 * Resolve with the close code once a nonce-gated `ws` connection is closed.
 *
 * The server validates the nonce *after* the WS upgrade completes (see
 * `server.ts` `handleConnection`), so a rejected client may briefly emit `open`
 * before the server closes it with code 1008 — `open` is therefore NOT treated
 * as a failure here; only the eventual close (with its code) settles us. The
 * `error` event (e.g. "abnormal closure") is swallowed so it never rejects.
 */
function waitRejected(socket: WebSocket): Promise<number> {
  return new Promise<number>((resolve) => {
    socket.once("error", () => {
      // Swallow — the close handler reports the authoritative code.
    });
    socket.once("close", (code) => {
      resolve(code);
    });
  });
}

/**
 * A small inbound collector over a connected `ws` client. Buffers every parsed
 * server frame and lets a test await until N frames (or a predicate) arrive.
 */
class FrameCollector {
  public readonly frames: ProtocolMessage[] = [];
  private waiters: (() => void)[] = [];

  constructor(socket: WebSocket) {
    socket.on("message", (data: WebSocket.RawData) => {
      const result = parseEnvelope(decodeRaw(data));
      if (result.ok) {
        this.frames.push(result.message);
        const pending = this.waiters;
        this.waiters = [];
        for (const w of pending) {
          w();
        }
      }
    });
  }

  /** Resolve once `predicate(frames)` holds (checked after each frame). */
  async until(
    predicate: (frames: ProtocolMessage[]) => boolean,
    timeoutMs = 1000
  ): Promise<void> {
    if (predicate(this.frames)) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `timed out waiting for frames; got [${this.frames
              .map((f) => f.type)
              .join(", ")}]`
          )
        );
      }, timeoutMs);
      const check = (): void => {
        if (predicate(this.frames)) {
          clearTimeout(timer);
          resolve();
        } else {
          this.waiters.push(check);
        }
      };
      this.waiters.push(check);
    });
  }

  /** All frames of a given type. */
  ofType<T extends ServerMessage["type"]>(type: T): ProtocolMessage[] {
    return this.frames.filter((f) => f.type === type);
  }
}

/** Tracks servers + sockets opened by a test so `afterEach` can close them all. */
interface Harness {
  servers: TransportServer[];
  sockets: WebSocket[];
}

let harness: Harness;

beforeEach(() => {
  harness = { servers: [], sockets: [] };
});

afterEach(async () => {
  for (const socket of harness.sockets) {
    try {
      socket.removeAllListeners();
      socket.terminate();
    } catch {
      // best-effort teardown
    }
  }
  // The reconnect-replacement hang is FIXED in `server.ts` (it now detaches only
  // its own app-level handlers via `detachAppHandlers`, leaving ws's internal
  // close bookkeeping so `wss.clients` drains and `close()` resolves). So every
  // `close()` is now a real awaited shutdown — no timer race, no leaked handles.
  await Promise.all(harness.servers.map((s) => s.close()));
});

/** Start a tracked {@link TransportServer} serving the HTML fixture. */
async function startServer(): Promise<{
  server: TransportServer;
  info: TransportStartInfo;
}> {
  const server = new TransportServer(WEBVIEW_FIXTURE);
  harness.servers.push(server);
  const info = await server.start();
  return { server, info };
}

/** Open a tracked `ws` client to `url` and await its open event. */
async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  harness.sockets.push(socket);
  await waitOpen(socket);
  return socket;
}

/* -------------------------------------------------------------------------- */
/* 1. Bind                                                                    */
/* -------------------------------------------------------------------------- */

describe("transportServer_start_bindsLoopbackEphemeralWithNonce", () => {
  it("transportServer_start_urlCarriesNonceAndBoundPort", async () => {
    const { info } = await startServer();
    // URL is loopback, carries the bound port and a non-empty `?t=` nonce.
    expect(info.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=.+/);
    expect(info.url).toContain(`:${info.port}/`);
    const nonce = new URL(info.url).searchParams.get("t");
    expect(nonce).toBeTruthy();
    expect(info.port).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Serve                                                                   */
/* -------------------------------------------------------------------------- */

describe("transportServer_http_servesSpaAnd404", () => {
  it("transportServer_getRoot_returns200HtmlFixture", async () => {
    const { info } = await startServer();
    const res = await fetch(`http://127.0.0.1:${info.port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain("webview-stub");
  });

  it("transportServer_unknownPath_returns404", async () => {
    const { info } = await startServer();
    const res = await fetch(`http://127.0.0.1:${info.port}/nope`);
    expect(res.status).toBe(404);
    // Drain the body so the connection is released cleanly.
    await res.text();
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Nonce gate                                                              */
/* -------------------------------------------------------------------------- */

describe("transportServer_nonceGate_acceptsValidRejectsInvalid", () => {
  it("transportServer_validNonce_connectsAndFiresOnConnect", async () => {
    const { server, info } = await startServer();
    let connected = false;
    server.onConnect(() => {
      connected = true;
    });
    await connect(toWsUrl(info.url));
    // onConnect fires synchronously inside the connection handler.
    expect(connected).toBe(true);
  });

  it("transportServer_wrongNonce_rejectsAndNoOnConnect", async () => {
    const { server, info } = await startServer();
    let connected = false;
    server.onConnect(() => {
      connected = true;
    });
    const bad = toWsUrl(info.url).replace(/\?t=.+$/, "?t=not-the-nonce");
    const socket = new WebSocket(bad);
    harness.sockets.push(socket);
    const code = await waitRejected(socket);
    // 1008 (policy violation) is the server's "unauthorized" close code.
    expect(code).toBe(1008);
    expect(connected).toBe(false);
  });

  it("transportServer_missingNonce_rejectsAndNoOnConnect", async () => {
    const { server, info } = await startServer();
    let connected = false;
    server.onConnect(() => {
      connected = true;
    });
    const noNonce = toWsUrl(info.url).replace(/\?t=.+$/, "");
    const socket = new WebSocket(noNonce);
    harness.sockets.push(socket);
    await waitRejected(socket);
    expect(connected).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Inbound                                                                 */
/* -------------------------------------------------------------------------- */

describe("transportServer_inbound_deliversValidDropsMalformed", () => {
  it("transportServer_validClientFrame_reachesOnMessageParsed", async () => {
    const { server, info } = await startServer();
    const received: ProtocolMessage[] = [];
    server.onMessage((msg) => {
      received.push(msg);
    });
    const socket = await connect(toWsUrl(info.url));

    socket.send(serialize(message("ready", {}, "id-ready")));
    socket.send(
      serialize(message("user_message", { text: "hello" }, "id-user"))
    );

    await waitFor(() => received.length >= 2);
    expect(received.map((m) => m.type)).toEqual(["ready", "user_message"]);
    const user = received[1];
    expect(user.type).toBe("user_message");
    if (user.type === "user_message") {
      expect(user.payload.text).toBe("hello");
    }
  });

  it("transportServer_malformedFrame_droppedHandlerNotCalledNoCrash", async () => {
    const { server, info } = await startServer();
    const received: ProtocolMessage[] = [];
    server.onMessage((msg) => {
      received.push(msg);
    });
    const socket = await connect(toWsUrl(info.url));

    // Bad JSON, then a well-formed-JSON-but-bad-shape frame.
    socket.send("}{ not json");
    socket.send(JSON.stringify({ v: 1, id: "x", type: "bogus", payload: {} }));
    // A valid frame AFTER the bad ones proves the server still works.
    socket.send(serialize(message("ready", {}, "id-after")));

    await waitFor(() => received.length >= 1);
    // Only the valid `ready` got through; the two malformed frames were dropped.
    expect(received.map((m) => m.type)).toEqual(["ready"]);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Outbound                                                                */
/* -------------------------------------------------------------------------- */

describe("transportServer_outbound_clientReceivesSerializedFrame", () => {
  it("transportServer_send_roundTripsViaParseEnvelope", async () => {
    const { server, info } = await startServer();
    const socket = await connect(toWsUrl(info.url));
    const collector = new FrameCollector(socket);

    const sent = message("assistant_delta", { text: "tok" }, "id-delta");
    server.send(sent);

    await collector.until((f) => f.length >= 1);
    expect(collector.frames[0]).toEqual(sent);
  });
});

/* -------------------------------------------------------------------------- */
/* 6. Single client / reconnect                                              */
/* -------------------------------------------------------------------------- */

describe("transportServer_singleClient_secondConnectionReplacesFirst", () => {
  it("transportServer_reconnect_closesOldTargetsNewWithoutDisconnect", async () => {
    const { server, info } = await startServer();
    let disconnects = 0;
    server.onDisconnect(() => {
      disconnects += 1;
    });

    const first = await connect(toWsUrl(info.url));
    const firstClosed = new Promise<void>((resolve) => {
      first.once("close", () => {
        resolve();
      });
    });

    // Second valid connection replaces the first.
    const second = await connect(toWsUrl(info.url));
    await firstClosed;
    expect(first.readyState).toBe(WebSocket.CLOSED);

    // A *replacement* is not a user disconnect: the server detaches the old
    // socket's listeners before closing it, so onDisconnect does NOT fire here
    // (it fires only when the active socket closes on its own — see the close
    // test). This documents the intentional single-client replace semantics.
    expect(disconnects).toBe(0);

    // `send` now targets the NEW socket only — the old socket gets nothing.
    const collector = new FrameCollector(second);
    const onFirst: ProtocolMessage[] = [];
    first.on("message", (d: WebSocket.RawData) => {
      const r = parseEnvelope(decodeRaw(d));
      if (r.ok) {
        onFirst.push(r.message);
      }
    });

    server.send(message("assistant_done", { stopReason: "end_turn" }, "id-d"));
    await collector.until((f) => f.some((m) => m.type === "assistant_done"));
    expect(onFirst).toHaveLength(0);
  });

  it("transportServer_multipleReconnects_closeResolvesPromptlyPortFreedNewestTargeted", async () => {
    // Drive several reconnects (each replaces the prior socket), then prove the
    // now-fixed `close()` resolves WITHOUT the old hang and frees the port. The
    // prior author had to race close() against a 500ms timer because a replaced
    // socket lingered in `wss.clients`; with `detachAppHandlers` that no longer
    // happens, so we await close() for real and bound it ourselves only to fail
    // loudly (not silently pass) if a regression reintroduces the hang.
    const server = new TransportServer(WEBVIEW_FIXTURE);
    const info = await server.start();
    const { port } = info;

    // Three successive valid connections; each replaces the previous one.
    const sockets: WebSocket[] = [];
    for (let i = 0; i < 3; i += 1) {
      const sock = new WebSocket(toWsUrl(info.url));
      harness.sockets.push(sock);
      sockets.push(sock);
      await waitOpen(sock);
    }
    const newest = sockets[sockets.length - 1];

    // `send` reaches ONLY the newest socket; the two replaced ones get nothing.
    const newestFrames = new FrameCollector(newest);
    const replacedFrames: ProtocolMessage[] = [];
    for (const old of sockets.slice(0, -1)) {
      old.on("message", (d: WebSocket.RawData) => {
        const r = parseEnvelope(decodeRaw(d));
        if (r.ok) {
          replacedFrames.push(r.message);
        }
      });
    }
    server.send(message("assistant_done", { stopReason: "end_turn" }, "id-rc"));
    await newestFrames.until((f) => f.some((m) => m.type === "assistant_done"));
    expect(replacedFrames).toHaveLength(0);

    // A REAL awaited close() after reconnects must resolve promptly (no hang).
    // The bound (well above the few-ms real close) only converts a hang into a
    // visible failure rather than a silent timeout-pass.
    let resolved = false;
    await Promise.race([
      server.close().then(() => {
        resolved = true;
      }),
      new Promise<void>((_, reject) => {
        setTimeout(() => {
          reject(new Error("close() did not resolve after reconnects (hang?)"));
        }, 2000);
      }),
    ]);
    expect(resolved).toBe(true);

    // The port is freed: a follow-up server can listen on a fresh ephemeral port
    // and a connect to the CLOSED port's URL must fail (connection refused).
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();

    // And the freed port can be rebound by a brand-new server that accepts a
    // client — proving the listener socket was actually released.
    const reborn = new TransportServer(WEBVIEW_FIXTURE);
    harness.servers.push(reborn);
    const rebornInfo = await reborn.start();
    const rebornClient = await connect(toWsUrl(rebornInfo.url));
    expect(rebornClient.readyState).toBe(WebSocket.OPEN);
  });

  it("transportServer_activeClientCloses_firesOnDisconnect", async () => {
    const { server, info } = await startServer();
    let disconnects = 0;
    const disconnected = new Promise<void>((resolve) => {
      server.onDisconnect(() => {
        disconnects += 1;
        resolve();
      });
    });

    const socket = await connect(toWsUrl(info.url));
    // The client closing on its own IS a user disconnect → onDisconnect fires.
    socket.close();
    await disconnected;
    expect(disconnects).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* 7. Clean shutdown                                                          */
/* -------------------------------------------------------------------------- */

describe("transportServer_close_shutsDownCleanlyAndIsIdempotent", () => {
  it("transportServer_close_freesPortSoFollowUpConnectFails", async () => {
    const server = new TransportServer(WEBVIEW_FIXTURE);
    const info = await server.start();
    const { port } = info;
    await server.close();

    // The port is free: a follow-up HTTP request to it must fail (connection
    // refused), proving the http server actually released the socket.
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it("transportServer_close_isIdempotent", async () => {
    const server = new TransportServer(WEBVIEW_FIXTURE);
    await server.start();
    await server.close();
    // A second close must resolve without throwing.
    await expect(server.close()).resolves.toBeUndefined();
  });

  it("transportServer_close_neverStarted_resolves", async () => {
    const server = new TransportServer(WEBVIEW_FIXTURE);
    await expect(server.close()).resolves.toBeUndefined();
  });

  it("transportServer_close_terminatesActiveClient", async () => {
    const { server, info } = await startServer();
    const socket = await connect(toWsUrl(info.url));
    const closed = new Promise<void>((resolve) => {
      socket.once("close", () => {
        resolve();
      });
    });
    // Remove from the harness list since we close the server here explicitly.
    await server.close();
    await closed;
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });
});

/* -------------------------------------------------------------------------- */
/* 8. Session glue — ready/config_state + no-key-leak (no client/Live needed) */
/* -------------------------------------------------------------------------- */

describe("chatSession_ready_repliesConfigStateWithoutKey", () => {
  /** A fake SDK context cast through `unknown` (only touched on a real turn). */
  function fakeCtx(): ConstructorParameters<typeof ChatSession>[0] {
    return makeFakeContext() as unknown as ConstructorParameters<
      typeof ChatSession
    >[0];
  }

  it("chatSession_ready_sendsConfigStateBooleanHasKeyNoKeyLeak", async () => {
    const { server, info } = await startServer();
    // The session self-wires server.onMessage in its constructor.
    new ChatSession(fakeCtx(), server, { model: "claude-sonnet-4-6" });

    const socket = await connect(toWsUrl(info.url));
    const collector = new FrameCollector(socket);

    socket.send(serialize(message("ready", {}, "id-ready")));
    await collector.until((f) => f.some((m) => m.type === "config_state"));

    const cfg = collector.ofType("config_state")[0];
    expect(cfg.type).toBe("config_state");
    if (cfg.type === "config_state") {
      expect(typeof cfg.payload.hasKey).toBe("boolean");
      expect(cfg.payload.model).toBe("claude-sonnet-4-6");
    }
    // No frame — config_state or otherwise — may carry an `apiKey`/key field.
    assertNoKeyLeak(collector.frames);
  });

  it("chatSession_userMessageNoKey_emitsErrorFrameNoKeyLeak", async () => {
    // With no ANTHROPIC_API_KEY, handleUserMessage returns BEFORE constructing
    // the runtime/Live — so this path is fully deterministic and Live-free. It
    // exercises the session's user_message → error framing and proves no key
    // leaks even on the failure path. Note the no-key path returns *before* the
    // trailing `refs_updated` send (that only follows a turn that ran the loop),
    // so exactly one `error` is emitted and no `refs_updated`.
    const priorKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const { server, info } = await startServer();
      new ChatSession(fakeCtx(), server);

      const socket = await connect(toWsUrl(info.url));
      const collector = new FrameCollector(socket);

      socket.send(serialize(message("user_message", { text: "hi" }, "id-u")));
      await collector.until((f) => f.some((m) => m.type === "error"));
      // Drain so any (erroneous) SECOND error frame the double-frame bug would
      // add has a chance to arrive before we count — pins the count at one.
      await settle();

      const errors = collector.ofType("error");
      // EXACTLY ONE error frame over the whole exchange (the NO_KEY message).
      expect(errors).toHaveLength(1);
      // The no-key path is `ran:false` → it short-circuits before any
      // `refs_updated`.
      expect(collector.ofType("refs_updated")).toHaveLength(0);
      assertNoKeyLeak(collector.frames);
    } finally {
      if (priorKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = priorKey;
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 9. Session glue — turn execution via the injected `runTurn` seam            */
/* -------------------------------------------------------------------------- */

describe("chatSession_turnExecution_viaInjectedRunner", () => {
  /** A fake SDK context cast through `unknown` (never touched by a scripted run). */
  function fakeCtx(): ConstructorParameters<typeof ChatSession>[0] {
    return makeFakeContext() as unknown as ConstructorParameters<
      typeof ChatSession
    >[0];
  }

  /**
   * Item 8 — full success ordering. The injected runner emits a delta, a
   * started+ok `tool_activity` pair, then `assistant_done`, and returns one ref.
   * The client must observe the §13 frames IN ORDER and the trailing
   * `refs_updated` (gated on `ran !== false`) carrying exactly that ref. The key
   * never crosses the wire on any frame.
   */
  it("chatSession_successfulTurn_streamsFramesInOrderThenRefsUpdated", async () => {
    // Synchronous emit then resolve — no `await` needed, so this is a plain
    // Promise-returning function (avoids `require-await`).
    const runTurn = (args: TurnRunArgs): Promise<TurnRunResult> => {
      args.events.assistantDelta("hi");
      args.events.toolActivity(
        "live_get_project",
        "reading project",
        "started"
      );
      args.events.toolActivity("live_get_project", "done", "ok");
      args.events.assistantDone("end_turn");
      return Promise.resolve({
        ok: true,
        messages: [{ role: "assistant", content: "hi" }],
        refs: ["track:0:Foo"],
      });
    };

    const { server, info } = await startServer();
    new ChatSession(fakeCtx(), server, { runTurn });

    const socket = await connect(toWsUrl(info.url));
    const collector = new FrameCollector(socket);

    socket.send(serialize(message("user_message", { text: "go" }, "id-u8")));
    // Wait until the terminal `refs_updated` arrives — everything precedes it.
    await collector.until((f) => f.some((m) => m.type === "refs_updated"));

    // Exact ordered sequence of types emitted by this turn.
    expect(collector.frames.map((f) => f.type)).toEqual([
      "assistant_delta",
      "tool_activity",
      "tool_activity",
      "assistant_done",
      "refs_updated",
    ]);

    const activity = collector.ofType("tool_activity");
    const first = activity[0];
    const second = activity[1];
    if (first.type === "tool_activity" && second.type === "tool_activity") {
      expect(first.payload.status).toBe("started");
      expect(second.payload.status).toBe("ok");
      expect(first.payload.tool).toBe("live_get_project");
    }

    const refs = collector.ofType("refs_updated")[0];
    if (refs.type === "refs_updated") {
      expect(refs.payload.refs).toEqual(["track:0:Foo"]);
    }

    // No error frame on the happy path, and no key leak on any frame.
    expect(collector.ofType("error")).toHaveLength(0);
    assertNoKeyLeak(collector.frames);
  });

  /**
   * Item 9 — concurrent turn. A runner that blocks on a controllable promise
   * keeps the first turn in flight (the session sets `activeTurn` before calling
   * the runner). A second `user_message` while in flight must yield exactly one
   * `error` frame ("A turn is already in progress."). Releasing the blocker then
   * lets the first turn complete (its `assistant_done` + `refs_updated` arrive).
   */
  it("chatSession_secondTurnWhileInFlight_rejectedWithBusyErrorFirstStillCompletes", async () => {
    const gate = deferred<void>();
    let starts = 0;
    const runTurn = async (args: TurnRunArgs): Promise<TurnRunResult> => {
      starts += 1;
      await gate.promise;
      args.events.assistantDone("end_turn");
      return {
        ok: true,
        messages: [{ role: "assistant", content: "done" }],
        refs: ["track:0:Bar"],
      };
    };

    const { server, info } = await startServer();
    new ChatSession(fakeCtx(), server, { runTurn });

    const socket = await connect(toWsUrl(info.url));
    const collector = new FrameCollector(socket);

    // First turn starts and parks inside the runner (activeTurn is now set).
    socket.send(serialize(message("user_message", { text: "one" }, "id-u9a")));
    await waitFor(() => starts === 1);

    // Second turn while the first is in flight → exactly one busy `error`.
    socket.send(serialize(message("user_message", { text: "two" }, "id-u9b")));
    await collector.until((f) => f.some((m) => m.type === "error"));

    const busy = collector.ofType("error");
    expect(busy).toHaveLength(1);
    if (busy[0].type === "error") {
      expect(busy[0].payload.message).toContain(
        "A turn is already in progress."
      );
    }
    // The rejected second turn never re-entered the runner.
    expect(starts).toBe(1);

    // Release the blocker → the FIRST turn completes through to refs_updated.
    gate.resolve();
    await collector.until((f) => f.some((m) => m.type === "refs_updated"));

    expect(collector.ofType("assistant_done")).toHaveLength(1);
    const refs = collector.ofType("refs_updated")[0];
    if (refs.type === "refs_updated") {
      expect(refs.payload.refs).toEqual(["track:0:Bar"]);
    }
    assertNoKeyLeak(collector.frames);
  });

  /**
   * Item 10a — cancel mid-turn trips `signal.aborted`. A runner that waits on a
   * controllable step (released only after we assert) observes the abort after a
   * `cancel` message, and no further frames arrive once aborted. We synchronize
   * deterministically (resolvable promises + a settle await), never on sleeps.
   */
  it("chatSession_cancelMidTurn_tripsSignalAbortedAndNoFurtherFrames", async () => {
    const started = deferred<void>();
    const finished = deferred<void>();
    let sawAborted = false;
    const runTurn = async (args: TurnRunArgs): Promise<TurnRunResult> => {
      started.resolve();
      // Park directly on the signal's abort: the runner resumes ONLY once the
      // session has tripped the signal in response to `cancel`. This removes the
      // socket round-trip race entirely (no need to guess when the inbound
      // `cancel` frame has been dispatched) — fully deterministic, no sleeps.
      await onceAborted(args.signal);
      sawAborted = args.signal.aborted;
      finished.resolve();
      return {
        ok: true,
        messages: [{ role: "assistant", content: "" }],
        refs: [],
        // ran:false → the session short-circuits before refs_updated, so an
        // aborted turn emits no further frames.
        ran: false,
      };
    };

    const { server, info } = await startServer();
    new ChatSession(fakeCtx(), server, { runTurn });

    const socket = await connect(toWsUrl(info.url));
    const collector = new FrameCollector(socket);

    socket.send(serialize(message("user_message", { text: "go" }, "id-u10")));
    await started.promise; // runner is parked on the signal, activeTurn is set

    // Cancel mid-turn → the session trips the signal → the runner resumes.
    socket.send(serialize(message("cancel", {}, "id-cancel")));
    await finished.promise;
    expect(sawAborted).toBe(true);

    // Drain so the session's `finally` + (skipped) refs_updated path run.
    await settle();
    // ran:false short-circuits refs_updated; an aborted turn emits no frames.
    expect(collector.frames).toHaveLength(0);
  });

  /**
   * Item 10b — `dispose()` also aborts an in-flight turn (sibling to cancel). The
   * runner parks; `session.dispose()` trips the same signal the runner observes.
   */
  it("chatSession_disposeMidTurn_abortsInFlightTurnSignalTrips", async () => {
    const started = deferred<void>();
    const finished = deferred<void>();
    let sawAborted = false;
    const runTurn = async (args: TurnRunArgs): Promise<TurnRunResult> => {
      started.resolve();
      await onceAborted(args.signal);
      sawAborted = args.signal.aborted;
      finished.resolve();
      return {
        ok: true,
        messages: [{ role: "assistant", content: "" }],
        refs: [],
        ran: false,
      };
    };

    const { server, info } = await startServer();
    const session = new ChatSession(fakeCtx(), server, { runTurn });

    const socket = await connect(toWsUrl(info.url));
    const collector = new FrameCollector(socket);

    socket.send(serialize(message("user_message", { text: "go" }, "id-u10b")));
    await started.promise;

    // dispose() (modal close) aborts the in-flight turn just like cancel.
    session.dispose();
    await finished.promise;
    expect(sawAborted).toBe(true);

    await settle();
    expect(collector.frames).toHaveLength(0);
  });

  /**
   * QA Finding 1 regression — single-error-frame OWNERSHIP, loop-style failure.
   *
   * A loop failure surfaces its own message via `events.error(...)` and returns
   * `{ ok:false }` WITHOUT `errorMessage`. The session must NOT add a second
   * frame (the pre-fix bug emitted two). We count `error` frames over the WHOLE
   * exchange so a regression to the double-frame bug fails here. Because `ran`
   * defaults true, the trailing `refs_updated` still follows.
   */
  it("chatSession_loopFailureRunnerOwnsErrorFrame_emitsExactlyOneError", async () => {
    const runTurn = (args: TurnRunArgs): Promise<TurnRunResult> => {
      // The runner (standing in for the loop) surfaces its own failure frame.
      args.events.error("boom");
      return Promise.resolve({
        ok: false,
        messages: [{ role: "assistant", content: "partial" }],
        refs: [],
        // NO errorMessage — ownership stays with the runner's events.error frame.
      });
    };

    const { server, info } = await startServer();
    new ChatSession(fakeCtx(), server, { runTurn });

    const socket = await connect(toWsUrl(info.url));
    const collector = new FrameCollector(socket);

    socket.send(serialize(message("user_message", { text: "go" }, "id-uf1")));
    // refs_updated is the terminal frame (ran defaults true); wait for it so the
    // whole exchange has flushed before we count.
    await collector.until((f) => f.some((m) => m.type === "refs_updated"));
    await settle(); // drain any (erroneous) second frame the bug would add

    const errors = collector.ofType("error");
    // EXACTLY ONE error frame over the whole exchange (not just the first).
    expect(errors).toHaveLength(1);
    if (errors[0].type === "error") {
      expect(errors[0].payload.message).toBe("boom");
    }
    // ran defaults true → refs_updated still follows the failed turn.
    expect(collector.ofType("refs_updated")).toHaveLength(1);
    assertNoKeyLeak(collector.frames);
  });

  /**
   * QA Finding 1 regression — single-error-frame OWNERSHIP, runner-reported
   * failure. The runner does NOT call `events.error`; it returns `{ ok:false }`
   * WITH `errorMessage`. The session owns the single frame and sends exactly one.
   */
  it("chatSession_runnerReportedFailureSessionOwnsErrorFrame_emitsExactlyOneError", async () => {
    // No params: this runner ignores its args (it never emits an event frame),
    // and a zero-arg function still satisfies the `TurnRunner` type.
    const runTurn = (): Promise<TurnRunResult> => {
      // No events.error here — the session sends the single frame from errorMessage.
      return Promise.resolve({
        ok: false,
        messages: [{ role: "assistant", content: "partial" }],
        refs: [],
        errorMessage: "nope",
      });
    };

    const { server, info } = await startServer();
    new ChatSession(fakeCtx(), server, { runTurn });

    const socket = await connect(toWsUrl(info.url));
    const collector = new FrameCollector(socket);

    socket.send(serialize(message("user_message", { text: "go" }, "id-uf2")));
    await collector.until((f) => f.some((m) => m.type === "refs_updated"));
    await settle();

    const errors = collector.ofType("error");
    // EXACTLY ONE error frame over the whole exchange.
    expect(errors).toHaveLength(1);
    if (errors[0].type === "error") {
      expect(errors[0].payload.message).toBe("nope");
    }
    expect(collector.ofType("refs_updated")).toHaveLength(1);
    assertNoKeyLeak(collector.frames);
  });
});

/* -------------------------------------------------------------------------- */
/* Local helpers                                                              */
/* -------------------------------------------------------------------------- */

/** A resolvable promise handle for deterministic in-flight synchronization. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

/** Build a {@link Deferred} (resolved externally by the test). */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Resolve once `signal` is aborted — immediately if already aborted, else on its
 * one-shot `abort` event. Lets a scripted runner park on the cancellation the
 * session owns, so a turn resumes EXACTLY when `cancel`/`dispose` trips it (no
 * socket-round-trip race, no sleeps).
 */
function onceAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => {
      resolve();
    });
  });
}

/**
 * Yield to the microtask/macrotask queue so already-resolved promise chains
 * (the runner's `await`, the session's `finally`, and any synchronous `send`)
 * flush before we assert. A single `setTimeout(0)` macrotask drains all pending
 * microtasks; this is deterministic given the awaits above, not a timing guess.
 */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** Poll a synchronous predicate until true or the timeout elapses. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor: predicate did not become true in time");
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

/**
 * Assert that NO serialized frame carries anything that looks like an API key
 * (a `key`/`apiKey` field, or a literal `sk-…` token). The §10 contract is that
 * the key never crosses the socket boundary in either direction.
 */
function assertNoKeyLeak(frames: ProtocolMessage[]): void {
  for (const frame of frames) {
    const wire = serialize(frame);
    expect(wire).not.toMatch(/sk-ant/);
    expect(wire).not.toMatch(/"apiKey"/);
    // `config_state` carries `hasKey` (allowed) but never a bare `"key"` field.
    expect(wire).not.toMatch(/"key"\s*:/);
  }
}
