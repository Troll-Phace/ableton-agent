import type * as Crypto from "node:crypto";
import type * as Http from "node:http";
import type { Socket } from "node:net";
import type * as ChildProcess from "node:child_process";
import {
  createProbeCancellation,
  type ProbeCancellation,
} from "./contracts.js";
import {
  AUTH_ORIGIN,
  AUTHORIZATION_ENDPOINT,
  RESOURCE,
  REQUESTED_SCOPES,
  PLAN_SCOPE,
  SigninFault,
  boundedString,
  validToken,
  record,
  validUuid,
  validHostId,
  errorCode,
  systemSigninClock,
  type SigninAuthorization,
  type SigninClock,
  type SigninPersistence,
  type StoredConnection,
  type Registration,
  type RevocationResult,
} from "./signin-contracts.js";
import {
  encodeForm,
  SigninDeadline,
  type OfficialHttpClient,
} from "./official-http.js";
import type { IdTokenClient, OfficialDiscovery } from "./id-token.js";

const LOOPBACK = "127.0.0.1";
const CALLBACK_PATH = "/auth/callback";
const DYNAMIC_CLIENT = "dynamic_agent_client";
const CALLBACK_LIMIT = 8192;
const BIND_TIMEOUT = 5000;
const CONSENT_TIMEOUT = 300000;
const BROWSER_TIMEOUT = 10000;
const AUTH_TIMEOUT = 360000;
const ACTION_TIMEOUT = 60000;
const CLEANUP_TIMEOUT = 5000;

/** Host-only ephemeral material. It is never returned through IPC. */
export interface PkceMaterial {
  verifier: string;
  challenge: string;
  state: string;
  nonce: string;
}
export type OAuthCrypto = Pick<
  typeof Crypto,
  "randomBytes" | "createHash" | "randomUUID"
>;
export function createPkceMaterial(crypto: OAuthCrypto): PkceMaterial {
  try {
    const random = () => crypto.randomBytes(32).toString("base64url");
    const verifier = random();
    const state = random();
    const nonce = random();
    const challenge = crypto
      .createHash("sha256")
      .update(verifier, "ascii")
      .digest("base64url");
    if (
      ![verifier, state, nonce, challenge].every((value) =>
        /^[A-Za-z0-9_-]{43}$/.test(value)
      ) ||
      new Set([verifier, state, nonce]).size !== 3
    )
      throw new SigninFault("native_unavailable");
    return { verifier, challenge, state, nonce };
  } catch (error) {
    throw new SigninFault(errorCode(error, "native_unavailable"));
  }
}
export interface AuthorizationUrlOptions {
  clientId?: string;
  hostId: string;
  redirectUri: string;
  pkce: PkceMaterial;
}
/** The one official authorization endpoint and preview parameter contract. */
export function buildAuthorizationUrl(
  options: AuthorizationUrlOptions
): string {
  const port = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/auth\/callback$/.exec(
    options.redirectUri
  )?.[1];
  if (
    !validHostId(options.hostId) ||
    !port ||
    Number(port) > 65535 ||
    (options.clientId !== undefined &&
      (!boundedString(options.clientId, 2048) ||
        options.clientId === DYNAMIC_CLIENT)) ||
    ![
      options.pkce.verifier,
      options.pkce.challenge,
      options.pkce.state,
      options.pkce.nonce,
    ].every((value) => /^[A-Za-z0-9_-]{43}$/.test(value))
  )
    throw new SigninFault("callback_invalid");
  const params: Record<string, string> = {
    response_type: "code",
    client_id: options.clientId ?? DYNAMIC_CLIENT,
    redirect_uri: options.redirectUri,
    scope: REQUESTED_SCOPES.join(" "),
    resource: RESOURCE,
    code_challenge: options.pkce.challenge,
    code_challenge_method: "S256",
    state: options.pkce.state,
    nonce: options.pkce.nonce,
    ext_agent_host_id: options.hostId,
  };
  if (options.clientId === undefined) {
    params.agent_name_hint = "Ableton Agent";
  }
  return `${AUTHORIZATION_ENDPOINT}?${encodeForm(params)}`;
}

export interface AuthorizationCallback {
  code: string;
  clientId: string;
}
export interface CallbackOptions {
  state: string;
  expectedClientId?: string;
  cancellation?: ProbeCancellation;
}
export interface CallbackHandle {
  redirectUri: string;
  result: Promise<AuthorizationCallback>;
  close(): Promise<void>;
}
export interface CallbackDependencies {
  http: () => Promise<Pick<typeof Http, "createServer">>;
  URL: typeof globalThis.URL;
  clock: SigninClock;
}
export type CallbackFactory = (
  options: CallbackOptions
) => Promise<CallbackHandle>;
export type BrowserLauncher = (
  url: string,
  cancellation?: ProbeCancellation
) => Promise<void>;

/** Callback parsing uses only the documented local URL constructor. Invalid
 * requests do not consume the pending attempt; only state-matched terminal
 * callbacks can settle it. No parameter value is ever reflected. */
export function parseAuthorizationCallback(
  raw: string,
  state: string,
  expectedClientId: string | undefined,
  URLCtor: typeof globalThis.URL
):
  | { kind: "ignore" }
  | { kind: "error"; fault: SigninFault }
  | { kind: "code"; value: AuthorizationCallback } {
  if (
    raw.length > CALLBACK_LIMIT ||
    !raw.startsWith(`${CALLBACK_PATH}?`) ||
    raw.includes("#")
  )
    return { kind: "ignore" };
  try {
    const url = new URLCtor(raw, `http://${LOOPBACK}`);
    if (url.origin !== `http://${LOOPBACK}` || url.pathname !== CALLBACK_PATH)
      return { kind: "ignore" };
    const query = url.searchParams;
    if (query.getAll("state").length !== 1 || query.get("state") !== state)
      return { kind: "ignore" };
    if (
      [
        "code",
        "error",
        "client_id",
        "iss",
        "error_description",
        "error_uri",
      ].some((key) => query.getAll(key).length > 1)
    )
      return { kind: "ignore" };
    if (query.has("iss") && query.get("iss") !== AUTH_ORIGIN)
      return { kind: "error", fault: new SigninFault("callback_invalid") };
    const error = query.get("error");
    const code = query.get("code");
    const issued = query.get("client_id");
    if (error !== null) {
      if (code !== null)
        return { kind: "error", fault: new SigninFault("callback_invalid") };
      return {
        kind: "error",
        fault: new SigninFault(
          error === "access_denied"
            ? "access_denied"
            : error === "invalid_scope" || error === "insufficient_scope"
              ? "plan_disabled"
              : "callback_invalid"
        ),
      };
    }
    if (!boundedString(code, 4096))
      return { kind: "error", fault: new SigninFault("callback_invalid") };
    if (expectedClientId !== undefined) {
      if (issued !== null && issued !== expectedClientId)
        return { kind: "error", fault: new SigninFault("client_mismatch") };
      return { kind: "code", value: { code, clientId: expectedClientId } };
    }
    if (!boundedString(issued, 2048) || issued === DYNAMIC_CLIENT)
      return { kind: "error", fault: new SigninFault("client_mismatch") };
    return { kind: "code", value: { code, clientId: issued } };
  } catch {
    return { kind: "ignore" };
  }
}

/** Open a one-use ephemeral callback listener; no browser or HTTP provider work. */
export async function openAuthorizationCallback(
  options: CallbackOptions,
  deps: CallbackDependencies
): Promise<CallbackHandle> {
  if (options.cancellation?.cancelled) throw new SigninFault("cancelled");
  const setup = new SigninDeadline(
    deps.clock,
    BIND_TIMEOUT,
    options.cancellation
  );
  const sockets = new Set<Socket>();
  let server: Http.Server | undefined;
  let onSocket: ((socket: Socket) => void) | undefined;
  let onRuntimeError: ((error: Error) => void) | undefined;
  let settle: (value: AuthorizationCallback) => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  let consumed = false;
  const pending = new Promise<AuthorizationCallback>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  void pending.catch(() => undefined);
  let closePromise: Promise<void> | undefined;
  const closeResources = (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      if (!server) return;
      const running = server;
      const deadline = new SigninDeadline(deps.clock, CLEANUP_TIMEOUT);
      let ok = true;
      try {
        const closed = new Promise<void>((resolve, reject) => {
          try {
            running.close((error?: Error) => {
              if (
                error &&
                !("code" in error && error.code === "ERR_SERVER_NOT_RUNNING")
              )
                reject(new SigninFault("cleanup_failed"));
              else resolve();
            });
          } catch (error) {
            if (
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "ERR_SERVER_NOT_RUNNING"
            )
              resolve();
            else reject(new SigninFault("cleanup_failed"));
          }
        });
        try {
          running.closeIdleConnections();
        } catch {
          ok = false;
        }
        try {
          await deadline.wait(closed);
        } catch {
          // The static response may finish gracefully; force close only on deadline.
          try {
            running.closeAllConnections();
          } catch {
            ok = false;
          }
          for (const socket of sockets) {
            try {
              socket.destroy();
            } catch {
              ok = false;
            }
          }
          const forced = new SigninDeadline(deps.clock, CLEANUP_TIMEOUT);
          try {
            await forced.wait(closed);
          } catch {
            ok = false;
          } finally {
            forced.close();
          }
        }
        if (running.listening) ok = false;
      } finally {
        deadline.close();
        if (onSocket) running.off("connection", onSocket);
        if (onRuntimeError) running.off("error", onRuntimeError);
        sockets.clear();
      }
      if (!ok) throw new SigninFault("cleanup_failed");
    })();
    return closePromise;
  };
  try {
    setup.check();
    const { createServer } = await setup.wait(deps.http());
    setup.check();
    server = createServer((req, res) => {
      const reply = (status: number, message: string) => {
        res
          .writeHead(status, {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'",
            Connection: "close",
          })
          .end(message);
      };
      if (consumed) {
        reply(409, "This sign-in attempt is no longer pending.");
        return;
      }
      if (req.method !== "GET" || !req.url) {
        reply(405, "Invalid callback request.");
        return;
      }
      const result = parseAuthorizationCallback(
        req.url,
        options.state,
        options.expectedClientId,
        deps.URL
      );
      if (result.kind === "ignore") {
        reply(400, "Invalid callback request.");
        return;
      }
      consumed = true;
      if (result.kind === "error") {
        reply(400, "Sign-in was not completed. Return to Ableton Agent.");
        fail(result.fault);
      } else {
        reply(200, "Return to Ableton Agent to continue.");
        settle(result.value);
      }
    });
    const running = server;
    onSocket = (socket) => {
      sockets.add(socket);
    };
    onRuntimeError = (error) => {
      fail(new SigninFault(errorCode(error, "callback_bind_failed")));
    };
    running.on("connection", onSocket);
    running.on("error", onRuntimeError);
    let onListening: () => void = () => undefined;
    let onBindError: (error: Error) => void = () => undefined;
    let port: number;
    try {
      const binding = new Promise<number>((resolve, reject) => {
        onListening = () => {
          const address = running.address();
          if (
            !address ||
            typeof address === "string" ||
            address.address !== LOOPBACK ||
            !Number.isInteger(address.port) ||
            address.port < 1 ||
            address.port > 65535
          )
            reject(new SigninFault("callback_bind_failed"));
          else resolve(address.port);
        };
        onBindError = (error) =>
          reject(new SigninFault(errorCode(error, "callback_bind_failed")));
        running.once("error", onBindError);
        running.listen(0, LOOPBACK, onListening);
      });
      port = await setup.wait(binding);
      setup.check();
    } finally {
      running.off("listening", onListening);
      running.off("error", onBindError);
    }
    const consent = new SigninDeadline(
      deps.clock,
      CONSENT_TIMEOUT,
      options.cancellation,
      undefined,
      "callback_timeout"
    );
    const result = (async () => {
      try {
        const callback = await consent.wait(pending);
        consent.check();
        return callback;
      } finally {
        consumed = true;
        consent.close();
        await closeResources();
      }
    })();
    void result.catch(() => undefined);
    return {
      redirectUri: `http://${LOOPBACK}:${port}${CALLBACK_PATH}`,
      result,
      async close() {
        consumed = true;
        fail(new SigninFault("cancelled"));
        await closeResources();
      },
    };
  } catch (error) {
    consumed = true;
    await closeResources();
    throw new SigninFault(errorCode(error, "callback_bind_failed"));
  } finally {
    setup.close();
  }
}

export interface BrowserDependencies {
  childProcess: () => Promise<Pick<typeof ChildProcess, "execFile">>;
  platform: string;
  URL: typeof globalThis.URL;
  clock: SigninClock;
}
/** The only supported browser invocation. No shell and no alternate launcher. */
export async function launchAuthorizationBrowser(
  url: string,
  deps: BrowserDependencies,
  cancellation?: ProbeCancellation
): Promise<void> {
  if (cancellation?.cancelled) throw new SigninFault("cancelled");
  if (deps.platform !== "darwin") throw new SigninFault("browser_unavailable");
  let parsed: InstanceType<typeof globalThis.URL>;
  try {
    parsed = new deps.URL(url);
  } catch {
    throw new SigninFault("invalid_endpoint");
  }
  if (
    parsed.origin !== AUTH_ORIGIN ||
    `${parsed.origin}${parsed.pathname}` !== AUTHORIZATION_ENDPOINT ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    !parsed.search ||
    url.length > CALLBACK_LIMIT
  )
    throw new SigninFault("invalid_endpoint");
  let child: ChildProcess.ChildProcess | undefined;
  let ended = false;
  const deadline = new SigninDeadline(
    deps.clock,
    BROWSER_TIMEOUT,
    cancellation,
    () => {
      try {
        child?.kill();
      } catch {
        /* no fallback */
      }
    }
  );
  try {
    const { execFile } = await deadline.wait(deps.childProcess());
    deadline.check();
    await deadline.wait(
      new Promise<void>((resolve, reject) => {
        child = execFile(
          "/usr/bin/open",
          [url],
          { shell: false, timeout: BROWSER_TIMEOUT, maxBuffer: 4096 },
          (error) => {
            ended = true;
            if (error)
              reject(
                new SigninFault(
                  errorCode(error) === "permission_denied"
                    ? "browser_denied"
                    : "browser_unavailable"
                )
              );
            else resolve();
          }
        );
      })
    );
    deadline.check();
  } catch (error) {
    const code = errorCode(error, "browser_unavailable");
    throw new SigninFault(
      code === "permission_denied" ? "browser_denied" : code
    );
  } finally {
    deadline.close();
    if (child && !ended) {
      try {
        child.kill();
      } catch {
        /* no alternate launcher */
      }
    }
  }
}

export interface OAuthLifecycleDependencies {
  http: OfficialHttpClient;
  store: SigninPersistence;
  idTokens: IdTokenClient;
  crypto: OAuthCrypto;
  callback: CallbackFactory;
  browser: BrowserLauncher;
  clock: SigninClock;
}
/** Resolve native side effects lazily. No requests, callbacks or browser launch here. */
export async function nativeOAuthLifecycleDependencies(
  http: OfficialHttpClient,
  store: SigninPersistence,
  idTokens: IdTokenClient
): Promise<OAuthLifecycleDependencies> {
  try {
    const [crypto, { URL }] = await Promise.all([
      import("node:crypto"),
      import("node:url"),
    ]);
    const clock = systemSigninClock;
    return {
      http,
      store,
      idTokens,
      crypto,
      clock,
      callback: (options) =>
        openAuthorizationCallback(options, {
          http: () => import("node:http"),
          URL,
          clock,
        }),
      browser: (url, cancellation) =>
        launchAuthorizationBrowser(
          url,
          {
            childProcess: () => import("node:child_process"),
            URL,
            clock,
            platform:
              typeof process === "object" ? process.platform : "unknown",
          },
          cancellation
        ),
    };
  } catch (error) {
    throw new SigninFault(errorCode(error, "native_unavailable"));
  }
}

interface TokenFields {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  idToken?: string;
}
/** Validate the token response without logging or keeping unverified identity. */
export function parseTokenFields(
  payload: unknown,
  clientId: string,
  now: number,
  previousRefreshToken?: string
): TokenFields {
  const row = record(payload);
  if (
    !row ||
    !validToken(row.access_token) ||
    !boundedString(row.token_type, 32) ||
    row.token_type.toLowerCase() !== "bearer" ||
    typeof row.expires_in !== "number" ||
    !Number.isSafeInteger(row.expires_in) ||
    row.expires_in <= 0 ||
    row.expires_in > 31536000 ||
    !Number.isSafeInteger(now) ||
    now <= 0 ||
    !Number.isSafeInteger(now + row.expires_in * 1000)
  )
    throw new SigninFault("invalid_response");
  if (row.client_id !== undefined && row.client_id !== clientId)
    throw new SigninFault("client_mismatch");
  const refreshToken =
    row.refresh_token === undefined ? previousRefreshToken : row.refresh_token;
  if (!validToken(refreshToken)) throw new SigninFault("invalid_response");
  if (!boundedString(row.scope, 8192)) throw new SigninFault("plan_disabled");
  const scopes = row.scope.split(" ");
  if (
    scopes.length > 64 ||
    scopes.some(
      (scope) =>
        !scope ||
        scope.length > 128 ||
        !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope)
    ) ||
    new Set(scopes).size !== scopes.length
  )
    throw new SigninFault("invalid_response");
  if (!scopes.includes(PLAN_SCOPE) || !scopes.includes("resource.invoke"))
    throw new SigninFault("plan_disabled");
  if (row.id_token !== undefined && !boundedString(row.id_token, 32768))
    throw new SigninFault("id_token_invalid");
  if (previousRefreshToken === undefined && row.id_token === undefined)
    throw new SigninFault("id_token_invalid");
  return {
    accessToken: row.access_token,
    refreshToken,
    scopes,
    expiresAt: now + row.expires_in * 1000,
    idToken: row.id_token,
  };
}

interface Operation {
  generation: number;
  cancellation: ReturnType<typeof createProbeCancellation>;
  check(): void;
}
interface Pending {
  operation: Operation;
  work: Promise<unknown>;
}
export interface PreflightResult {
  storageReady: true;
  budgetReady: true;
  discoveryReady: true;
  jwksReady: true;
}
export interface OAuthProgress {
  state: "awaiting_consent" | "validating";
}

/** Host-only OAuth lifecycle. Explicit operator gates, generation-guarded writes,
 * a single operation, no automatic refresh/retry, and local cleanup after revocation.
 */
export class OAuthLifecycle {
  private generation = 0;
  private pending?: Pending;
  private discovery?: OfficialDiscovery;
  private signingOut = false;
  constructor(private readonly deps: OAuthLifecycleDependencies) {}

  /** Host-only restart load. Caller must check expiry and scopes before inference. */
  loadConnection(): StoredConnection | undefined {
    return this.deps.store.loadSelectedConnection();
  }
  /** Local, bounded discovery/JWKS and private storage preflight; no OAuth. */
  async preflight(cancellation?: ProbeCancellation): Promise<PreflightResult> {
    return await this.exclusive(
      ACTION_TIMEOUT,
      cancellation,
      async (operation) => {
        operation.check();
        this.deps.store.ensureHostId();
        this.deps.store.getBudget();
        const discovery = await this.deps.idTokens.loadDiscovery(
          operation.cancellation
        );
        operation.check();
        await this.deps.idTokens.verifyJwks(discovery, operation.cancellation);
        operation.check();
        this.discovery = discovery;
        return {
          storageReady: true,
          budgetReady: true,
          discoveryReady: true,
          jwksReady: true,
        };
      }
    );
  }
  /** Starts one operator-authorized sign-in, dynamically registering only when
   * no selected registration exists or the operator explicitly selects a new one. */
  async signIn(
    authorization: SigninAuthorization,
    progress?: (event: OAuthProgress) => void
  ): Promise<StoredConnection> {
    this.requireAuthorization(authorization);
    return await this.exclusive(
      AUTH_TIMEOUT,
      authorization.cancellation,
      async (operation) => {
        operation.check();
        const hostId = this.deps.store.ensureHostId();
        if (
          authorization.newRegistration &&
          this.deps.store.loadSelectedConnection()
        )
          throw new SigninFault("operation_busy");
        const selected = authorization.newRegistration
          ? undefined
          : this.deps.store.selectedRegistration();
        const discovery = await this.getDiscovery(operation);
        operation.check();
        const pkce = createPkceMaterial(this.deps.crypto);
        const callback = await this.deps.callback({
          state: pkce.state,
          expectedClientId: selected?.clientId,
          cancellation: operation.cancellation,
        });
        let auth: AuthorizationCallback | undefined;
        let callbackFailure: SigninFault | undefined;
        try {
          operation.check();
          const url = buildAuthorizationUrl({
            clientId: selected?.clientId,
            hostId,
            redirectUri: callback.redirectUri,
            pkce,
          });
          progress?.({ state: "awaiting_consent" });
          await this.deps.browser(url, operation.cancellation);
          operation.check();
          auth = await callback.result;
          operation.check();
        } catch (error) {
          callbackFailure = new SigninFault(errorCode(error));
        } finally {
          try {
            await callback.close();
          } catch {
            callbackFailure = new SigninFault("cleanup_failed");
          }
        }
        if (callbackFailure) throw callbackFailure;
        if (!auth) throw new SigninFault("callback_invalid");
        operation.check();
        if (
          !boundedString(auth.code, 4096) ||
          !boundedString(auth.clientId, 2048) ||
          auth.clientId === DYNAMIC_CLIENT ||
          (selected && selected.clientId !== auth.clientId)
        )
          throw new SigninFault("client_mismatch");
        progress?.({ state: "validating" });
        const payload = await this.deps.http.requestJson("token", {
          cancellation: operation.cancellation,
          form: {
            grant_type: "authorization_code",
            client_id: auth.clientId,
            code: auth.code,
            code_verifier: pkce.verifier,
            redirect_uri: callback.redirectUri,
            resource: RESOURCE,
          },
        });
        operation.check();
        const fields = parseTokenFields(
          payload,
          auth.clientId,
          this.deps.clock.now()
        );
        if (!fields.idToken) throw new SigninFault("id_token_invalid");
        const identity = await this.deps.idTokens.verifyIdToken(
          discovery,
          fields.idToken,
          {
            clientId: auth.clientId,
            nonce: pkce.nonce,
            subject: selected?.subject,
          },
          operation.cancellation
        );
        operation.check();
        if (
          identity.issuer !== AUTH_ORIGIN ||
          !boundedString(identity.subject, 2048) ||
          (selected &&
            (identity.subject !== selected.subject ||
              identity.issuer !== selected.issuer))
        )
          throw new SigninFault("identity_mismatch");
        const localId = selected?.localId ?? this.deps.crypto.randomUUID();
        if (!validUuid(localId)) throw new SigninFault("native_unavailable");
        const registration: Registration = {
          localId,
          clientId: auth.clientId,
          issuer: identity.issuer,
          subject: identity.subject,
        };
        const result: StoredConnection = {
          version: 1,
          ...registration,
          accessToken: fields.accessToken,
          refreshToken: fields.refreshToken,
          expiresAt: fields.expiresAt,
          scopes: fields.scopes,
        };
        operation.check();
        this.deps.store.saveConnection(result);
        operation.check();
        return result;
      }
    );
  }
  /** Exactly one explicit refresh. Rotated credentials replace the old record
   * together; terminal invalid_grant clears unusable local tokens. */
  async refresh(authorization: SigninAuthorization): Promise<StoredConnection> {
    this.requireAuthorization(authorization);
    return await this.exclusive(
      ACTION_TIMEOUT,
      authorization.cancellation,
      async (operation) => {
        const current = this.deps.store.loadSelectedConnection();
        if (!current) throw new SigninFault("reconnect_required");
        const discovery = await this.getDiscovery(operation);
        operation.check();
        let payload: unknown;
        try {
          payload = await this.deps.http.requestJson("token", {
            cancellation: operation.cancellation,
            form: {
              grant_type: "refresh_token",
              client_id: current.clientId,
              refresh_token: current.refreshToken,
              resource: RESOURCE,
            },
          });
        } catch (error) {
          operation.check();
          if (errorCode(error) === "invalid_grant") {
            this.deps.store.clearCredentials(current.localId);
            throw new SigninFault("reconnect_required");
          }
          throw new SigninFault(errorCode(error));
        }
        operation.check();
        try {
          const fields = parseTokenFields(
            payload,
            current.clientId,
            this.deps.clock.now(),
            current.refreshToken
          );
          if (fields.idToken) {
            // Refresh is not a new authorization attempt: its optional ID token
            // is signature/issuer/audience/expiry/subject checked, not a new nonce.
            const identity = await this.deps.idTokens.verifyIdToken(
              discovery,
              fields.idToken,
              { clientId: current.clientId, subject: current.subject },
              operation.cancellation
            );
            operation.check();
            if (
              identity.issuer !== current.issuer ||
              identity.subject !== current.subject
            )
              throw new SigninFault("identity_mismatch");
          }
          const result: StoredConnection = {
            version: 1,
            localId: current.localId,
            clientId: current.clientId,
            issuer: current.issuer,
            subject: current.subject,
            accessToken: fields.accessToken,
            refreshToken: fields.refreshToken,
            expiresAt: fields.expiresAt,
            scopes: fields.scopes,
          };
          operation.check();
          this.deps.store.saveConnection(result);
          operation.check();
          return result;
        } catch (error) {
          operation.check();
          // A successful token endpoint response may have rotated credentials;
          // invalid returned identity/scope cannot leave the old connection usable.
          const code = errorCode(error, "invalid_response");
          if (
            [
              "invalid_response",
              "plan_disabled",
              "client_mismatch",
              "identity_mismatch",
              "id_token_invalid",
              "jwks_invalid",
            ].includes(code)
          )
            this.deps.store.clearCredentials(current.localId);
          throw new SigninFault(code);
        }
      }
    );
  }
  /** Invalidates any in-flight generation immediately. */
  cancel(): void {
    this.generation++;
    this.pending?.operation.cancellation.cancel();
  }

  /** Cancel first, attempt selected registration revocation without overlapping
   * a request, then delete local credential files even if remote status is unknown. */
  async signOut(): Promise<RevocationResult> {
    if (this.signingOut) throw new SigninFault("operation_busy");
    this.signingOut = true;
    const previous = this.pending;
    this.cancel();
    let remoteRevocation: RevocationResult["remoteRevocation"] =
      "not_applicable";
    let localCleared = false;
    try {
      let idle = true;
      if (previous) {
        const wait = new SigninDeadline(this.deps.clock, CLEANUP_TIMEOUT);
        try {
          await wait.wait(previous.work.catch(() => undefined));
        } catch {
          idle = false;
        } finally {
          wait.close();
        }
      }
      const selected = this.deps.store.loadSelectedConnection();
      if (selected) {
        remoteRevocation = "unconfirmed";
        if (idle) {
          const control = createProbeCancellation();
          const deadline = new SigninDeadline(
            this.deps.clock,
            ACTION_TIMEOUT,
            undefined,
            () => control.cancel()
          );
          try {
            const discovery =
              this.discovery ??
              (await deadline.wait(this.deps.idTokens.loadDiscovery(control)));
            deadline.check();
            await deadline.wait(
              this.deps.http.requestEmpty(
                { kind: "revocation", url: discovery.revocationEndpoint },
                {
                  cancellation: control,
                  form: {
                    token: selected.refreshToken,
                    token_type_hint: "refresh_token",
                    client_id: selected.clientId,
                  },
                }
              )
            );
            deadline.check();
            remoteRevocation = "request_accepted";
          } catch {
            /* unconfirmed; local cleanup still required */
          } finally {
            deadline.close();
            control.cancel();
          }
        }
      }
    } catch {
      remoteRevocation = "unconfirmed";
    } finally {
      try {
        this.deps.store.clearAllCredentials();
        localCleared = true;
      } catch {
        localCleared = false;
      }
      this.discovery = undefined;
      this.signingOut = false;
    }
    return { localCleared, remoteRevocation };
  }

  private requireAuthorization(authorization: SigninAuthorization): void {
    if (authorization.eligible !== true)
      throw new SigninFault("eligibility_pending");
    if (authorization.operatorStarted !== true)
      throw new SigninFault("operator_required");
    if (authorization.cancellation?.cancelled)
      throw new SigninFault("cancelled");
  }
  private async getDiscovery(operation: Operation): Promise<OfficialDiscovery> {
    if (this.discovery) return this.discovery;
    const discovery = await this.deps.idTokens.loadDiscovery(
      operation.cancellation
    );
    operation.check();
    this.discovery = discovery;
    return discovery;
  }
  private async exclusive<T>(
    duration: number,
    cancellation: ProbeCancellation | undefined,
    run: (operation: Operation) => Promise<T>
  ): Promise<T> {
    if (this.pending || this.signingOut)
      throw new SigninFault("operation_busy");
    if (cancellation?.cancelled) throw new SigninFault("cancelled");
    const generation = ++this.generation;
    const control = createProbeCancellation();
    const operation: Operation = {
      generation,
      cancellation: control,
      check: () => {
        if (control.cancelled || this.generation !== generation)
          throw new SigninFault("cancelled");
      },
    };
    const remove = cancellation?.onCancel(() => control.cancel());
    const deadline = new SigninDeadline(
      this.deps.clock,
      duration,
      control,
      () => control.cancel()
    );
    // Assign pending before the work starts; clear only when the underlying work
    // settles, even when the caller-facing deadline has already been cancelled.
    const work = (async () => {
      await Promise.resolve();
      operation.check();
      return await run(operation);
    })();
    this.pending = { operation, work };
    const clear = () => {
      if (this.pending?.operation === operation) this.pending = undefined;
      remove?.();
    };
    void work.then(clear, clear);
    try {
      const result = await deadline.wait(work);
      operation.check();
      return result;
    } catch (error) {
      control.cancel();
      throw new SigninFault(errorCode(error));
    } finally {
      deadline.close();
    }
  }
}
