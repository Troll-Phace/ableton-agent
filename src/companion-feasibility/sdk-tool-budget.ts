import {
  SigninFault,
  record,
} from "../extension/feasibility/signin-contracts.js";
import { SDK_TOOL_EXPERIMENT } from "./sdk-tool-roundtrip.js";

export const SDK_TOOL_BUDGET_FILE = "sdk-tool-roundtrip-budget.json" as const;
export const SDK_TOOL_AUTHORIZATION_FILE =
  "sdk-tool-roundtrip-authorization.json" as const;
export type SdkToolRecordName =
  | typeof SDK_TOOL_BUDGET_FILE
  | typeof SDK_TOOL_AUTHORIZATION_FILE;
export interface SdkToolRecordStore {
  assertHistoricalFrozen(): void;
  assertNoSdkToolTemporaries(): void;
  read(name: SdkToolRecordName): unknown;
  write(name: SdkToolRecordName, value: object): void;
}
export interface SdkToolBudgetStatus {
  experiment: typeof SDK_TOOL_EXPERIMENT;
  cap: 2;
  attempts: 0 | 1 | 2 | null;
  state:
    | "not_authorized"
    | "ready"
    | "active"
    | "interrupted"
    | "exhausted"
    | "blocked";
}
const base = { version: 1, experimentId: SDK_TOOL_EXPERIMENT, cap: 2 } as const;

/** One two-step experiment. Intent precedes count; partial or uncertain
 * writes cannot grant either slot. Only this in-memory run can continue
 * after its first reservation, never a reconstructed budget. */
export class SdkToolBudget {
  private blocked = false;
  private seenAuthorization = false;
  private observed: 0 | 1 | 2 = 0;
  private activeFirst = false;
  constructor(private readonly store: SdkToolRecordStore) {}

  private inspect(): SdkToolBudgetStatus {
    this.store.assertHistoricalFrozen();
    this.store.assertNoSdkToolTemporaries();
    const authorization = this.store.read(SDK_TOOL_AUTHORIZATION_FILE);
    const budget = this.store.read(SDK_TOOL_BUDGET_FILE);
    const summary = { experiment: SDK_TOOL_EXPERIMENT, cap: 2 } as const;
    if (
      authorization === undefined &&
      budget === undefined &&
      !this.seenAuthorization
    )
      return { ...summary, state: "not_authorized", attempts: null };
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
      a.experimentId !== SDK_TOOL_EXPERIMENT ||
      b.experimentId !== SDK_TOOL_EXPERIMENT ||
      a.cap !== 2 ||
      b.cap !== 2 ||
      (b.attempts !== 0 && b.attempts !== 1 && b.attempts !== 2) ||
      a.reservationIntent !== b.attempts ||
      b.attempts < this.observed
    )
      throw new SigninFault("storage_invalid");
    this.observed = b.attempts;
    return {
      ...summary,
      attempts: b.attempts,
      state:
        b.attempts === 0
          ? "ready"
          : b.attempts === 2
            ? "exhausted"
            : this.activeFirst
              ? "active"
              : "interrupted",
    };
  }

  status(): SdkToolBudgetStatus {
    try {
      if (!this.blocked) return this.inspect();
    } catch {
      this.blocked = true;
    }
    return {
      experiment: SDK_TOOL_EXPERIMENT,
      cap: 2,
      attempts: null,
      state: "blocked",
    };
  }

  authorize(ownerAuthorized: boolean): SdkToolBudgetStatus {
    if (ownerAuthorized !== true) throw new SigninFault("operator_required");
    if (this.status().state !== "not_authorized")
      throw new SigninFault("storage_invalid");
    try {
      this.store.write(SDK_TOOL_AUTHORIZATION_FILE, {
        ...base,
        reservationIntent: 0,
      });
      this.store.write(SDK_TOOL_BUDGET_FILE, { ...base, attempts: 0 });
      const ready = this.inspect();
      if (ready.state !== "ready") throw new SigninFault("storage_invalid");
      return ready;
    } catch (error) {
      this.blocked = true;
      throw error;
    }
  }

  /** Step two is called only by the validated first-terminal continuation. */
  reserve(step: 1 | 2): SdkToolBudgetStatus {
    const before = this.status();
    if (
      !(step === 1 && before.state === "ready") &&
      !(step === 2 && before.state === "active")
    )
      throw new SigninFault(
        before.state === "blocked" ? "storage_invalid" : "budget_exhausted"
      );
    try {
      this.store.write(SDK_TOOL_AUTHORIZATION_FILE, {
        ...base,
        reservationIntent: step,
      });
      this.store.write(SDK_TOOL_BUDGET_FILE, { ...base, attempts: step });
      const confirmed = this.inspect();
      if (confirmed.attempts !== step) throw new SigninFault("storage_invalid");
      this.activeFirst = step === 1;
      return { ...confirmed, state: step === 1 ? "active" : "exhausted" };
    } catch (error) {
      this.activeFirst = false;
      this.blocked = true;
      throw error;
    }
  }

  /** Subsequent runs or process restarts cannot resume after step one. */
  finish(): void {
    this.activeFirst = false;
  }
}
