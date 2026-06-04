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

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
import { buildSnapshot } from "../src/extension/snapshot.js";
import {
  refFromHandle,
  type ClassTokens,
} from "../src/extension/references.js";

import type { ApiVersion, ExtensionContext } from "@ableton-extensions/sdk";

import type Anthropic from "@anthropic-ai/sdk";

import {
  FakeClass,
  makeFakeContext,
  type FakeExtensionContext,
} from "./fixtures/fake-extension-context.js";

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
 * Outcome of awaiting a nonce-gated `ws` connection attempt.
 *
 * `opened` records whether the client ever fired `open`. With the PRE-handshake
 * gate (`verifyClient` → HTTP 401), a rejected client must NEVER open — it fails
 * the handshake and emits `error` directly. `statusCode` carries the 401 from
 * `ws`'s `unexpected-response` path when available.
 */
interface RejectionOutcome {
  /** True only if the client fired `open` before settling (regression signal). */
  opened: boolean;
  /** HTTP status from the failed upgrade, when `ws` surfaces it (e.g. 401). */
  statusCode: number | null;
}

/**
 * Resolve once a nonce-gated `ws` connection attempt settles via `error` or
 * `close`, capturing whether it ever `open`ed and the rejection HTTP status.
 *
 * The server validates the nonce PRE-handshake in `verifyClient` (see
 * `server.ts` {@link TransportServer.start}); a rejected client therefore fails
 * the WS handshake — `open` must NOT fire, and `ws` emits `error` (with an
 * `unexpected-response` carrying HTTP 401). Both `error` and `close` are
 * swallowed-as-settle so the assertion can inspect `opened`/`statusCode`.
 */
function waitRejected(socket: WebSocket): Promise<RejectionOutcome> {
  return new Promise<RejectionOutcome>((resolve) => {
    let opened = false;
    let statusCode: number | null = null;
    let settled = false;
    const settle = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ opened, statusCode });
    };
    socket.once("open", () => {
      // A regression to a post-handshake gate would set this — the test fails.
      opened = true;
    });
    socket.once("unexpected-response", (_req, res) => {
      statusCode = res.statusCode ?? null;
      settle();
    });
    socket.once("error", () => {
      settle();
    });
    socket.once("close", () => {
      settle();
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
      // A pre-handshake-rejected socket may still be CONNECTING here;
      // `terminate()` on it makes ws emit an `error` ("closed before the
      // connection was established") asynchronously. With listeners stripped
      // that would be an UNCAUGHT exception, so re-attach a no-op `error` sink
      // before terminating. Best-effort teardown either way.
      socket.on("error", () => {
        /* swallow teardown noise */
      });
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

  it("transportServer_deriveStyleUrlWithCorrectNonce_connectsAndFiresOnConnect", async () => {
    // Rebuild the connect URL exactly as the webview's `deriveWebSocketUrl`
    // does — `ws://127.0.0.1:<port>/?t=<nonce>` from the bound port + nonce —
    // so this proves the in-Live-shaped URL passes the pre-handshake gate (the
    // smoke-test failure was THIS shape being rejected as "bad/missing nonce").
    const { server, info } = await startServer();
    const parsed = new URL(info.url);
    const nonce = parsed.searchParams.get("t");
    expect(nonce).toBeTruthy();
    const wsUrl = `ws://127.0.0.1:${info.port}/?t=${String(nonce)}`;

    let connected = false;
    server.onConnect(() => {
      connected = true;
    });
    const socket = await connect(wsUrl);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(connected).toBe(true);
  });

  it("transportServer_nonceWithExtraParamsAnyOrder_connects", async () => {
    // The dependency-free parser must find `t=` regardless of position in the
    // query string. Shape the connect URL as `?a=1&t=<nonce>&b=2` and prove the
    // pre-handshake gate still accepts it (proves split-on-`&` + find-`t=`).
    const { server, info } = await startServer();
    const parsed = new URL(info.url);
    const nonce = parsed.searchParams.get("t");
    expect(nonce).toBeTruthy();
    const wsUrl = `ws://127.0.0.1:${info.port}/?a=1&t=${String(nonce)}&b=2`;

    let connected = false;
    server.onConnect(() => {
      connected = true;
    });
    const socket = await connect(wsUrl);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(connected).toBe(true);
  });

  it("transportServer_percentEncodedNonceValue_decodesAndConnects", async () => {
    // A nonce carrying a percent-encoded byte must round-trip through the
    // parser's `decodeURIComponent`. We can't change the server's randomUUID
    // nonce, but we CAN prove the decode path by percent-encoding a character of
    // the real nonce in the URL — the server decodes it back to the exact nonce
    // and the gate accepts. (UUIDs use only `[0-9a-f-]`; we encode a hyphen as
    // `%2D`, which `decodeURIComponent` returns as `-`.)
    const { server, info } = await startServer();
    const parsed = new URL(info.url);
    const nonce = parsed.searchParams.get("t");
    expect(nonce).toBeTruthy();
    const nonceStr = String(nonce);
    // Encode the first hyphen (UUIDs always contain hyphens) as %2D.
    const encoded = nonceStr.replace("-", "%2D");
    expect(encoded).not.toBe(nonceStr); // ensure we actually encoded something
    const wsUrl = `ws://127.0.0.1:${info.port}/?t=${encoded}`;

    let connected = false;
    server.onConnect(() => {
      connected = true;
    });
    const socket = await connect(wsUrl);
    expect(socket.readyState).toBe(WebSocket.OPEN);
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
    const outcome = await waitRejected(socket);
    // PRE-handshake reject: the client must NEVER open, and the upgrade fails
    // with HTTP 401 (verifyClient). A regressed post-handshake gate would set
    // `opened = true` and surface no 401, failing here.
    expect(outcome.opened).toBe(false);
    expect(outcome.statusCode).toBe(401);
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
    const outcome = await waitRejected(socket);
    // Missing nonce is also refused PRE-handshake: no open, HTTP 401.
    expect(outcome.opened).toBe(false);
    expect(outcome.statusCode).toBe(401);
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
/* 10. Session glue — destructive-action confirmation round-trip (Phase 9)     */
/* -------------------------------------------------------------------------- */

/**
 * The shape of the loop's confirmation gate the session builds per turn
 * (`ChatSession.buildRequestConfirmation`). It is a private method, so we reach
 * it through a typed accessor — this drives the REAL session machinery (the
 * `pendingConfirmations` map, the `confirm_request` frame send, the
 * `confirm_response` dispatch, the abort listener, and the `dispose` drain) over
 * a real `ws` round-trip, exactly as the default runner would in production. We
 * cannot use the default runner directly here (it constructs a real network
 * Claude client), so the injected `runTurn` seam stands in for the loop and
 * invokes this real gate the way `runAgentLoop` does before a destructive flush.
 */
type RequestConfirmation = (plan: {
  summary: string;
  actions: string[];
  calls: unknown[];
}) => Promise<boolean>;

/** Typed view of the session's private confirmation builder (real code under test). */
interface SessionConfirmAccess {
  buildRequestConfirmation(signal: AbortSignal): RequestConfirmation;
}

/** Reach the real private `buildRequestConfirmation` without `any`. */
function confirmGateOf(
  session: unknown,
  signal: AbortSignal
): RequestConfirmation {
  return (session as SessionConfirmAccess).buildRequestConfirmation(signal);
}

describe("chatSession_confirmation_roundTrip", () => {
  function fakeCtx(): ConstructorParameters<typeof ChatSession>[0] {
    return makeFakeContext() as unknown as ConstructorParameters<
      typeof ChatSession
    >[0];
  }

  /** A destructive plan as the loop's summarizer would produce it. */
  const PLAN: { summary: string; actions: string[]; calls: unknown[] } = {
    summary:
      "This will permanently change 1 thing and cannot be undone automatically by the agent.",
    actions: ["Delete track:1:Bass"],
    calls: [],
  };

  it("chatSession_confirmRequestFrame_carriesPlanIdSummaryActionsNoKey", async () => {
    // The injected runner stands in for the loop: it invokes the session's REAL
    // confirmation gate (which sends a `confirm_request`) and resolves once the
    // user answers. We approve, then assert the turn proceeds to assistant_done +
    // refs_updated, and that the confirm_request frame preceded them.
    let approved: boolean | null = null;
    const runTurn = async (args: TurnRunArgs): Promise<TurnRunResult> => {
      const gate = confirmGateOf(session, args.signal);
      approved = await gate({ ...PLAN });
      args.events.assistantDone("end_turn");
      return {
        ok: true,
        messages: [{ role: "assistant", content: "deleted" }],
        refs: ["track:1:Keys"],
      };
    };

    const { server, info } = await startServer();
    const session = new ChatSession(fakeCtx(), server, { runTurn });

    const socket = await connect(toWsUrl(info.url));
    const collector = new FrameCollector(socket);

    socket.send(
      serialize(message("user_message", { text: "delete bass" }, "id-c1"))
    );
    await collector.until((f) => f.some((m) => m.type === "confirm_request"));

    const cr = collector.ofType("confirm_request")[0];
    expect(cr.type).toBe("confirm_request");
    let planId = "";
    if (cr.type === "confirm_request") {
      expect(typeof cr.payload.planId).toBe("string");
      expect(cr.payload.planId.length).toBeGreaterThan(0);
      expect(cr.payload.summary).toBe(PLAN.summary);
      expect(cr.payload.actions).toEqual(["Delete track:1:Bass"]);
      planId = cr.payload.planId;
    }

    // Approve → the gate resolves true, the runner finishes, refs follow.
    socket.send(
      serialize(
        message("confirm_response", { planId, approved: true }, "id-r1")
      )
    );
    await collector.until((f) => f.some((m) => m.type === "refs_updated"));

    expect(approved).toBe(true);
    expect(collector.ofType("assistant_done")).toHaveLength(1);
    // confirm_request came before assistant_done/refs_updated in the stream.
    const types = collector.frames.map((f) => f.type);
    expect(types.indexOf("confirm_request")).toBeLessThan(
      types.indexOf("assistant_done")
    );
    expect(collector.ofType("error")).toHaveLength(0);
    assertNoKeyLeak(collector.frames);
  });

  it("chatSession_confirmResponseApprovedTrue_gateResolvesTrue", async () => {
    // The runner awaits the gate, then resolves `done` — we await that (not a
    // bare settle) so the socket-delivered confirm_response has fully driven the
    // gate before we assert. Deterministic, no sleeps.
    const done = deferred<boolean>();
    const runTurn = async (args: TurnRunArgs): Promise<TurnRunResult> => {
      const resolved = await confirmGateOf(session, args.signal)({ ...PLAN });
      done.resolve(resolved);
      return { ok: true, messages: [], refs: [], ran: false };
    };
    const { server, info } = await startServer();
    const session = new ChatSession(fakeCtx(), server, { runTurn });
    const socket = await connect(toWsUrl(info.url));
    const collector = new FrameCollector(socket);

    socket.send(serialize(message("user_message", { text: "go" }, "id-a")));
    await collector.until((f) => f.some((m) => m.type === "confirm_request"));
    const planId = planIdOf(collector);
    socket.send(
      serialize(
        message("confirm_response", { planId, approved: true }, "id-ra")
      )
    );
    expect(await done.promise).toBe(true);
  });

  it("chatSession_confirmResponseApprovedFalse_gateResolvesFalseCleanDecline", async () => {
    const done = deferred<boolean>();
    const runTurn = async (args: TurnRunArgs): Promise<TurnRunResult> => {
      const resolved = await confirmGateOf(session, args.signal)({ ...PLAN });
      done.resolve(resolved);
      return { ok: true, messages: [], refs: [], ran: false };
    };
    const { server, info } = await startServer();
    const session = new ChatSession(fakeCtx(), server, { runTurn });
    const socket = await connect(toWsUrl(info.url));
    const collector = new FrameCollector(socket);

    socket.send(serialize(message("user_message", { text: "go" }, "id-d")));
    await collector.until((f) => f.some((m) => m.type === "confirm_request"));
    const planId = planIdOf(collector);
    socket.send(
      serialize(
        message("confirm_response", { planId, approved: false }, "id-rd")
      )
    );
    expect(await done.promise).toBe(false);
    // A decline emits no error frame from the session (the card is the signal).
    await settle();
    expect(collector.ofType("error")).toHaveLength(0);
  });

  it("chatSession_doubleConfirmResponseSamePlanId_secondIgnoredIdempotent", async () => {
    const done = deferred<void>();
    let settleCount = 0;
    const runTurn = async (args: TurnRunArgs): Promise<TurnRunResult> => {
      await confirmGateOf(session, args.signal)({ ...PLAN });
      settleCount += 1;
      done.resolve();
      return { ok: true, messages: [], refs: [], ran: false };
    };
    const { server, info } = await startServer();
    const session = new ChatSession(fakeCtx(), server, { runTurn });
    const socket = await connect(toWsUrl(info.url));
    const collector = new FrameCollector(socket);

    socket.send(serialize(message("user_message", { text: "go" }, "id-dd")));
    await collector.until((f) => f.some((m) => m.type === "confirm_request"));
    const planId = planIdOf(collector);

    // First response settles the gate; the second (same planId) must be ignored.
    socket.send(
      serialize(
        message("confirm_response", { planId, approved: true }, "id-rd1")
      )
    );
    socket.send(
      serialize(
        message("confirm_response", { planId, approved: false }, "id-rd2")
      )
    );
    await done.promise;
    await settle(); // give a (buggy) second settle a chance to land before counting
    // The gate resolved exactly once (first response wins); no crash, no second
    // settle. No error frame from the ignored duplicate.
    expect(settleCount).toBe(1);
    expect(collector.ofType("error")).toHaveLength(0);
  });

  it("chatSession_unknownPlanId_ignoredGracefullyNoErrorFrame", async () => {
    const runTurn = async (args: TurnRunArgs): Promise<TurnRunResult> => {
      // Park the gate so the turn stays in flight; we never answer the real plan.
      await confirmGateOf(session, args.signal)({ ...PLAN });
      return { ok: true, messages: [], refs: [], ran: false };
    };
    const { server, info } = await startServer();
    const session = new ChatSession(fakeCtx(), server, { runTurn });
    const socket = await connect(toWsUrl(info.url));
    const collector = new FrameCollector(socket);

    socket.send(serialize(message("user_message", { text: "go" }, "id-u")));
    await collector.until((f) => f.some((m) => m.type === "confirm_request"));

    // A confirm_response for a planId the session never minted is ignored.
    socket.send(
      serialize(
        message(
          "confirm_response",
          { planId: "not-a-real-plan", approved: true },
          "id-bad"
        )
      )
    );
    await settle();
    // No error frame — the unknown id is dropped with a debug log only.
    expect(collector.ofType("error")).toHaveLength(0);
    // The real plan is still pending (no spurious settle), so dispose can drain it.
    session.dispose();
    await settle();
  });

  it("chatSession_cancelWhilePending_settlesFalseNoHangNoExtraFrames", async () => {
    const done = deferred<{ resolved: boolean; aborted: boolean }>();
    const runTurn = async (args: TurnRunArgs): Promise<TurnRunResult> => {
      const resolved = await confirmGateOf(session, args.signal)({ ...PLAN });
      // Mirror the loop's post-await abort re-check (decision 5): a cancel while
      // the card is open settles the gate false AND aborts the signal.
      done.resolve({ resolved, aborted: args.signal.aborted });
      return { ok: true, messages: [], refs: [], ran: false };
    };
    const { server, info } = await startServer();
    const session = new ChatSession(fakeCtx(), server, { runTurn });
    const socket = await connect(toWsUrl(info.url));
    const collector = new FrameCollector(socket);

    socket.send(serialize(message("user_message", { text: "go" }, "id-cx")));
    await collector.until((f) => f.some((m) => m.type === "confirm_request"));
    const beforeCancel = collector.frames.length;

    // Cancel mid-card → the session aborts the turn signal → the gate's abort
    // listener settles it false; the turn ends with no hang.
    socket.send(serialize(message("cancel", {}, "id-cancel")));
    const outcome = await done.promise;

    expect(outcome.resolved).toBe(false);
    expect(outcome.aborted).toBe(true);
    // No extra frames beyond the confirm_request (ran:false → no refs_updated).
    await settle();
    expect(collector.frames.length).toBe(beforeCancel);
  });

  it("chatSession_disposeWhilePending_drainsSettlesFalseNoHang", async () => {
    const done = deferred<boolean>();
    const runTurn = async (args: TurnRunArgs): Promise<TurnRunResult> => {
      const resolved = await confirmGateOf(session, args.signal)({ ...PLAN });
      done.resolve(resolved);
      return { ok: true, messages: [], refs: [], ran: false };
    };
    const { server, info } = await startServer();
    const session = new ChatSession(fakeCtx(), server, { runTurn });
    const socket = await connect(toWsUrl(info.url));
    const collector = new FrameCollector(socket);

    socket.send(serialize(message("user_message", { text: "go" }, "id-dz")));
    await collector.until((f) => f.some((m) => m.type === "confirm_request"));

    // dispose() (modal close) aborts the turn + drains pending confirmations.
    session.dispose();
    expect(await done.promise).toBe(false);
  });

  it("chatSession_preAbortedSignal_gateResolvesFalseWithoutSendingCard", async () => {
    const done = deferred<boolean>();
    const runTurn = async (args: TurnRunArgs): Promise<TurnRunResult> => {
      // The session set activeTurn; abort it BEFORE invoking the gate so the
      // pre-aborted branch (resolve false, no frame) is exercised.
      session.dispose();
      const resolved = await confirmGateOf(session, args.signal)({ ...PLAN });
      done.resolve(resolved);
      return { ok: true, messages: [], refs: [], ran: false };
    };
    const { server, info } = await startServer();
    const session = new ChatSession(fakeCtx(), server, { runTurn });
    const socket = await connect(toWsUrl(info.url));
    const collector = new FrameCollector(socket);

    socket.send(serialize(message("user_message", { text: "go" }, "id-pa")));
    expect(await done.promise).toBe(false);
    // No confirm_request frame was sent for a pre-aborted signal.
    await settle();
    expect(collector.ofType("confirm_request")).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 10b. Session glue — "New chat" / clear-conversation (new_chat, §13)          */
/* -------------------------------------------------------------------------- */

/**
 * Typed view of the session's private conversation state. `transcript` and
 * `sessionId` are private fields; reading them through this narrow accessor (no
 * `any`) is the least-invasive seam to assert the in-memory reset that
 * `handleNewChat` performs — exactly as §10's confirmation tests reach
 * `buildRequestConfirmation` through a typed view of the same instance.
 */
interface SessionStateAccess {
  transcript: Anthropic.MessageParam[];
  sessionId: string;
}

/** Read the session's private `transcript` (in-memory, the array the loop grows). */
function transcriptOf(session: unknown): Anthropic.MessageParam[] {
  return (session as SessionStateAccess).transcript;
}

/** Read the session's private `sessionId` (the persisted file stem). */
function sessionIdOf(session: unknown): string {
  return (session as SessionStateAccess).sessionId;
}

/**
 * Drives the REAL `handleNewChat` path over the `ws` client against a
 * `ChatSession`. Proves the §13 `new_chat` contract end-to-end:
 *  - the in-memory transcript is reset to empty (the NEXT turn starts fresh);
 *  - `sessionId` is re-minted, and the prior conversation's `sessions/<oldId>.json`
 *    file still EXISTS on disk afterward (the old thread is left untouched);
 *  - an in-flight turn's AbortSignal trips (same as `cancel`);
 *  - a pending confirmation settles false (no hang, no extra frames);
 *  - NO outbound frame is emitted, and the key never leaks (over every frame).
 *
 * `new_chat` carries an empty payload (like `cancel`/`ready`), so the round-trip
 * itself is covered by `protocol.test.ts`; here we exercise the session handler.
 */
describe("chatSession_newChat_clearsConversation", () => {
  /** Per-test temp storage dir for the session's transcript files. */
  let storageDir: string;

  beforeEach(() => {
    storageDir = mkdtempSync(join(tmpdir(), "abl-newchat-"));
  });

  afterEach(() => {
    rmSync(storageDir, { recursive: true, force: true });
  });

  /** A fake context with a real temp `storageDirectory` wired into env. */
  function fakeCtxWithStorage(
    dir: string | undefined
  ): ConstructorParameters<typeof ChatSession>[0] {
    return makeFakeContext(undefined, {
      storageDirectory: dir,
    }) as unknown as ConstructorParameters<typeof ChatSession>[0];
  }

  /** A fake context with no storage dir (transcript persistence no-ops). */
  function fakeCtx(): ConstructorParameters<typeof ChatSession>[0] {
    return makeFakeContext() as unknown as ConstructorParameters<
      typeof ChatSession
    >[0];
  }

  /**
   * A scripted runner that appends one user + one assistant message and returns
   * the grown transcript — so a completed turn leaves a non-empty transcript the
   * `new_chat` handler can then reset.
   */
  const growTurn = (args: TurnRunArgs): Promise<TurnRunResult> => {
    const grown: typeof args.transcript = [
      ...args.transcript,
      { role: "user", content: args.text },
      { role: "assistant", content: "a-reply" },
    ];
    args.events.assistantDone("end_turn");
    return Promise.resolve({ ok: true, messages: grown, refs: [] });
  };

  it("chatSession_newChat_resetsTranscriptSoNextTurnStartsEmpty", async () => {
    const { server, info } = await startServer();
    const session = new ChatSession(fakeCtx(), server, { runTurn: growTurn });

    const socket = await connect(toWsUrl(info.url));
    const collector = new FrameCollector(socket);

    // Run one turn → the transcript now carries the user + assistant messages.
    socket.send(
      serialize(message("user_message", { text: "hello" }, "id-nc1"))
    );
    await collector.until((f) => f.some((m) => m.type === "refs_updated"));
    expect(transcriptOf(session)).toHaveLength(2);

    // New chat → the in-memory transcript resets to empty.
    socket.send(serialize(message("new_chat", {}, "id-nc2")));
    await waitFor(() => transcriptOf(session).length === 0);
    expect(transcriptOf(session)).toEqual([]);

    // The FOLLOWING turn starts from that empty transcript: the runner grows it
    // from zero, so it ends with exactly the new turn's 2 messages (no carryover).
    socket.send(
      serialize(message("user_message", { text: "fresh" }, "id-nc3"))
    );
    await collector.until(
      (f) => f.filter((m) => m.type === "refs_updated").length >= 2
    );
    const after = transcriptOf(session);
    expect(after).toHaveLength(2);
    const firstUser = after[0];
    if (typeof firstUser.content === "string") {
      // The new turn's first message is "fresh" — the prior "hello" is gone.
      expect(firstUser.content).toBe("fresh");
    }
  });

  it("chatSession_newChat_mintsNewSessionIdOldFilePersistsNewTurnWritesNewFile", async () => {
    const { server, info } = await startServer();
    const session = new ChatSession(fakeCtxWithStorage(storageDir), server, {
      runTurn: growTurn,
    });

    const socket = await connect(toWsUrl(info.url));
    const collector = new FrameCollector(socket);

    // Turn 1 persists the transcript under the ORIGINAL sessionId.
    const oldId = sessionIdOf(session);
    socket.send(serialize(message("user_message", { text: "one" }, "id-o1")));
    await collector.until((f) => f.some((m) => m.type === "refs_updated"));
    const oldFile = join(storageDir, "sessions", `${oldId}.json`);
    await waitFor(() => existsSync(oldFile));
    expect(existsSync(oldFile)).toBe(true);

    // New chat → sessionId is re-minted (different from the old one).
    socket.send(serialize(message("new_chat", {}, "id-o2")));
    await waitFor(() => sessionIdOf(session) !== oldId);
    const newId = sessionIdOf(session);
    expect(newId).not.toBe(oldId);

    // A turn on the new session writes a NEW file under the new id…
    socket.send(serialize(message("user_message", { text: "two" }, "id-o3")));
    await collector.until(
      (f) => f.filter((m) => m.type === "refs_updated").length >= 2
    );
    const newFile = join(storageDir, "sessions", `${newId}.json`);
    await waitFor(() => existsSync(newFile));

    // …and the OLD conversation's file is STILL on disk (left untouched). The two
    // files are distinct, so the prior thread is recoverable until superseded.
    expect(existsSync(oldFile)).toBe(true);
    expect(existsSync(newFile)).toBe(true);
    expect(newFile).not.toBe(oldFile);

    // The old file still holds the original turn's 2 messages (not overwritten).
    const oldBody: unknown = JSON.parse(readFileSync(oldFile, "utf8"));
    expect(Array.isArray(oldBody)).toBe(true);
    expect(oldBody as unknown[]).toHaveLength(2);
  });

  it("chatSession_newChatWhileTurnInFlight_tripsSignalAbortedLikeCancel", async () => {
    const started = deferred<void>();
    const finished = deferred<void>();
    let sawAborted = false;
    // By-reference runner (mirrors how the real loop aliases `args.transcript`):
    // it grows the SAME array the session holds, then parks on the signal. After
    // new_chat trips the signal it returns that same (grown) array — the session
    // MUST discard it (epoch guard) and leave `transcript` reset to `[]`.
    const runTurn = async (args: TurnRunArgs): Promise<TurnRunResult> => {
      args.transcript.push({ role: "user", content: args.text });
      args.transcript.push({ role: "assistant", content: "in-progress" });
      started.resolve();
      // Park on the signal the session owns; resume ONLY once new_chat trips it.
      await onceAborted(args.signal);
      sawAborted = args.signal.aborted;
      finished.resolve();
      return {
        ok: true,
        messages: args.transcript,
        refs: [],
        // ran:false → short-circuits before refs_updated; no further frames.
        ran: false,
      };
    };

    const { server, info } = await startServer();
    const session = new ChatSession(fakeCtx(), server, { runTurn });

    const socket = await connect(toWsUrl(info.url));
    const collector = new FrameCollector(socket);

    socket.send(serialize(message("user_message", { text: "go" }, "id-nf1")));
    await started.promise; // runner parked, activeTurn set, transcript grown

    // new_chat mid-turn aborts the in-flight turn exactly like cancel.
    socket.send(serialize(message("new_chat", {}, "id-nf2")));
    await finished.promise;
    expect(sawAborted).toBe(true);

    await settle();
    // ran:false → no refs_updated; new_chat itself sends no frame.
    expect(collector.frames).toHaveLength(0);
    // Strengthened: the reset SURVIVES the superseded turn's completion — the
    // session discarded the stale (grown) result rather than reinstating it.
    expect(transcriptOf(session)).toEqual([]);
  });

  it("chatSession_newChatMidTurn_discardsStaleResultTranscriptStaysEmpty", async () => {
    // C1 regression (the CRITICAL the shipped in-flight test missed). The runner
    // mutates AND returns the SAME `args.transcript` array BY REFERENCE — exactly
    // how `defaultRunTurn`/`runAgentLoop` alias the session's array. Pre-fix, the
    // session's post-await `this.transcript = result.messages` + `persistTranscript`
    // ran UNCONDITIONALLY, reinstating that grown array under the NEW sessionId.
    // The epoch guard now discards a superseded turn's result, so `transcript`
    // stays `[]`. This assertion FAILS against the pre-fix code and passes now.
    const gate = deferred<void>();
    const settledTranscript = deferred<void>();
    const runTurn = async (args: TurnRunArgs): Promise<TurnRunResult> => {
      // Grow the SAME array the session holds (by reference), as the real loop does.
      args.transcript.push({ role: "user", content: args.text });
      args.transcript.push({
        role: "assistant",
        content: [{ type: "text", text: "old" }],
      });
      // Park mid-flight until the test has sent `new_chat`.
      await gate.promise;
      settledTranscript.resolve();
      return { ok: true, messages: args.transcript, refs: [], ran: true };
    };

    const { server, info } = await startServer();
    const session = new ChatSession(fakeCtx(), server, { runTurn });

    const socket = await connect(toWsUrl(info.url));
    const collector = new FrameCollector(socket);

    // Turn starts and grows the (by-reference) transcript to 2 messages…
    socket.send(
      serialize(message("user_message", { text: "hello" }, "id-c1a"))
    );
    await waitFor(() => transcriptOf(session).length === 2);

    // …while the runner is parked, new_chat resets the conversation + bumps epoch.
    socket.send(serialize(message("new_chat", {}, "id-c1b")));
    await waitFor(() => transcriptOf(session).length === 0);

    // Release the runner → it returns the SAME grown array. The session must
    // DISCARD it (superseded), NOT reinstate it.
    gate.resolve();
    await settledTranscript.promise;
    await settle();

    // The reset stands: the stale grown array was discarded, transcript is empty.
    expect(transcriptOf(session)).toEqual([]);
    // The superseded turn emits no trailing refs_updated (sendRefs=false).
    expect(collector.ofType("refs_updated")).toHaveLength(0);
    assertNoKeyLeak(collector.frames);
  });

  it("chatSession_newChatMidTurn_noPollutedNewSessionFileWritten", async () => {
    // Companion to C1 with a real storageDir: a mid-turn new_chat must NOT persist
    // the discarded turn's old content under the NEW sessionId. After the reset,
    // nothing is persisted, so `sessions/<newId>.json` does not exist yet.
    const gate = deferred<void>();
    const settledTranscript = deferred<void>();
    const runTurn = async (args: TurnRunArgs): Promise<TurnRunResult> => {
      args.transcript.push({ role: "user", content: args.text });
      args.transcript.push({ role: "assistant", content: "old-content" });
      await gate.promise;
      settledTranscript.resolve();
      return { ok: true, messages: args.transcript, refs: [], ran: true };
    };

    const { server, info } = await startServer();
    const session = new ChatSession(fakeCtxWithStorage(storageDir), server, {
      runTurn,
    });

    const socket = await connect(toWsUrl(info.url));

    socket.send(serialize(message("user_message", { text: "hi" }, "id-pf1")));
    await waitFor(() => transcriptOf(session).length === 2);

    // new_chat mid-turn → reset + new sessionId (captured AFTER the bump).
    socket.send(serialize(message("new_chat", {}, "id-pf2")));
    await waitFor(() => transcriptOf(session).length === 0);
    const newId = sessionIdOf(session);

    // Release the discarded turn → it must NOT persist under the new id.
    gate.resolve();
    await settledTranscript.promise;
    await settle();

    // No file under the NEW sessionId exists yet — nothing was persisted post-reset,
    // so the fresh session is not polluted with the old (discarded) content.
    const newFile = join(storageDir, "sessions", `${newId}.json`);
    expect(existsSync(newFile)).toBe(false);
  });

  it("chatSession_cancelMidTurn_adoptsPartialTranscriptNotSuperseded", async () => {
    // Contrast guard against over-fixing: `cancel` (unlike `new_chat`) does NOT
    // bump the epoch, so a cancelled turn still ADOPTS its partial transcript.
    // A by-reference runner grows the array, then resolves on cancel. The session
    // must reflect that partial progress (non-empty) — proving the epoch guard
    // discriminates cancel from new_chat.
    const started = deferred<void>();
    const finished = deferred<void>();
    const runTurn = async (args: TurnRunArgs): Promise<TurnRunResult> => {
      args.transcript.push({ role: "user", content: args.text });
      args.transcript.push({ role: "assistant", content: "partial-progress" });
      started.resolve();
      await onceAborted(args.signal);
      finished.resolve();
      // A cancelled turn returns the partial transcript it built so far.
      return { ok: true, messages: args.transcript, refs: [], ran: true };
    };

    const { server, info } = await startServer();
    const session = new ChatSession(fakeCtx(), server, { runTurn });

    const socket = await connect(toWsUrl(info.url));

    socket.send(serialize(message("user_message", { text: "go" }, "id-cm1")));
    await started.promise;

    // cancel (NOT new_chat) mid-turn: trips the signal, leaves the epoch intact.
    socket.send(serialize(message("cancel", {}, "id-cm2")));
    await finished.promise;
    await settle();

    // The partial transcript was ADOPTED (cancel is not a supersession).
    const after = transcriptOf(session);
    expect(after).toHaveLength(2);
    const assistantMsg = after[1];
    if (typeof assistantMsg.content === "string") {
      expect(assistantMsg.content).toBe("partial-progress");
    }
  });

  it("chatSession_newChatWhileConfirmPending_settlesFalseNoHangNoExtraFrames", async () => {
    const done = deferred<{ resolved: boolean; aborted: boolean }>();
    const runTurn = async (args: TurnRunArgs): Promise<TurnRunResult> => {
      const resolved = await confirmGateOf(
        session,
        args.signal
      )({
        summary: "This deletes 1 thing.",
        actions: ["Delete track:1:Bass"],
        calls: [],
      });
      done.resolve({ resolved, aborted: args.signal.aborted });
      return { ok: true, messages: [], refs: [], ran: false };
    };
    const { server, info } = await startServer();
    const session = new ChatSession(fakeCtx(), server, { runTurn });
    const socket = await connect(toWsUrl(info.url));
    const collector = new FrameCollector(socket);

    socket.send(serialize(message("user_message", { text: "go" }, "id-np1")));
    await collector.until((f) => f.some((m) => m.type === "confirm_request"));
    const beforeNewChat = collector.frames.length;

    // new_chat with a pending confirm → the handler drains it with settle(false),
    // which (via the gate's abort listener path) also trips the signal. Mirrors
    // the dispose-drain test, but driven by new_chat.
    socket.send(serialize(message("new_chat", {}, "id-np2")));
    const outcome = await done.promise;

    expect(outcome.resolved).toBe(false);
    expect(outcome.aborted).toBe(true);
    // No extra frames beyond the confirm_request (new_chat sends none; ran:false).
    await settle();
    expect(collector.frames.length).toBe(beforeNewChat);
  });

  it("chatSession_newChat_emitsNoOutboundFrameAndNoKeyLeak", async () => {
    const { server, info } = await startServer();
    const session = new ChatSession(fakeCtx(), server, { runTurn: growTurn });

    const socket = await connect(toWsUrl(info.url));
    const collector = new FrameCollector(socket);

    // Run one turn so there is a non-empty transcript + a settled session to clear.
    socket.send(serialize(message("user_message", { text: "hi" }, "id-nq1")));
    await collector.until((f) => f.some((m) => m.type === "refs_updated"));
    const beforeNewChat = collector.frames.length;

    // new_chat must produce NO outbound frame at all (the webview clears its own
    // DOM; the handler sends nothing).
    socket.send(serialize(message("new_chat", {}, "id-nq2")));
    await waitFor(() => transcriptOf(session).length === 0);
    await settle(); // give any (erroneous) frame a chance to land before counting

    // Zero new frames since the turn's refs_updated — new_chat sends nothing.
    expect(collector.frames.length).toBe(beforeNewChat);
    // Specifically: no NEW error/assistant_* frame followed the new_chat (the
    // prior turn's own assistant_done legitimately precedes `beforeNewChat`).
    const afterNewChat = collector.frames.slice(beforeNewChat);
    expect(afterNewChat).toHaveLength(0);
    expect(afterNewChat.some((f) => f.type === "error")).toBe(false);
    expect(afterNewChat.some((f) => f.type === "assistant_delta")).toBe(false);
    expect(afterNewChat.some((f) => f.type === "assistant_done")).toBe(false);
    // The key never crosses the wire on any frame across the whole exchange.
    assertNoKeyLeak(collector.frames);
  });
});

/* -------------------------------------------------------------------------- */
/* 11. Session glue — set_config persistence + no-key-leak (Phase 10, §10)      */
/* -------------------------------------------------------------------------- */

/**
 * Drives the REAL `set_config` path over the `ws` client against a `ChatSession`
 * whose fake context carries a temp `storageDirectory`. Proves the §10
 * contract end-to-end:
 *  - a `set_config` with a key writes `config.json` (key present on disk) and
 *    replies `config_state` with `hasKey:true` + the new model;
 *  - a `set_config` against an UNDEFINED storage dir still flips in-memory
 *    `hasKey` and replies `config_state` (nothing persisted);
 *  - the key the client sent NEVER appears in any server→client frame, even
 *    after `set_config` (the no-key-leak guarantee, applied over EVERY frame).
 *
 * It also proves transcript restore across two `ChatSession` instances sharing
 * one temp dir: a scripted turn persists, and a second session restores the
 * prior turn's transcript on construction.
 */
describe("chatSession_setConfig_persistsAndNeverLeaksKey", () => {
  /** Per-test temp storage dir for the session's config / transcript. */
  let storageDir: string;

  beforeEach(() => {
    storageDir = mkdtempSync(join(tmpdir(), "abl-session-"));
  });

  afterEach(() => {
    rmSync(storageDir, { recursive: true, force: true });
  });

  /** A fake context with a real temp `storageDirectory` wired into env. */
  function fakeCtxWithStorage(
    dir: string | undefined
  ): ConstructorParameters<typeof ChatSession>[0] {
    return makeFakeContext(undefined, {
      storageDirectory: dir,
    }) as unknown as ConstructorParameters<typeof ChatSession>[0];
  }

  /** A leak-bearing key value used as the input the client sends. */
  const SECRET_KEY = "sk-ant-set-config-secret";

  it("chatSession_setConfigWithKey_writesConfigJsonAndRepliesHasKeyTrue", async () => {
    const { server, info } = await startServer();
    new ChatSession(fakeCtxWithStorage(storageDir), server, {
      model: "claude-sonnet-4-6",
    });

    const socket = await connect(toWsUrl(info.url));
    const collector = new FrameCollector(socket);

    socket.send(
      serialize(
        message(
          "set_config",
          { apiKey: SECRET_KEY, model: "claude-opus-4-20250514" },
          "id-sc1"
        )
      )
    );
    await collector.until((f) => f.some((m) => m.type === "config_state"));

    // The reply carries hasKey:true + the new model — never the key value.
    const cfg = collector.ofType("config_state")[0];
    if (cfg.type === "config_state") {
      expect(cfg.payload.hasKey).toBe(true);
      expect(cfg.payload.model).toBe("claude-opus-4-20250514");
    }

    // The key landed on disk (Node-only persistence), and the model too.
    const onDisk = readFileSync(join(storageDir, "config.json"), "utf8");
    expect(onDisk).toContain(SECRET_KEY);
    expect(onDisk).toContain("claude-opus-4-20250514");

    // Yet NO outbound frame — config_state or otherwise — leaked the key.
    assertNoKeyLeak(collector.frames);
    // Belt-and-suspenders: the literal secret never crossed any frame.
    for (const frame of collector.frames) {
      expect(serialize(frame)).not.toContain(SECRET_KEY);
    }
  });

  it("chatSession_setConfigUndefinedStorage_flipsInMemoryHasKeyNoPersist", async () => {
    const { server, info } = await startServer();
    // Undefined storageDirectory: nothing to persist, but the live session
    // must still honor the change in-memory and reply config_state.
    new ChatSession(fakeCtxWithStorage(undefined), server, {
      model: "claude-sonnet-4-6",
    });

    const socket = await connect(toWsUrl(info.url));
    const collector = new FrameCollector(socket);

    // First confirm the pre-set_config state has no key.
    socket.send(serialize(message("ready", {}, "id-r")));
    await collector.until((f) => f.some((m) => m.type === "config_state"));
    const before = collector.ofType("config_state")[0];
    if (before.type === "config_state") {
      expect(before.payload.hasKey).toBe(false);
    }

    // Now set a key with no storage dir → in-memory flip, fresh config_state.
    socket.send(
      serialize(message("set_config", { apiKey: SECRET_KEY }, "id-sc2"))
    );
    await collector.until(
      (f) => f.filter((m) => m.type === "config_state").length >= 2
    );
    const after = collector.ofType("config_state")[1];
    if (after.type === "config_state") {
      expect(after.payload.hasKey).toBe(true);
    }
    assertNoKeyLeak(collector.frames);
    for (const frame of collector.frames) {
      expect(serialize(frame)).not.toContain(SECRET_KEY);
    }
  });

  it("chatSession_transcriptRestore_secondSessionSeesPriorTurn", async () => {
    // A scripted runner that appends one assistant message and returns the grown
    // transcript — the session persists it under storageDir after the turn.
    const runTurn = (args: TurnRunArgs): Promise<TurnRunResult> => {
      const grown: typeof args.transcript = [
        ...args.transcript,
        { role: "user", content: args.text },
        { role: "assistant", content: "remembered-reply" },
      ];
      args.events.assistantDone("end_turn");
      return Promise.resolve({ ok: true, messages: grown, refs: [] });
    };

    // Session 1: run a turn that persists the transcript to disk.
    const first = await startServer();
    const session1 = new ChatSession(
      fakeCtxWithStorage(storageDir),
      first.server,
      {
        runTurn,
      }
    );
    const socket1 = await connect(toWsUrl(first.info.url));
    const collector1 = new FrameCollector(socket1);
    socket1.send(
      serialize(message("user_message", { text: "remember this" }, "id-t1"))
    );
    await collector1.until((f) => f.some((m) => m.type === "refs_updated"));
    // Flush on dispose for good measure, then tear this server down.
    session1.dispose();
    await first.server.close();

    // The transcript landed under sessions/.
    expect(existsSync(join(storageDir, "sessions"))).toBe(true);

    // Session 2: a brand-new ChatSession sharing the same storageDir restores
    // the prior turn on construction. We prove the restored transcript is fed
    // forward by having the runner echo back its length.
    let observedPriorLength = -1;
    const runTurn2 = (args: TurnRunArgs): Promise<TurnRunResult> => {
      observedPriorLength = args.transcript.length;
      args.events.assistantDone("end_turn");
      return Promise.resolve({ ok: true, messages: args.transcript, refs: [] });
    };
    const second = await startServer();
    new ChatSession(fakeCtxWithStorage(storageDir), second.server, {
      runTurn: runTurn2,
    });
    const socket2 = await connect(toWsUrl(second.info.url));
    const collector2 = new FrameCollector(socket2);
    socket2.send(
      serialize(message("user_message", { text: "continue" }, "id-t2"))
    );
    await collector2.until((f) => f.some((m) => m.type === "refs_updated"));

    // The restored transcript had the 2 messages session 1 persisted (user +
    // assistant), proving cross-session continuity through the real store.
    expect(observedPriorLength).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* 12. Session glue — `ready` history rehydration (Phase 10 follow-up, §10/§13)  */
/* -------------------------------------------------------------------------- */

/**
 * Drives the REAL `handleReady` → `projectHistory`/`extractDisplayText` path over
 * a `ws` client against a `ChatSession` whose transcript is restored from a temp
 * `storageDirectory` (a `sessions/<id>.json` written before construction). Proves:
 *  - on `ready`, the server emits `config_state` THEN exactly one `history` frame
 *    whose `items` equal the projected user/assistant display text, IN ORDER;
 *  - tool_result-only user messages and tool_use-only assistant messages are
 *    SKIPPED, while an assistant message carrying BOTH a text block and a tool_use
 *    block contributes its text (the projection rule);
 *  - an empty/first-run transcript yields NO `history` frame (only `config_state`);
 *  - the §10 no-key-leak guarantee still holds over every frame, the history one
 *    included.
 *
 * A `MessageParam`-typed transcript is written to disk; `MessageParam.content`
 * admits string OR an array of content blocks, which is exactly what the
 * projection iterates — so this exercises both the string and array branches of
 * `extractDisplayText`.
 */
describe("chatSession_ready_rehydratesHistory", () => {
  /** Per-test temp storage dir holding the seeded `sessions/<id>.json`. */
  let storageDir: string;

  beforeEach(() => {
    storageDir = mkdtempSync(join(tmpdir(), "abl-history-"));
  });

  afterEach(() => {
    rmSync(storageDir, { recursive: true, force: true });
  });

  /** A fake context wired to the temp storage dir (transcript restore on ctor). */
  function fakeCtxWithStorage(
    dir: string | undefined
  ): ConstructorParameters<typeof ChatSession>[0] {
    return makeFakeContext(undefined, {
      storageDirectory: dir,
    }) as unknown as ConstructorParameters<typeof ChatSession>[0];
  }

  /** Write a transcript to `<storageDir>/sessions/<id>.json` so it is restored. */
  function seedTranscript(messages: unknown[]): void {
    const sessionsDir = join(storageDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "seeded.json"),
      JSON.stringify(messages),
      "utf8"
    );
  }

  /**
   * A realistic tool-use round transcript:
   *   1. user (string)                          → kept ("what's in this track?")
   *   2. assistant [text + tool_use]            → kept (its text only)
   *   3. user [tool_result]                     → SKIPPED (no text block)
   *   4. assistant [text]                       → kept (final reply)
   * Expected projected items: exactly the 3 text turns (1, 2, 4) in order; the
   * tool_use / tool_result internals never reach the wire.
   */
  const TOOL_ROUND_TRANSCRIPT: unknown[] = [
    { role: "user", content: "what's in this track?" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Let me check the project." },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "live_get_project",
          input: {},
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: "tracks: [Bass]",
        },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "A Reverb and a Compressor." }],
    },
  ];

  it("chatSession_ready_emitsConfigStateThenHistoryWithProjectedItems", async () => {
    seedTranscript(TOOL_ROUND_TRANSCRIPT);

    const { server, info } = await startServer();
    // The session restores the seeded transcript on construction.
    new ChatSession(fakeCtxWithStorage(storageDir), server, {
      model: "claude-sonnet-4-6",
    });

    const socket = await connect(toWsUrl(info.url));
    const collector = new FrameCollector(socket);

    socket.send(serialize(message("ready", {}, "id-ready")));
    await collector.until((f) => f.some((m) => m.type === "history"));
    // Drain so any (erroneous) second history frame the suppression bug would add
    // has a chance to arrive before we count — pins the count at one.
    await settle();

    // Exactly one config_state and one history frame, config_state FIRST.
    expect(collector.ofType("config_state")).toHaveLength(1);
    expect(collector.ofType("history")).toHaveLength(1);
    const types = collector.frames.map((f) => f.type);
    expect(types.indexOf("config_state")).toBeLessThan(
      types.indexOf("history")
    );

    // The projected items: the tool_result-only user msg and the tool_use block
    // are dropped; the assistant [text + tool_use] contributes ONLY its text.
    const hist = collector.ofType("history")[0];
    expect(hist.type).toBe("history");
    if (hist.type === "history") {
      expect(hist.payload.items).toEqual([
        { role: "user", text: "what's in this track?" },
        { role: "assistant", text: "Let me check the project." },
        { role: "assistant", text: "A Reverb and a Compressor." },
      ]);
    }

    // No history frame may carry an API key (§10 — text-only display projection).
    assertNoKeyLeak(collector.frames);
  });

  it("chatSession_ready_multiTextBlocksJoinedByNewline", async () => {
    // An assistant turn whose content array has two text blocks → joined by "\n";
    // a string-content user turn → used verbatim. Pins the join rule of
    // `extractDisplayText` and the string branch.
    seedTranscript([
      { role: "user", content: "summarize" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Line one." },
          { type: "text", text: "Line two." },
        ],
      },
    ]);

    const { server, info } = await startServer();
    new ChatSession(fakeCtxWithStorage(storageDir), server);

    const socket = await connect(toWsUrl(info.url));
    const collector = new FrameCollector(socket);

    socket.send(serialize(message("ready", {}, "id-ready")));
    await collector.until((f) => f.some((m) => m.type === "history"));

    const hist = collector.ofType("history")[0];
    if (hist.type === "history") {
      expect(hist.payload.items).toEqual([
        { role: "user", text: "summarize" },
        { role: "assistant", text: "Line one.\nLine two." },
      ]);
    }
  });

  it("chatSession_ready_pureToolTranscript_emitsNoHistoryFrame", async () => {
    // A transcript with ONLY tool plumbing (tool_use assistant + tool_result user)
    // projects to zero renderable items → NO history frame is sent (config_state
    // only), so a session that holds only tool turns never sends an empty frame.
    seedTranscript([
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "live_get_project",
            input: {},
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
        ],
      },
    ]);

    const { server, info } = await startServer();
    new ChatSession(fakeCtxWithStorage(storageDir), server);

    const socket = await connect(toWsUrl(info.url));
    const collector = new FrameCollector(socket);

    socket.send(serialize(message("ready", {}, "id-ready")));
    await collector.until((f) => f.some((m) => m.type === "config_state"));
    // Drain so a (buggy) history frame for a no-text transcript would land first.
    await settle();

    expect(collector.ofType("config_state")).toHaveLength(1);
    expect(collector.ofType("history")).toHaveLength(0);
  });

  it("chatSession_ready_emptyFirstRunTranscript_emitsNoHistoryFrame", async () => {
    // No seeded sessions/ at all → empty restored transcript → config_state only.
    const { server, info } = await startServer();
    new ChatSession(fakeCtxWithStorage(storageDir), server);

    const socket = await connect(toWsUrl(info.url));
    const collector = new FrameCollector(socket);

    socket.send(serialize(message("ready", {}, "id-ready")));
    await collector.until((f) => f.some((m) => m.type === "config_state"));
    await settle();

    expect(collector.ofType("config_state")).toHaveLength(1);
    expect(collector.ofType("history")).toHaveLength(0);
  });
});

/** Extract the planId from the first confirm_request frame a collector saw. */
function planIdOf(collector: FrameCollector): string {
  const cr = collector.ofType("confirm_request")[0];
  if (cr.type === "confirm_request") {
    return cr.payload.planId;
  }
  throw new Error("no confirm_request frame to read planId from");
}

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

/* -------------------------------------------------------------------------- */
/* 13. Phase 11 — launch-scope flow: scopeRef → buildSnapshot → loop          */
/* -------------------------------------------------------------------------- */

/**
 * Phase 11 Task 3c — the scope-flow wiring that feeds the per-turn snapshot.
 *
 * `ChatSession.defaultRunTurn` calls `buildSnapshot(this.ctx, this.scopeRef)`
 * every turn (verified by reading `session.ts`), and the launch routine
 * (`launch.ts`) converts the clicked Handle into that `scopeRef` via
 * `refFromHandle` (ok → scoped session, ResolveErr → header-only). These tests
 * exercise the SAME two production functions the runtime uses — the least-
 * invasive seam, adding NO new production hooks:
 *  - `buildSnapshot(ctx, scopeRef)` carries the scoped track into the block the
 *    loop receives (the `defaultRunTurn` `snapshot` argument);
 *  - the snapshot is re-derived (fresh re-resolution, §6) on each call, so two
 *    sequential turns reflect intervening drift;
 *  - `refFromHandle` makes the launch decision: a top-level track Handle →
 *    `{ ok:true, ref }` (flows as `scopeRef`); a dead handle → ResolveErr →
 *    header-only (no `scopeRef`).
 *
 * The `runTurn` injection seam used by §9 bypasses `buildSnapshot`, so proving
 * the wiring at the `buildSnapshot`/`refFromHandle` boundary is the faithful way
 * to assert it without a fabricated runner that never touches the real path.
 */
describe("chatSession_scopeFlow_scopeRefFeedsPerTurnSnapshot", () => {
  /**
   * The fake's class tokens, threaded into `refFromHandle` exactly as
   * `references.test.ts` does (the fake's class identities are not the SDK's, so
   * `refFromHandle`'s default SDK tokens do not recognize the fake's nodes).
   * `buildSnapshot` needs no tokens — its forward walk reads each token's
   * `className` tag, which the real SDK `Track` token carries.
   */
  const TOKENS = {
    probe: FakeClass.DataModelObject,
    track: FakeClass.Track,
    clip: FakeClass.Clip,
    clipSlot: FakeClass.ClipSlot,
    takeLane: FakeClass.TakeLane,
    scene: FakeClass.Scene,
    cuePoint: FakeClass.CuePoint,
    device: FakeClass.Device,
    chain: FakeClass.Chain,
    trackMixer: FakeClass.TrackMixer,
    chainMixer: FakeClass.ChainMixer,
    param: FakeClass.DeviceParameter,
  } as unknown as ClassTokens;

  /** Cast a fake to the SDK context type at the documented seam (no `any`). */
  function scopeCtx(fake: FakeExtensionContext): ExtensionContext<ApiVersion> {
    return fake as unknown as ExtensionContext<ApiVersion>;
  }

  /** Parse a snapshot string to a record (the loop receives this string). */
  function parse(json: string): Record<string, unknown> {
    return JSON.parse(json) as Record<string, unknown>;
  }

  it("scopeFlow_scopeRefReachesSnapshot_expandsScopedTrack", () => {
    // The string `defaultRunTurn` would pass as `this.scopeRef` (from launch).
    const fake = makeFakeContext();
    const snapshot = parse(buildSnapshot(scopeCtx(fake), "track:0:Drums"));
    // The loop's snapshot block reflects the scoped track (not header-only).
    const scoped = snapshot.scopedTrack as Record<string, unknown> | undefined;
    expect(scoped).toBeDefined();
    expect(scoped?.ref).toBe("track:0:Drums");
    expect(scoped?.name).toBe("Drums");
    expect(snapshot.scopeNote).toBeUndefined();
  });

  it("scopeFlow_noScopeRef_loopReceivesHeaderOnlySnapshot", () => {
    // `scopeRef: undefined` (header-only launch) → no scoped track in the block.
    const fake = makeFakeContext();
    const snapshot = parse(buildSnapshot(scopeCtx(fake), undefined));
    expect(snapshot.scopedTrack).toBeUndefined();
    expect(snapshot.scopeNote).toBeUndefined();
    expect((snapshot.header as { tempo: number }).tempo).toBe(120);
  });

  it("scopeFlow_rebuiltPerTurn_reResolvesAgainstLiveModel", () => {
    // §6: the snapshot is re-derived from the SAME scopeRef each turn. Turn 1
    // resolves the scoped track; deleting it between turns makes Turn 2 fall
    // back honestly — proving fresh re-resolution, not a cached handle.
    const fake = makeFakeContext();
    const turn1 = parse(buildSnapshot(scopeCtx(fake), "track:0:Drums"));
    expect(turn1.scopedTrack).toBeDefined();

    fake.remove("tracks[0]"); // the launch-scoped track is deleted mid-session.

    const turn2 = parse(buildSnapshot(scopeCtx(fake), "track:0:Drums"));
    expect(turn2.scopedTrack).toBeUndefined();
    expect(turn2.scopeNote).toContain("ref_unresolved");
    // The header is re-read fresh too (Drums no longer listed).
    expect((turn2.header as { tracks: unknown[] }).tracks).toHaveLength(4);
  });

  it("scopeFlow_rebuiltPerTurn_reflectsRenameAcrossTurns", () => {
    // A rename of a DIFFERENT track between turns must be reflected in the header
    // of the second turn's snapshot (no stale cache across turns).
    const fake = makeFakeContext();
    const t1 = parse(buildSnapshot(scopeCtx(fake), "track:0:Drums"));
    expect((t1.header as { tracks: { name: string }[] }).tracks[1].name).toBe(
      "Bass"
    );

    fake.rename("tracks[1]", "Sub");

    const t2 = parse(buildSnapshot(scopeCtx(fake), "track:0:Drums"));
    expect((t2.header as { tracks: { name: string }[] }).tracks[1].name).toBe(
      "Sub"
    );
    // The scope (Drums) is unaffected and still expands.
    expect(t2.scopedTrack).toBeDefined();
  });

  it("scopeFlow_launchConversion_topLevelTrackHandleYieldsScopeRef", () => {
    // launch.ts: a top-level track Handle → refFromHandle ok → that ref becomes
    // the session's scopeRef. Use the real SDK tokens (refFromHandle's default),
    // which the fake recognizes via the Track token's `className` tag.
    const fake = makeFakeContext();
    const handle = fake.handleOf("tracks[1]"); // Bass
    const r = refFromHandle(scopeCtx(fake), handle, TOKENS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ref).toBe("track:1:Bass");
      // And that minted ref flows straight into a scoped snapshot.
      const snapshot = parse(buildSnapshot(scopeCtx(fake), r.ref));
      expect((snapshot.scopedTrack as { name: string }).name).toBe("Bass");
    }
  });

  it("scopeFlow_launchConversion_deadHandleYieldsHeaderOnly", () => {
    // launch.ts: a dead/non-anchorable handle → ResolveErr → no scopeRef →
    // header-only session. Prove the conversion fails, then the header-only
    // snapshot is what the loop would receive.
    const fake = makeFakeContext();
    const handle = fake.handleOf("tracks[0]");
    fake.remove("tracks[0]"); // handle is now dead.
    const r = refFromHandle(scopeCtx(fake), handle, TOKENS);
    expect(r.ok).toBe(false);

    // The session built with `scopeRef: undefined` produces a header-only block.
    const snapshot = parse(buildSnapshot(scopeCtx(fake), undefined));
    expect(snapshot.scopedTrack).toBeUndefined();
    expect(snapshot.scopeNote).toBeUndefined();
  });
});
