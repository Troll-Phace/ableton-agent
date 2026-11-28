import type { ProbeCancellation } from "./contracts.js";
import {
  AUTH_ORIGIN,
  DISCOVERY_ENDPOINT,
  TOKEN_ENDPOINT,
  MODELS_ENDPOINT,
  RESPONSES_ENDPOINT,
  SigninFault,
  errorCode,
  record,
  boundedString,
  validToken,
  systemSigninClock,
  type SigninClock,
  type SigninCode,
} from "./signin-contracts.js";

const JSON_LIMIT = 1024 * 1024;
const JSON_TIMEOUT = 15000;
const STREAM_TIMEOUT = 60000;
const CLEANUP_TIMEOUT = 5000;

/** A request can target only fixed official routes or an auth-origin discovery URL. */
export type OfficialRoute =
  | "discovery"
  | "token"
  | "models"
  | "responses"
  | { kind: "jwks" | "revocation"; url: string };
export interface OfficialRequest {
  cancellation?: ProbeCancellation;
  bearer?: string;
  form?: Readonly<Record<string, string>>;
  json?: unknown;
}
export interface OfficialHttpDependencies {
  fetch: typeof globalThis.fetch;
  AbortController: typeof globalThis.AbortController;
  TextDecoder: typeof globalThis.TextDecoder;
  URL: typeof globalThis.URL;
  clock: SigninClock;
}

/** Uses only verified local constructors and the original native transport. No request is made here. */
export async function nativeOfficialHttpDependencies(): Promise<OfficialHttpDependencies> {
  try {
    if (
      typeof globalThis.fetch !== "function" ||
      typeof globalThis.AbortController !== "function"
    )
      throw new SigninFault("native_unavailable");
    const [{ TextDecoder }, { URL }] = await Promise.all([
      import("node:util"),
      import("node:url"),
    ]);
    return {
      fetch: globalThis.fetch,
      AbortController: globalThis.AbortController,
      TextDecoder,
      URL,
      clock: systemSigninClock,
    };
  } catch (error) {
    throw new SigninFault(errorCode(error, "native_unavailable"));
  }
}

export interface OfficialBody {
  /** Bounded reader; throws only fixed SigninFault codes. */
  read(): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>;
  /** Original native abort. A pending read must independently reject to prove it. */
  abort(): void;
  readonly aborted: boolean;
}
export interface OfficialHttpClient {
  requestJson(
    route: Exclude<OfficialRoute, "responses">,
    request?: OfficialRequest
  ): Promise<unknown>;
  requestEmpty(
    route: { kind: "revocation"; url: string },
    request: OfficialRequest
  ): Promise<void>;
  requestStream<T>(
    request: OfficialRequest,
    consume: (body: OfficialBody) => Promise<T>
  ): Promise<T>;
}

/** A fixed bounded race, including callback binding and cleanup. No native globals needed. */
export class SigninDeadline {
  private timer: ReturnType<typeof setTimeout>;
  private remove?: () => void;
  private reason?: SigninFault;
  private readonly interruption: Promise<never>;
  constructor(
    private readonly clock: SigninClock,
    duration: number,
    cancellation?: ProbeCancellation,
    interrupt?: () => void,
    timeoutCode: SigninCode = "timeout"
  ) {
    let rejectInterruption: (error: Error) => void = () => undefined;
    this.interruption = new Promise<never>((_resolve, reject) => {
      rejectInterruption = reject;
    });
    void this.interruption.catch(() => undefined);
    const stop = (code: SigninCode) => {
      if (this.reason) return;
      this.reason = new SigninFault(code);
      try {
        interrupt?.();
      } catch {
        /* timeout/cancel still settles */
      }
      rejectInterruption(this.reason);
    };
    this.timer = clock.setTimeout(() => stop(timeoutCode), duration);
    this.remove = cancellation?.onCancel(() => stop("cancelled"));
  }
  check(): void {
    if (this.reason) throw this.reason;
  }
  async wait<T>(task: PromiseLike<T>): Promise<T> {
    return await Promise.race([task, this.interruption]);
  }
  close(): void {
    this.clock.clearTimeout(this.timer);
    this.remove?.();
  }
}

/** Discovery endpoints must stay on the official HTTPS auth origin. */
export function validateAuthEndpoint(
  value: unknown,
  URLCtor: typeof globalThis.URL
): string {
  if (!boundedString(value, 2048)) throw new SigninFault("invalid_endpoint");
  try {
    const url = new URLCtor(value);
    if (
      url.origin !== AUTH_ORIGIN ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname === "/" ||
      url.href !== value
    )
      throw new SigninFault("invalid_endpoint");
    return url.href;
  } catch {
    throw new SigninFault("invalid_endpoint");
  }
}

/** Encode a form without relying on the host's absent global URLSearchParams. */
export function encodeForm(values: Readonly<Record<string, string>>): string {
  const encode = (value: string) =>
    encodeURIComponent(value)
      .replace(
        /[!'()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
      )
      .replace(/%20/g, "+");
  return Object.entries(values)
    .map(([key, value]) => `${encode(key)}=${encode(value)}`)
    .join("&");
}
function routeUrl(
  route: OfficialRoute,
  URLCtor: typeof globalThis.URL
): string {
  switch (route) {
    case "discovery":
      return DISCOVERY_ENDPOINT;
    case "token":
      return TOKEN_ENDPOINT;
    case "models":
      return MODELS_ENDPOINT;
    case "responses":
      return RESPONSES_ENDPOINT;
    default:
      if (!route || (route.kind !== "jwks" && route.kind !== "revocation"))
        throw new SigninFault("invalid_endpoint");
      return validateAuthEndpoint(route.url, URLCtor);
  }
}
function routeKind(route: OfficialRoute): string {
  return typeof route === "string" ? route : route.kind;
}
function isAbort(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  try {
    return (
      ("name" in error && error.name === "AbortError") ||
      ("code" in error && error.code === "ABORT_ERR")
    );
  } catch {
    return false;
  }
}
function classifyHttp(
  status: number,
  payload: unknown,
  kind: string
): SigninCode {
  const root = record(payload);
  const raw = root?.error;
  const code = typeof raw === "string" ? raw : record(raw)?.code;
  if (status === 429) return "usage_limited";
  if (status >= 500) return "temporary_failure";
  if (code === "invalid_grant" && kind === "token") return "invalid_grant";
  if (code === "access_denied") return "access_denied";
  if (code === "invalid_scope" || code === "insufficient_scope")
    return "plan_disabled";
  if (code === "temporarily_unavailable") return "temporary_failure";
  if (status === 401 && (kind === "models" || kind === "responses"))
    return "reconnect_required";
  if (status === 403 && (kind === "models" || kind === "responses"))
    return "plan_disabled";
  if (status >= 300 && status < 400) return "redirect_rejected";
  return "http_rejected";
}

/** Single in-flight native HTTP seam. All raw exceptions are normalized. */
export class OfficialHttp implements OfficialHttpClient {
  private busy = false;
  private tainted = false;
  constructor(private readonly deps: OfficialHttpDependencies) {}

  /** Bounded JSON parse, including error shape classification. */
  async requestJson(
    route: Exclude<OfficialRoute, "responses">,
    request: OfficialRequest = {}
  ): Promise<unknown> {
    return await this.run(
      route,
      request,
      JSON_TIMEOUT,
      async (body, status, contentType) => {
        if (status < 200 || status >= 300)
          throw new SigninFault(
            classifyHttp(status, await this.readError(body), routeKind(route))
          );
        const payload = await this.readJson(body, contentType);
        return payload;
      }
    );
  }

  /** Revocation may return an empty success body. Request acceptance is not proof of server-side erasure. */
  async requestEmpty(
    route: { kind: "revocation"; url: string },
    request: OfficialRequest
  ): Promise<void> {
    await this.run(route, request, JSON_TIMEOUT, async (body, status) => {
      if (status < 200 || status >= 300) {
        const payload = await this.readError(body);
        throw new SigninFault(classifyHttp(status, payload, route.kind));
      }
      while (!(await body.read()).done) {
        /* bounded by run's cumulative byte limit */
      }
    });
  }

  /** Native SSE only. Consumer owns SSE framing, not the connection resources. */
  async requestStream<T>(
    request: OfficialRequest,
    consume: (body: OfficialBody) => Promise<T>
  ): Promise<T> {
    return await this.run(
      "responses",
      request,
      STREAM_TIMEOUT,
      async (body, status, contentType) => {
        if (status < 200 || status >= 300) {
          const payload = await this.readError(body);
          throw new SigninFault(classifyHttp(status, payload, "responses"));
        }
        if (
          contentType?.split(";")[0]?.trim().toLowerCase() !==
          "text/event-stream"
        )
          throw new SigninFault("invalid_response");
        return await consume(body);
      }
    );
  }

  private async readError(body: OfficialBody): Promise<unknown> {
    try {
      return await this.readJson(body);
    } catch (error) {
      if (errorCode(error) !== "invalid_response")
        throw new SigninFault(errorCode(error));
      return undefined;
    }
  }

  private async readJson(
    body: OfficialBody,
    contentType?: string
  ): Promise<unknown> {
    if (
      contentType !== undefined &&
      !/(?:^application\/json$|\+json$)/i.test(
        contentType.split(";")[0]?.trim() ?? ""
      )
    )
      throw new SigninFault("invalid_response");
    const decoder = new this.deps.TextDecoder("utf-8", { fatal: true });
    let text = "";
    while (true) {
      const row = await body.read();
      if (row.done) break;
      try {
        text += decoder.decode(row.value, { stream: true });
      } catch {
        throw new SigninFault("invalid_response");
      }
    }
    try {
      text += decoder.decode();
      return JSON.parse(text) as unknown;
    } catch {
      throw new SigninFault("invalid_response");
    }
  }

  private async run<T>(
    route: OfficialRoute,
    request: OfficialRequest,
    duration: number,
    consume: (
      body: OfficialBody,
      status: number,
      contentType: string | undefined
    ) => Promise<T>
  ): Promise<T> {
    if (this.busy) throw new SigninFault("operation_busy");
    if (this.tainted) throw new SigninFault("cleanup_failed");
    if (request.cancellation?.cancelled) throw new SigninFault("cancelled");
    this.busy = true;
    let controller: AbortController | undefined;
    let deadline: SigninDeadline | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let responseBody: ReadableStream<Uint8Array> | null | undefined;
    let finished = false;
    let manuallyAborted = false;
    let bytes = 0;
    let chunks = 0;
    let failed: SigninFault | undefined;
    let settled: { value: T } | undefined;
    try {
      if (
        typeof this.deps.fetch !== "function" ||
        typeof this.deps.AbortController !== "function" ||
        typeof this.deps.TextDecoder !== "function" ||
        typeof this.deps.URL !== "function"
      )
        throw new SigninFault("native_unavailable");
      const url = routeUrl(route, this.deps.URL);
      const kind = routeKind(route);
      const headers: Record<string, string> = {
        Accept: kind === "responses" ? "text/event-stream" : "application/json",
      };
      let method = "GET";
      let body: string | undefined;
      if (kind === "token" || kind === "revocation") {
        if (!request.form || request.bearer || request.json !== undefined)
          throw new SigninFault("invalid_response");
        method = "POST";
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        body = encodeForm(request.form);
      } else if (kind === "models" || kind === "responses") {
        if (!validToken(request.bearer) || request.form)
          throw new SigninFault("reconnect_required");
        headers.Authorization = `Bearer ${request.bearer}`;
        if (kind === "responses") {
          if (request.json === undefined)
            throw new SigninFault("invalid_response");
          method = "POST";
          headers["Content-Type"] = "application/json";
          body = JSON.stringify(request.json);
        } else if (request.json !== undefined)
          throw new SigninFault("invalid_response");
      } else if (request.bearer || request.form || request.json !== undefined)
        throw new SigninFault("invalid_response");
      if (body !== undefined && body.length > JSON_LIMIT)
        throw new SigninFault("response_limit");
      controller = new this.deps.AbortController();
      const activeController = controller;
      deadline = new SigninDeadline(
        this.deps.clock,
        duration,
        request.cancellation,
        () => activeController.abort()
      );
      const activeDeadline = deadline;
      activeDeadline.check();
      const pending = this.deps.fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
        redirect: "error",
      });
      // Late result after timeout/cancellation cannot restore state; discard its body.
      void pending
        .then(
          (late) => {
            // The body must be owned even when Fetch resolves concurrently
            // with cancellation, before the awaiting continuation resumes.
            if (!finished) {
              responseBody = late?.body;
              return;
            }
            if (late?.body && typeof late.body.cancel === "function") {
              try {
                void late.body.cancel().catch(() => undefined);
              } catch {
                /* late cleanup */
              }
            }
          },
          () => undefined
        )
        .catch(() => undefined);
      const response = await activeDeadline.wait(pending);
      responseBody = response?.body;
      activeDeadline.check();
      if (
        !response ||
        !Number.isInteger(response.status) ||
        response.status < 100 ||
        response.status > 599
      )
        throw new SigninFault("invalid_response");
      if (
        response.redirected ||
        (response.url && response.url !== url) ||
        (response.status >= 300 && response.status < 400)
      )
        throw new SigninFault("redirect_rejected");
      if (responseBody) {
        if (typeof responseBody.getReader !== "function")
          throw new SigninFault("invalid_response");
        reader = responseBody.getReader();
        if (
          !reader ||
          typeof reader.read !== "function" ||
          typeof reader.cancel !== "function" ||
          typeof reader.releaseLock !== "function"
        )
          throw new SigninFault("invalid_response");
      }
      const activeReader = reader;
      const wrapped: OfficialBody = {
        get aborted() {
          return activeController.signal.aborted;
        },
        abort() {
          manuallyAborted = true;
          try {
            activeController.abort();
          } catch {
            throw new SigninFault("native_unavailable");
          }
        },
        async read() {
          activeDeadline.check();
          if (!activeReader) return { done: true, value: undefined };
          try {
            const row = await activeDeadline.wait(activeReader.read());
            activeDeadline.check();
            if (row.done) return row;
            if (
              !ArrayBuffer.isView(row.value) ||
              typeof row.value.byteLength !== "number"
            )
              throw new SigninFault("invalid_response");
            bytes += row.value.byteLength;
            chunks++;
            if (bytes > JSON_LIMIT || chunks > 10000)
              throw new SigninFault("response_limit");
            return row;
          } catch (error) {
            activeDeadline.check();
            if (
              manuallyAborted &&
              activeController.signal.aborted &&
              isAbort(error)
            )
              throw new SigninFault("native_abort");
            throw new SigninFault(errorCode(error));
          }
        },
      };
      const value = await activeDeadline.wait(
        consume(
          wrapped,
          response.status,
          response.headers?.get("content-type") ?? undefined
        )
      );
      activeDeadline.check();
      settled = { value };
    } catch (error) {
      failed = new SigninFault(errorCode(error));
      try {
        deadline?.check();
      } catch (interruption) {
        failed = new SigninFault(errorCode(interruption));
      }
    } finally {
      finished = true;
      deadline?.close();
      const cleanup = new SigninDeadline(this.deps.clock, CLEANUP_TIMEOUT);
      let cleanupOk = true;
      try {
        try {
          if (controller && !controller.signal.aborted) controller.abort();
        } catch {
          cleanupOk = false;
        }
        let pending: Promise<unknown> | undefined;
        try {
          if (reader && typeof reader.cancel === "function")
            pending = reader.cancel();
          else if (responseBody && typeof responseBody.cancel === "function")
            pending = responseBody.cancel();
        } catch (error) {
          if (!isAbort(error)) cleanupOk = false;
        }
        if (reader) {
          try {
            reader.releaseLock();
          } catch {
            cleanupOk = false;
          }
        }
        if (pending) {
          try {
            await cleanup.wait(pending);
          } catch (error) {
            if (!isAbort(error)) cleanupOk = false;
          }
        }
      } finally {
        cleanup.close();
        this.busy = false;
      }
      if (!cleanupOk) {
        this.tainted = true;
        failed = new SigninFault("cleanup_failed");
      }
      if (!failed && request.cancellation?.cancelled)
        failed = new SigninFault("cancelled");
    }
    if (failed) throw failed;
    if (!settled) throw new SigninFault("invalid_response");
    return settled.value;
  }
}
