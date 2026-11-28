import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import { URL } from "node:url";
import { EventEmitter } from "node:events";

import jwt from "jsonwebtoken";
import { vi } from "vitest";

import { type CompanionStorageDependencies } from "../../src/companion-feasibility/storage.js";
import { type CompanionRuntimeDependencies } from "../../src/companion-feasibility/runtime.js";
import {
  COMPANION_CONTROL_PORT,
  COMPANION_CONTROL_HOST,
} from "../../src/companion-feasibility/main.js";
import { AUTHORIZATION_ENDPOINT } from "../../src/extension/feasibility/signin-contracts.js";
import { fakeHttp, testClock, CODE, CLIENT, DETAIL } from "./chatgpt-signin.js";

/** Private synthetic account home; the actual user home is never inspected. */
export function companionHome() {
  const workspace = fs.mkdtempSync(path.join(tmpdir(), "companion-test-only-"));
  const home = path.join(workspace, "synthetic-home");
  fs.mkdirSync(home, { mode: 0o700 });
  const root = path.join(
    home,
    "Library",
    "Ableton Agent Feasibility Companion"
  );
  const directory = path.join(root, "p15-3-signin");
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("POSIX test identity required");
  const deps: CompanionStorageDependencies = {
    fs,
    path,
    homeDirectory: home,
    uid,
    randomUUID: () => crypto.randomUUID(),
    TextDecoder,
  };
  return {
    workspace,
    home,
    root,
    directory,
    deps,
    file: (name: string) => path.join(directory, name),
    dispose: () => fs.rmSync(workspace, { recursive: true, force: true }),
  };
}

/** Native traffic is allowed only for the test's own ephemeral synthetic
 * listeners. All external HTTPS is exclusively scripted and fail-closed. */
export function runtimeFixture(
  home: ReturnType<typeof companionHome>,
  pid = 12345
) {
  const network = fakeHttp();
  const servers: http.Server[] = [];
  const sockets: Socket[] = [];
  const loopback: string[] = [];
  const requests: string[] = [];
  const nativeFetch = globalThis.fetch;
  const createServer = vi.fn((listener: http.RequestListener) => {
    const server = http.createServer((req, res) => {
      requests.push(req.url?.split("?")[0] ?? "");
      listener(req, res);
    });
    server.on("connection", (socket) => sockets.push(socket));
    servers.push(server);
    return server;
  });
  function ownedLoopback(raw: string, allowed: string[]) {
    const url = new URL(raw);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password ||
      url.hash ||
      !allowed.includes(url.pathname) ||
      !servers.some((server) => {
        const address = server.address();
        return (
          address !== null &&
          typeof address !== "string" &&
          address.address === "127.0.0.1" &&
          String(address.port) === url.port
        );
      })
    )
      throw new Error("Unexpected synthetic loopback destination");
    return url;
  }
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    if (typeof input !== "string") throw new Error("Expected fixture URL");
    if (input.startsWith("http://")) {
      const url = ownedLoopback(input, [
        "/companion-stream",
        "/companion-abort",
      ]);
      if (url.search || init?.redirect !== "error")
        throw new Error("Invalid synthetic transport request");
      loopback.push(url.pathname);
      return await nativeFetch(input, { ...init, redirect: "error" });
    }
    return await network.deps.fetch(input, init);
  });
  const browser = vi.fn(async (raw: string) => {
    const auth = new URL(raw);
    if (auth.origin + auth.pathname !== AUTHORIZATION_ENDPOINT)
      throw new Error("Unexpected fake browser route");
    const callback = ownedLoopback(
      auth.searchParams.get("redirect_uri") ?? "",
      ["/auth/callback"]
    );
    if (callback.search) throw new Error("Unexpected callback query");
    const state = auth.searchParams.get("state");
    if (!state) throw new Error("Missing synthetic state");
    callback.searchParams.set("state", state);
    callback.searchParams.set("code", CODE);
    callback.searchParams.set("client_id", CLIENT);
    const response = await nativeFetch(callback.href, { redirect: "error" });
    await response.text();
    if (!response.ok) throw new Error("Synthetic callback failed");
  });
  const deps: CompanionRuntimeDependencies = {
    storage: home.deps,
    http: { createServer: createServer as unknown as typeof http.createServer },
    crypto,
    jwt,
    pid,
    fetch,
    AbortController,
    TextDecoder,
    URL,
    clock: testClock(),
    eligibilityBasisReady: true,
    browser,
  };
  return {
    deps,
    network,
    servers,
    sockets,
    loopback,
    requests,
    fetch,
    browser,
    createServer,
  };
}

/** In-memory fixed-port server double: no actual port or network is used. */
export class FakeSingletonServer extends EventEmitter {
  listening = false;
  readonly listener: http.RequestListener;
  constructor(
    listener: http.RequestListener,
    private readonly bindError?: string
  ) {
    super();
    this.listener = listener;
  }
  listen = vi.fn(
    (
      options: { host: string; port: number; exclusive: boolean },
      onListening: () => void
    ) => {
      if (
        options.host !== COMPANION_CONTROL_HOST ||
        options.port !== COMPANION_CONTROL_PORT ||
        options.exclusive !== true
      )
        throw new Error("Unexpected singleton bind");
      if (this.bindError)
        queueMicrotask(() =>
          this.emit(
            "error",
            Object.assign(new Error(DETAIL), { code: this.bindError })
          )
        );
      else {
        this.listening = true;
        queueMicrotask(onListening);
      }
      return this;
    }
  );
  address() {
    return this.listening
      ? {
          address: COMPANION_CONTROL_HOST,
          port: COMPANION_CONTROL_PORT,
          family: "IPv4",
        }
      : null;
  }
  close = vi.fn((callback: (error?: Error) => void) => {
    this.listening = false;
    callback();
    this.emit("close");
  });
  closeAllConnections = vi.fn();
  response(
    method: string,
    url: string,
    headers: Record<string, string | undefined> = {}
  ) {
    const response = {
      status: 0,
      headers: {} as Record<string, string>,
      body: "",
    };
    const res = {
      writeHead(status: number, fields?: Record<string, string>) {
        response.status = status;
        response.headers = fields ?? {};
        return this;
      },
      end(body?: string) {
        response.body = body ?? "";
        return this;
      },
    };
    this.listener(
      { method, url, headers } as http.IncomingMessage,
      res as unknown as http.ServerResponse
    );
    return response;
  }
}
export function fakeSingleton(bindError?: string) {
  const servers: FakeSingletonServer[] = [];
  const createServer = vi.fn((listener: http.RequestListener) => {
    const server = new FakeSingletonServer(listener, bindError);
    servers.push(server);
    return server as unknown as http.Server;
  });
  return {
    http: { createServer: createServer as unknown as typeof http.createServer },
    servers,
    createServer,
    clock: testClock(),
  };
}
