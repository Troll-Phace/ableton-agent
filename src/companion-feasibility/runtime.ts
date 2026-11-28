import * as http from "node:http";
import * as crypto from "node:crypto";
import { TextDecoder } from "node:util";
import { URL } from "node:url";
import jwt from "jsonwebtoken";

import { createProbeCancellation } from "../extension/feasibility/contracts.js";
import {
  OfficialHttp,
  SigninDeadline,
  type OfficialRequest,
  type OfficialHttpClient,
  type OfficialHttpDependencies,
} from "../extension/feasibility/official-http.js";
import { OidcIdTokenVerifier } from "../extension/feasibility/id-token.js";
import {
  OAuthLifecycle,
  openAuthorizationCallback,
  launchAuthorizationBrowser,
  type BrowserLauncher,
  type OAuthCrypto,
} from "../extension/feasibility/oauth.js";
import { SyntheticResponses } from "../extension/feasibility/responses.js";
import { SigninSession } from "../extension/feasibility/signin-session.js";
import {
  systemSigninClock,
  SigninFault,
} from "../extension/feasibility/signin-contracts.js";
import {
  createCompanionStorage,
  nativeCompanionStorageDependencies,
  type CompanionStorage,
  type CompanionStorageDependencies,
  type CompanionStorageHealth,
} from "./storage.js";
import {
  CompanionPreflight,
  companionJwtAdapter,
  type CompanionJwt,
  type CompanionPreflightReport,
} from "./preflight.js";

export interface CompanionRuntimeDependencies extends OfficialHttpDependencies {
  storage: CompanionStorageDependencies;
  http: Pick<typeof http, "createServer">;
  crypto: OAuthCrypto &
    Pick<typeof crypto, "generateKeyPairSync" | "createPublicKey">;
  jwt: CompanionJwt;
  pid: number;
  eligibilityBasisReady: boolean;
  browser: BrowserLauncher;
}

/** Resolve capabilities only. No requests, browser launch or file access. */
export function nativeCompanionRuntimeDependencies(): CompanionRuntimeDependencies {
  if (
    process.platform !== "darwin" ||
    typeof process.getuid !== "function" ||
    process.getuid() <= 0 ||
    typeof globalThis.fetch !== "function" ||
    typeof globalThis.AbortController !== "function"
  )
    throw new SigninFault("native_unavailable");
  return {
    storage: nativeCompanionStorageDependencies(),
    http,
    crypto,
    jwt,
    pid: process.pid,
    fetch: globalThis.fetch,
    AbortController: globalThis.AbortController,
    TextDecoder,
    URL,
    clock: systemSigninClock,
    // Reviewed MIT integration basis; not a claim about individual plan eligibility.
    eligibilityBasisReady: true,
    browser: (url, cancellation) =>
      launchAuthorizationBrowser(
        url,
        {
          childProcess: () => import("node:child_process"),
          platform: process.platform,
          URL,
          clock: systemSigninClock,
        },
        cancellation
      ),
  };
}

export interface CompanionRuntimeStatus {
  storage: CompanionStorageHealth;
  preflight?: CompanionPreflightReport;
}
export interface CompanionRuntimeShutdown {
  cleanup: "complete" | "pending";
  credentials: "not_cleared_by_shutdown";
}

/** Host-only composition; control receives only session snapshots and safe status.
 * The official HTTP wrapper cannot dispatch after shutdown or uncertain storage. */
export class CompanionRuntime {
  readonly session: SigninSession;
  private readonly storage: CompanionStorage;
  private readonly preflight: CompanionPreflight;
  private readonly oauth: OAuthLifecycle;
  private readonly stopControl = createProbeCancellation();
  private readonly requests = new Set<Promise<unknown>>();
  private shutdownTask?: Promise<CompanionRuntimeShutdown>;

  constructor(private readonly deps: CompanionRuntimeDependencies) {
    this.storage = createCompanionStorage(deps.storage);
    const official = new OfficialHttp(deps);
    const scoped = async <T>(
      request: OfficialRequest,
      run: (request: OfficialRequest) => Promise<T>
    ): Promise<T> => {
      if (this.stopControl.cancelled) throw new SigninFault("cancelled");
      this.storage.assertReady();
      const combined = createProbeCancellation();
      const removeShutdown = this.stopControl.onCancel(() => combined.cancel());
      const removeAction = request.cancellation?.onCancel(() =>
        combined.cancel()
      );
      const task = Promise.resolve().then(() => {
        if (combined.cancelled) throw new SigninFault("cancelled");
        this.storage.assertReady();
        return run({ ...request, cancellation: combined });
      });
      this.requests.add(task);
      try {
        return await task;
      } finally {
        this.requests.delete(task);
        removeShutdown();
        removeAction?.();
      }
    };
    const client: OfficialHttpClient = {
      requestJson: (route, request = {}) =>
        scoped(request, (bounded) => official.requestJson(route, bounded)),
      requestEmpty: (route, request) =>
        scoped(request, (bounded) => official.requestEmpty(route, bounded)),
      requestStream: (request, consume) =>
        scoped(request, (bounded) => official.requestStream(bounded, consume)),
    };
    this.oauth = new OAuthLifecycle({
      http: client,
      store: this.storage.store,
      idTokens: new OidcIdTokenVerifier({
        http: client,
        crypto: deps.crypto,
        jwt: companionJwtAdapter(deps.jwt),
        URL: deps.URL,
        clock: deps.clock,
      }),
      crypto: deps.crypto,
      clock: deps.clock,
      browser: deps.browser,
      callback: (options) =>
        openAuthorizationCallback(options, {
          http: () => Promise.resolve(deps.http),
          URL: deps.URL,
          clock: deps.clock,
        }),
    });
    const responses = new SyntheticResponses({
      http: client,
      store: this.storage.store,
      TextDecoder: deps.TextDecoder,
      clock: deps.clock,
    });
    this.preflight = new CompanionPreflight({ ...deps, storage: this.storage });
    this.session = new SigninSession({
      eligibilityBasisReady: deps.eligibilityBasisReady,
      clock: deps.clock,
      oauth: this.oauth,
      responses,
      store: this.storage.store,
      hostPreflight: (cancellation) => this.preflight.run(cancellation),
    });
  }

  status(): CompanionRuntimeStatus {
    const preflight = this.preflight.report();
    return {
      storage: this.storage.health(),
      ...(preflight ? { preflight } : {}),
    };
  }

  /** Stops operations without implicitly revoking, clearing or re-registering. */
  shutdown(): Promise<CompanionRuntimeShutdown> {
    return (this.shutdownTask ??= this.stop());
  }
  private async stop(): Promise<CompanionRuntimeShutdown> {
    this.stopControl.cancel();
    this.oauth.cancel();
    this.session.cancel();
    const deadline = new SigninDeadline(this.deps.clock, 5000);
    let cleanup: CompanionRuntimeShutdown["cleanup"] = "pending";
    try {
      while (this.session.snapshot().busy || this.requests.size) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await deadline.wait(
            new Promise<void>((resolve) => {
              timer = this.deps.clock.setTimeout(resolve, 20);
            })
          );
        } finally {
          if (timer !== undefined) this.deps.clock.clearTimeout(timer);
        }
      }
      cleanup = "complete";
    } catch {
      // A deadline is not proof of cancellation or remote revocation.
    } finally {
      deadline.close();
    }
    return { cleanup, credentials: "not_cleared_by_shutdown" };
  }
}

/** Native callers must acquire the fixed-port singleton before invoking this. */
export function createCompanionRuntime(
  deps = nativeCompanionRuntimeDependencies()
): CompanionRuntime {
  return new CompanionRuntime(deps);
}
