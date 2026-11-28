import {
  SigninFault,
  record,
} from "../extension/feasibility/signin-contracts.js";

export const DIAGNOSTIC_EXPERIMENT = "p15_3_text_response_diagnostic" as const;
export const DIAGNOSTIC_BUDGET_FILE =
  "response-diagnostic-budget.json" as const;
export const DIAGNOSTIC_AUTHORIZATION_FILE =
  "response-diagnostic-authorization.json" as const;
export type DiagnosticRecordName =
  | typeof DIAGNOSTIC_BUDGET_FILE
  | typeof DIAGNOSTIC_AUTHORIZATION_FILE;
export interface DiagnosticRecordStore {
  assertOriginalFrozen(): void;
  assertNoDiagnosticTemporaries(): void;
  read(name: DiagnosticRecordName): unknown;
  write(name: DiagnosticRecordName, value: object): void;
}
export interface DiagnosticBudgetStatus {
  experiment: typeof DIAGNOSTIC_EXPERIMENT;
  cap: 1;
  attempts: 0 | 1 | null;
  state: "not_authorized" | "ready" | "exhausted" | "blocked";
}
const base = {
  version: 1,
  experimentId: DIAGNOSTIC_EXPERIMENT,
  cap: 1,
} as const;

/** Monotonic separate authorization and attempt records. A missing half of
 * the pair, orphan temporary, or incomplete reservation cannot grant a slot. */
export class DiagnosticBudget {
  private blocked = false;
  private seenAuthorization = false;
  constructor(private readonly store: DiagnosticRecordStore) {}

  private inspect(): DiagnosticBudgetStatus {
    this.store.assertOriginalFrozen();
    this.store.assertNoDiagnosticTemporaries();
    const authorization = this.store.read(DIAGNOSTIC_AUTHORIZATION_FILE);
    const budget = this.store.read(DIAGNOSTIC_BUDGET_FILE);
    const result = { experiment: DIAGNOSTIC_EXPERIMENT, cap: 1 } as const;
    if (
      authorization === undefined &&
      budget === undefined &&
      !this.seenAuthorization
    )
      return { ...result, state: "not_authorized", attempts: null };
    this.seenAuthorization = true;
    const a = record(authorization);
    const b = record(budget);
    if (
      !a ||
      !b ||
      Object.keys(a).length !== 4 ||
      Object.keys(b).length !== 4 ||
      a.version !== 1 ||
      b.version !== 1 ||
      a.experimentId !== DIAGNOSTIC_EXPERIMENT ||
      b.experimentId !== DIAGNOSTIC_EXPERIMENT ||
      a.cap !== 1 ||
      b.cap !== 1 ||
      typeof a.reservationStarted !== "boolean" ||
      (b.attempts !== 0 && b.attempts !== 1) ||
      a.reservationStarted !== (b.attempts === 1)
    )
      throw new SigninFault("storage_invalid");
    return {
      ...result,
      state: b.attempts === 1 ? "exhausted" : "ready",
      attempts: b.attempts,
    };
  }

  /** Read-only; never infer permission from an unavailable record. */
  status(): DiagnosticBudgetStatus {
    try {
      if (!this.blocked) return this.inspect();
    } catch {
      this.blocked = true;
    }
    return {
      experiment: DIAGNOSTIC_EXPERIMENT,
      cap: 1,
      attempts: null,
      state: "blocked",
    };
  }

  /** Only an explicit paired owner authorization may create the experiment. */
  authorize(ownerAuthorized: boolean): DiagnosticBudgetStatus {
    if (ownerAuthorized !== true) throw new SigninFault("operator_required");
    if (this.status().state !== "not_authorized")
      throw new SigninFault("storage_invalid");
    try {
      // Commit the one-time creation marker first; incomplete creation blocks.
      this.store.write(DIAGNOSTIC_AUTHORIZATION_FILE, {
        ...base,
        reservationStarted: false,
      });
      this.store.write(DIAGNOSTIC_BUDGET_FILE, { ...base, attempts: 0 });
      const result = this.inspect();
      if (result.state !== "ready") throw new SigninFault("storage_invalid");
      return result;
    } catch (error) {
      this.blocked = true;
      throw error;
    }
  }

  /** Durable intent then reservation, both before Fetch. Never recreate or reset. */
  reserve(): DiagnosticBudgetStatus {
    const before = this.status();
    if (before.state !== "ready")
      throw new SigninFault(
        before.state === "exhausted" ? "budget_exhausted" : "storage_invalid"
      );
    try {
      this.store.write(DIAGNOSTIC_AUTHORIZATION_FILE, {
        ...base,
        reservationStarted: true,
      });
      this.store.write(DIAGNOSTIC_BUDGET_FILE, { ...base, attempts: 1 });
      const result = this.inspect();
      if (result.state !== "exhausted" || result.attempts !== 1)
        throw new SigninFault("storage_invalid");
      return result;
    } catch (error) {
      this.blocked = true;
      throw error;
    }
  }
}
