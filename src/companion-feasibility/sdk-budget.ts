import {
  SigninFault,
  record,
} from "../extension/feasibility/signin-contracts.js";
import { SDK_EXPERIMENT } from "./sdk-responses.js";

export const SDK_BUDGET_FILE = "sdk-diagnostic-budget.json" as const;
export const SDK_AUTHORIZATION_FILE =
  "sdk-diagnostic-authorization.json" as const;
export type SdkRecordName =
  | typeof SDK_BUDGET_FILE
  | typeof SDK_AUTHORIZATION_FILE;
export interface SdkRecordStore {
  assertHistoricalFrozen(): void;
  assertNoSdkTemporaries(): void;
  read(name: SdkRecordName): unknown;
  write(name: SdkRecordName, value: object): void;
}
export interface SdkBudgetStatus {
  experiment: typeof SDK_EXPERIMENT;
  cap: 1;
  attempts: 0 | 1 | null;
  state: "not_authorized" | "ready" | "exhausted" | "blocked";
}
const base = { version: 1, experimentId: SDK_EXPERIMENT, cap: 1 } as const;

/** A separate one-request SDK experiment. Both historical budgets are checked
 * read-only. The authorization/intent record is committed before its companion
 * budget record, so a missing half, uncertain write or orphan temp cannot grant
 * an allowance. No renewal, reset or alternate experiment is available. */
export class SdkBudget {
  private blocked = false;
  private seenAuthorization = false;
  constructor(private readonly store: SdkRecordStore) {}

  private inspect(): SdkBudgetStatus {
    this.store.assertHistoricalFrozen();
    this.store.assertNoSdkTemporaries();
    const authorization = this.store.read(SDK_AUTHORIZATION_FILE);
    const budget = this.store.read(SDK_BUDGET_FILE);
    const summary = { experiment: SDK_EXPERIMENT, cap: 1 } as const;
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
      a.experimentId !== SDK_EXPERIMENT ||
      b.experimentId !== SDK_EXPERIMENT ||
      a.cap !== 1 ||
      b.cap !== 1 ||
      typeof a.reservationStarted !== "boolean" ||
      (b.attempts !== 0 && b.attempts !== 1) ||
      a.reservationStarted !== (b.attempts === 1)
    )
      throw new SigninFault("storage_invalid");
    return {
      ...summary,
      state: b.attempts === 1 ? "exhausted" : "ready",
      attempts: b.attempts,
    };
  }

  /** A read-only view. Unverified accounting is never zero or spendable. */
  status(): SdkBudgetStatus {
    try {
      if (!this.blocked) return this.inspect();
    } catch {
      this.blocked = true;
    }
    return {
      experiment: SDK_EXPERIMENT,
      cap: 1,
      attempts: null,
      state: "blocked",
    };
  }

  /** A separate authenticated owner action; creates the allowance, not a request. */
  authorize(ownerAuthorized: boolean): SdkBudgetStatus {
    if (ownerAuthorized !== true) throw new SigninFault("operator_required");
    if (this.status().state !== "not_authorized")
      throw new SigninFault("storage_invalid");
    try {
      this.store.write(SDK_AUTHORIZATION_FILE, {
        ...base,
        reservationStarted: false,
      });
      this.store.write(SDK_BUDGET_FILE, { ...base, attempts: 0 });
      const ready = this.inspect();
      if (ready.state !== "ready" || ready.attempts !== 0)
        throw new SigninFault("storage_invalid");
      return ready;
    } catch (error) {
      this.blocked = true;
      throw error;
    }
  }

  /** Synchronously commit intent and the consumed slot before any Fetch. */
  reserve(): SdkBudgetStatus {
    const before = this.status();
    if (before.state !== "ready")
      throw new SigninFault(
        before.state === "exhausted" ? "budget_exhausted" : "storage_invalid"
      );
    try {
      this.store.write(SDK_AUTHORIZATION_FILE, {
        ...base,
        reservationStarted: true,
      });
      this.store.write(SDK_BUDGET_FILE, { ...base, attempts: 1 });
      const exhausted = this.inspect();
      if (exhausted.state !== "exhausted" || exhausted.attempts !== 1)
        throw new SigninFault("storage_invalid");
      return exhausted;
    } catch (error) {
      this.blocked = true;
      throw error;
    }
  }
}
