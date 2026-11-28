import type { OfficialHttpClient } from "../extension/feasibility/official-http.js";
import { ResponseDiagnostics } from "../extension/feasibility/response-diagnostics.js";
import {
  collectCompletedResponse,
  finalizeResponseEvidence,
  failedResponseEvidence,
  responsesErrorCode,
  ResponsesFault,
  type CapturedResponse,
  type InferenceContext,
  type ResponseEvidence,
  type ResponsesCode,
} from "../extension/feasibility/responses.js";
import {
  PLAN_SCOPE,
  REQUESTED_SCOPES,
  SigninFault,
  validToken,
  type SigninClock,
  type StoredConnection,
} from "../extension/feasibility/signin-contracts.js";
import type {
  DiagnosticBudget,
  DiagnosticBudgetStatus,
} from "./diagnostic-budget.js";

export interface TextDiagnosticResult {
  outcome: "pass" | "blocked" | "failed";
  code: ResponsesCode;
  markerAcknowledged: boolean;
  evidence?: ResponseEvidence;
}
export interface TextDiagnosticStatus {
  budget: DiagnosticBudgetStatus;
  originalAttempts: 1 | null;
  result?: TextDiagnosticResult;
}
interface ResponseDiagnosticDependencies {
  http: Pick<OfficialHttpClient, "requestStream">;
  budget: DiagnosticBudget;
  loadConnection(): StoredConnection | undefined;
  assertOriginalFrozen(): void;
  clock: SigninClock;
  TextDecoder: typeof globalThis.TextDecoder;
}
function blocked(code: ResponsesCode): boolean {
  return (
    [
      "eligibility_pending",
      "operator_required",
      "operation_busy",
      "plan_only_required",
      "budget_exhausted",
      "plan_disabled",
      "reconnect_required",
      "cancelled",
      "permission_denied",
      "native_unavailable",
      "cleanup_failed",
      "storage_unavailable",
      "storage_unsafe",
      "storage_invalid",
      "storage_failed",
      "usage_limited",
      "temporary_failure",
      "timeout",
    ] as readonly ResponsesCode[]
  ).includes(code);
}

/** Companion-only text diagnostic. Callable solely with verified session
 * context; never receives an arbitrary prompt, tools, URL or model override. */
export class ResponseDiagnostic {
  private busy = false;
  private result?: TextDiagnosticResult;
  constructor(private readonly deps: ResponseDiagnosticDependencies) {}

  status(): TextDiagnosticStatus {
    let originalAttempts: 1 | null = null;
    try {
      this.deps.assertOriginalFrozen();
      originalAttempts = 1;
    } catch {
      /* never present unknown as 1 */
    }
    return {
      budget: this.deps.budget.status(),
      originalAttempts,
      ...(this.result ? { result: structuredClone(this.result) } : {}),
    };
  }

  private current(context: InferenceContext): StoredConnection {
    this.deps.assertOriginalFrozen();
    if (context.cancellation?.cancelled) throw new SigninFault("cancelled");
    if (context.authorization.eligible !== true)
      throw new SigninFault("eligibility_pending");
    if (context.authorization.operatorStarted !== true)
      throw new SigninFault("operator_required");
    if (
      context.authorization.planOnlyConfirmed !== true ||
      context.authorization.creditFallbackDisabled !== true
    )
      throw new ResponsesFault("plan_only_required");
    const saved = this.deps.loadConnection();
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
    return saved;
  }

  /** Called only via the session's fresh catalog/model/plan-only gate. */
  authorize(context: InferenceContext, ownerAuthorized: boolean): void {
    this.current(context);
    this.deps.budget.authorize(ownerAuthorized);
  }

  /** No result is published until the session independently verifies generation. */
  publish(result: TextDiagnosticResult): void {
    if (result.evidence && !this.result) this.result = result;
  }

  async run(
    context: InferenceContext,
    ownerAuthorized: boolean
  ): Promise<TextDiagnosticResult> {
    if (ownerAuthorized !== true)
      return {
        outcome: "blocked",
        code: "operator_required",
        markerAcknowledged: false,
      };
    if (this.busy)
      return {
        outcome: "blocked",
        code: "operation_busy",
        markerAcknowledged: false,
      };
    this.busy = true;
    let captured: CapturedResponse | undefined;
    let diagnostics: ResponseDiagnostics | undefined;
    try {
      const connection = this.current(context);
      this.deps.budget.reserve();
      const observed = new ResponseDiagnostics();
      diagnostics = observed;
      this.current(context);
      captured = await this.deps.http.requestStream(
        {
          bearer: connection.accessToken,
          cancellation: context.cancellation,
          json: {
            model: context.modelSlug,
            store: false,
            stream: true,
            input: [
              {
                role: "developer",
                content:
                  "This is a fixed synthetic text-only feasibility diagnostic. Reply with exactly p15_3.",
              },
              { role: "user", content: "Reply with p15_3." },
            ],
          },
        },
        async (body) => {
          captured = await collectCompletedResponse(
            body,
            this.deps.TextDecoder,
            "acknowledgement",
            context.cancellation,
            observed
          );
          return captured;
        },
        observed
      );
      const evidence = finalizeResponseEvidence(captured.evidence, observed);
      this.current(context);
      const markerAcknowledged =
        captured.acknowledgement &&
        evidence.terminal === "completed" &&
        evidence.code === "response_completed";
      const code = markerAcknowledged
        ? "response_completed"
        : evidence.code === "response_completed"
          ? "invalid_response"
          : evidence.code;
      return {
        outcome: markerAcknowledged
          ? "pass"
          : blocked(code)
            ? "blocked"
            : "failed",
        code,
        markerAcknowledged,
        evidence,
      };
    } catch (error) {
      const code = context.cancellation?.cancelled
        ? "cancelled"
        : responsesErrorCode(error);
      return {
        outcome: !diagnostics || blocked(code) ? "blocked" : "failed",
        code,
        markerAcknowledged: false,
        ...(diagnostics
          ? {
              evidence: failedResponseEvidence(
                code,
                diagnostics,
                captured?.evidence
              ),
            }
          : {}),
      };
    } finally {
      this.busy = false;
    }
  }
}
