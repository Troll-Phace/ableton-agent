import type * as Crypto from "node:crypto";
import type { ProbeCancellation } from "./contracts.js";
import {
  AUTH_ORIGIN,
  AUTHORIZATION_ENDPOINT,
  TOKEN_ENDPOINT,
  DISCOVERY_ENDPOINT,
  SigninFault,
  errorCode,
  record,
  boundedString,
  type SigninClock,
  systemSigninClock,
} from "./signin-contracts.js";
import {
  validateAuthEndpoint,
  type OfficialHttpClient,
} from "./official-http.js";

const MAX_TOKEN = 32768;
const MAX_KEYS = 64;
const ALGORITHM = "RS256";

export interface OfficialDiscovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  revocationEndpoint: string;
}

/** Maintained bundled verifier seam: the coordinator owns the dependency pin and
 * runtime adapter. Tests may inject a deterministic verifier using generated keys.
 * Decode is untrusted metadata only; signature verification is delegated entirely.
 */
export interface JwtVerificationOptions {
  algorithms: ["RS256"];
  issuer: string;
  audience: string;
  nonce?: string;
  clockTimestamp: number;
  clockTolerance: number;
  complete: false;
}
export interface MaintainedJwtVerifier {
  decode(token: string, options: { complete: true }): unknown;
  verify(
    token: string,
    key: Crypto.KeyObject,
    options: JwtVerificationOptions
  ): unknown;
}
export interface IdTokenDependencies {
  http: OfficialHttpClient;
  jwt: MaintainedJwtVerifier;
  crypto: Pick<typeof Crypto, "createPublicKey">;
  URL: typeof globalThis.URL;
  clock: SigninClock;
}
/** Load only allowed crypto/URL primitives. The maintained verifier is supplied
 * by the reviewed bundle adapter; there is no handwritten signature fallback. */
export async function nativeIdTokenDependencies(
  http: OfficialHttpClient,
  jwt: MaintainedJwtVerifier
): Promise<IdTokenDependencies> {
  try {
    const [crypto, { URL }] = await Promise.all([
      import("node:crypto"),
      import("node:url"),
    ]);
    return { http, jwt, crypto, URL, clock: systemSigninClock };
  } catch (error) {
    throw new SigninFault(errorCode(error, "verification_unavailable"));
  }
}
export interface IdTokenExpectation {
  clientId: string;
  nonce?: string;
  subject?: string;
}
export interface VerifiedIdentity {
  issuer: string;
  subject: string;
}
export interface IdTokenClient {
  loadDiscovery(cancellation?: ProbeCancellation): Promise<OfficialDiscovery>;
  verifyJwks(
    discovery: OfficialDiscovery,
    cancellation?: ProbeCancellation
  ): Promise<void>;
  verifyIdToken(
    discovery: OfficialDiscovery,
    token: string,
    expected: IdTokenExpectation,
    cancellation?: ProbeCancellation
  ): Promise<VerifiedIdentity>;
}

/** Exact issuer/authorization/token endpoints, separately restricted discovered URLs. */
export function validateDiscovery(
  payload: unknown,
  URLCtor: typeof globalThis.URL
): OfficialDiscovery {
  try {
    const root = record(payload);
    if (
      !root ||
      root.issuer !== AUTH_ORIGIN ||
      root.authorization_endpoint !== AUTHORIZATION_ENDPOINT ||
      root.token_endpoint !== TOKEN_ENDPOINT ||
      !Array.isArray(root.id_token_signing_alg_values_supported) ||
      !root.id_token_signing_alg_values_supported.includes(ALGORITHM)
    )
      throw new SigninFault("discovery_invalid");
    const jwksUri = validateAuthEndpoint(root.jwks_uri, URLCtor);
    const revocationEndpoint = validateAuthEndpoint(
      root.revocation_endpoint,
      URLCtor
    );
    if (
      jwksUri === revocationEndpoint ||
      [AUTHORIZATION_ENDPOINT, TOKEN_ENDPOINT, DISCOVERY_ENDPOINT].includes(
        jwksUri
      ) ||
      [AUTHORIZATION_ENDPOINT, TOKEN_ENDPOINT, DISCOVERY_ENDPOINT].includes(
        revocationEndpoint
      )
    )
      throw new SigninFault("discovery_invalid");
    return {
      issuer: AUTH_ORIGIN,
      authorizationEndpoint: AUTHORIZATION_ENDPOINT,
      tokenEndpoint: TOKEN_ENDPOINT,
      jwksUri,
      revocationEndpoint,
    };
  } catch {
    throw new SigninFault("discovery_invalid");
  }
}

function validateResolvedDiscovery(
  discovery: OfficialDiscovery,
  URLCtor: typeof globalThis.URL
): OfficialDiscovery {
  return validateDiscovery(
    {
      issuer: discovery.issuer,
      authorization_endpoint: discovery.authorizationEndpoint,
      token_endpoint: discovery.tokenEndpoint,
      jwks_uri: discovery.jwksUri,
      revocation_endpoint: discovery.revocationEndpoint,
      id_token_signing_alg_values_supported: [ALGORITHM],
    },
    URLCtor
  );
}
function jwks(payload: unknown): Record<string, unknown>[] {
  const root = record(payload);
  if (
    !root ||
    !Array.isArray(root.keys) ||
    root.keys.length < 1 ||
    root.keys.length > MAX_KEYS
  )
    throw new SigninFault("jwks_invalid");
  const keys: Record<string, unknown>[] = [];
  const ids = new Set<string>();
  for (const candidate of root.keys) {
    const key = record(candidate);
    if (!key || !boundedString(key.kid, 256) || ids.has(key.kid))
      throw new SigninFault("jwks_invalid");
    ids.add(key.kid);
    keys.push(key);
  }
  return keys;
}
function publicRsaKey(
  key: Record<string, unknown>,
  crypto: IdTokenDependencies["crypto"]
): Crypto.KeyObject {
  if (
    key.kty !== "RSA" ||
    (key.alg !== undefined && key.alg !== ALGORITHM) ||
    (key.use !== undefined && key.use !== "sig") ||
    (key.key_ops !== undefined &&
      (!Array.isArray(key.key_ops) ||
        key.key_ops.length !== 1 ||
        key.key_ops[0] !== "verify")) ||
    ["d", "p", "q", "dp", "dq", "qi", "oth"].some(
      (name) => key[name] !== undefined
    ) ||
    !boundedString(key.n, 2048) ||
    !boundedString(key.e, 32) ||
    !/^[A-Za-z0-9_-]+$/.test(key.n) ||
    !/^[A-Za-z0-9_-]+$/.test(key.e)
  )
    throw new SigninFault("jwks_invalid");
  try {
    // Only public RSA fields from the official JWKS; never use JOSE header URLs.
    const result = crypto.createPublicKey({
      key: { kty: "RSA", n: key.n, e: key.e },
      format: "jwk",
    });
    if (
      result.asymmetricKeyType !== "rsa" ||
      (result.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    )
      throw new SigninFault("jwks_invalid");
    return result;
  } catch (error) {
    throw new SigninFault(errorCode(error, "jwks_invalid"));
  }
}

/** Host-only validation, explicitly delegated signature verification. */
export class OidcIdTokenVerifier implements IdTokenClient {
  constructor(private readonly deps: IdTokenDependencies) {}

  async loadDiscovery(
    cancellation?: ProbeCancellation
  ): Promise<OfficialDiscovery> {
    return validateDiscovery(
      await this.deps.http.requestJson("discovery", { cancellation }),
      this.deps.URL
    );
  }

  /** Preflight verifies the JWKS can yield at least one suitable public key. */
  async verifyJwks(
    discovery: OfficialDiscovery,
    cancellation?: ProbeCancellation
  ): Promise<void> {
    const checked = validateResolvedDiscovery(discovery, this.deps.URL);
    const keys = jwks(
      await this.deps.http.requestJson(
        { kind: "jwks", url: checked.jwksUri },
        { cancellation }
      )
    );
    const rsa = keys.filter(
      (key) =>
        key.kty === "RSA" &&
        (key.alg === undefined || key.alg === ALGORITHM) &&
        (key.use === undefined || key.use === "sig")
    );
    if (!rsa.length) throw new SigninFault("jwks_invalid");
    for (const key of rsa) publicRsaKey(key, this.deps.crypto);
  }

  async verifyIdToken(
    discovery: OfficialDiscovery,
    token: string,
    expected: IdTokenExpectation,
    cancellation?: ProbeCancellation
  ): Promise<VerifiedIdentity> {
    if (cancellation?.cancelled) throw new SigninFault("cancelled");
    if (
      !boundedString(token, MAX_TOKEN) ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) ||
      !boundedString(expected.clientId, 2048) ||
      (expected.nonce !== undefined && !boundedString(expected.nonce, 256))
    )
      throw new SigninFault("id_token_invalid");
    const checked = validateResolvedDiscovery(discovery, this.deps.URL);
    let header: Record<string, unknown> | undefined;
    try {
      header = record(
        record(this.deps.jwt.decode(token, { complete: true }))?.header
      );
    } catch {
      throw new SigninFault("id_token_invalid");
    }
    if (
      !header ||
      header.alg !== ALGORITHM ||
      !boundedString(header.kid, 256) ||
      ["jku", "x5u", "jwk", "x5c", "crit"].some(
        (key) => header?.[key] !== undefined
      )
    )
      throw new SigninFault("id_token_invalid");
    const keys = jwks(
      await this.deps.http.requestJson(
        { kind: "jwks", url: checked.jwksUri },
        { cancellation }
      )
    );
    const matches = keys.filter((key) => key.kid === header?.kid);
    if (matches.length !== 1) throw new SigninFault("jwks_invalid");
    const key = publicRsaKey(matches[0], this.deps.crypto);
    if (cancellation?.cancelled) throw new SigninFault("cancelled");
    const now = Math.floor(this.deps.clock.now() / 1000);
    let claims: Record<string, unknown> | undefined;
    try {
      claims = record(
        this.deps.jwt.verify(token, key, {
          algorithms: [ALGORITHM],
          issuer: checked.issuer,
          audience: expected.clientId,
          nonce: expected.nonce,
          clockTimestamp: now,
          clockTolerance: 0,
          complete: false,
        })
      );
    } catch (error) {
      throw new SigninFault(errorCode(error, "id_token_invalid"));
    }
    // Validate the shape and OIDC-specific claims even when the verifier already
    // checks issuer/audience/expiry/nonce. No identity is accepted before verify.
    if (
      !claims ||
      claims.iss !== checked.issuer ||
      !boundedString(claims.sub, 2048) ||
      typeof claims.exp !== "number" ||
      !Number.isSafeInteger(claims.exp) ||
      claims.exp <= now ||
      typeof claims.iat !== "number" ||
      !Number.isSafeInteger(claims.iat) ||
      claims.iat <= 0 ||
      claims.iat > now ||
      (claims.nbf !== undefined &&
        (typeof claims.nbf !== "number" ||
          !Number.isSafeInteger(claims.nbf) ||
          claims.nbf > now)) ||
      (expected.nonce !== undefined && claims.nonce !== expected.nonce)
    )
      throw new SigninFault("id_token_invalid");
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (
      audiences.length < 1 ||
      audiences.length > 16 ||
      !audiences.every((value) => boundedString(value, 2048)) ||
      !audiences.includes(expected.clientId) ||
      new Set(audiences).size !== audiences.length ||
      (audiences.length > 1 && claims.azp !== expected.clientId) ||
      (claims.azp !== undefined && claims.azp !== expected.clientId)
    )
      throw new SigninFault("id_token_invalid");
    if (expected.subject !== undefined && claims.sub !== expected.subject)
      throw new SigninFault("identity_mismatch");
    return { issuer: checked.issuer, subject: claims.sub };
  }
}
