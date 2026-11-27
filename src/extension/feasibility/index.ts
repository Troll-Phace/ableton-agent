import type { Server } from "node:http";

import {
  initialize,
  type ActivationContext,
  type ExtensionContext,
} from "@ableton-extensions/sdk";

import {
  createProbeCancellation,
  type ProbeResult,
  type NativeCompatibilityReport,
} from "./contracts.js";
import {
  closeLoopback,
  listenLoopback,
  result,
  sanitizedFailure,
} from "./host-probes.js";
import { runNativeCompatibility } from "./native-compatibility.js";

// Build injects the same static HTML included explicitly in the archive. No runtime
// file read outside SDK storage; no production webview import.
declare const __FEASIBILITY_WEBVIEW__: string;
declare const __FEASIBILITY_BUILD_ID__: string;
const VERSION = "0.0.2";
const BUILD_ID =
  typeof __FEASIBILITY_BUILD_ID__ === "string"
    ? __FEASIBILITY_BUILD_ID__
    : "unbuilt";
const COMMAND = "feasibility.p15_3.open";
const PREFIX = "[chatgpt-feasibility]";
const MODAL_DEADLINE_MS = 120000;

function log(status: ProbeResult): void {
  console.info(PREFIX, JSON.stringify(status));
}

async function showFixture(ctx: ExtensionContext<"1.0.0">): Promise<void> {
  let server: Server | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cancellation: ReturnType<typeof createProbeCancellation> | undefined;
  let ongoing: Promise<NativeCompatibilityReport> | undefined;
  let report: NativeCompatibilityReport | null = null;
  let actionFailed = false;
  try {
    const [{ createServer }, { randomBytes }] = await Promise.all([
      import("node:http"),
      import("node:crypto"),
    ]);
    const token = randomBytes(32).toString("hex");
    const root = `/${token}`;
    const send = (res: import("node:http").ServerResponse, body: object) => {
      res
        .writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        })
        .end(JSON.stringify(body));
    };
    server = createServer((req, res) => {
      // All meaningful UI paths require the unlogged, per-modal random nonce.
      // No user-supplied command, URL, filename or request body is parsed.
      if (req.method === "GET" && req.url === `${root}/`) {
        res
          .writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "Content-Security-Policy":
              "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          })
          .end(__FEASIBILITY_WEBVIEW__);
      } else if (req.method === "GET" && req.url === `${root}/status`) {
        send(res, {
          running: !!ongoing,
          report,
          actionFailed,
          version: VERSION,
          buildId: BUILD_ID,
        });
      } else if (req.method === "POST" && req.url === `${root}/compatibility`) {
        if (!ongoing && report?.restored !== false && !actionFailed) {
          cancellation = createProbeCancellation();
          report = null;
          ongoing = runNativeCompatibility({ cancellation });
          void (async () => {
            try {
              report = (await ongoing) ?? null;
              console.info(
                PREFIX,
                JSON.stringify({
                  version: VERSION,
                  buildId: BUILD_ID,
                  compatibility: report,
                })
              );
            } catch (error) {
              actionFailed = true;
              log(result("activation", "failed", sanitizedFailure(error)));
            } finally {
              ongoing = undefined;
            }
          })();
        }
        send(res, {
          running: !!ongoing,
          report,
          actionFailed,
          version: VERSION,
          buildId: BUILD_ID,
        });
      } else if (req.method === "POST" && req.url === `${root}/cancel`) {
        cancellation?.cancel();
        send(res, {
          running: !!ongoing,
          report,
          actionFailed,
          version: VERSION,
          buildId: BUILD_ID,
        });
      } else res.writeHead(404).end();
    });
    const port = await listenLoopback(server);
    log(result("modal_ipc", "pass", "nonce_listener_bound"));
    // The callback only cleans up once the dialog closes; never block activation
    // or the command callback awaiting the SDK modal promise.
    await Promise.race([
      ctx.ui.showModalDialog(`http://127.0.0.1:${port}${root}/`, 480, 560),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, MODAL_DEADLINE_MS);
      }),
    ]);
  } catch (error) {
    log(result("modal_ipc", "blocked", sanitizedFailure(error)));
    // Do not run the old browser/storage probes or automatically run a
    // compatibility experiment if modal setup failed. Operator action only.
  } finally {
    if (timeout) clearTimeout(timeout);
    cancellation?.cancel();
    if (ongoing) {
      try {
        await ongoing;
      } catch {
        /* already classified */
      }
    }
    if (server) {
      try {
        await closeLoopback(server);
      } catch {
        log(result("modal_ipc", "failed", "cleanup_failed"));
      }
    }
  }
}

/** Temporary fixture activation: SDK commands/environment/UI only, no song access. */
export function activate(activation: ActivationContext): void {
  try {
    const ctx = initialize(activation, "1.0.0");
    log(
      result("activation", "pass", "initialized", {
        version: VERSION,
        buildId: BUILD_ID,
      })
    );
    let open = false;
    ctx.commands.registerCommand(COMMAND, () => {
      if (open) return;
      open = true;
      void (async () => {
        try {
          await showFixture(ctx);
        } catch (error) {
          log(result("modal_ipc", "failed", sanitizedFailure(error)));
        } finally {
          open = false;
        }
      })();
    });
    void (async () => {
      try {
        await ctx.ui.registerContextMenuAction(
          "AudioTrack",
          "ChatGPT feasibility 0.0.2 — compatibility…",
          COMMAND
        );
        log(result("activation", "pass", "context_action_registered"));
      } catch (error) {
        log(result("activation", "blocked", sanitizedFailure(error)));
      }
    })();
  } catch (error) {
    log(result("activation", "blocked", sanitizedFailure(error)));
  }
}
