/**
 * Runtime capability shim for Live's Extension Host Node runtime.
 *
 * Live 12.4.5b3's Extension Host runs the extension in a **stripped V8 realm**:
 * it is Node 24.14.1 (`require('node:*')` works), but the realm omits Node's
 * usual web-global injections — `TextDecoder`, `Headers`, `URL`, `ReadableStream`,
 * `crypto`, etc. are all `undefined` at module-eval time. `@anthropic-ai/sdk` and
 * its transitive deps (notably `undici`) assume those globals exist, so the very
 * first dependency that touches one throws at load (`TextDecoder is not defined`,
 * `URLSearchParams is not defined`, `Headers is not defined` — all confirmed
 * across Live runs).
 *
 * ## Why eval order is the whole game
 *
 * `undici` references `TextDecoder` (and friends) **at the top of its own module
 * factory**. A static `import "undici"` is **hoisted** by both the ES spec and
 * esbuild, so it evaluates undici's factory BEFORE this module's body runs — i.e.
 * before we can assign the missing globals. A previous version of this shim used
 * a static `import { Headers } from "undici"`, which therefore defeated itself:
 * undici evaluated (and threw on `TextDecoder`) before the shim could install it.
 *
 * The fix is a strictly-ordered module body:
 *
 *  1. Statically import ONLY `node:*` builtins. These are safe to hoist — they
 *     define the classes we need and do NOT depend on any missing global.
 *  2. Assign the Node-builtin-sourced globals onto `globalThis` FIRST (only when
 *     absent — never clobber a host-provided impl), so they exist before undici.
 *  3. Print the capability probe NOW, before undici loads, so even if undici
 *     still fails the operator's log shows the full realm picture. The probe also
 *     reports the event/microtask globals undici needs that we CANNOT source from
 *     a `node:` module (`Event`, `EventTarget`, `AbortController`, …) so the next
 *     Live run tells us whether THEY are the next gap.
 *  4. THEN load `undici` **lazily via a runtime `require`** (NOT a static import),
 *     so its factory evaluates here — after step 2's globals exist — and assign
 *     its Fetch-API classes (`Headers`/`Request`/`Response`/`FormData`) onto
 *     `globalThis` if absent. The `require` is wrapped in try/catch that logs the
 *     exact error, so if undici needs another global at eval we see which.
 *
 * Source modules (step 2, all `node:*`):
 *  - `URL` / `URLSearchParams`                         ← `node:url`
 *  - `TextEncoder` / `TextDecoder`                     ← `node:util`
 *  - `ReadableStream` / `WritableStream` /
 *    `TransformStream` / `ByteLengthQueuingStrategy` /
 *    `CountQueuingStrategy`                            ← `node:stream/web`
 *  - `crypto` (Web Crypto)                             ← `node:crypto` webcrypto
 *  - `Blob` / `File`                                   ← `node:buffer`
 *  - `performance`                                     ← `node:perf_hooks`
 *  - `MessageChannel` / `MessagePort`                  ← `node:worker_threads`
 * Fetch-API classes (step 4, lazy):
 *  - `Headers` / `Request` / `Response` / `FormData`   ← `undici` (runtime require)
 *
 * Fetch-stack consistency: the host has its own `fetch`, which we leave alone.
 * Our `Headers`/`Request`/`Response` come from `undici`, and a host `fetch` from a
 * different impl can reject an undici `Request`/`Headers`. To avoid a cross-impl
 * mismatch the Anthropic client is constructed with undici's `fetch` (acquired
 * lazily; see `claude-client.ts` `realMessagesClient`), so fetch +
 * Headers/Request/Response are all the same undici impl. We ALSO shim the global
 * Fetch classes here because the SDK constructs `new Headers()` against the global
 * in places — both paths are covered.
 *
 * **Import this FIRST** — as the very first import in `src/extension/index.ts` —
 * so the globals are patched before any dependency module initializes. ES import
 * ordering guarantees a top-of-file `import "./runtime-shim.js";` runs before
 * later imports in the same file.
 *
 * The host's only log sink is `console.*`, so the probe logs there. It reports
 * `typeof` only — never any value — so no secret can leak through it.
 */

import { createRequire } from "node:module";

import { Blob as NodeBlob, File as NodeFile } from "node:buffer";
import { webcrypto as nodeWebcrypto } from "node:crypto";
import { performance as nodePerformance } from "node:perf_hooks";
import {
  ReadableStream as NodeReadableStream,
  WritableStream as NodeWritableStream,
  TransformStream as NodeTransformStream,
  ByteLengthQueuingStrategy as NodeByteLengthQueuingStrategy,
  CountQueuingStrategy as NodeCountQueuingStrategy,
} from "node:stream/web";
import {
  URL as NodeURL,
  URLSearchParams as NodeURLSearchParams,
} from "node:url";
import {
  TextEncoder as NodeTextEncoder,
  TextDecoder as NodeTextDecoder,
} from "node:util";
import {
  MessageChannel as NodeMessageChannel,
  MessagePort as NodeMessagePort,
} from "node:worker_threads";

/** Log prefix mirroring the host's `console.*` convention. */
const LOG_PREFIX = "[runtime-shim]";

/** Mutable view of the global object for typed, `any`-free assignment. */
type MutableGlobal = Record<string, unknown>;

/**
 * The minimal slice of `undici` this shim assigns onto `globalThis`. Declared so
 * the runtime `require` result can be narrowed without `any`.
 */
interface UndiciFetchClasses {
  Headers: unknown;
  Request: unknown;
  Response: unknown;
  FormData: unknown;
}

/**
 * Assign `value` onto `globalThis[name]` **only when the global is currently
 * `undefined`** — never clobbering a host-provided implementation.
 */
function defineIfAbsent(g: MutableGlobal, name: string, value: unknown): void {
  if (typeof g[name] === "undefined") {
    g[name] = value;
  }
}

/**
 * Resolve a CJS-safe `require` for the esbuild-bundled extension.
 *
 * The bundle is CJS (`format: "cjs"`, `platform: "node"`), so `__filename` /
 * `__dirname` are defined on the module scope and surfaced on `globalThis` by the
 * host; under ESM/tests they may be absent, so we fall back through `__dirname`
 * and finally `process.cwd()`. This mirrors the `globalThis.__dirname` pattern in
 * `transport/server.ts`. The base only anchors module resolution — `undici` is
 * resolved from `node_modules` (or, in the built bundle, inlined by esbuild and
 * reached via this lazy call rather than a hoisted top-level import).
 */
function createCjsRequire(): NodeRequire {
  const g = globalThis as {
    __filename?: string;
    __dirname?: string;
  };
  const base =
    g.__filename ??
    (typeof g.__dirname === "string"
      ? `${g.__dirname}/index.js`
      : `${process.cwd()}/index.js`);
  return createRequire(base);
}

/**
 * Patch the web-platform globals the Extension Host strips (idempotent / no-op
 * for any already present) and log a host-capability probe.
 *
 * Strict eval order (see the module-level TSDoc): node-builtin globals are
 * installed FIRST, the probe is printed BEFORE undici loads, and undici is then
 * loaded LAZILY via a runtime `require` so it evaluates after the globals exist.
 *
 * Side-effecting and run on import for its global patches. Exported so a
 * lightweight test (and the stripped-realm vm test) can assert it installs each
 * global when absent and is a no-op when present.
 */
export function installRuntimeShim(): void {
  const g = globalThis as MutableGlobal;

  // --- Step 2: install node:* -sourced globals BEFORE undici loads. ---------

  // WHATWG URL — node:url.
  defineIfAbsent(g, "URL", NodeURL);
  defineIfAbsent(g, "URLSearchParams", NodeURLSearchParams);

  // Text encoding — node:util.
  defineIfAbsent(g, "TextEncoder", NodeTextEncoder);
  defineIfAbsent(g, "TextDecoder", NodeTextDecoder);

  // WHATWG streams — node:stream/web.
  defineIfAbsent(g, "ReadableStream", NodeReadableStream);
  defineIfAbsent(g, "WritableStream", NodeWritableStream);
  defineIfAbsent(g, "TransformStream", NodeTransformStream);
  defineIfAbsent(g, "ByteLengthQueuingStrategy", NodeByteLengthQueuingStrategy);
  defineIfAbsent(g, "CountQueuingStrategy", NodeCountQueuingStrategy);

  // Web Crypto — node:crypto's webcrypto.
  defineIfAbsent(g, "crypto", nodeWebcrypto);

  // Binary containers — node:buffer. `File` is present in Node 24 but guarded.
  defineIfAbsent(g, "Blob", NodeBlob);
  defineIfAbsent(g, "File", NodeFile);

  // High-res timer — node:perf_hooks.
  defineIfAbsent(g, "performance", nodePerformance);

  // Worker messaging — node:worker_threads.
  defineIfAbsent(g, "MessageChannel", NodeMessageChannel);
  defineIfAbsent(g, "MessagePort", NodeMessagePort);

  // --- Step 3: probe NOW, before undici loads. ------------------------------
  //
  // Reports `typeof` only (never a value). Covers: the step-2 globals; `fetch`
  // and the Fetch-API classes (`Headers`/`Request`/`Response`/`FormData` — still
  // `undefined` here, expected, undici fills them in step 4); and the
  // event/microtask globals undici needs that we CANNOT source from a `node:`
  // module — if any of those are `undefined`, they are the next likely gap.
  console.log(
    `${LOG_PREFIX} probe(pre-undici):` +
      ` URL=${typeof g.URL} URLSearchParams=${typeof g.URLSearchParams}` +
      ` TextEncoder=${typeof g.TextEncoder} TextDecoder=${typeof g.TextDecoder}` +
      ` ReadableStream=${typeof g.ReadableStream}` +
      ` WritableStream=${typeof g.WritableStream}` +
      ` TransformStream=${typeof g.TransformStream}` +
      ` crypto=${typeof g.crypto} Blob=${typeof g.Blob} File=${typeof g.File}` +
      ` performance=${typeof g.performance}` +
      ` MessageChannel=${typeof g.MessageChannel}` +
      ` MessagePort=${typeof g.MessagePort}` +
      ` fetch=${typeof g.fetch} Headers=${typeof g.Headers}` +
      ` Request=${typeof g.Request} Response=${typeof g.Response}` +
      ` FormData=${typeof g.FormData}` +
      // Globals undici needs that no `node:` module exports — NOT shimmed here.
      ` Event=${typeof g.Event} EventTarget=${typeof g.EventTarget}` +
      ` CustomEvent=${typeof g.CustomEvent} DOMException=${typeof g.DOMException}` +
      ` AbortController=${typeof g.AbortController}` +
      ` AbortSignal=${typeof g.AbortSignal}` +
      ` queueMicrotask=${typeof g.queueMicrotask}` +
      ` structuredClone=${typeof g.structuredClone}` +
      ` setImmediate=${typeof g.setImmediate}`
  );

  // --- Step 4: load undici LAZILY (runtime require), after globals exist. ----
  //
  // A static `import "undici"` would be hoisted and run undici's factory before
  // the assignments above. A runtime `require` runs the factory HERE, so undici
  // sees `TextDecoder` & friends already installed. Wrapped so an eval failure
  // (e.g. a still-missing global undici touches at load) logs the exact error
  // instead of crashing the extension at import.
  try {
    const requireFn = createCjsRequire();
    const undici = requireFn("undici") as UndiciFetchClasses;
    defineIfAbsent(g, "Headers", undici.Headers);
    defineIfAbsent(g, "Request", undici.Request);
    defineIfAbsent(g, "Response", undici.Response);
    defineIfAbsent(g, "FormData", undici.FormData);
    console.log(
      `${LOG_PREFIX} probe(post-undici):` +
        ` Headers=${typeof g.Headers} Request=${typeof g.Request}` +
        ` Response=${typeof g.Response} FormData=${typeof g.FormData}`
    );
  } catch (err) {
    // Do NOT rethrow — a Fetch-class gap must not take down the whole extension
    // at load. The host's only sink is console.*; surface the exact cause.
    console.error(
      `${LOG_PREFIX} failed to lazily load undici for Fetch-API globals` +
        ` (Headers/Request/Response/FormData remain ${typeof g.Headers}) —` +
        ` Claude requests needing them will fail until resolved`,
      err
    );
  }
}

// Run on import so a bare `import "./runtime-shim.js";` patches the globals
// before any later import in the same module initializes its dependencies.
installRuntimeShim();
