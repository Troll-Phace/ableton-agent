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
import {
  SyntheticResponses,
  type InferenceContext,
} from "../extension/feasibility/responses.js";
import { SigninSession } from "../extension/feasibility/signin-session.js";
import { DiagnosticBudget } from "./diagnostic-budget.js";
import { SdkBudget, type SdkBudgetStatus } from "./sdk-budget.js";
import {
  SDK_EXPERIMENT,
  SdkResponses,
  type SdkDiagnosticAuthorization,
  type SdkDiagnosticStatus,
} from "./sdk-responses.js";
import {
  SdkToolRoundtrip,
  type SdkToolRoundtripAuthorization,
  type SdkToolRoundtripStatus,
} from "./sdk-tool-roundtrip.js";
import {
  ResponseDiagnostic,
  type TextDiagnosticStatus,
} from "./response-diagnostic.js";
import {
  systemSigninClock,
  SigninFault,
  PLAN_SCOPE,
  REQUESTED_SCOPES,
  validToken,
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
  /** Legacy synthetic seams remain test-only. */
  diagnosticMode?: boolean;
  /** Fixed on in SDK-mode packages. */
  sdkMode?: boolean;
  /** 0.0.6: separate explicit durable owner-operated one-request experiment. */
  sdkLiveProbe?: boolean;
  /** 0.0.7 offline tool proof; no live allowance or durable new budget. */
  sdkToolRoundtripMode?: boolean;
  sdkToolRoundtripAuthorization?: SdkToolRoundtripAuthorization;
  /** Synthetic direct-runtime tests only. Never configured by the packaged CLI. */
  sdkAuthorization?: SdkDiagnosticAuthorization;
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
    sdkMode: true,
    sdkToolRoundtripMode: true,
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
  sdk?: SdkRuntimeStatus;
  sdkToolRoundtrip?: SdkToolRoundtripStatus;
}
export interface SdkRuntimeStatus extends Omit<SdkDiagnosticStatus, "mode"> {
  mode: "offline_only" | "operator_test";
  budget?: SdkBudgetStatus;
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
  private readonly sdk?: SdkResponses;
  private readonly sdkLiveBudget?: SdkBudget;
  private readonly priorSdkBudget?: SdkBudget;
  private readonly sdkToolRoundtrip?: SdkToolRoundtrip;
  private readonly priorDiagnosticBudget?: DiagnosticBudget;
  private readonly stopControl = createProbeCancellation();
  private readonly requests = new Set<Promise<unknown>>();
  private shutdownTask?: Promise<CompanionRuntimeShutdown>;

  constructor(private readonly deps: CompanionRuntimeDependencies) {
    const sdkToolMode = deps.sdkToolRoundtripMode === true;
    const sdkLiveProbe = deps.sdkLiveProbe === true && !sdkToolMode;
    const sdkMode = deps.sdkMode === true || sdkLiveProbe || sdkToolMode;
    const diagnosticMode = sdkMode || deps.diagnosticMode === true;
    this.storage = createCompanionStorage(
      deps.storage,
      diagnosticMode,
      sdkMode,
      sdkToolMode
    );
    const persisted = this.storage.store;
    const store: SigninPersistence = diagnosticMode
      ? {
          ensureHostId: () => persisted.ensureHostId(),
          selectedRegistration: () => {
            const selected = persisted.selectedRegistration();
            if ((sdkLiveProbe || sdkToolMode) && !selected)
              throw new SigninFault("reconnect_required");
            return selected;
          },
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
      if (diagnosticMode) this.storage.frozenOriginalBudget();
      const combined = createProbeCancellation();
      const removeShutdown = this.stopControl.onCancel(() => combined.cancel());
      const removeAction = request.cancellation?.onCancel(() =>
        combined.cancel()
      );
      const task = Promise.resolve().then(() => {
        if (combined.cancelled) throw new SigninFault("cancelled");
        this.storage.assertReady();
        if (diagnosticMode) this.storage.frozenOriginalBudget();
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
    if (diagnosticMode && !sdkMode)
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
    if (sdkMode) {
      const prior = new DiagnosticBudget(this.storage.diagnosticRecords());
      this.priorDiagnosticBudget = prior;
      const liveBudget = sdkLiveProbe
        ? new SdkBudget(this.storage.sdkDiagnosticRecords())
        : undefined;
      this.sdkLiveBudget = liveBudget;
      let reservationConfirmed = false;
      if (!sdkToolMode)
        this.sdk = new SdkResponses({
          fetch: deps.fetch,
          AbortController: deps.AbortController,
          clock: deps.clock,
          loadConnection: () => this.storage.store.loadSelectedConnection(),
          assertFrozenBudgets: () => {
            if (this.stopControl.cancelled) throw new SigninFault("cancelled");
            this.storage.frozenOriginalBudget();
            const state = prior.status();
            if (state.state !== "exhausted" || state.attempts !== 1)
              throw new SigninFault("storage_invalid");
            if (liveBudget) {
              const current = liveBudget.status();
              if (
                reservationConfirmed
                  ? current.state !== "exhausted" || current.attempts !== 1
                  : current.state !== "ready" || current.attempts !== 0
              )
                throw new SigninFault("storage_invalid");
            }
          },
          // The live-probe composition cannot use synthetic allowance injection.
          authorization: liveBudget
            ? {
                isAuthorized: () => liveBudget.status().state === "ready",
                reserve: () => {
                  const reserved = liveBudget.reserve();
                  reservationConfirmed =
                    reserved.state === "exhausted" && reserved.attempts === 1;
                  return reservationConfirmed;
                },
              }
            : deps.sdkAuthorization,
        });
      if (sdkToolMode) {
        const priorSdk = new SdkBudget(this.storage.sdkDiagnosticRecords());
        this.priorSdkBudget = priorSdk;
        this.sdkToolRoundtrip = new SdkToolRoundtrip({
          fetch: deps.fetch,
          AbortController: deps.AbortController,
          clock: deps.clock,
          loadConnection: () => this.storage.store.loadSelectedConnection(),
          assertFrozenBudgets: () => {
            if (this.stopControl.cancelled) throw new SigninFault("cancelled");
            this.storage.frozenOriginalBudget();
            const previous = prior.status();
            const sdkText = priorSdk.status();
            if (
              previous.state !== "exhausted" ||
              previous.attempts !== 1 ||
              sdkText.state !== "exhausted" ||
              sdkText.attempts !== 1
            )
              throw new SigninFault("storage_invalid");
          },
          authorization: deps.sdkToolRoundtripAuthorization,
        });
      }
    }
    this.session = new SigninSession({
      eligibilityBasisReady: deps.eligibilityBasisReady,
      diagnosticMode,
      clock: deps.clock,
      oauth: this.oauth,
      responses,
      store,
      hostPreflight: (cancellation) => {
        if (diagnosticMode) this.storage.frozenOriginalBudget();
        return this.preflight.run(cancellation);
      },
    });
  }

  status(): CompanionRuntimeStatus {
    const preflight = this.preflight.report();
    let prior: TextDiagnosticStatus | undefined;
    if (this.priorDiagnosticBudget) {
      let originalAttempts: 1 | null = null;
      try {
        this.storage.frozenOriginalBudget();
        originalAttempts = 1;
      } catch {
        /* unknown */
      }
      prior = { originalAttempts, budget: this.priorDiagnosticBudget.status() };
    }
    return {
      storage: this.storage.health(),
      ...(preflight ? { preflight } : {}),
      ...(this.diagnostic
        ? { diagnostic: this.diagnostic.status() }
        : prior
          ? { diagnostic: prior }
          : {}),
      ...(this.sdk
        ? {
            sdk: this.sdkLiveBudget
              ? {
                  ...this.sdk.status(),
                  mode: "operator_test" as const,
                  budget: this.sdkLiveBudget.status(),
                }
              : this.sdk.status(),
          }
        : this.priorSdkBudget
          ? {
              sdk: {
                experiment: SDK_EXPERIMENT,
                mode: "offline_only" as const,
                allowanceAvailable: false,
                budget: this.priorSdkBudget.status(),
              },
            }
          : {}),
      ...(this.sdkToolRoundtrip
        ? { sdkToolRoundtrip: this.sdkToolRoundtrip.status() }
        : {}),
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

  /** Separate durable authorization through the same session gates, no Fetch. */
  async authorizeSdkDiagnostic(ownerAuthorized: boolean): Promise<void> {
    const budget = this.sdkLiveBudget;
    if (!budget || ownerAuthorized !== true)
      throw new SigninFault("operator_required");
    await this.session.authorizeTextDiagnostic(
      { operatorStarted: true },
      (context) => {
        this.verifySdkAuthorizationConnection(context);
        budget.authorize(ownerAuthorized);
      }
    );
  }

  private verifySdkAuthorizationConnection(context: InferenceContext): void {
    if (this.stopControl.cancelled || context.cancellation?.cancelled)
      throw new SigninFault("cancelled");
    const saved = this.storage.store.loadSelectedConnection();
    const expected = context.connection;
    if (
      !saved ||
      saved.localId !== expected.localId ||
      saved.clientId !== expected.clientId ||
      saved.issuer !== expected.issuer ||
      saved.subject !== expected.subject ||
      saved.accessToken !== expected.accessToken ||
      !validToken(saved.accessToken) ||
      !Number.isSafeInteger(saved.expiresAt) ||
      saved.expiresAt <= this.deps.clock.now()
    )
      throw new SigninFault("reconnect_required");
    if (
      !saved.scopes.includes(PLAN_SCOPE) ||
      !REQUESTED_SCOPES.every((scope) => saved.scopes.includes(scope))
    )
      throw new SigninFault("plan_disabled");
  }

  /** Run requires the separate ready budget; the unchanged SDK adapter reserves it. */
  async runSdkDiagnostic(ownerAuthorized: boolean): Promise<void> {
    const sdk = this.sdk;
    if (!sdk || ownerAuthorized !== true)
      throw new SigninFault("operator_required");
    if (!sdk.status().allowanceAvailable)
      throw new SigninFault("budget_exhausted");
    await this.session.runTextDiagnostic(
      { operatorStarted: true },
      async (context) => {
        const task = sdk.run(context, ownerAuthorized);
        this.requests.add(task);
        try {
          return await task;
        } finally {
          this.requests.delete(task);
        }
      },
      (result) => sdk.publish(result)
    );
  }

  /** One session generation spans both fixed SDK requests. No native allowance. */
  async runSdkToolRoundtrip(ownerAuthorized: boolean): Promise<void> {
    const tool = this.sdkToolRoundtrip;
    if (!tool || ownerAuthorized !== true)
      throw new SigninFault("operator_required");
    if (!tool.status().allowanceAvailable)
      throw new SigninFault("budget_exhausted");
    await this.session.runSdkToolRoundtrip(
      { operatorStarted: true },
      async (context) => {
        const task = tool.run(context, ownerAuthorized);
        this.requests.add(task);
        try {
          return await task;
        } finally {
          this.requests.delete(task);
        }
      },
      (result) => tool.publish(result)
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
