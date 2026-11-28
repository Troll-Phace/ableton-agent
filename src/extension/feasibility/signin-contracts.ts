import type { ProbeCancellation } from "./contracts.js";

/** Only the documented preview route is supported; no key, cookie or credit fallback. */
export const AUTH_ORIGIN = "https://auth.openai.com";
export const AUTHORIZATION_ENDPOINT = `${AUTH_ORIGIN}/api/accounts/authorize`;
export const TOKEN_ENDPOINT = `${AUTH_ORIGIN}/api/accounts/oauth/token`;
export const DISCOVERY_ENDPOINT = `${AUTH_ORIGIN}/.well-known/openid-configuration`;
export const RESOURCE = "https://api.openai.com/v1";
export const MODELS_ENDPOINT = `${RESOURCE}/models`;
export const RESPONSES_ENDPOINT = `${RESOURCE}/responses`;
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const REQUESTED_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "resource.invoke",
  PLAN_SCOPE,
] as const;

export type SigninState =
  | "idle"
  | "preflight_ready"
  | "awaiting_consent"
  | "validating"
  | "connected"
  | "model_selected"
  | "running_roundtrip"
  | "roundtrip_complete"
  | "running_cancellation"
  | "finished"
  | "denied"
  | "plan_disabled"
  | "reconnect_required"
  | "blocked"
  | "cancelled"
  | "failed"
  | "signed_out";
export type SigninCode =
  | "eligibility_pending"
  | "operator_required"
  | "operation_busy"
  | "cancelled"
  | "native_abort"
  | "timeout"
  | "native_unavailable"
  | "permission_denied"
  | "network_failed"
  | "cleanup_failed"
  | "invalid_endpoint"
  | "redirect_rejected"
  | "invalid_response"
  | "response_limit"
  | "http_rejected"
  | "usage_limited"
  | "temporary_failure"
  | "invalid_grant"
  | "access_denied"
  | "plan_disabled"
  | "discovery_invalid"
  | "jwks_invalid"
  | "id_token_invalid"
  | "verification_unavailable"
  | "identity_mismatch"
  | "client_mismatch"
  | "callback_invalid"
  | "callback_timeout"
  | "browser_unavailable"
  | "browser_denied"
  | "callback_bind_failed"
  | "storage_unavailable"
  | "storage_unsafe"
  | "storage_invalid"
  | "storage_failed"
  | "budget_exhausted"
  | "reconnect_required";

/** Fixed allowlisted error only. Raw errors and provider bodies are never attached. */
export class SigninFault extends Error {
  constructor(readonly code: SigninCode) {
    super(code);
    this.name = "SigninFault";
  }
}

/** Structural classification works across realms without exposing messages. */
export function errorCode(
  error: unknown,
  fallback: SigninCode = "network_failed"
): SigninCode {
  if (error instanceof SigninFault) return error.code;
  if (typeof error === "object" && error !== null) {
    try {
      if (
        "code" in error &&
        typeof error.code === "string" &&
        ["ERR_ACCESS_DENIED", "EACCES", "EPERM"].includes(error.code)
      )
        return "permission_denied";
    } catch {
      /* Never marshal exception fields. */
    }
  }
  return fallback;
}

/** Native timers are injected in tests; timestamps are milliseconds. */
export interface SigninClock {
  now(): number;
  setTimeout(
    callback: () => void,
    delay: number
  ): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
export const systemSigninClock: SigninClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
};

/** Host-only OIDC registration identity. Never project any field to IPC. */
export interface Registration {
  localId: string;
  clientId: string;
  issuer: string;
  subject: string;
}

/** Host-only protected storage record: the verified ID token itself is discarded. */
export interface StoredConnection extends Registration {
  version: 1;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}
export interface RequestBudget {
  version: 1;
  runId: string;
  attempts: number;
}

/** All persistence is synchronous and atomic so a generation check can precede
 * the write without a cancellation/sign-out race. */
export interface SigninPersistence {
  /** Canonical persisted UUIDv4 URI; never a raw UUID or user identifier. */
  ensureHostId(): string;
  selectedRegistration(): Registration | undefined;
  loadSelectedConnection(): StoredConnection | undefined;
  saveConnection(connection: StoredConnection): void;
  clearCredentials(localId: string): void;
  clearAllCredentials(): void;
  getBudget(): RequestBudget;
  reserveInferenceAttempt(): RequestBudget;
}

/** Runtime gates are explicit input, not claims about eligibility. */
export interface SigninAuthorization {
  eligible: boolean;
  operatorStarted: boolean;
  /** Explicitly request a new registration; default reuses selected registration. */
  newRegistration?: boolean;
  cancellation?: ProbeCancellation;
}
export interface RevocationResult {
  localCleared: boolean;
  remoteRevocation: "request_accepted" | "unconfirmed" | "not_applicable";
}

/** Narrowing helpers never coerce malformed remote values. */
export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
export function boundedString(value: unknown, max = 4096): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > max)
    return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return false;
  }
  return true;
}
/** Opaque bearer/refresh values cannot contain whitespace or header controls. */
export function validToken(value: unknown): value is string {
  return boundedString(value, 32768) && !/\s/.test(value);
}
export function validUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value
    )
  );
}

/** Derive the documented UUIDv4 host URI without changing the underlying UUID.
 * Only raw, hyphenated RFC-variant v4 values are accepted for legacy migration. */
export function hostIdFromUuid(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length !== 36 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  )
    return undefined;
  return `urn:uuid:${value.toLowerCase()}`;
}

/** Persisted and transmitted host IDs must be in the canonical URI form. */
export function validHostId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("urn:uuid:") &&
    hostIdFromUuid(value.slice("urn:uuid:".length)) === value
  );
}
