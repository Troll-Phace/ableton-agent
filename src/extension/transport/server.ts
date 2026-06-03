/**
 * Localhost HTTP + WebSocket transport server — the extension ⇄ webview channel
 * for Spike R3 **Outcome D** (act-in-place, full-duplex socket; see
 * docs/ARCHITECTURE.md §11 UI & Transport, §13 Socket Protocol, §17 spike 3.2).
 *
 * The extension is the WS *server*; the modal webview is the single client. This
 * module:
 *  - binds an `http.createServer` to **loopback + an ephemeral port**
 *    (`listen(0, "127.0.0.1")`) — never a fixed port, never a public interface;
 *  - serves the built single-file SPA (`dist/webview/index.html`) same-origin at
 *    `GET /`, so the webview's WebSocket is same-origin (the cleanest path proven
 *    by spike 3.2 variant (b));
 *  - **nonce-gates** the WebSocket upgrade: a per-session `crypto.randomUUID()`
 *    nonce is embedded in the connect URL (`/?t=<nonce>`) and any upgrade whose
 *    `?t` does not match is destroyed — this stops other localhost processes from
 *    connecting to the chat socket;
 *  - tracks a **single active client** (the modal); a new valid connection
 *    replaces and closes the previous one;
 *  - parses every inbound frame with the pure {@link parseEnvelope} and only
 *    delivers valid {@link ClientMessage}s upstream — malformed frames are logged
 *    structurally and dropped, never thrown.
 *
 * Deliberately **SDK-free and injectable**: it takes no `ExtensionContext`, never
 * imports `@ableton-extensions/sdk` / `@anthropic-ai/sdk` / `src/webview`, and
 * never sees the Anthropic API key. This keeps it headlessly testable with a real
 * Node `ws` client and keeps all secrets in the host's trusted Node layer.
 *
 * The host's only log sink is `console.*` (code-style "Error handling"), so every
 * caught failure logs structured context.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocket, WebSocketServer } from "ws";

import {
  isClientMessage,
  parseEnvelope,
  serialize,
  type ClientMessage,
  type ProtocolMessage,
} from "../../shared/protocol.js";

/** Loopback host the server binds to — never a routable interface. */
const LOOPBACK_HOST = "127.0.0.1";

/** Log prefix mirroring the host's `console.*` convention. */
const LOG_PREFIX = "[transport]";

/**
 * Directory containing the built webview asset, resolved at runtime.
 *
 * In the CJS bundle `__dirname` is defined and resolves to `dist/`, so the
 * single-file SPA sits at `dist/webview/index.html`. Under ESM / tests
 * (`__dirname` undefined) we fall back to `import.meta.url`. `@ts-expect-error`
 * is unnecessary because `__dirname` exists on the CJS global in this build; we
 * read it defensively via `globalThis`.
 */
function resolveWebviewPath(): string {
  const cjsDirname = (globalThis as { __dirname?: string }).__dirname;
  const baseDir =
    typeof cjsDirname === "string"
      ? cjsDirname
      : dirname(fileURLToPath(import.meta.url));
  return join(baseDir, "webview", "index.html");
}

/**
 * Decode a `ws` inbound frame to a UTF-8 string.
 *
 * `RawData` is `Buffer | ArrayBuffer | Buffer[]` (binary frames), and a naive
 * `.toString()` on an `ArrayBuffer` yields `[object ArrayBuffer]`. Routing every
 * case through `Buffer.from` guarantees a correct UTF-8 decode for the JSON
 * envelope (text frames also arrive as `Buffer` under the default `ws` config).
 */
function rawDataToString(data: WebSocket.RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  // `data` is `Buffer | ArrayBuffer` here; `Uint8Array` accepts both and
  // Buffer.from(Uint8Array) is a well-typed overload.
  return Buffer.from(new Uint8Array(data)).toString("utf8");
}

/** Inline page served when the built SPA is missing (operator must build it). */
const FALLBACK_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Ableton Claude Agent</title></head>
<body style="font-family:system-ui;padding:2rem">
<h1>Webview asset missing</h1>
<p>The built SPA <code>dist/webview/index.html</code> was not found.
Run <code>npm run build:webview</code> (or <code>npm run build:dev</code>) and relaunch.</p>
</body></html>`;

/** Result of {@link TransportServer.start}: the connect URL (with nonce) + port. */
export interface TransportStartInfo {
  /** Same-origin URL the modal loads — includes the session nonce as `?t=`. */
  url: string;
  /** The OS-assigned ephemeral port bound on loopback. */
  port: number;
}

/** Handler invoked with each valid inbound {@link ClientMessage}. */
export type ClientMessageHandler = (msg: ClientMessage) => void;

/** Handler invoked when the (single) webview client connects. */
export type ConnectHandler = () => void;

/** Handler invoked when the active webview client disconnects. */
export type DisconnectHandler = () => void;

/** The app-level `ws` event listeners bound to a single socket. */
interface SocketHandlers {
  /** `message` listener bound for this socket. */
  onMessage: (data: WebSocket.RawData) => void;
  /** `close` listener bound for this socket. */
  onClose: () => void;
  /** `error` listener bound for this socket. */
  onError: (err: Error) => void;
}

/**
 * Localhost HTTP + WebSocket transport server for Outcome D.
 *
 * Construct once per session, `start()` before opening the modal, register
 * `onMessage` / `onConnect` / `onDisconnect` handlers, `send()` server messages,
 * and `close()` on teardown. Single active client; nonce-gated upgrades.
 */
export class TransportServer {
  /** Per-session nonce embedded in the connect URL and required on upgrade. */
  private readonly nonce: string;

  /** Underlying HTTP server (serves the SPA + hosts the WS upgrade). */
  private httpServer: HttpServer | null = null;

  /** WebSocket server attached to {@link httpServer} (external-server mode). */
  private wss: WebSocketServer | null = null;

  /** The single active webview socket, if connected. */
  private activeSocket: WebSocket | null = null;

  /** Cached SPA HTML (read once on first request; null until read). */
  private cachedHtml: string | null = null;

  /** Registered inbound-message handler, if any. */
  private messageHandler: ClientMessageHandler | null = null;

  /** Registered connect handler, if any. */
  private connectHandler: ConnectHandler | null = null;

  /** Registered disconnect handler, if any. */
  private disconnectHandler: DisconnectHandler | null = null;

  /**
   * App-level listeners bound per socket, kept by reference so they can be
   * detached individually — never via `removeAllListeners()`, which would also
   * strip ws's internal `close` bookkeeping and orphan the socket in
   * `wss.clients` (hanging `wss.close()`).
   */
  private readonly appHandlers = new WeakMap<WebSocket, SocketHandlers>();

  /** Resolved path to the built webview asset. */
  private readonly webviewPath: string;

  /**
   * @param webviewPath - optional override for the SPA asset path (tests inject
   *   a fixture; production resolves `dist/webview/index.html` at runtime).
   */
  public constructor(webviewPath: string = resolveWebviewPath()) {
    this.nonce = randomUUID();
    this.webviewPath = webviewPath;
  }

  /**
   * Bind the HTTP+WS server to loopback on an ephemeral port and begin serving.
   *
   * Resolves once the server is listening, with the nonce-bearing connect `url`
   * and the assigned `port`. Rejects only if the listen itself fails.
   *
   * @returns the connect {@link TransportStartInfo}.
   */
  public start(): Promise<TransportStartInfo> {
    return new Promise<TransportStartInfo>((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handleHttpRequest(req, res);
      });
      this.httpServer = server;

      const wss = new WebSocketServer({ server });
      this.wss = wss;
      wss.on("connection", (socket, req) => {
        this.handleConnection(socket, req);
      });
      wss.on("error", (err) => {
        console.error(`${LOG_PREFIX} WebSocketServer error`, err);
      });

      server.once("error", (err) => {
        console.error(`${LOG_PREFIX} HTTP server error during listen`, err);
        reject(err instanceof Error ? err : new Error(String(err)));
      });

      server.listen(0, LOOPBACK_HOST, () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          const err = new Error(
            `${LOG_PREFIX} unexpected server address: ${String(address)}`
          );
          console.error(err.message);
          reject(err);
          return;
        }
        const { port } = address;
        const url = `http://${LOOPBACK_HOST}:${port}/?t=${this.nonce}`;
        console.log(`${LOG_PREFIX} listening on ${url}`);
        resolve({ url, port });
      });
    });
  }

  /**
   * Serialize and send a server message to the active webview client.
   *
   * No-op (with a debug log) when no client is connected or the socket is not
   * open — the host must tolerate a missing/closed modal without throwing.
   *
   * @param msg - the {@link ProtocolMessage} to send.
   */
  public send(msg: ProtocolMessage): void {
    const socket = this.activeSocket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      console.debug(
        `${LOG_PREFIX} send("${msg.type}") dropped — no open client`
      );
      return;
    }
    try {
      socket.send(serialize(msg));
    } catch (err) {
      console.error(`${LOG_PREFIX} send("${msg.type}") failed`, err);
    }
  }

  /**
   * Register the handler for valid inbound {@link ClientMessage}s. Replaces any
   * previously registered handler.
   *
   * @param handler - invoked once per valid client frame.
   */
  public onMessage(handler: ClientMessageHandler): void {
    this.messageHandler = handler;
  }

  /**
   * Register the handler invoked when the webview client connects. Replaces any
   * previously registered handler.
   *
   * @param handler - invoked on each accepted (nonce-valid) connection.
   */
  public onConnect(handler: ConnectHandler): void {
    this.connectHandler = handler;
  }

  /**
   * Register the handler invoked when the active webview client disconnects.
   * Replaces any previously registered handler.
   *
   * @param handler - invoked when the active socket closes.
   */
  public onDisconnect(handler: DisconnectHandler): void {
    this.disconnectHandler = handler;
  }

  /**
   * Close the WebSocket server and HTTP server, terminating any active client.
   *
   * Idempotent: safe to call when never started or already closed. Resolves once
   * both servers have fully shut down.
   *
   * @returns a promise that settles when teardown is complete.
   */
  public close(): Promise<void> {
    return new Promise<void>((resolve) => {
      const { wss, httpServer } = this;
      this.wss = null;
      this.httpServer = null;

      if (this.activeSocket !== null) {
        try {
          this.activeSocket.terminate();
        } catch (err) {
          console.error(`${LOG_PREFIX} error terminating active socket`, err);
        }
        this.activeSocket = null;
      }

      const closeHttp = (): void => {
        if (httpServer === null) {
          resolve();
          return;
        }
        httpServer.close((err) => {
          if (err !== undefined && err !== null) {
            // ERR_SERVER_NOT_RUNNING is expected when never started.
            console.debug(`${LOG_PREFIX} http close note`, err.message);
          }
          resolve();
        });
      };

      if (wss === null) {
        closeHttp();
        return;
      }
      // In external-server mode, close BOTH wss and the http server.
      wss.close((err) => {
        if (err !== undefined && err !== null) {
          console.debug(`${LOG_PREFIX} wss close note`, err.message);
        }
        closeHttp();
      });
    });
  }

  /* ----------------------------------------------------------------------- */
  /* HTTP serving                                                            */
  /* ----------------------------------------------------------------------- */

  /**
   * Serve the SPA at `GET /` (and `GET /?...`); 404 for any other path.
   *
   * The SPA HTML is read once and cached; if the asset is missing, an inline
   * fallback page is served and the operator is told (via `console.error`) to
   * build the webview — the server never crashes on a missing asset.
   */
  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    try {
      // Strip the query string; the path is everything before "?".
      const rawUrl = req.url ?? "/";
      const pathOnly = rawUrl.split("?", 1)[0];

      if (req.method === "GET" && pathOnly === "/") {
        const html = this.readSpaHtml();
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
        });
        res.end(html);
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
    } catch (err) {
      console.error(`${LOG_PREFIX} error handling HTTP request`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.end("Internal Server Error");
    }
  }

  /** Read the built SPA HTML (cached); fall back to the inline page if missing. */
  private readSpaHtml(): string {
    if (this.cachedHtml !== null) {
      return this.cachedHtml;
    }
    try {
      this.cachedHtml = readFileSync(this.webviewPath, "utf8");
    } catch (err) {
      console.error(
        `${LOG_PREFIX} webview asset missing at ${this.webviewPath} — run "npm run build:webview" (or build:dev)`,
        err
      );
      this.cachedHtml = FALLBACK_HTML;
    }
    return this.cachedHtml;
  }

  /* ----------------------------------------------------------------------- */
  /* WebSocket lifecycle                                                     */
  /* ----------------------------------------------------------------------- */

  /**
   * Handle a new WS connection: enforce the nonce gate, replace any prior
   * client, and wire message/close/error handlers.
   *
   * The nonce is validated here (rather than in `verifyClient`) so the gate runs
   * after the upgrade and the socket can be cleanly destroyed on mismatch.
   */
  private handleConnection(socket: WebSocket, req: IncomingMessage): void {
    if (!this.isNonceValid(req)) {
      console.error(
        `${LOG_PREFIX} rejecting WS connection — bad/missing nonce (url=${String(
          req.url
        )})`
      );
      try {
        socket.close(1008, "unauthorized");
        socket.terminate();
      } catch (err) {
        console.error(`${LOG_PREFIX} error terminating rejected socket`, err);
      }
      return;
    }

    // Single active client: replace and close any previous socket.
    if (this.activeSocket !== null) {
      console.debug(`${LOG_PREFIX} replacing existing client connection`);
      const previous = this.activeSocket;
      this.activeSocket = null;
      try {
        // Detach ONLY our app-level handlers, not ws's internal `close`
        // bookkeeping listener (it runs `wss.clients.delete(ws)`; stripping it
        // via `removeAllListeners()` would orphan the socket in `wss.clients`
        // and hang `wss.close()` forever). Our handlers already guard on
        // `socket !== this.activeSocket`, so leaving them attached would also be
        // safe — but we remove them to avoid spurious app callbacks, while the
        // natural `close` still drains the socket from `wss.clients`.
        this.detachAppHandlers(previous);
        previous.close(1000, "replaced");
        previous.terminate();
      } catch (err) {
        console.error(`${LOG_PREFIX} error closing previous socket`, err);
      }
    }

    this.activeSocket = socket;

    // Bind app-level handlers as named references so they can later be removed
    // individually (without touching ws's internal listeners).
    const onMessage = (data: WebSocket.RawData): void => {
      this.handleSocketMessage(socket, data);
    };
    const onClose = (): void => {
      this.handleSocketClose(socket);
    };
    const onError = (err: Error): void => {
      console.error(`${LOG_PREFIX} active socket error`, err);
    };
    this.appHandlers.set(socket, { onMessage, onClose, onError });
    socket.on("message", onMessage);
    socket.on("close", onClose);
    socket.on("error", onError);

    try {
      this.connectHandler?.();
    } catch (err) {
      console.error(`${LOG_PREFIX} onConnect handler threw`, err);
    }
  }

  /**
   * Validate the `?t` nonce query param on the upgrade request URL.
   *
   * @returns `true` only when `?t` exactly equals the session nonce.
   */
  private isNonceValid(req: IncomingMessage): boolean {
    const rawUrl = req.url ?? "";
    // Parse against a loopback base so a path-only `req.url` is valid input.
    let provided: string | null;
    try {
      provided = new URL(rawUrl, `http://${LOOPBACK_HOST}`).searchParams.get(
        "t"
      );
    } catch {
      return false;
    }
    return provided !== null && provided === this.nonce;
  }

  /** Parse + deliver one inbound frame; never throws to the socket. */
  private handleSocketMessage(
    socket: WebSocket,
    data: WebSocket.RawData
  ): void {
    // Ignore frames from a socket that is no longer the active client.
    if (socket !== this.activeSocket) {
      return;
    }
    try {
      const raw = rawDataToString(data);
      const result = parseEnvelope(raw);
      if (!result.ok) {
        console.error(
          `${LOG_PREFIX} dropping malformed inbound frame: ${result.error}`
        );
        return;
      }
      const msg = result.message;
      if (!isClientMessage(msg)) {
        console.error(
          `${LOG_PREFIX} dropping non-client inbound message: type="${msg.type}"`
        );
        return;
      }
      try {
        this.messageHandler?.(msg);
      } catch (err) {
        console.error(
          `${LOG_PREFIX} onMessage handler threw for "${msg.type}"`,
          err
        );
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} error processing inbound frame`, err);
    }
  }

  /** Handle the active socket closing: clear it and notify the disconnect hook. */
  private handleSocketClose(socket: WebSocket): void {
    // The socket has closed (ws's internal listener has already drained it from
    // `wss.clients`); drop our app-level listeners so nothing dangles.
    this.detachAppHandlers(socket);
    if (socket !== this.activeSocket) {
      return;
    }
    this.activeSocket = null;
    try {
      this.disconnectHandler?.();
    } catch (err) {
      console.error(`${LOG_PREFIX} onDisconnect handler threw`, err);
    }
  }

  /**
   * Remove ONLY this server's app-level listeners (`message`/`close`/`error`)
   * from a socket, leaving ws's internal `close` bookkeeping listener intact so
   * the socket still drains from `wss.clients`. Never use
   * `removeAllListeners()`, which would strip that internal listener and hang
   * `wss.close()` (see §13 reconnect path).
   */
  private detachAppHandlers(socket: WebSocket): void {
    const handlers = this.appHandlers.get(socket);
    if (handlers === undefined) {
      return;
    }
    this.appHandlers.delete(socket);
    socket.off("message", handlers.onMessage);
    socket.off("close", handlers.onClose);
    socket.off("error", handlers.onError);
  }
}
