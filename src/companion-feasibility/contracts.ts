import type { SigninSnapshot } from "../extension/feasibility/signin-session.js";
import type { CompanionRuntimeStatus } from "./runtime.js";
import { DIAGNOSTIC_EXPERIMENT } from "./diagnostic-budget.js";
import { SDK_EXPERIMENT } from "./sdk-responses.js";
import { SDK_TOOL_EXPERIMENT } from "./sdk-tool-roundtrip.js";

export const CONTROL_PATH = "/" as const;
export const PAIR_PATH = "/pair" as const;
export const SESSION_PATH = "/session" as const;
export const ACTION_PATH = "/action" as const;
export const SESSION_COOKIE = "companion_session";
export const CSRF_HEADER = "x-companion-csrf";
export const PAIRING_TTL_MS = 120_000;
export const PAIRING_MAX_FAILURES = 5;
export const SESSION_TTL_MS = 900_000;
export const CONTROL_BODY_LIMIT = 4096;

export type ControlAction =
  | { action: "status" }
  | {
      action:
        | "preflight"
        | "refresh"
        | "load_models"
        | "run_roundtrip"
        | "run_cancellation"
        | "cancel"
        | "sign_out"
        | "quit";
      operatorStarted: true;
    }
  | { action: "sign_in"; operatorStarted: true; newRegistration?: boolean }
  | { action: "select_model"; operatorStarted: true; modelSlug: string }
  | {
      action: "authorize_text_diagnostic" | "run_text_diagnostic";
      operatorStarted: true;
      ownerAuthorized: true;
      experiment: typeof DIAGNOSTIC_EXPERIMENT;
    }
  | {
      action: "authorize_sdk_diagnostic" | "run_sdk_diagnostic";
      operatorStarted: true;
      ownerAuthorized: true;
      experiment: typeof SDK_EXPERIMENT;
    }
  | {
      action: "authorize_sdk_tool_roundtrip" | "run_sdk_tool_roundtrip";
      operatorStarted: true;
      ownerAuthorized: true;
      experiment: typeof SDK_TOOL_EXPERIMENT;
    }
  | {
      action: "confirm_plan_only";
      operatorStarted: true;
      planOnlyConfirmed: true;
      creditFallbackDisabled: true;
    };

export type ControlErrorCode =
  | "request_rejected"
  | "unsupported_media_type"
  | "body_too_large"
  | "invalid_request"
  | "pairing_failed"
  | "pairing_unavailable"
  | "session_required"
  | "csrf_rejected"
  | "operation_busy"
  | "control_closed"
  | "operation_failed";
export interface ControlError {
  ok: false;
  code: ControlErrorCode;
}
export interface ControlSessionReply {
  ok: true;
  csrf: string;
}
export interface ControlStatusReply {
  ok: true;
  snapshot: SigninSnapshot;
  runtime: CompanionRuntimeStatus;
}
export interface ControlQuitReply {
  ok: true;
  stopping: true;
}
export type ControlReply =
  | ControlError
  | ControlSessionReply
  | ControlStatusReply
  | ControlQuitReply;

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
export function parsePairingRequest(value: unknown): string | undefined {
  const row = object(value);
  return row &&
    exact(row, ["code"]) &&
    typeof row.code === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(row.code)
    ? row.code
    : undefined;
}
export function parseControlAction(value: unknown): ControlAction | undefined {
  const row = object(value);
  if (!row || typeof row.action !== "string") return undefined;
  const action = row.action;
  if (action === "status")
    return exact(row, ["action"]) ? { action } : undefined;
  if (row.operatorStarted !== true) return undefined;
  const keys = ["action", "operatorStarted"];
  switch (action) {
    case "preflight":
    case "refresh":
    case "load_models":
    case "run_roundtrip":
    case "run_cancellation":
    case "cancel":
    case "sign_out":
    case "quit":
      return exact(row, keys) ? { action, operatorStarted: true } : undefined;
    case "authorize_text_diagnostic":
    case "run_text_diagnostic":
      return exact(row, [...keys, "ownerAuthorized", "experiment"]) &&
        row.ownerAuthorized === true &&
        row.experiment === DIAGNOSTIC_EXPERIMENT
        ? {
            action,
            operatorStarted: true,
            ownerAuthorized: true,
            experiment: DIAGNOSTIC_EXPERIMENT,
          }
        : undefined;
    case "authorize_sdk_diagnostic":
    case "run_sdk_diagnostic":
      return exact(row, [...keys, "ownerAuthorized", "experiment"]) &&
        row.ownerAuthorized === true &&
        row.experiment === SDK_EXPERIMENT
        ? {
            action,
            operatorStarted: true,
            ownerAuthorized: true,
            experiment: SDK_EXPERIMENT,
          }
        : undefined;
    case "authorize_sdk_tool_roundtrip":
    case "run_sdk_tool_roundtrip":
      return exact(row, [...keys, "ownerAuthorized", "experiment"]) &&
        row.ownerAuthorized === true &&
        row.experiment === SDK_TOOL_EXPERIMENT
        ? {
            action,
            operatorStarted: true,
            ownerAuthorized: true,
            experiment: SDK_TOOL_EXPERIMENT,
          }
        : undefined;
    case "sign_in":
      if (exact(row, keys)) return { action, operatorStarted: true };
      if (
        exact(row, [...keys, "newRegistration"]) &&
        typeof row.newRegistration === "boolean"
      )
        return {
          action,
          operatorStarted: true,
          newRegistration: row.newRegistration,
        };
      return undefined;
    case "select_model":
      return exact(row, [...keys, "modelSlug"]) &&
        typeof row.modelSlug === "string" &&
        row.modelSlug.length >= 1 &&
        row.modelSlug.length <= 128 &&
        !/\s/.test(row.modelSlug)
        ? { action, operatorStarted: true, modelSlug: row.modelSlug }
        : undefined;
    case "confirm_plan_only":
      return exact(row, [
        ...keys,
        "planOnlyConfirmed",
        "creditFallbackDisabled",
      ]) &&
        row.planOnlyConfirmed === true &&
        row.creditFallbackDisabled === true
        ? {
            action,
            operatorStarted: true,
            planOnlyConfirmed: true,
            creditFallbackDisabled: true,
          }
        : undefined;
    default:
      return undefined;
  }
}
