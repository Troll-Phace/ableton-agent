import { randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";

import { SigninDeadline } from "../extension/feasibility/official-http.js";
import {
  systemSigninClock,
  type SigninClock,
} from "../extension/feasibility/signin-contracts.js";
import type { CompanionControlContext, CompanionControl } from "./main.js";
import { COMPANION_CONTROL_ORIGIN } from "./main.js";
import {
  ACTION_PATH,
  CONTROL_PATH,
  PAIR_PATH,
  SESSION_PATH,
  SESSION_COOKIE,
  CSRF_HEADER,
  PAIRING_TTL_MS,
  PAIRING_MAX_FAILURES,
  SESSION_TTL_MS,
  CONTROL_BODY_LIMIT,
  parseControlAction,
  parsePairingRequest,
  type ControlAction,
  type ControlErrorCode,
  type ControlReply,
  type ControlStatusReply,
} from "./contracts.js";

const HOST = "127.0.0.1:17863";
const BODY_TIMEOUT_MS = 5000;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const JSON_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;

export interface CompanionControlDependencies {
  clock: SigninClock;
  randomBytes(size: number): Uint8Array;
  /** Only the controlling interactive terminal, never a persistent logger. */
  showPairingCode(code: string): void;
  /** Fixed control URL, no caller-supplied destination or arguments. */
  openControlPanel(): Promise<void>;
}
export interface CompanionControlOptions {
  view: string;
  dependencies?: CompanionControlDependencies;
}
export function nativeCompanionControlDependencies(): CompanionControlDependencies {
  return {
    clock: systemSigninClock,
    randomBytes,
    showPairingCode(code) {
      if (!process.stdin.isTTY || !process.stdout.isTTY)
        throw new Error("interactive_required");
      process.stdout.write(
        `One-time local pairing code (expires in two minutes): ${code}\n`
      );
    },
    openControlPanel: () =>
      new Promise<void>((resolve, reject) => {
        if (
          process.platform !== "darwin" ||
          !process.stdin.isTTY ||
          !process.stdout.isTTY
        ) {
          reject(new Error("browser_unavailable"));
          return;
        }
        execFile(
          "/usr/bin/open",
          [COMPANION_CONTROL_ORIGIN + "/"],
          { timeout: 5000, maxBuffer: 4096, windowsHide: true },
          (error) => {
            if (error) reject(new Error("browser_unavailable"));
            else resolve();
          }
        );
      }),
  };
}
class ControlFault extends Error {
  constructor(
    readonly status: number,
    readonly code: ControlErrorCode
  ) {
    super(code);
  }
}
function header(req: IncomingMessage, name: string): string | undefined {
  // Reject duplicate security-relevant header fields, even if Node joined them.
  const count = req.rawHeaders.filter(
    (_, index) =>
      index % 2 === 0 && req.rawHeaders[index].toLowerCase() === name
  ).length;
  const value = req.headers[name];
  if (count > 1 || (value !== undefined && typeof value !== "string"))
    throw new ControlFault(403, "request_rejected");
  return value;
}
function token(deps: CompanionControlDependencies): string {
  const bytes = deps.randomBytes(32);
  if (bytes.length !== 32) throw new Error("random_unavailable");
  return Buffer.from(bytes).toString("base64url");
}
function same(a: string | undefined, b: string): boolean {
  if (!a || !TOKEN_SHAPE.test(a) || !TOKEN_SHAPE.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "ascii"), Buffer.from(b, "ascii"));
}
function sessionCookie(req: IncomingMessage): string | undefined {
  const raw = header(req, "cookie");
  if (!raw || raw.length > 2048) return undefined;
  const values = raw
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(SESSION_COOKIE + "="))
    .map((part) => part.slice(SESSION_COOKIE.length + 1));
  return values.length === 1 ? values[0] : undefined;
}
function common(res: ServerResponse): void {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()"
  );
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
  );
}
function reply(res: ServerResponse, status: number, value: ControlReply): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...(status >= 400 ? { Connection: "close" } : {}),
  });
  res.end(JSON.stringify(value));
}
function writeCookie(res: ServerResponse, id: string): void {
  // Plain HTTP loopback only: Secure-cookie behavior on 127.0.0.1 varies by browser.
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`
  );
}
async function readJson(
  req: IncomingMessage,
  clock: SigninClock
): Promise<unknown> {
  if (!JSON_TYPE.test(header(req, "content-type") ?? ""))
    throw new ControlFault(415, "unsupported_media_type");
  const contentLength = header(req, "content-length");
  if (
    contentLength !== undefined &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > CONTROL_BODY_LIMIT)
  ) {
    req.resume();
    throw new ControlFault(413, "body_too_large");
  }
  const deadline = new SigninDeadline(clock, BODY_TIMEOUT_MS);
  const body: Buffer[] = [];
  let total = 0;
  let remove: () => void = () => undefined;
  try {
    const work = new Promise<unknown>((resolve, reject) => {
      const finish = () => {
        try {
          const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(body, total)
          );
          resolve(JSON.parse(decoded) as unknown);
        } catch {
          reject(new ControlFault(400, "invalid_request"));
        }
      };
      const onError = () => reject(new ControlFault(400, "invalid_request"));
      const onData = (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > CONTROL_BODY_LIMIT) {
          reject(new ControlFault(413, "body_too_large"));
          cleanup();
          req.resume();
          return;
        }
        body.push(chunk);
      };
      const cleanup = () => {
        req.off("data", onData);
        req.off("end", finish);
        req.off("aborted", onError);
        req.off("error", onError);
      };
      // Cleanup on all outcomes, including deadline.
      remove = cleanup;
      req.on("data", onData);
      req.once("end", finish);
      req.once("aborted", onError);
      req.once("error", onError);
    });
    return await deadline.wait(work);
  } catch (error) {
    if (error instanceof ControlFault) throw error;
    req.destroy();
    throw new ControlFault(400, "invalid_request");
  } finally {
    deadline.close();
    remove();
  }
}

export function createCompanionControl(
  context: CompanionControlContext,
  options: CompanionControlOptions
): CompanionControl {
  if (context.origin !== COMPANION_CONTROL_ORIGIN)
    throw new Error("invalid_control_origin");
  if (!options.view.includes("{{CSP_NONCE}}"))
    throw new Error("invalid_control_view");
  const deps = options.dependencies ?? nativeCompanionControlDependencies();
  let pairing: { code: string; expires: number; failures: number } | undefined;
  let session: { id: string; csrf: string; expires: number } | undefined;
  let closed = false;
  let started = false;
  let active = 0;
  let signingOut = false;
  const currentSession = (req: IncomingMessage) => {
    if (session && deps.clock.now() >= session.expires) session = undefined;
    if (!session || !same(sessionCookie(req), session.id))
      throw new ControlFault(401, "session_required");
    return session;
  };
  const status = (): ControlStatusReply => ({
    ok: true,
    snapshot: context.runtime.session.snapshot(),
    runtime: context.runtime.status(),
  });
  function failPairing(): never {
    if (pairing) {
      pairing.failures++;
      if (pairing.failures >= PAIRING_MAX_FAILURES) pairing = undefined;
    }
    throw new ControlFault(403, "pairing_failed");
  }
  async function handle(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    common(res);
    try {
      if (closed) throw new ControlFault(503, "control_closed");
      const origin = header(req, "origin");
      if (
        header(req, "host") !== HOST ||
        (origin !== undefined && origin !== COMPANION_CONTROL_ORIGIN) ||
        header(req, "sec-fetch-site") === "cross-site"
      )
        throw new ControlFault(403, "request_rejected");
      if (req.method === "GET" && req.url === CONTROL_PATH) {
        const nonce = token(deps);
        res.setHeader(
          "Content-Security-Policy",
          `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`
        );
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(options.view.replaceAll("{{CSP_NONCE}}", nonce));
        return;
      }
      // No GET mutations, no alternate origins, preflight/CORS or generic routes.
      if (
        req.method !== "POST" ||
        origin !== COMPANION_CONTROL_ORIGIN ||
        (req.url !== PAIR_PATH &&
          req.url !== SESSION_PATH &&
          req.url !== ACTION_PATH)
      )
        throw new ControlFault(403, "request_rejected");
      if (req.url === PAIR_PATH) {
        if (!pairing || deps.clock.now() >= pairing.expires) {
          pairing = undefined;
          throw new ControlFault(403, "pairing_unavailable");
        }
        let input: unknown;
        try {
          input = await readJson(req, deps.clock);
        } catch (error) {
          if (pairing) {
            pairing.failures++;
            if (pairing.failures >= PAIRING_MAX_FAILURES) pairing = undefined;
          }
          throw error;
        }
        if (closed || !pairing || deps.clock.now() >= pairing.expires)
          throw new ControlFault(403, "pairing_unavailable");
        if (!same(parsePairingRequest(input), pairing.code)) failPairing();
        pairing = undefined;
        const id = token(deps),
          csrf = token(deps);
        if (id === csrf) throw new ControlFault(500, "operation_failed");
        session = { id, csrf, expires: deps.clock.now() + SESSION_TTL_MS };
        writeCookie(res, id);
        context.touch();
        reply(res, 200, { ok: true, csrf });
        return;
      }
      const authenticated = currentSession(req);
      if (req.url === SESSION_PATH) {
        // Reload bootstrap, same-origin POST + HttpOnly cookie only. No action
        // or idle extension; the response returns only the ephemeral CSRF token.
        const input = await readJson(req, deps.clock);
        if (
          typeof input !== "object" ||
          input === null ||
          Array.isArray(input) ||
          Object.keys(input).length !== 0
        )
          throw new ControlFault(400, "invalid_request");
        if (closed || currentSession(req) !== authenticated)
          throw new ControlFault(401, "session_required");
        reply(res, 200, { ok: true, csrf: authenticated.csrf });
        return;
      }
      if (!same(header(req, CSRF_HEADER), authenticated.csrf))
        throw new ControlFault(403, "csrf_rejected");
      const action = parseControlAction(await readJson(req, deps.clock));
      if (closed || currentSession(req) !== authenticated)
        throw new ControlFault(401, "session_required");
      if (!action) throw new ControlFault(400, "invalid_request");
      if (action.action === "status") {
        reply(res, 200, status());
        return;
      }
      if (
        action.action !== "cancel" &&
        action.action !== "sign_out" &&
        action.action !== "quit" &&
        (active > 0 || signingOut)
      )
        throw new ControlFault(409, "operation_busy");
      if (action.action === "sign_out" && signingOut)
        throw new ControlFault(409, "operation_busy");
      authenticated.expires = deps.clock.now() + SESSION_TTL_MS;
      writeCookie(res, authenticated.id);
      context.touch();
      if (action.action === "quit") {
        closed = true;
        pairing = undefined;
        session = undefined;
        res.setHeader(
          "Set-Cookie",
          `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
        );
        let notified = false;
        const notifyQuit = () => {
          if (notified) return;
          notified = true;
          context.requestQuit();
        };
        res.once("finish", notifyQuit);
        res.once("close", notifyQuit);
        if (res.destroyed) notifyQuit();
        else reply(res, 200, { ok: true, stopping: true });
        return;
      }
      if (action.action === "cancel") {
        context.runtime.session.cancel();
        reply(res, 200, status());
        return;
      }
      if (action.action === "sign_out") signingOut = true;
      active++;
      try {
        await dispatch(action);
        if (!closed) reply(res, 200, status());
      } finally {
        active--;
        if (action.action === "sign_out") signingOut = false;
      }
    } catch (error) {
      const fault =
        error instanceof ControlFault
          ? error
          : new ControlFault(500, "operation_failed");
      reply(res, fault.status, { ok: false, code: fault.code });
    }
  }
  async function dispatch(
    action: Exclude<ControlAction, { action: "status" }>
  ): Promise<void> {
    const s = context.runtime.session;
    const operator = { operatorStarted: true };
    const runtime = context.runtime.status();
    const diagnosticMode = !!runtime.diagnostic;
    const sdkMode = !!runtime.sdk;
    const sdkLiveProbe = runtime.sdk?.mode === "operator_test";
    if (
      diagnosticMode &&
      (action.action === "run_roundtrip" ||
        action.action === "run_cancellation")
    )
      throw new ControlFault(403, "invalid_request");
    if (
      sdkLiveProbe &&
      action.action === "sign_in" &&
      action.newRegistration === true
    )
      throw new ControlFault(403, "invalid_request");
    if (
      sdkMode &&
      (action.action === "authorize_text_diagnostic" ||
        action.action === "run_text_diagnostic")
    )
      throw new ControlFault(403, "invalid_request");
    switch (action.action) {
      case "preflight":
        await s.preflight(operator);
        break;
      case "sign_in":
        await s.signIn({
          ...operator,
          newRegistration: action.newRegistration,
        });
        break;
      case "refresh":
        await s.refresh(operator);
        break;
      case "load_models":
        await s.loadModels(operator);
        break;
      case "select_model":
        s.selectModel(action.modelSlug, operator);
        break;
      case "confirm_plan_only":
        s.confirmPlanOnly({
          ...operator,
          planOnlyConfirmed: true,
          creditFallbackDisabled: true,
        });
        break;
      case "run_roundtrip":
        await s.runRoundTrip(operator);
        break;
      case "run_cancellation":
        await s.runCancellation(operator);
        break;
      case "authorize_text_diagnostic":
        if (!diagnosticMode || !context.runtime.authorizeTextDiagnostic)
          throw new ControlFault(403, "invalid_request");
        await context.runtime.authorizeTextDiagnostic(action.ownerAuthorized);
        break;
      case "run_text_diagnostic":
        if (!diagnosticMode || !context.runtime.runTextDiagnostic)
          throw new ControlFault(403, "invalid_request");
        await context.runtime.runTextDiagnostic(action.ownerAuthorized);
        break;
      case "run_sdk_diagnostic":
        if (
          !runtime.sdk?.allowanceAvailable ||
          !context.runtime.runSdkDiagnostic
        )
          throw new ControlFault(403, "invalid_request");
        await context.runtime.runSdkDiagnostic(action.ownerAuthorized);
        break;
      case "authorize_sdk_diagnostic":
        if (
          !sdkLiveProbe ||
          runtime.sdk?.budget?.state !== "not_authorized" ||
          !context.runtime.authorizeSdkDiagnostic
        )
          throw new ControlFault(403, "invalid_request");
        await context.runtime.authorizeSdkDiagnostic(action.ownerAuthorized);
        break;
      case "sign_out":
        await s.signOut(operator);
        break;
      case "cancel":
      case "quit":
        break;
    }
  }
  return {
    handler(req, res) {
      void handle(req, res);
    },
    async start() {
      if (started || closed) throw new Error("control_unavailable");
      started = true;
      const code = token(deps);
      pairing = {
        code,
        expires: deps.clock.now() + PAIRING_TTL_MS,
        failures: 0,
      };
      try {
        deps.showPairingCode(code);
        await deps.openControlPanel();
      } catch {
        pairing = undefined;
        throw new Error("control_browser_unavailable");
      }
    },
    close() {
      closed = true;
      pairing = undefined;
      session = undefined;
    },
  };
}
