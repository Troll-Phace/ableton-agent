import {
  createProbeCancellation,
  type ProbeCancellation,
} from "./contracts.js";
import type { OAuthLifecycle } from "./oauth.js";
import { SigninDeadline } from "./official-http.js";
import { safeResponseDiagnostics } from "./response-diagnostics.js";
import {
  PLAN_SCOPE,
  REQUESTED_SCOPES,
  SigninFault,
  validToken,
  type SigninClock,
  type SigninPersistence,
  type SigninState,
  type StoredConnection,
  type RevocationResult,
} from "./signin-contracts.js";
import {
  parseModelCatalog,
  responsesErrorCode,
  type SyntheticResponses,
  type ResponsesCode,
  type ModelChoice,
  type InferenceContext,
  type RoundTripResult,
  type CancellationResult,
  type ResponseEvidence,
  type UsageCounts,
} from "./responses.js";

export type SessionCode =
  | ResponsesCode
  | "preflight_required"
  | "host_preflight_failed"
  | "restart_required"
  | "refresh_required"
  | "preflight_ready"
  | "connected"
  | "refreshed"
  | "models_loaded"
  | "model_selected"
  | "plan_only_confirmed"
  | "signed_out";
export interface OperatorAction {
  operatorStarted: boolean;
}
export interface SignInAction extends OperatorAction {
  newRegistration?: boolean;
}
export interface PlanOnlyAction extends OperatorAction {
  planOnlyConfirmed: boolean;
  creditFallbackDisabled: boolean;
}
/** S4 must supply these actual no-credential checks, not hardcoded success. */
export interface HostPreflightEvidence {
  nativeTransport: boolean;
  callbackBinding: boolean;
  privateStorage: boolean;
  bundledVerifier: boolean;
}
export type HostPreflightCheck = (
  cancellation: ProbeCancellation
) => Promise<HostPreflightEvidence>;
export interface SigninSessionDependencies {
  /** Host-owned documented integration eligibility basis, never a webview input. */
  eligibilityBasisReady: boolean;
  /** Separate companion-only experiment; the original three slots stay frozen. */
  diagnosticMode?: boolean;
  clock: SigninClock;
  oauth: Pick<
    OAuthLifecycle,
    "preflight" | "loadConnection" | "signIn" | "refresh" | "cancel" | "signOut"
  >;
  responses: Pick<
    SyntheticResponses,
    "loadCatalog" | "runRoundTrip" | "runCancellation" | "clearTransient"
  >;
  store: Pick<SigninPersistence, "getBudget" | "clearAllCredentials">;
  hostPreflight: HostPreflightCheck;
}

/** The only session data allowed to cross IPC. No token, identity, run ID,
 * authorization URL, provider text, argument, raw error or callback data. */
export interface SigninSnapshot {
  state: SigninState;
  code?: SessionCode;
  busy: boolean;
  eligibilityBasisReady: boolean;
  preflightReady: boolean;
  hostPreflight?: HostPreflightEvidence;
  hasConnection: boolean;
  accountLabel?: "Connection 1";
  grantedScopes: string[];
  planScopeGranted: boolean;
  persistedConnectionLoaded: boolean;
  refreshVerified: boolean;
  models: ModelChoice[];
  selectedModelSlug?: string;
  planOnlyConfirmed: boolean;
  creditFallbackDisabled: boolean;
  attempts: number | null;
  roundtrip?: RoundTripResult;
  cancellation?: CancellationResult;
  revocation?: RevocationResult;
}

const ACTION_TIMEOUT = 90000;
const AUTH_TIMEOUT = 370000;
const ROUNDTRIP_TIMEOUT = 140000;
const CANCELLATION_TIMEOUT = 70000;
const CLEANUP_TIMEOUT = 5000;
const SAFE_CODES = new Set<string>([
  "eligibility_pending",
  "operator_required",
  "operation_busy",
  "cancelled",
  "native_abort",
  "timeout",
  "native_unavailable",
  "permission_denied",
  "network_failed",
  "cleanup_failed",
  "invalid_endpoint",
  "redirect_rejected",
  "invalid_response",
  "response_limit",
  "http_rejected",
  "usage_limited",
  "temporary_failure",
  "invalid_grant",
  "access_denied",
  "plan_disabled",
  "discovery_invalid",
  "jwks_invalid",
  "id_token_invalid",
  "verification_unavailable",
  "identity_mismatch",
  "client_mismatch",
  "callback_invalid",
  "callback_timeout",
  "browser_unavailable",
  "browser_denied",
  "callback_bind_failed",
  "storage_unavailable",
  "storage_unsafe",
  "storage_invalid",
  "storage_failed",
  "budget_exhausted",
  "reconnect_required",
  "catalog_invalid",
  "catalog_required",
  "model_not_selected",
  "plan_only_required",
  "attempt_order_invalid",
  "roundtrip_required",
  "malformed_sse",
  "premature_eof",
  "response_failed",
  "response_incomplete",
  "invalid_function_call",
  "duplicate_call",
  "argument_mismatch",
  "unexpected_function_call",
  "missing_acknowledgement",
  "response_completed",
  "roundtrip_complete",
  "cancellation_demonstrated",
  "cancellation_not_demonstrated",
  "preflight_required",
  "host_preflight_failed",
  "restart_required",
  "refresh_required",
  "preflight_ready",
  "connected",
  "refreshed",
  "models_loaded",
  "model_selected",
  "plan_only_confirmed",
  "signed_out",
]);
function safeCode(value: unknown): SessionCode {
  return typeof value === "string" && SAFE_CODES.has(value)
    ? (value as SessionCode)
    : "invalid_response";
}
class SessionFault extends Error {
  constructor(readonly code: SessionCode) {
    super(code);
    this.name = "SessionFault";
  }
}
function sessionError(error: unknown): SessionCode {
  return safeCode(
    error instanceof SessionFault ? error.code : responsesErrorCode(error)
  );
}
function stateFor(code: SessionCode): SigninState {
  if (code === "access_denied") return "denied";
  if (code === "plan_disabled") return "plan_disabled";
  if (code === "reconnect_required" || code === "invalid_grant")
    return "reconnect_required";
  if (code === "cancelled") return "cancelled";
  if (
    [
      "eligibility_pending",
      "operator_required",
      "operation_busy",
      "plan_only_required",
      "preflight_required",
      "host_preflight_failed",
      "restart_required",
      "refresh_required",
      "catalog_required",
      "model_not_selected",
      "roundtrip_required",
      "attempt_order_invalid",
      "budget_exhausted",
      "permission_denied",
      "native_unavailable",
      "verification_unavailable",
      "cleanup_failed",
      "storage_unavailable",
      "storage_unsafe",
      "storage_invalid",
      "storage_failed",
      "usage_limited",
      "temporary_failure",
      "timeout",
      "callback_timeout",
      "browser_unavailable",
      "browser_denied",
      "callback_bind_failed",
    ].includes(code)
  )
    return "blocked";
  return "failed";
}
function counted(
  value: unknown,
  max = Number.MAX_SAFE_INTEGER
): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= max
    ? value
    : undefined;
}
function attempts(value: unknown): number | null {
  return counted(value, 3) ?? null;
}
function usage(value: UsageCounts | undefined): UsageCounts | undefined {
  if (!value) return undefined;
  const result: UsageCounts = {};
  for (const key of [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cachedInputTokens",
  ] as const) {
    const number = counted(value[key]);
    if (number !== undefined) result[key] = number;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
function safeEvidence(
  value: ResponseEvidence | undefined
): ResponseEvidence | undefined {
  if (!value) return undefined;
  const terminal = [
    "completed",
    "failed",
    "incomplete",
    "interrupted",
    "malformed",
    "cancelled",
    "not_observed",
  ].includes(value.terminal)
    ? value.terminal
    : "not_observed";
  const counts = usage(value.usage);
  return {
    terminal,
    code: safeCode(value.code) as ResponsesCode,
    events: counted(value.events, 10001) ?? null,
    bytes: counted(value.bytes, 1048577) ?? null,
    ...(counts ? { usage: counts } : {}),
    ...(value.diagnostics
      ? { diagnostics: safeResponseDiagnostics(value.diagnostics) }
      : {}),
  };
}
function safeRoundtrip(value: RoundTripResult): RoundTripResult {
  const first = safeEvidence(value.first);
  const second = safeEvidence(value.second);
  return {
    outcome:
      value.outcome === "pass" || value.outcome === "blocked"
        ? value.outcome
        : "failed",
    code: safeCode(value.code) as ResponsesCode,
    attempts: attempts(value.attempts),
    ...(first ? { first } : {}),
    ...(second ? { second } : {}),
    functionEchoValidated: value.functionEchoValidated === true,
    finalMarkerAcknowledged: value.finalMarkerAcknowledged === true,
  };
}
function safeCancellation(value: CancellationResult): CancellationResult {
  const evidence = safeEvidence(value.evidence);
  return {
    outcome:
      value.outcome === "pass" || value.outcome === "blocked"
        ? value.outcome
        : "failed",
    code: safeCode(value.code) as ResponsesCode,
    attempts: attempts(value.attempts),
    ...(evidence ? { evidence } : {}),
    textDeltaObserved: value.textDeltaObserved === true,
    abortRequested: value.abortRequested === true,
    pendingReadRejected: value.pendingReadRejected === true,
    cleanupVerified: value.cleanupVerified === true,
  };
}
function safePreflight(value: HostPreflightEvidence): HostPreflightEvidence {
  return {
    nativeTransport: value.nativeTransport === true,
    callbackBinding: value.callbackBinding === true,
    privateStorage: value.privateStorage === true,
    bundledVerifier: value.bundledVerifier === true,
  };
}
function safeRevocation(value: RevocationResult): RevocationResult {
  return {
    localCleared: value.localCleared === true,
    remoteRevocation:
      value.remoteRevocation === "request_accepted" ||
      value.remoteRevocation === "not_applicable"
        ? value.remoteRevocation
        : "unconfirmed",
  };
}
function hasPlan(connection: StoredConnection): boolean {
  return (
    connection.scopes.includes(PLAN_SCOPE) &&
    connection.scopes.includes("resource.invoke")
  );
}
interface Operation {
  generation: number;
  control: ReturnType<typeof createProbeCancellation>;
  check(): void;
}
interface Pending {
  operation: Operation;
  work: Promise<void>;
}

/** Single host-owned state machine for the bounded feasibility experiment. */
export class SigninSession {
  private state: SigninState = "idle";
  private code?: SessionCode;
  private generation = 0;
  private pending?: Pending;
  private signingOut = false;
  private preflightReady = false;
  private hostEvidence?: HostPreflightEvidence;
  private connection?: StoredConnection;
  private persistedConnectionLoaded = false;
  private refreshAttempted = false;
  private refreshVerified = false;
  private models: ModelChoice[] = [];
  private selectedModel?: string;
  private planOnlyConfirmed = false;
  private creditFallbackDisabled = false;
  private attemptCount: number | null = null;
  private roundtrip?: RoundTripResult;
  private cancellation?: CancellationResult;
  private revocation?: RevocationResult;
  constructor(private readonly deps: SigninSessionDependencies) {}

  /** Immutable, allowlisted, display-safe projection for S4. */
  snapshot(): SigninSnapshot {
    const connection = this.connection;
    return {
      state: this.state,
      ...(this.code ? { code: safeCode(this.code) } : {}),
      busy: !!this.pending || this.signingOut,
      eligibilityBasisReady: this.deps.eligibilityBasisReady === true,
      preflightReady: this.preflightReady,
      ...(this.hostEvidence
        ? { hostPreflight: safePreflight(this.hostEvidence) }
        : {}),
      hasConnection: !!connection,
      ...(connection ? { accountLabel: "Connection 1" as const } : {}),
      grantedScopes: connection
        ? REQUESTED_SCOPES.filter((scope) => connection.scopes.includes(scope))
        : [],
      planScopeGranted: !!connection && hasPlan(connection),
      persistedConnectionLoaded: this.persistedConnectionLoaded,
      refreshVerified: this.refreshVerified,
      models: this.models.map((model) => ({
        slug: model.slug,
        displayName: model.displayName,
      })),
      ...(this.selectedModel ? { selectedModelSlug: this.selectedModel } : {}),
      planOnlyConfirmed: this.planOnlyConfirmed,
      creditFallbackDisabled: this.creditFallbackDisabled,
      attempts: this.attemptCount,
      ...(this.roundtrip ? { roundtrip: safeRoundtrip(this.roundtrip) } : {}),
      ...(this.cancellation
        ? { cancellation: safeCancellation(this.cancellation) }
        : {}),
      ...(this.revocation
        ? { revocation: safeRevocation(this.revocation) }
        : {}),
    };
  }

  /** Explicit no-credential preflight; only after all local checks pass may the
   * OAuth seam retrieve official discovery/JWKS and load protected persistence. */
  async preflight(action: OperatorAction): Promise<SigninSnapshot> {
    return await this.perform(ACTION_TIMEOUT, async (operation) => {
      this.authorize(action);
      // A second preflight on the same live session is not restart evidence.
      if (this.preflightReady) return;
      this.resetSelection();
      this.preflightReady = false;
      this.hostEvidence = undefined;
      this.connection = undefined;
      this.persistedConnectionLoaded = false;
      this.refreshAttempted = false;
      this.refreshVerified = false;
      const host = safePreflight(
        await this.deps.hostPreflight(operation.control)
      );
      operation.check();
      this.hostEvidence = host;
      if (
        !host.nativeTransport ||
        !host.callbackBinding ||
        !host.privateStorage ||
        !host.bundledVerifier
      )
        throw new SessionFault("host_preflight_failed");
      const check = await this.deps.oauth.preflight(operation.control);
      operation.check();
      if (
        check.storageReady !== true ||
        check.budgetReady !== true ||
        check.discoveryReady !== true ||
        check.jwksReady !== true
      )
        throw new SessionFault("host_preflight_failed");
      this.updateBudget();
      const stored = this.deps.oauth.loadConnection();
      operation.check();
      this.preflightReady = true;
      this.connection = stored;
      this.persistedConnectionLoaded = !!stored;
      if (stored && !hasPlan(stored)) {
        this.set("plan_disabled", "plan_disabled");
        return;
      }
      if (stored && stored.expiresAt <= this.deps.clock.now()) {
        this.set("reconnect_required", "reconnect_required");
        return;
      }
      this.set(
        stored ? "connected" : "preflight_ready",
        stored ? "connected" : "preflight_ready"
      );
    });
  }

  /** Explicit personal consent only. No automatic browser or account selection. */
  async signIn(action: SignInAction): Promise<SigninSnapshot> {
    return await this.perform(AUTH_TIMEOUT, async (operation) => {
      this.authorize(action);
      this.requirePreflight();
      this.resetSelection();
      this.refreshAttempted = false;
      this.refreshVerified = false;
      this.persistedConnectionLoaded = false;
      this.set("awaiting_consent");
      const connection = await this.deps.oauth.signIn(
        {
          eligible: this.deps.eligibilityBasisReady,
          operatorStarted: action.operatorStarted,
          newRegistration: action.newRegistration,
          cancellation: operation.control,
        },
        (progress) => {
          if (
            this.generation === operation.generation &&
            !operation.control.cancelled
          )
            this.set(progress.state);
        }
      );
      operation.check();
      this.connection = connection;
      this.requirePlan(connection);
      this.requireUnexpired(connection);
      this.updateBudget();
      this.set("connected", "connected");
    });
  }

  /** One explicit refresh after a persisted connection has been loaded in a
   * fresh session. The coordinator separately verifies an actual host restart. */
  async refresh(action: OperatorAction): Promise<SigninSnapshot> {
    return await this.perform(ACTION_TIMEOUT, async (operation) => {
      this.authorize(action);
      this.requirePreflight();
      if (!this.persistedConnectionLoaded)
        throw new SessionFault("restart_required");
      if (!this.connection) throw new SigninFault("reconnect_required");
      if (this.refreshAttempted) throw new SessionFault("refresh_required");
      this.requirePlan(this.connection);
      this.refreshAttempted = true;
      this.refreshVerified = false;
      this.resetSelection();
      this.set("validating");
      const connection = await this.deps.oauth.refresh({
        eligible: this.deps.eligibilityBasisReady,
        operatorStarted: action.operatorStarted,
        cancellation: operation.control,
      });
      operation.check();
      this.connection = connection;
      this.requirePlan(connection);
      this.requireUnexpired(connection);
      this.refreshVerified = true;
      this.updateBudget();
      this.set("connected", "refreshed");
    });
  }

  /** Catalog is retrieved only for the explicitly refreshed connection. */
  async loadModels(action: OperatorAction): Promise<SigninSnapshot> {
    return await this.perform(ACTION_TIMEOUT, async (operation) => {
      this.authorize(action);
      this.requirePreflight();
      const connection = this.requireInferenceConnection();
      const before = this.updateBudget();
      if (before !== (this.deps.diagnosticMode ? 1 : 0))
        throw new SessionFault(
          before === 3 ? "budget_exhausted" : "attempt_order_invalid"
        );
      this.resetSelection();
      const list = await this.deps.responses.loadCatalog({
        connection,
        authorization: {
          eligible: this.deps.eligibilityBasisReady,
          operatorStarted: action.operatorStarted,
        },
        cancellation: operation.control,
      });
      operation.check();
      // Independently project only safe model fields, even at the dependency seam.
      this.models = parseModelCatalog(
        {
          models: list.map((model) => ({
            visibility: "list",
            slug: model.slug,
            display_name: model.displayName,
          })),
        },
        [
          connection.accessToken,
          connection.refreshToken,
          connection.clientId,
          connection.subject,
          connection.localId,
        ]
      );
      this.updateBudget();
      this.set("connected", "models_loaded");
    });
  }

  /** No default model. Exact match against the account-visible catalog only. */
  selectModel(slug: string, action: OperatorAction): SigninSnapshot {
    if (this.pending || this.signingOut) return this.busySnapshot();
    try {
      this.authorize(action);
      this.requirePreflight();
      this.requireInferenceConnection();
      this.planOnlyConfirmed = false;
      this.creditFallbackDisabled = false;
      this.selectedModel = undefined;
      this.updateBudget();
      if (this.attemptCount !== (this.deps.diagnosticMode ? 1 : 0))
        throw new SessionFault(
          this.attemptCount === 3 ? "budget_exhausted" : "attempt_order_invalid"
        );
      if (!this.models.some((model) => model.slug === slug))
        throw new SessionFault("model_not_selected");
      this.selectedModel = slug;
      this.set("model_selected", "model_selected");
    } catch (error) {
      this.fail(sessionError(error));
    }
    return this.snapshot();
  }

  /** Separate explicit owner confirmation for plan-only usage/no credit fallback. */
  confirmPlanOnly(action: PlanOnlyAction): SigninSnapshot {
    if (this.pending || this.signingOut) return this.busySnapshot();
    try {
      this.authorize(action);
      this.requirePreflight();
      this.requireInferenceConnection();
      this.planOnlyConfirmed = false;
      this.creditFallbackDisabled = false;
      if (
        !this.selectedModel ||
        !this.models.some((model) => model.slug === this.selectedModel)
      )
        throw new SessionFault("model_not_selected");
      this.updateBudget();
      if (this.attemptCount !== (this.deps.diagnosticMode ? 1 : 0))
        throw new SessionFault(
          this.attemptCount === 3 ? "budget_exhausted" : "attempt_order_invalid"
        );
      if (
        action.planOnlyConfirmed !== true ||
        action.creditFallbackDisabled !== true
      )
        throw new SessionFault("plan_only_required");
      this.planOnlyConfirmed = true;
      this.creditFallbackDisabled = true;
      this.set("model_selected", "plan_only_confirmed");
    } catch (error) {
      this.fail(sessionError(error));
    }
    return this.snapshot();
  }

  async runRoundTrip(action: OperatorAction): Promise<SigninSnapshot> {
    return await this.perform(ROUNDTRIP_TIMEOUT, async (operation) => {
      if (this.deps.diagnosticMode)
        throw new SessionFault("attempt_order_invalid");
      const context = this.inferenceContext(action, operation);
      this.updateBudget();
      if (this.attemptCount !== 0)
        throw new SessionFault(
          this.attemptCount === 3 ? "budget_exhausted" : "attempt_order_invalid"
        );
      this.roundtrip = undefined;
      this.cancellation = undefined;
      this.set("running_roundtrip");
      const result = safeRoundtrip(
        await this.deps.responses.runRoundTrip(context)
      );
      operation.check();
      this.roundtrip = result;
      const reserved = this.updateBudget();
      if (
        result.outcome === "pass" &&
        result.code === "roundtrip_complete" &&
        result.functionEchoValidated &&
        result.finalMarkerAcknowledged &&
        result.first?.terminal === "completed" &&
        result.second?.terminal === "completed" &&
        reserved === 2
      )
        this.set("roundtrip_complete", "roundtrip_complete");
      else
        this.fail(result.outcome === "pass" ? "invalid_response" : result.code);
    });
  }

  async runCancellation(action: OperatorAction): Promise<SigninSnapshot> {
    return await this.perform(CANCELLATION_TIMEOUT, async (operation) => {
      if (this.deps.diagnosticMode)
        throw new SessionFault("attempt_order_invalid");
      const context = this.inferenceContext(action, operation);
      this.updateBudget();
      if (this.attemptCount === 3) throw new SigninFault("budget_exhausted");
      if (
        this.state !== "roundtrip_complete" ||
        this.roundtrip?.outcome !== "pass" ||
        this.attemptCount !== 2
      )
        throw new SessionFault("roundtrip_required");
      this.cancellation = undefined;
      this.set("running_cancellation");
      const result = safeCancellation(
        await this.deps.responses.runCancellation(context)
      );
      operation.check();
      this.cancellation = result;
      const reserved = this.updateBudget();
      if (
        result.outcome === "pass" &&
        result.code === "cancellation_demonstrated" &&
        result.textDeltaObserved &&
        result.abortRequested &&
        result.pendingReadRejected &&
        result.cleanupVerified &&
        reserved === 3
      )
        this.set("finished", "cancellation_demonstrated");
      else
        this.fail(result.outcome === "pass" ? "invalid_response" : result.code);
    });
  }

  /** The companion's named one-request experiment uses the same verified
   * connection, catalog, owner gates and operation generation, never the old slots. */
  async authorizeTextDiagnostic(
    action: OperatorAction,
    authorize: (context: InferenceContext) => void
  ): Promise<SigninSnapshot> {
    return await this.perform(ACTION_TIMEOUT, (operation) => {
      if (!this.deps.diagnosticMode || this.updateBudget() !== 1)
        throw new SessionFault("attempt_order_invalid");
      const context = this.inferenceContext(action, operation);
      authorize(context);
      operation.check();
      this.set("model_selected", "plan_only_confirmed");
      return Promise.resolve();
    });
  }

  /** Publish only after the session generation survives cancellation/sign-out. */
  async runTextDiagnostic<
    T extends { outcome: "pass" | "blocked" | "failed"; code: ResponsesCode },
  >(
    action: OperatorAction,
    run: (context: InferenceContext) => Promise<T>,
    publish: (result: T) => void
  ): Promise<SigninSnapshot> {
    return await this.perform(CANCELLATION_TIMEOUT, async (operation) => {
      if (!this.deps.diagnosticMode || this.updateBudget() !== 1)
        throw new SessionFault("attempt_order_invalid");
      const context = this.inferenceContext(action, operation);
      this.set("validating");
      const result = await run(context);
      operation.check();
      this.updateBudget();
      publish(result);
      if (result.outcome === "pass" && result.code === "response_completed")
        this.set("finished", "response_completed");
      else
        this.fail(result.outcome === "pass" ? "invalid_response" : result.code);
    });
  }

  /** Cancels promptly, invalidates all late state and discards transient catalog/proof. */
  cancel(): SigninSnapshot {
    if (this.signingOut) return this.snapshot();
    this.invalidate();
    if (this.preflightReady) {
      try {
        this.updateBudget();
      } catch {
        this.attemptCount = null;
      }
    }
    this.set("cancelled", "cancelled");
    return this.snapshot();
  }

  /** User-requested cleanup is allowed even when eligibility/preflight failed.
   * Do not overlap a revocation with a request which ignores cancellation. */
  async signOut(action: OperatorAction): Promise<SigninSnapshot> {
    if (action.operatorStarted !== true) {
      this.fail("operator_required");
      return this.snapshot();
    }
    if (this.signingOut) return this.busySnapshot();
    this.signingOut = true;
    const previous = this.pending;
    const mayRevoke = this.preflightReady && this.deps.eligibilityBasisReady;
    this.invalidate();
    let revocation: RevocationResult = {
      localCleared: false,
      remoteRevocation: "unconfirmed",
    };
    try {
      let idle = true;
      if (previous) {
        const deadline = new SigninDeadline(this.deps.clock, CLEANUP_TIMEOUT);
        try {
          await deadline.wait(previous.work.catch(() => undefined));
        } catch {
          idle = false;
        } finally {
          deadline.close();
        }
      }
      if (idle && mayRevoke)
        revocation = safeRevocation(await this.deps.oauth.signOut());
      else {
        this.deps.store.clearAllCredentials();
        revocation = { localCleared: true, remoteRevocation: "unconfirmed" };
      }
    } catch {
      try {
        this.deps.store.clearAllCredentials();
        revocation.localCleared = true;
      } catch {
        /* report local cleanup failure */
      }
    } finally {
      this.connection = undefined;
      this.preflightReady = false;
      this.persistedConnectionLoaded = false;
      this.refreshVerified = false;
      this.refreshAttempted = false;
      this.revocation = safeRevocation(revocation);
      try {
        this.updateBudget();
      } catch {
        this.attemptCount = null;
      }
      this.signingOut = false;
      this.set(
        revocation.localCleared ? "signed_out" : "blocked",
        revocation.localCleared ? "signed_out" : "storage_failed"
      );
    }
    return this.snapshot();
  }

  private set(state: SigninState, code?: SessionCode): void {
    this.state = state;
    this.code = code;
  }
  private fail(code: SessionCode): void {
    if (
      code === "reconnect_required" ||
      code === "invalid_grant" ||
      code === "plan_disabled"
    ) {
      this.resetSelection();
      this.refreshVerified = false;
      // Retain no stale bearer after an explicit revocation/unauthorized result.
      if (code !== "plan_disabled") this.connection = undefined;
    }
    this.set(stateFor(code), code);
  }
  private authorize(action: OperatorAction): void {
    if (this.deps.eligibilityBasisReady !== true)
      throw new SigninFault("eligibility_pending");
    if (action.operatorStarted !== true)
      throw new SigninFault("operator_required");
  }
  private requirePreflight(): void {
    if (!this.preflightReady) throw new SessionFault("preflight_required");
  }
  private requirePlan(connection: StoredConnection): void {
    if (!hasPlan(connection)) throw new SigninFault("plan_disabled");
  }
  private requireUnexpired(connection: StoredConnection): void {
    if (
      !validToken(connection.accessToken) ||
      !Number.isSafeInteger(connection.expiresAt) ||
      connection.expiresAt <= this.deps.clock.now()
    )
      throw new SigninFault("reconnect_required");
  }
  private requireInferenceConnection(): StoredConnection {
    if (!this.connection) throw new SigninFault("reconnect_required");
    this.requirePlan(this.connection);
    this.requireUnexpired(this.connection);
    if (!this.refreshVerified) throw new SessionFault("refresh_required");
    return this.connection;
  }
  private inferenceContext(
    action: OperatorAction,
    operation: Operation
  ): InferenceContext {
    this.authorize(action);
    this.requirePreflight();
    const connection = this.requireInferenceConnection();
    if (
      !this.selectedModel ||
      !this.models.some((model) => model.slug === this.selectedModel)
    )
      throw new SessionFault("model_not_selected");
    if (!this.planOnlyConfirmed || !this.creditFallbackDisabled)
      throw new SessionFault("plan_only_required");
    operation.check();
    return {
      connection,
      modelSlug: this.selectedModel,
      authorization: {
        eligible: this.deps.eligibilityBasisReady,
        operatorStarted: action.operatorStarted,
        planOnlyConfirmed: this.planOnlyConfirmed,
        creditFallbackDisabled: this.creditFallbackDisabled,
      },
      cancellation: operation.control,
    };
  }
  private updateBudget(): number {
    const budget = this.deps.store.getBudget();
    const count = attempts(budget.attempts);
    if (count === null || budget.version !== 1) {
      this.attemptCount = null;
      throw new SigninFault("storage_invalid");
    }
    this.attemptCount = count;
    return count;
  }
  private resetSelection(): void {
    this.deps.responses.clearTransient();
    this.models = [];
    this.selectedModel = undefined;
    this.planOnlyConfirmed = false;
    this.creditFallbackDisabled = false;
  }
  private invalidate(): void {
    this.generation++;
    this.pending?.operation.control.cancel();
    this.deps.oauth.cancel();
    this.resetSelection();
  }
  private busySnapshot(): SigninSnapshot {
    return { ...this.snapshot(), code: "operation_busy" };
  }
  private async perform(
    duration: number,
    run: (operation: Operation) => Promise<void>
  ): Promise<SigninSnapshot> {
    if (this.pending || this.signingOut) return this.busySnapshot();
    const generation = ++this.generation;
    const control = createProbeCancellation();
    const operation: Operation = {
      generation,
      control,
      check: () => {
        if (generation !== this.generation || control.cancelled)
          throw new SigninFault("cancelled");
      },
    };
    const deadline = new SigninDeadline(
      this.deps.clock,
      duration,
      control,
      () => control.cancel()
    );
    const work = (async () => {
      await Promise.resolve();
      operation.check();
      await run(operation);
    })();
    this.pending = { operation, work };
    const clear = () => {
      if (this.pending?.operation === operation) this.pending = undefined;
    };
    void work.then(clear, clear);
    try {
      await deadline.wait(work);
      operation.check();
    } catch (error) {
      if (generation === this.generation) {
        const code = sessionError(error);
        control.cancel();
        this.generation++;
        this.deps.oauth.cancel();
        // Do not touch storage on an unauthorized/preflight-blocked operation.
        if (this.preflightReady) {
          try {
            this.updateBudget();
          } catch {
            this.attemptCount = null;
          }
        }
        this.fail(code);
      }
    } finally {
      deadline.close();
    }
    return this.snapshot();
  }
}
