import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type * as Crypto from "node:crypto";

import {
  initialize,
  type ActivationContext,
  type ExtensionContext,
} from "@ableton-extensions/sdk";

import type { ProbeCancellation, ProbeResult } from "./contracts.js";
import {
  closeLoopback,
  listenLoopback,
  result,
  sanitizedFailure,
} from "./host-probes.js";
import {
  nativeCompatibilityDependencies,
  runNativeCompatibility,
} from "./native-compatibility.js";
import {
  CredentialStore,
  nativeCredentialStoreDependencies,
  SIGNIN_STORAGE_DIRECTORY,
  classifyStorageDiagnostic,
  privateStorageOpenFlags,
  type StorageDiagnosticStage,
  type StorageDiagnosticEvent,
  type CredentialStoreDependencies,
} from "./credential-store.js";
import {
  OidcIdTokenVerifier,
  nativeIdTokenDependencies,
  type IdTokenClient,
  type MaintainedJwtVerifier,
  type OfficialDiscovery,
} from "./id-token.js";
import {
  OfficialHttp,
  nativeOfficialHttpDependencies,
  SigninDeadline,
  type OfficialHttpClient,
  type OfficialHttpDependencies,
} from "./official-http.js";
import {
  OAuthLifecycle,
  nativeOAuthLifecycleDependencies,
  openAuthorizationCallback,
} from "./oauth.js";
import { SyntheticResponses } from "./responses.js";
import {
  SigninSession,
  type HostPreflightEvidence,
  type SigninSnapshot,
} from "./signin-session.js";
import {
  AUTH_ORIGIN,
  AUTHORIZATION_ENDPOINT,
  TOKEN_ENDPOINT,
  SigninFault,
  errorCode,
  systemSigninClock,
  validUuid,
  type SigninClock,
} from "./signin-contracts.js";

// The real isolated package injects an entry adapter which lazily loads the
// exact reviewed bundled verifier. The source fixture alone intentionally has
// no verifier dependency or ability to pass the sign-in preflight.
declare const __FEASIBILITY_WEBVIEW__: string;
declare const __FEASIBILITY_BUILD_ID__: string;
const VERSION = "0.0.3";
const BUILD_ID =
  typeof __FEASIBILITY_BUILD_ID__ === "string"
    ? __FEASIBILITY_BUILD_ID__
    : "unbuilt";
const COMMAND = "feasibility.p15_3.open";
const PREFIX = "[chatgpt-feasibility]";
const MODAL_DEADLINE_MS = 15 * 60 * 1000;
const MODAL_CLEANUP_MS = 5000;

export type BundledJwt = Pick<
  typeof import("jsonwebtoken"),
  "decode" | "verify" | "sign"
>;
export type BundledJwtLoader = () => Promise<BundledJwt>;

/** Delegate both JOSE parsing and actual signature verification to the pinned
 * maintained package. No global shims or handwritten signature verifier. */
export function maintainedVerifierAdapter(
  jwt: BundledJwt
): MaintainedJwtVerifier {
  return {
    decode(token, options) {
      return jwt.decode(token, options);
    },
    verify(token, key, options) {
      return jwt.verify(token, key, options);
    },
  };
}

function log(status: ProbeResult): void {
  console.info(PREFIX, JSON.stringify(status));
}
function logEnvelope(event: string, payload: object): void {
  console.info(
    PREFIX,
    JSON.stringify({ version: VERSION, buildId: BUILD_ID, event, ...payload })
  );
}
function assertActive(cancellation: ProbeCancellation): void {
  if (cancellation.cancelled) throw new SigninFault("cancelled");
}

/** Credential-free verification of the *actual bundled* implementation. Only a
 * generated local keypair and a fake JWKS seam are used; no provider request. */
export async function verifyBundledJwt(
  jwt: BundledJwt,
  crypto: Pick<typeof Crypto, "generateKeyPairSync" | "createPublicKey">,
  URLCtor: typeof globalThis.URL,
  clock: SigninClock,
  cancellation: ProbeCancellation
): Promise<boolean> {
  try {
    assertActive(cancellation);
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const kid = "synthetic-preflight-key";
    const audience = "synthetic-preflight-audience";
    const subject = "synthetic-preflight-subject";
    const nonce = "synthetic-preflight-nonce";
    const now = Math.floor(clock.now() / 1000);
    const token = jwt.sign(
      {
        iss: AUTH_ORIGIN,
        aud: audience,
        sub: subject,
        nonce,
        iat: now,
        exp: now + 60,
      },
      privateKey,
      { algorithm: "RS256", keyid: kid }
    );
    const discovery: OfficialDiscovery = {
      issuer: AUTH_ORIGIN,
      authorizationEndpoint: AUTHORIZATION_ENDPOINT,
      tokenEndpoint: TOKEN_ENDPOINT,
      jwksUri: `${AUTH_ORIGIN}/fixture-synthetic-jwks`,
      revocationEndpoint: `${AUTH_ORIGIN}/fixture-synthetic-revoke`,
    };
    const localOnly: OfficialHttpClient = {
      async requestJson(route) {
        await Promise.resolve();
        if (
          typeof route === "object" &&
          route.kind === "jwks" &&
          route.url === discovery.jwksUri
        )
          return {
            keys: [
              {
                ...publicKey.export({ format: "jwk" }),
                kid,
                alg: "RS256",
                use: "sig",
              },
            ],
          };
        throw new SigninFault("invalid_endpoint");
      },
      requestEmpty: () => Promise.reject(new SigninFault("invalid_endpoint")),
      requestStream: () => Promise.reject(new SigninFault("invalid_endpoint")),
    };
    const verifier = new OidcIdTokenVerifier({
      http: localOnly,
      jwt: maintainedVerifierAdapter(jwt),
      crypto,
      URL: URLCtor,
      clock,
    });
    const identity = await verifier.verifyIdToken(
      discovery,
      token,
      { clientId: audience, nonce, subject },
      cancellation
    );
    if (identity.issuer !== AUTH_ORIGIN || identity.subject !== subject)
      return false;
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[2]) return false;
    // A deliberately invalid synthetic signature must be rejected by the real
    // maintained verifier, not just accepted on the basis of decoded claims.
    const signature = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
    let badSignatureRejected = false;
    let wrongNonceRejected = false;
    try {
      await verifier.verifyIdToken(
        discovery,
        `${parts[0]}.${parts[1]}.${signature}`,
        { clientId: audience, nonce, subject },
        cancellation
      );
    } catch (error) {
      badSignatureRejected = errorCode(error) === "id_token_invalid";
    }
    try {
      await verifier.verifyIdToken(
        discovery,
        token,
        { clientId: audience, nonce: "different-synthetic-nonce", subject },
        cancellation
      );
    } catch (error) {
      wrongNonceRejected = errorCode(error) === "id_token_invalid";
    }
    assertActive(cancellation);
    return badSignatureRejected && wrongNonceRejected;
  } catch {
    return false;
  }
}

/** No credential content or identity can enter these fixed diagnostic rows. */
export type StorageDiagnosticPhase =
  | "ensure_host_id"
  | "get_budget"
  | "synthetic_storage"
  | "synthetic_cleanup";
export interface PrivateStorageDiagnosticRow extends StorageDiagnosticEvent {
  phase: StorageDiagnosticPhase;
}
export interface PrivateStorageDiagnosticReport {
  verified: boolean;
  rows: PrivateStorageDiagnosticRow[];
  truncated: boolean;
  lastFailure?: PrivateStorageDiagnosticRow;
}

/** Run the same protected store's host/budget setup, then use only owned fixed
 * synthetic files. A separate diagnostic store prevents logging credential
 * operations after preflight. No credential read or provider call occurs here. */
export function verifyPrivateStorage(
  storageDirectory: string,
  deps: CredentialStoreDependencies
): PrivateStorageDiagnosticReport {
  const { fs, path, uid } = deps;
  const MAX_ROWS = 96;
  let phase: StorageDiagnosticPhase = "ensure_host_id";
  const rows = new Map<string, PrivateStorageDiagnosticRow>();
  let truncated = false;
  let lastFailure: PrivateStorageDiagnosticRow | undefined;
  const record = (event: StorageDiagnosticEvent): void => {
    const row: PrivateStorageDiagnosticRow = {
      phase,
      stage: event.stage,
      outcome: event.outcome,
      code: event.code,
    };
    const key = `${row.phase}:${row.stage}:${row.outcome}:${row.code}`;
    if (
      row.outcome === "blocked" &&
      ((row.stage !== "operation" && row.stage !== "cleanup") || !lastFailure)
    )
      lastFailure = row;
    if (!rows.has(key)) {
      if (rows.size < MAX_ROWS) rows.set(key, row);
      else truncated = true;
    }
  };
  const step = <T>(
    stage: StorageDiagnosticStage,
    run: () => T,
    absentAllowed = false
  ): T => {
    try {
      const value = run();
      record({ stage, outcome: "pass", code: "verified" });
      return value;
    } catch (error) {
      const code = classifyStorageDiagnostic(error);
      record({
        stage,
        outcome: absentAllowed && code === "not_found" ? "pass" : "blocked",
        code,
      });
      throw error;
    }
  };
  let primary: string | undefined;
  let replacement: string | undefined;
  let ownPrimary = false;
  let ownReplacement = false;
  let ok = false;
  const privateFile = (name: string) => {
    const info = step("file_lstat", () => fs.lstatSync(name));
    step("file_metadata", () => {
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.uid !== uid ||
        (info.mode & 0o7777) !== 0o600 ||
        info.size < 1 ||
        info.size > 64
      )
        throw new SigninFault("storage_unsafe");
    });
    return info;
  };
  const create = (name: string, markOwned: () => void, content: string) => {
    const flags = step("write_flags", () =>
      privateStorageOpenFlags(fs, "write")
    );
    const fd = step("write_open", () => fs.openSync(name, flags, 0o600));
    markOwned();
    try {
      step("write_bytes", () => fs.writeFileSync(fd, content, "utf8"));
      step("write_sync", () => fs.fsyncSync(fd));
    } finally {
      step("write_close", () => fs.closeSync(fd));
    }
    privateFile(name);
  };
  try {
    const diagnosticStore = new CredentialStore(storageDirectory, {
      ...deps,
      diagnostic: record,
    });
    step("operation", () => diagnosticStore.ensureHostId());
    phase = "get_budget";
    step("operation", () => diagnosticStore.getBudget());
    phase = "synthetic_storage";
    const directory = path.join(storageDirectory, SIGNIN_STORAGE_DIRECTORY);
    const info = step("directory_lstat", () => fs.lstatSync(directory));
    step("directory_metadata", () => {
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== uid ||
        (info.mode & 0o7777) !== 0o700
      )
        throw new SigninFault("storage_unsafe");
    });
    const [firstId, secondId] = step("random_uuid", () => {
      const first = deps.randomUUID();
      const second = deps.randomUUID();
      if (!validUuid(first) || !validUuid(second) || first === second)
        throw new SigninFault("storage_failed");
      return [first, second];
    });
    primary = path.join(directory, `.preflight-${firstId}.tmp`);
    replacement = path.join(directory, `.preflight-${secondId}.tmp`);
    create(
      primary,
      () => {
        ownPrimary = true;
      },
      "synthetic-initial\n"
    );
    create(
      replacement,
      () => {
        ownReplacement = true;
      },
      "synthetic-replacement\n"
    );
    const replacementInfo = privateFile(replacement);
    const primaryPath = primary;
    const replacementPath = replacement;
    step("write_rename", () => fs.renameSync(replacementPath, primaryPath));
    ownReplacement = false;
    const finalInfo = privateFile(primary);
    step("destination_identity", () => {
      if (
        finalInfo.dev !== replacementInfo.dev ||
        finalInfo.ino !== replacementInfo.ino
      )
        throw new SigninFault("storage_failed");
    });
    // Read only the fixed synthetic marker from the verified same inode, with
    // the exact credential store's mandatory native no-follow read flags.
    const readFlags = step("read_flags", () =>
      privateStorageOpenFlags(fs, "read")
    );
    const readFd = step("read_open", () => fs.openSync(primaryPath, readFlags));
    try {
      const opened = step("read_fstat", () => fs.fstatSync(readFd));
      step("file_metadata", () => {
        if (
          !opened.isFile() ||
          opened.isSymbolicLink() ||
          opened.uid !== uid ||
          opened.nlink !== 1 ||
          (opened.mode & 0o7777) !== 0o600 ||
          opened.size < 1 ||
          opened.size > 64 ||
          opened.dev !== finalInfo.dev ||
          opened.ino !== finalInfo.ino
        )
          throw new SigninFault("storage_unsafe");
      });
      const bytes = step("read_bytes", () => {
        const buffer = new Uint8Array(65);
        let offset = 0;
        while (offset < buffer.length) {
          const count = fs.readSync(
            readFd,
            buffer,
            offset,
            buffer.length - offset,
            null
          );
          if (count === 0) break;
          offset += count;
        }
        if (offset < 1 || offset > 64) throw new SigninFault("storage_unsafe");
        return buffer.subarray(0, offset);
      });
      step("read_decode", () => {
        if (
          new deps.TextDecoder("utf-8", { fatal: true }).decode(bytes) !==
          "synthetic-replacement\n"
        )
          throw new SigninFault("storage_invalid");
      });
    } finally {
      step("read_close", () => fs.closeSync(readFd));
    }
    ok = true;
    record({ stage: "operation", outcome: "pass", code: "verified" });
  } catch (error) {
    ok = false;
    record({
      stage: "operation",
      outcome: "blocked",
      code: classifyStorageDiagnostic(error),
    });
  } finally {
    phase = "synthetic_cleanup";
    for (const [name, owned] of [
      [primary, ownPrimary],
      [replacement, ownReplacement],
    ] as const) {
      if (!name || !owned) continue;
      try {
        const info = step("cleanup_metadata", () => fs.lstatSync(name));
        step("cleanup_metadata", () => {
          if (
            !info.isFile() ||
            info.isSymbolicLink() ||
            info.uid !== uid ||
            info.nlink !== 1 ||
            (info.mode & 0o7777) !== 0o600
          )
            throw new SigninFault("storage_unsafe");
        });
        step("cleanup_unlink", () => fs.unlinkSync(name));
        // Verify absence without reading any contents or exposing the path.
        step("cleanup_absence", () => {
          try {
            fs.lstatSync(name);
          } catch (error) {
            if (classifyStorageDiagnostic(error) === "not_found") return;
            throw error;
          }
          throw new SigninFault("storage_failed");
        });
      } catch (error) {
        ok = false;
        record({
          stage: "cleanup",
          outcome: "blocked",
          code: classifyStorageDiagnostic(error),
        });
      }
    }
  }
  return {
    verified: ok,
    rows: [...rows.values()],
    truncated,
    ...(lastFailure ? { lastFailure } : {}),
  };
}

function sameDescriptor(
  a: PropertyDescriptor | undefined,
  b: PropertyDescriptor | undefined
): boolean {
  if (!a || !b) return a === b;
  return (
    a.configurable === b.configurable &&
    a.enumerable === b.enumerable &&
    a.get === b.get &&
    a.set === b.set &&
    a.writable === b.writable &&
    a.value === b.value
  );
}

/** Reuse the proven F2C stream and pending-read abort checks, with an isolated
 * frozen dependency bag of local constructors. This deliberately makes a
 * supplemental lane ineligible; the actual global object is never modified. */
async function verifyLocalTransport(
  http: OfficialHttpDependencies,
  cancellation: ProbeCancellation
): Promise<boolean> {
  const native = nativeCompatibilityDependencies();
  const keys = ["TextDecoder", "URL", "ReadableStream"] as const;
  const originals = keys.map((key) =>
    Object.getOwnPropertyDescriptor(globalThis, key)
  );
  const web = await native.streamWeb();
  assertActive(cancellation);
  // Bind the original native Fetch receiver; only this private bag contains
  // the permitted builtin constructors. Never label them as actual globals.
  const globals = Object.freeze({
    TextDecoder: http.TextDecoder,
    URL: http.URL,
    ReadableStream: web.ReadableStream,
    fetch: http.fetch.bind(globalThis),
    AbortController: http.AbortController,
  });
  const report = await runNativeCompatibility(
    { cancellation },
    { ...native, globals }
  );
  const lane = report.lanes[0];
  const unchanged = keys.every((key, index) =>
    sameDescriptor(
      originals[index],
      Object.getOwnPropertyDescriptor(globalThis, key)
    )
  );
  const pass =
    report.outcome === "pass" &&
    report.lanes.length === 1 &&
    lane?.lane === "local" &&
    lane.outcome === "pass" &&
    report.restored &&
    unchanged &&
    lane.stream.measurements.preEofRead === true &&
    lane.abort.measurements.pendingRead === true &&
    lane.abort.measurements.serverClosedBeforeTeardown === true &&
    lane.stream.measurements.cleanup === true &&
    lane.abort.measurements.cleanup === true;
  logEnvelope("local_transport_preflight", {
    outcome: pass ? "pass" : "blocked",
    nodeVersion: report.nodeVersion,
    lane: "local",
    supplementalLaneExecuted: report.lanes.length > 1,
    actualGlobalsUnchanged: unchanged,
    streamCode: lane?.stream.code ?? "not_observed",
    abortCode: lane?.abort.code ?? "not_observed",
    streamBytes: lane?.stream.measurements.bytes ?? 0,
    pendingRead: lane?.abort.measurements.pendingRead === true,
    closedBeforeTeardown:
      lane?.abort.measurements.serverClosedBeforeTeardown === true,
  });
  return pass;
}

/** Binds and immediately disposes a synthetic callback. Never opens a browser. */
async function verifyCallbackBinding(
  crypto: Pick<typeof Crypto, "randomBytes">,
  URLCtor: typeof globalThis.URL,
  cancellation: ProbeCancellation
): Promise<boolean> {
  const callback = await openAuthorizationCallback(
    { state: crypto.randomBytes(32).toString("base64url"), cancellation },
    { http: () => import("node:http"), URL: URLCtor, clock: systemSigninClock }
  );
  const rejected = callback.result.then(
    () => false,
    (error) => errorCode(error) === "cancelled"
  );
  await callback.close();
  return await rejected;
}

export interface FixtureSessionHandle {
  session: SigninSession;
  /** Mapping presence only; never expose registration identifiers to IPC. */
  hasPriorRegistration(): boolean;
}

/** Session creation is credential-free. Runtime native dependencies and the
 * verifier are resolved lazily; the operator's preflight is the only route to
 * discovery/JWKS, and the session gates all subsequent owner actions. */
export async function createFixtureSession(
  storageDirectory: string | undefined,
  loadJwt: BundledJwtLoader,
  eligibilityBasisReady: boolean
): Promise<FixtureSessionHandle> {
  if (!storageDirectory) throw new SigninFault("storage_unavailable");
  const storageDeps = await nativeCredentialStoreDependencies();
  const store = new CredentialStore(storageDirectory, storageDeps);
  let httpDeps: OfficialHttpDependencies | undefined;
  let httpClient: OfficialHttp | undefined;
  let jwt: BundledJwt | undefined;
  let idTokenClient: OidcIdTokenVerifier | undefined;
  const getHttp = async (): Promise<OfficialHttp> => {
    if (!httpClient) {
      httpDeps = await nativeOfficialHttpDependencies();
      httpClient = new OfficialHttp(httpDeps);
    }
    return httpClient;
  };
  const http: OfficialHttpClient = {
    async requestJson(route, request) {
      return await (await getHttp()).requestJson(route, request);
    },
    async requestEmpty(route, request) {
      await (await getHttp()).requestEmpty(route, request);
    },
    async requestStream(request, consume) {
      return await (await getHttp()).requestStream(request, consume);
    },
  };
  const getJwt = async (): Promise<BundledJwt> => {
    if (!jwt) {
      const loaded = await loadJwt();
      if (
        typeof loaded.decode !== "function" ||
        typeof loaded.verify !== "function" ||
        typeof loaded.sign !== "function"
      )
        throw new SigninFault("verification_unavailable");
      jwt = loaded;
    }
    return jwt;
  };
  const getIdTokens = async (): Promise<OidcIdTokenVerifier> => {
    if (!idTokenClient)
      idTokenClient = new OidcIdTokenVerifier(
        await nativeIdTokenDependencies(
          http,
          maintainedVerifierAdapter(await getJwt())
        )
      );
    return idTokenClient;
  };
  const idTokens: IdTokenClient = {
    async loadDiscovery(cancellation) {
      return await (await getIdTokens()).loadDiscovery(cancellation);
    },
    async verifyJwks(discovery, cancellation) {
      await (await getIdTokens()).verifyJwks(discovery, cancellation);
    },
    async verifyIdToken(discovery, token, expected, cancellation) {
      return await (
        await getIdTokens()
      ).verifyIdToken(discovery, token, expected, cancellation);
    },
  };
  const oauthDeps = await nativeOAuthLifecycleDependencies(
    http,
    store,
    idTokens
  );
  const oauth = new OAuthLifecycle(oauthDeps);
  const responses = new SyntheticResponses({
    http,
    store,
    TextDecoder: storageDeps.TextDecoder,
    clock: systemSigninClock,
  });
  const hostPreflight = async (
    cancellation: ProbeCancellation
  ): Promise<HostPreflightEvidence> => {
    const evidence = {
      nativeTransport: false,
      callbackBinding: false,
      privateStorage: false,
      bundledVerifier: false,
    };
    const check = async (
      name: keyof HostPreflightEvidence,
      run: () => Promise<boolean> | boolean
    ) => {
      assertActive(cancellation);
      try {
        evidence[name] = await run();
      } catch (error) {
        logEnvelope("host_preflight_check", {
          check: name,
          outcome: "blocked",
          code: errorCode(error, "native_unavailable"),
        });
        return;
      }
      logEnvelope("host_preflight_check", {
        check: name,
        outcome: evidence[name] ? "pass" : "blocked",
        code: evidence[name] ? "verified" : "not_verified",
      });
    };
    await check("nativeTransport", async () => {
      await getHttp();
      return httpDeps
        ? await verifyLocalTransport(httpDeps, cancellation)
        : false;
    });
    await check("callbackBinding", async () => {
      const [{ URL }, crypto] = await Promise.all([
        import("node:url"),
        import("node:crypto"),
      ]);
      return await verifyCallbackBinding(crypto, URL, cancellation);
    });
    await check("privateStorage", () => {
      const diagnostic = verifyPrivateStorage(storageDirectory, storageDeps);
      logEnvelope("private_storage_diagnostic", { diagnostic });
      return diagnostic.verified;
    });
    await check("bundledVerifier", async () => {
      const [{ URL }, crypto, loaded] = await Promise.all([
        import("node:url"),
        import("node:crypto"),
        getJwt(),
      ]);
      return await verifyBundledJwt(
        loaded,
        crypto,
        URL,
        systemSigninClock,
        cancellation
      );
    });
    assertActive(cancellation);
    return evidence;
  };
  return {
    session: new SigninSession({
      eligibilityBasisReady,
      clock: systemSigninClock,
      store,
      oauth,
      responses,
      hostPreflight,
    }),
    hasPriorRegistration: () => store.selectedRegistration() !== undefined,
  };
}

export interface FixtureUiState {
  version: string;
  buildId: string;
  snapshot: SigninSnapshot | null;
  welcomeVisible: boolean;
  startupCode?: string;
  actionCode?: string;
}
export type FixtureAction =
  | "preflight"
  | "signin"
  | "refresh"
  | "models"
  | "confirm-plan-only"
  | "roundtrip"
  | "cancellation"
  | "cancel"
  | "signout"
  | "dismiss-welcome";
const ACTIONS = new Set<string>([
  "preflight",
  "signin",
  "refresh",
  "models",
  "confirm-plan-only",
  "roundtrip",
  "cancellation",
  "cancel",
  "signout",
  "dismiss-welcome",
]);
const OWNER_ACTION = { operatorStarted: true } as const;

/** Per-activation session owner. Only a protected modal command can initiate an
 * action. A modal reopen does not create a fresh apparent restart. */
export class FixtureController {
  private action?: Promise<void>;
  private signoutAction?: Promise<void>;
  private welcomeVisible = false;
  private welcomeShown = false;
  private actionCode?: ReturnType<typeof errorCode>;
  constructor(
    private readonly handle: FixtureSessionHandle | undefined,
    private readonly startupCode?: ReturnType<typeof errorCode>
  ) {}

  snapshot(): FixtureUiState {
    return {
      version: VERSION,
      buildId: BUILD_ID,
      snapshot: this.handle?.session.snapshot() ?? null,
      welcomeVisible: this.welcomeVisible,
      ...(this.startupCode ? { startupCode: this.startupCode } : {}),
      ...(this.actionCode ? { actionCode: this.actionCode } : {}),
    };
  }

  /** Dispatch one of the fixed operator actions; no provider prompt, endpoint,
   * credentials, arbitrary command or eligibility flag can arrive from IPC. */
  dispatch(action: FixtureAction): boolean {
    const session = this.handle?.session;
    if (!session) return false;
    if (action === "dismiss-welcome") {
      this.welcomeVisible = false;
      return true;
    }
    if (action === "cancel") {
      if (this.signoutAction) return false;
      session.cancel();
      logEnvelope("session", { snapshot: session.snapshot() });
      return true;
    }
    if (action === "signout") {
      if (this.signoutAction) return false;
      this.welcomeVisible = false;
      return this.launch(() => session.signOut(OWNER_ACTION), true);
    }
    if (this.action || this.signoutAction || session.snapshot().busy)
      return false;
    switch (action) {
      case "preflight":
        return this.launch(() => session.preflight(OWNER_ACTION));
      case "signin": {
        // Welcome is shown after the first successful plan-enabled registration,
        // not on modal reopen, refresh, reconnect or a persisted connection load.
        let firstRegistration = false;
        try {
          firstRegistration =
            session.snapshot().preflightReady &&
            this.handle?.hasPriorRegistration() === false;
        } catch (error) {
          this.actionCode = errorCode(error, "storage_failed");
          return false;
        }
        return this.launch(
          () => session.signIn(OWNER_ACTION),
          false,
          firstRegistration
        );
      }
      case "refresh":
        return this.launch(() => session.refresh(OWNER_ACTION));
      case "models":
        return this.launch(() => session.loadModels(OWNER_ACTION));
      case "confirm-plan-only": {
        this.actionCode = undefined;
        const snapshot = session.confirmPlanOnly({
          ...OWNER_ACTION,
          planOnlyConfirmed: true,
          creditFallbackDisabled: true,
        });
        logEnvelope("session", { snapshot });
        return true;
      }
      case "roundtrip":
        return this.launch(() => session.runRoundTrip(OWNER_ACTION));
      case "cancellation":
        return this.launch(() => session.runCancellation(OWNER_ACTION));
    }
    return false;
  }

  /** Exact selected catalog slug only, never a free-form model/destination. */
  selectModel(slug: string): boolean {
    const session = this.handle?.session;
    if (
      !session ||
      this.action ||
      this.signoutAction ||
      session.snapshot().busy ||
      !session.snapshot().models.some((model) => model.slug === slug)
    )
      return false;
    this.actionCode = undefined;
    const snapshot = session.selectModel(slug, OWNER_ACTION);
    logEnvelope("session", { snapshot });
    return true;
  }

  /** Modal closure cancels active work, but never silently signs out or resets
   * a valid idle session/proof. An already-authorized sign-out finishes itself. */
  async modalClosed(): Promise<void> {
    const session = this.handle?.session;
    if (session && !this.signoutAction && session.snapshot().busy)
      session.cancel();
    const pending = [this.action, this.signoutAction].filter(
      (value): value is Promise<void> => value !== undefined
    );
    if (pending.length) {
      const deadline = new SigninDeadline(systemSigninClock, MODAL_CLEANUP_MS);
      try {
        await deadline.wait(Promise.allSettled(pending));
      } catch {
        logEnvelope("modal_cleanup", {
          outcome: "blocked",
          code: "cleanup_pending",
        });
      } finally {
        deadline.close();
      }
    }
  }

  private launch(
    run: () => Promise<SigninSnapshot>,
    signout = false,
    welcome = false
  ): boolean {
    this.actionCode = undefined;
    const work = (async () => {
      try {
        const snapshot = await run();
        if (
          welcome &&
          !this.welcomeShown &&
          snapshot.state === "connected" &&
          snapshot.planScopeGranted &&
          !this.signoutAction
        ) {
          this.welcomeShown = true;
          this.welcomeVisible = true;
        }
        logEnvelope("session", { snapshot });
      } catch (error) {
        this.actionCode = errorCode(error);
        logEnvelope("session_action", {
          outcome: "blocked",
          code: this.actionCode,
        });
      } finally {
        if (signout) this.signoutAction = undefined;
        else this.action = undefined;
      }
    })();
    if (signout) this.signoutAction = work;
    else this.action = work;
    return true;
  }
}

/** A per-modal opaque nonce capability; same-origin, empty-body fixed actions,
 * no generic RPC and no CORS. This handler can be tested entirely offline. */
export function createSigninRequestHandler(
  controller: FixtureController,
  nonce: string,
  origin: () => string,
  html: string
): (req: IncomingMessage, res: ServerResponse) => void {
  if (!/^[a-f0-9]{64}$/.test(nonce)) throw new SigninFault("invalid_response");
  const root = `/${nonce}`;
  const send = (res: ServerResponse, status: number, payload: object) => {
    res
      .writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        Connection: "close",
      })
      .end(JSON.stringify(payload));
  };
  return (req, res) => {
    const expectedOrigin = origin();
    if (
      !expectedOrigin ||
      req.headers.host !== expectedOrigin.slice("http://".length) ||
      (req.headers.origin !== undefined &&
        req.headers.origin !== expectedOrigin)
    ) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === "GET" && req.url === `${root}/`) {
      res
        .writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy":
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        })
        .end(html);
      return;
    }
    if (req.method === "GET" && req.url === `${root}/status`) {
      send(res, 200, controller.snapshot());
      return;
    }
    if (
      req.method !== "POST" ||
      !req.url?.startsWith(`${root}/`) ||
      req.url.length > root.length + 520 ||
      req.headers["transfer-encoding"] !== undefined ||
      (req.headers["content-length"] !== undefined &&
        req.headers["content-length"] !== "0")
    ) {
      res.writeHead(404).end();
      return;
    }
    const route = req.url.slice(root.length + 1);
    let accepted = false;
    try {
      if (route.startsWith("model/")) {
        const encoded = route.slice("model/".length);
        if (
          !encoded ||
          encoded.includes("/") ||
          encoded.includes("?") ||
          encoded.includes("#")
        ) {
          res.writeHead(404).end();
          return;
        }
        accepted = controller.selectModel(decodeURIComponent(encoded));
      } else if (ACTIONS.has(route))
        accepted = controller.dispatch(route as FixtureAction);
      else {
        res.writeHead(404).end();
        return;
      }
    } catch {
      send(res, 400, { code: "invalid_response" });
      return;
    }
    // Return only the current projection. The host's one-operation state machine
    // owns async progress; status polling never invokes a provider operation.
    send(res, accepted ? 200 : 409, controller.snapshot());
  };
}

async function showFixture(
  ctx: ExtensionContext<"1.0.0">,
  controller: FixtureController
): Promise<void> {
  let server: Server | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const [{ createServer }, { randomBytes }] = await Promise.all([
      import("node:http"),
      import("node:crypto"),
    ]);
    const nonce = randomBytes(32).toString("hex");
    let origin = "";
    server = createServer(
      createSigninRequestHandler(
        controller,
        nonce,
        () => origin,
        __FEASIBILITY_WEBVIEW__
      )
    );
    const port = await listenLoopback(server);
    origin = `http://127.0.0.1:${port}`;
    log(result("modal_ipc", "pass", "nonce_listener_bound"));
    await Promise.race([
      ctx.ui.showModalDialog(`${origin}/${nonce}/`, 540, 700),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, MODAL_DEADLINE_MS);
      }),
    ]);
  } catch (error) {
    log(result("modal_ipc", "blocked", sanitizedFailure(error)));
  } finally {
    if (timeout) clearTimeout(timeout);
    try {
      await controller.modalClosed();
    } catch {
      logEnvelope("modal_cleanup", {
        outcome: "blocked",
        code: "cleanup_failed",
      });
    }
    if (server) {
      try {
        await closeLoopback(server);
      } catch {
        log(result("modal_ipc", "failed", "cleanup_failed"));
      }
    }
  }
}

/** Real package entry injects the pinned, lazily bundled verifier. A standalone
 * source build has no eligibility basis or verifier and cannot start OAuth. */
export function activate(
  activation: ActivationContext,
  loadJwt: BundledJwtLoader = () =>
    Promise.reject(new SigninFault("verification_unavailable")),
  eligibilityBasisReady = false
): void {
  try {
    const ctx = initialize(activation, "1.0.0");
    log(
      result("activation", "pass", "initialized", {
        version: VERSION,
        buildId: BUILD_ID,
        sdkVersion: "1.0.0-beta.0",
      })
    );
    let open = false;
    let controller: Promise<FixtureController> | undefined;
    const getController = () => {
      controller ??= (async () => {
        try {
          return new FixtureController(
            await createFixtureSession(
              ctx.environment.storageDirectory,
              loadJwt,
              eligibilityBasisReady
            )
          );
        } catch (error) {
          const code = errorCode(error, "native_unavailable");
          logEnvelope("session_initialization", { outcome: "blocked", code });
          return new FixtureController(undefined, code);
        }
      })();
      return controller;
    };
    ctx.commands.registerCommand(COMMAND, () => {
      if (open) return;
      open = true;
      void (async () => {
        try {
          await showFixture(ctx, await getController());
        } catch (error) {
          log(result("modal_ipc", "failed", sanitizedFailure(error)));
        } finally {
          open = false;
        }
      })();
    });
    void (async () => {
      try {
        await ctx.ui.registerContextMenuAction(
          "AudioTrack",
          "ChatGPT feasibility 0.0.3 — sign-in…",
          COMMAND
        );
        log(result("activation", "pass", "context_action_registered"));
      } catch (error) {
        log(result("activation", "blocked", sanitizedFailure(error)));
      }
    })();
  } catch (error) {
    log(result("activation", "blocked", sanitizedFailure(error)));
  }
}
