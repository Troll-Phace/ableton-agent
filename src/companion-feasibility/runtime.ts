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
import { DiagnosticBudget } from "./diagnostic-budget.js";
import {
  ResponseDiagnostic,
  type TextDiagnosticStatus,
} from "./response-diagnostic.js";
import {
  systemSigninClock,
  SigninFault,
  type SigninPersistence,
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
  /** Fixed on in the 0.0.4 native package; legacy synthetic seams remain test-only. */
  diagnosticMode?: boolean;
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
    diagnosticMode: true,
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
  diagnostic?: TextDiagnosticStatus;
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
  private readonly diagnostic?: ResponseDiagnostic;
  private readonly stopControl = createProbeCancellation();
  private readonly requests = new Set<Promise<unknown>>();
  private shutdownTask?: Promise<CompanionRuntimeShutdown>;

  constructor(private readonly deps: CompanionRuntimeDependencies) {
    this.storage = createCompanionStorage(
      deps.storage,
      deps.diagnosticMode === true
    );
    const persisted = this.storage.store;
    const store: SigninPersistence = deps.diagnosticMode
      ? {
          ensureHostId: () => persisted.ensureHostId(),
          selectedRegistration: () => persisted.selectedRegistration(),
          loadSelectedConnection: () => persisted.loadSelectedConnection(),
          saveConnection: (connection) => persisted.saveConnection(connection),
          clearCredentials: (localId) => persisted.clearCredentials(localId),
          clearAllCredentials: () => persisted.clearAllCredentials(),
          getBudget: () => this.storage.frozenOriginalBudget(),
          reserveInferenceAttempt: () => {
            throw new SigninFault("budget_exhausted");
          },
        }
      : persisted;
    const official = new OfficialHttp(deps);
    const scoped = async <T>(
      request: OfficialRequest,
      run: (request: OfficialRequest) => Promise<T>
    ): Promise<T> => {
      if (this.stopControl.cancelled) throw new SigninFault("cancelled");
      this.storage.assertReady();
      if (deps.diagnosticMode) this.storage.frozenOriginalBudget();
      const combined = createProbeCancellation();
      const removeShutdown = this.stopControl.onCancel(() => combined.cancel());
      const removeAction = request.cancellation?.onCancel(() =>
        combined.cancel()
      );
      const task = Promise.resolve().then(() => {
        if (combined.cancelled) throw new SigninFault("cancelled");
        this.storage.assertReady();
        if (deps.diagnosticMode) this.storage.frozenOriginalBudget();
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
      requestStream: (request, consume, diagnostics) =>
        scoped(request, (bounded) =>
          official.requestStream(bounded, consume, diagnostics)
        ),
    };
    this.oauth = new OAuthLifecycle({
      http: client,
      store,
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
      store,
      TextDecoder: deps.TextDecoder,
      clock: deps.clock,
    });
    this.preflight = new CompanionPreflight({ ...deps, storage: this.storage });
    if (deps.diagnosticMode)
      this.diagnostic = new ResponseDiagnostic({
        budget: new DiagnosticBudget(this.storage.diagnosticRecords()),
        http: client,
        loadConnection: () => this.storage.store.loadSelectedConnection(),
        assertOriginalFrozen: () => {
          this.storage.frozenOriginalBudget();
        },
        clock: deps.clock,
        TextDecoder: deps.TextDecoder,
      });
    this.session = new SigninSession({
      eligibilityBasisReady: deps.eligibilityBasisReady,
      diagnosticMode: deps.diagnosticMode,
      clock: deps.clock,
      oauth: this.oauth,
      responses,
      store,
      hostPreflight: (cancellation) => {
        if (deps.diagnosticMode) this.storage.frozenOriginalBudget();
        return this.preflight.run(cancellation);
      },
    });
  }

  status(): CompanionRuntimeStatus {
    const preflight = this.preflight.report();
    return {
      storage: this.storage.health(),
      ...(preflight ? { preflight } : {}),
      ...(this.diagnostic ? { diagnostic: this.diagnostic.status() } : {}),
    };
  }

  /** Paired explicit owner authorization, distinct from plan-only confirmation. */
  async authorizeTextDiagnostic(ownerAuthorized: boolean): Promise<void> {
    const diagnostic = this.diagnostic;
    if (!diagnostic || ownerAuthorized !== true)
      throw new SigninFault("operator_required");
    await this.session.authorizeTextDiagnostic(
      { operatorStarted: true },
      (context) => diagnostic.authorize(context, ownerAuthorized)
    );
  }
  async runTextDiagnostic(ownerAuthorized: boolean): Promise<void> {
    const diagnostic = this.diagnostic;
    if (!diagnostic || ownerAuthorized !== true)
      throw new SigninFault("operator_required");
    await this.session.runTextDiagnostic(
      { operatorStarted: true },
      (context) => diagnostic.run(context, ownerAuthorized),
      (result) => diagnostic.publish(result)
    );
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
