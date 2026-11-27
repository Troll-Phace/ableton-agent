import * as http from "node:http";
import type * as childProcess from "node:child_process";
import type { Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { vi } from "vitest";

import type {
  ProbeName,
  ProbeResult,
} from "../../src/extension/feasibility/contracts.js";
import {
  nativeProbeDependencies,
  type HostProbeDependencies,
} from "../../src/extension/feasibility/host-probes.js";

export const MARKER = "p15_3-private-storage-probe.json";
export const PRIVATE_PID = 12345;
export const SYNTHETIC_DETAIL = "synthetic-private-detail";

/** A deliberately path-bearing synthetic error, never a real credential. */
export function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(SYNTHETIC_DETAIL), { code });
}

/** Only test-owned temporary directories may be used as SDK storage stand-ins. */
export function makeStorage() {
  const directory = mkdtempSync(join(tmpdir(), "p15-3-offline-"));
  return {
    directory,
    marker: join(directory, MARKER),
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

/** Use real Node loopback when available; reject all non-fixture fetch URLs,
 * and replace the child-process loader even in tests opting into the browser.
 */
export function makeProbeFixture(
  overrides: Partial<HostProbeDependencies> = {}
) {
  const servers: http.Server[] = [];
  const requests: string[] = [];
  const sockets: Socket[] = [];
  const nativeFetch = globalThis.fetch;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    if (typeof input !== "string")
      throw new Error("Expected a fixture URL string");
    const url = new URL(input);
    const port = servers.at(-1)?.address();
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      typeof port !== "object" ||
      port === null ||
      port === undefined ||
      url.port !== String(port.port) ||
      !["/stream", "/abort", "/browser"].includes(url.pathname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("Unexpected fixture destination");
    }
    requests.push(url.pathname);
    return await nativeFetch(input, { ...init, redirect: "error" });
  });
  const createServer = vi.fn((listener: http.RequestListener) => {
    const server = http.createServer(listener);
    servers.push(server);
    server.on("connection", (socket) => sockets.push(socket));
    return server;
  });
  const childLoader = vi.fn<HostProbeDependencies["childProcess"]>(() =>
    Promise.reject(codedError("ERR_ACCESS_DENIED"))
  );
  const deps: HostProbeDependencies = {
    ...nativeProbeDependencies(),
    pid: PRIVATE_PID,
    platform: "darwin",
    http: () =>
      Promise.resolve({
        ...http,
        createServer: createServer as unknown as typeof http.createServer,
      }),
    fetch,
    childProcess: childLoader,
    ...overrides,
  };
  return { deps, servers, requests, sockets, fetch, childLoader, createServer };
}

/** Fetch one fixture-owned page using the guarded loopback fetch; never spawn. */
export function fakeBrowserModule(
  invoke: (
    file: string,
    args: string[],
    options: object,
    callback: (error: Error | null) => void
  ) => void
) {
  const kill = vi.fn(() => true);
  const execFile = vi.fn(
    (
      file: string,
      args: string[],
      options: object,
      callback: (error: Error | null) => void
    ) => {
      invoke(file, args, options, callback);
      return { kill };
    }
  );
  const loader = vi.fn<HostProbeDependencies["childProcess"]>(() =>
    Promise.resolve({
      execFile: execFile as unknown as typeof childProcess.execFile,
    } as typeof childProcess)
  );
  return { loader, execFile, kill };
}

/** Require a uniquely reported probe; duplicate outcome rows are not success. */
export function onlyProbe(
  results: ProbeResult[],
  name: ProbeName
): ProbeResult {
  const matches = results.filter((row) => row.probe === name);
  if (matches.length !== 1 || !matches[0]) {
    throw new Error("Expected exactly one probe result: " + name);
  }
  return matches[0];
}
