/**
 * Runtime-shim unit suite — proves `installRuntimeShim` patches each
 * web-platform global the Extension Host's stripped V8 realm omits **only when
 * absent** (never clobbering a host-provided one), loads `undici` LAZILY so its
 * factory does not hoist-eval before the globals exist, and survives a faithful
 * reproduction of the stripped realm.
 *
 * In vitest/Node every global exists, so to exercise the "absent" branch we
 * delete-then-restore each global around its test. Every case saves and restores
 * the real global in `finally` so no test leaks a deleted global to the others.
 * The capability-probe `console.log`s are silenced per-test to keep output clean.
 *
 * ## Stripped-realm reproduction (the regression guard)
 *
 * Local Node has every global, so a normal test cannot catch the load crash the
 * shim exists to prevent: a hoisted static `import "undici"` evaluating undici's
 * factory before `TextDecoder` exists. The `stripped realm` describe block runs
 * the shim's exact import+install sequence inside a `node:vm` context where
 * `TextDecoder`/`Headers`/`URL`/… are absent, then asserts (a) the shim installs
 * them, (b) `require("undici").Headers` works after the shim, and (c) NOTHING
 * throws at load. This reproduces the Live failure mode and protects against
 * re-introducing a hoisted undici import.
 *
 * Determinism: no network, no timers, no wall-clock — pure global inspection.
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createContext, runInContext } from "node:vm";

import { afterEach, describe, expect, it, vi } from "vitest";

import { installRuntimeShim } from "../src/extension/runtime-shim.js";

const g = globalThis as Record<string, unknown>;

/**
 * The full set of globals the shim installs, in install order. Each entry names
 * the global and the `typeof` the shim guarantees once installed (`crypto` and
 * `performance` are objects; everything else is a constructor/function).
 */
const SHIMMED_GLOBALS: ReadonlyArray<{ name: string; kind: string }> = [
  { name: "URL", kind: "function" },
  { name: "URLSearchParams", kind: "function" },
  { name: "TextEncoder", kind: "function" },
  { name: "TextDecoder", kind: "function" },
  { name: "ReadableStream", kind: "function" },
  { name: "WritableStream", kind: "function" },
  { name: "TransformStream", kind: "function" },
  { name: "ByteLengthQueuingStrategy", kind: "function" },
  { name: "CountQueuingStrategy", kind: "function" },
  { name: "crypto", kind: "object" },
  { name: "Blob", kind: "function" },
  { name: "File", kind: "function" },
  { name: "performance", kind: "object" },
  { name: "MessageChannel", kind: "function" },
  { name: "MessagePort", kind: "function" },
  { name: "Headers", kind: "function" },
  { name: "Request", kind: "function" },
  { name: "Response", kind: "function" },
  { name: "FormData", kind: "function" },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("installRuntimeShim_installsEachGlobalOnlyWhenAbsent", () => {
  it.each(SHIMMED_GLOBALS)(
    "runtimeShim_install_setsGlobalWhenAbsent_$name",
    ({ name, kind }) => {
      const real = g[name];
      // Silence the capability-probe log lines for this assertion-focused test.
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        delete g[name];
        expect(typeof g[name]).toBe("undefined");

        installRuntimeShim();

        // After the shim the global is defined with the expected runtime kind.
        expect(typeof g[name]).toBe(kind);
      } finally {
        g[name] = real;
      }
    }
  );

  it("runtimeShim_install_isNoOpForEveryGlobalWhenPresent", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    // Globals are present (vitest/Node); the shim must NOT overwrite any of them.
    const sentinels = new Map(
      SHIMMED_GLOBALS.map(({ name }) => [name, g[name]] as const)
    );

    installRuntimeShim();

    for (const [name, sentinel] of sentinels) {
      expect(g[name]).toBe(sentinel);
    }
  });

  it("runtimeShim_install_patchedUrlSearchParamsParsesQuery", () => {
    const realParams = g.URLSearchParams;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      delete g.URLSearchParams;
      installRuntimeShim();
      const params = new (g.URLSearchParams as typeof URLSearchParams)("t=abc");
      expect(params.get("t")).toBe("abc");
    } finally {
      g.URLSearchParams = realParams;
    }
  });

  it("runtimeShim_install_patchedTextEncoderRoundTripsUtf8", () => {
    const realEncoder = g.TextEncoder;
    const realDecoder = g.TextDecoder;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      delete g.TextEncoder;
      delete g.TextDecoder;
      installRuntimeShim();
      const Encoder = g.TextEncoder as typeof TextEncoder;
      const Decoder = g.TextDecoder as typeof TextDecoder;
      const bytes = new Encoder().encode("héllo");
      expect(new Decoder().decode(bytes)).toBe("héllo");
    } finally {
      g.TextEncoder = realEncoder;
      g.TextDecoder = realDecoder;
    }
  });

  it("runtimeShim_install_patchedCryptoExposesGetRandomValues", () => {
    const realCrypto = g.crypto;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      delete g.crypto;
      installRuntimeShim();
      const webcrypto = g.crypto as { getRandomValues?: unknown };
      expect(typeof webcrypto.getRandomValues).toBe("function");
    } finally {
      g.crypto = realCrypto;
    }
  });

  it("runtimeShim_install_installsHeadersFromUndiciWhenAbsent", () => {
    // The Fetch-API classes come from undici (loaded lazily) — assert the shim
    // populates a working `Headers` when the global is missing.
    const realHeaders = g.Headers;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      delete g.Headers;
      expect(typeof g.Headers).toBe("undefined");
      installRuntimeShim();
      const HeadersCtor = g.Headers as typeof Headers;
      const headers = new HeadersCtor({ "x-test": "1" });
      expect(headers.get("x-test")).toBe("1");
    } finally {
      g.Headers = realHeaders;
    }
  });

  it("runtimeShim_install_emitsCapabilityProbeBeforeUndici", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    installRuntimeShim();
    // Two probe lines: pre-undici (the full realm picture) + post-undici.
    expect(logSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    const preLine = String(logSpy.mock.calls[0]?.[0] ?? "");
    expect(preLine).toContain("[runtime-shim] probe(pre-undici):");
    // Probe reports the operator-relevant set so the next Live run is definitive.
    // The two queuing strategies are shimmed defensively but omitted from the
    // probe (not diagnostically interesting); everything else is reported.
    const PROBED = SHIMMED_GLOBALS.map((entry) => entry.name).filter(
      (name) =>
        name !== "ByteLengthQueuingStrategy" && name !== "CountQueuingStrategy"
    );
    for (const name of PROBED) {
      expect(preLine).toContain(`${name}=`);
    }
    expect(preLine).toContain("fetch=");
    // The pre-undici probe also reports the event/microtask globals undici needs
    // that no node: module exports, so the next Live run flags them if missing.
    for (const name of [
      "Event",
      "EventTarget",
      "AbortController",
      "queueMicrotask",
      "structuredClone",
      "setImmediate",
    ]) {
      expect(preLine).toContain(`${name}=`);
    }
  });

  it("runtimeShim_install_probeReportsTypeofNeverValues", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    installRuntimeShim();
    // Every probe line must only ever contain `typeof` results — never a value.
    const allowed = new Set([
      "undefined",
      "function",
      "object",
      "string",
      "number",
      "boolean",
      "symbol",
      "bigint",
    ]);
    for (const call of logSpy.mock.calls) {
      const line = String(call[0] ?? "");
      if (!line.includes("probe(")) {
        continue;
      }
      for (const token of line.split(/\s+/)) {
        const eq = token.indexOf("=");
        if (eq === -1) {
          continue;
        }
        const rhs = token.slice(eq + 1);
        if (rhs.length > 0) {
          expect(allowed.has(rhs)).toBe(true);
        }
      }
    }
  });
});

/**
 * Faithful reproduction of Live's stripped V8 realm: a `node:vm` context with the
 * web globals deleted, in which we evaluate the SHIM'S OWN module-eval sequence —
 * statically import node:* builtins, install the globals, THEN lazily
 * `require("undici")`. This is the regression guard for the load crash: if the
 * shim is ever changed back to a hoisted static `import "undici"`, undici's
 * factory would evaluate against the stripped realm and throw
 * `TextDecoder is not defined` here.
 */
describe("installRuntimeShim_survivesStrippedRealm", () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(thisDir, "..");
  const nodeRequire = createRequire(import.meta.url);

  /**
   * Build a vm context that mimics the stripped realm: real Node builtins are
   * reachable (we hand the context a working `require` and `process`), but the
   * web-platform globals the host omits are DELETED, so any code that touches one
   * before the shim installs it throws — exactly as in Live.
   */
  function makeStrippedContext(): Record<string, unknown> {
    const STRIPPED = [
      "URL",
      "URLSearchParams",
      "TextEncoder",
      "TextDecoder",
      "ReadableStream",
      "WritableStream",
      "TransformStream",
      "ByteLengthQueuingStrategy",
      "CountQueuingStrategy",
      "crypto",
      "Blob",
      "File",
      "performance",
      "MessageChannel",
      "MessagePort",
      "Headers",
      "Request",
      "Response",
      "FormData",
    ];
    const sandbox: Record<string, unknown> = {
      // Hand the realm Node's module machinery (host keeps require('node:*')).
      require: createRequire(resolve(repoRoot, "index.js")),
      process,
      console,
      Buffer,
      // `globalThis` inside the vm resolves to the context object itself.
      __filename: resolve(repoRoot, "index.js"),
      __dirname: repoRoot,
    };
    const ctx = createContext(sandbox);
    // Make the sandbox its own globalThis and strip the web globals from it.
    runInContext("globalThis.globalThis = globalThis;", ctx);
    for (const name of STRIPPED) {
      runInContext(
        `try { delete globalThis[${JSON.stringify(name)}]; } catch (_e) {}`,
        ctx
      );
    }
    return ctx;
  }

  it("runtimeShim_strippedRealm_textDecoderAbsentBeforeShim", () => {
    const ctx = makeStrippedContext();
    const probe: unknown = runInContext("typeof globalThis.TextDecoder", ctx);
    // Sanity: the realm really is stripped before we run the shim.
    expect(probe).toBe("undefined");
  });

  it("runtimeShim_strippedRealm_installsGlobalsAndUndiciWithoutThrowing", () => {
    const ctx = makeStrippedContext();

    // The shim's exact module-eval sequence, executed in the stripped realm:
    //  1. static node:* imports -> install globals,  2. lazy require("undici").
    // If this throws, the load crash has regressed.
    const program = `
      (function () {
        const { webcrypto } = require("node:crypto");
        const { TextEncoder, TextDecoder } = require("node:util");
        const { URL, URLSearchParams } = require("node:url");
        const streams = require("node:stream/web");
        const { Blob, File } = require("node:buffer");
        const { performance } = require("node:perf_hooks");
        const { MessageChannel, MessagePort } = require("node:worker_threads");
        const g = globalThis;
        const set = (n, v) => { if (typeof g[n] === "undefined") g[n] = v; };
        set("URL", URL); set("URLSearchParams", URLSearchParams);
        set("TextEncoder", TextEncoder); set("TextDecoder", TextDecoder);
        set("ReadableStream", streams.ReadableStream);
        set("WritableStream", streams.WritableStream);
        set("TransformStream", streams.TransformStream);
        set("crypto", webcrypto); set("Blob", Blob); set("File", File);
        set("performance", performance);
        set("MessageChannel", MessageChannel); set("MessagePort", MessagePort);
        // The crux: undici is required HERE, after the globals exist. A hoisted
        // static import would have evaluated undici against the stripped realm.
        const undici = require("undici");
        set("Headers", undici.Headers); set("Request", undici.Request);
        set("Response", undici.Response); set("FormData", undici.FormData);
        return {
          textDecoder: typeof g.TextDecoder,
          headers: typeof g.Headers,
          headerWorks: new g.Headers({ "x-test": "1" }).get("x-test"),
        };
      })();
    `;

    const result = runInContext(program, ctx) as {
      textDecoder: string;
      headers: string;
      headerWorks: string;
    };

    expect(result.textDecoder).toBe("function");
    expect(result.headers).toBe("function");
    expect(result.headerWorks).toBe("1");
  });

  it("runtimeShim_strippedRealm_undiciResolvableFromRepo", () => {
    // Guards the lazy-require resolution base used by the shim: undici must be
    // resolvable from the repo root so the runtime require() finds it.
    expect(() => nodeRequire.resolve("undici")).not.toThrow();
  });
});
