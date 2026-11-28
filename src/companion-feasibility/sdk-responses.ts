import {
  SigninFault,
  type SigninClock,
  type StoredConnection,
} from "../extension/feasibility/signin-contracts.js";
import {
  ResponsesFault,
  type InferenceContext,
  type ResponsesCode,
} from "../extension/feasibility/responses.js";
import {
  consumeSdkStream,
  emptySdkEvidence,
  requireTextOnlyEvent,
  sdkBlocked,
  sdkFailure,
  sdkTextMarker,
  verifySdkConnection,
  type SdkDiagnosticEvidence,
} from "./sdk-stream.js";
export type { SdkDiagnosticEvidence } from "./sdk-stream.js";

export const SDK_EXPERIMENT = "p15_3_official_sdk_diagnostic" as const;
/** Only an explicitly injected synthetic test reservation can enable this checkpoint. */
export interface SdkDiagnosticAuthorization {
  isAuthorized(): boolean;
  reserve(): boolean;
}
export interface SdkResponsesDependencies {
  fetch: typeof globalThis.fetch;
  AbortController: typeof globalThis.AbortController;
  clock: SigninClock;
  loadConnection(): StoredConnection | undefined;
  assertFrozenBudgets(): void;
  authorization?: SdkDiagnosticAuthorization;
}
export interface SdkDiagnosticResult {
  outcome: "pass" | "blocked" | "failed";
  code: ResponsesCode;
  markerAcknowledged: boolean;
  evidence: Readonly<SdkDiagnosticEvidence>;
}
export interface SdkDiagnosticStatus {
  experiment: typeof SDK_EXPERIMENT;
  mode: "offline_only";
  allowanceAvailable: boolean;
  result?: SdkDiagnosticResult;
}

/** Official SDK streaming, with an app-owned single-dispatch gate and bounded
 * transport, deadline, terminal semantics and sanitized result. No live allowance. */
export class SdkResponses {
  private busy = false;
  private attempted = false;
  private candidate?: SdkDiagnosticResult;
  private result?: SdkDiagnosticResult;
  constructor(private readonly deps: SdkResponsesDependencies) {}

  status(): SdkDiagnosticStatus {
    let allowanceAvailable = false;
    try {
      allowanceAvailable =
        !this.attempted &&
        !this.busy &&
        this.deps.authorization?.isAuthorized() === true;
    } catch {
      /* fail closed */
    }
    return {
      experiment: SDK_EXPERIMENT,
      mode: "offline_only",
      allowanceAvailable,
      ...(this.result ? { result: structuredClone(this.result) } : {}),
    };
  }

  private current(context: InferenceContext): StoredConnection {
    return verifySdkConnection(this.deps, context);
  }

  /** Called only after the session verifies that the operation generation survived. */
  publish(result: SdkDiagnosticResult): void {
    if (result === this.candidate && !this.result)
      this.result = structuredClone(result);
  }

  async run(
    context: InferenceContext,
    ownerAuthorized: boolean
  ): Promise<SdkDiagnosticResult> {
    const evidence = emptySdkEvidence();
    const result = (
      code: ResponsesCode,
      markerAcknowledged = false
    ): SdkDiagnosticResult => {
      const snapshot: SdkDiagnosticResult = Object.freeze({
        outcome:
          markerAcknowledged && code === "response_completed"
            ? "pass"
            : sdkBlocked(code)
              ? "blocked"
              : "failed",
        code,
        markerAcknowledged,
        evidence: Object.freeze({ ...evidence }),
      });
      if (evidence.reservation !== "not_started" && !this.candidate)
        this.candidate = snapshot;
      return snapshot;
    };
    if (ownerAuthorized !== true) return result("operator_required");
    if (this.busy) return result("operation_busy");
    if (this.attempted || !this.deps.authorization)
      return result("budget_exhausted");
    this.busy = true;
    try {
      const connection = this.current(context);
      if (this.deps.authorization.isAuthorized() !== true)
        return result("budget_exhausted");
      this.attempted = true;
      evidence.reservation = "uncertain";
      if (this.deps.authorization.reserve() !== true)
        throw new SigninFault("budget_exhausted");
      evidence.reservation = "reserved";
      this.current(context);
      const code = await this.consume(context, connection, evidence);
      if (context.cancellation?.cancelled) {
        evidence.primaryFailureCode ??= "cancelled";
        return result("cancelled");
      }
      return result(code, code === "response_completed");
    } catch (error) {
      const code = context.cancellation?.cancelled
        ? "cancelled"
        : sdkFailure(error);
      evidence.primaryFailureCode = code;
      return result(code);
    } finally {
      this.busy = false;
    }
  }

  private async consume(
    context: InferenceContext,
    connection: StoredConnection,
    evidence: SdkDiagnosticEvidence
  ): Promise<ResponsesCode> {
    const payload = {
      model: context.modelSlug,
      store: false as const,
      stream: true as const,
      input: [
        {
          role: "developer" as const,
          content:
            "This is a fixed synthetic text-only feasibility diagnostic. Reply with exactly p15_3.",
        },
        { role: "user" as const, content: "Reply with p15_3." },
      ],
    };
    const result = await consumeSdkStream(
      this.deps,
      context,
      connection,
      evidence,
      payload,
      () => {
        this.current(context);
      },
      {
        observe: requireTextOnlyEvent,
        complete: (output) => {
          if (!sdkTextMarker(output))
            throw new ResponsesFault("missing_acknowledgement");
          return true;
        },
      }
    );
    return result.code;
  }
}
