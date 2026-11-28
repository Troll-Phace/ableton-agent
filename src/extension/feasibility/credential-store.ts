import type * as Fs from "node:fs";
import type * as Path from "node:path";
import {
  AUTH_ORIGIN,
  SigninFault,
  boundedString,
  validToken,
  errorCode,
  record,
  validUuid,
  type Registration,
  type RequestBudget,
  type SigninPersistence,
  type StoredConnection,
} from "./signin-contracts.js";

export const SIGNIN_STORAGE_DIRECTORY = "p15-3-signin";
const MAX_FILE_BYTES = 131072;
const MAX_CONNECTIONS = 16;
const MAX_ATTEMPTS = 3;
const MAX_DIRECTORY_ENTRIES = 128;
// A generated same-directory temporary filename is itself a durable cleanup
// obligation. A restart need not read its contents (which may contain tokens).
const UUID_PART =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const TEMPORARY_NAME = new RegExp(
  `^\\.(?:host\\.json|connections\\.json|run-budget\\.json|connection-${UUID_PART}\\.json)\\.${UUID_PART}\\.tmp$`
);
const MAP_FILE = "connections.json";
const HOST_FILE = "host.json";
const BUDGET_FILE = "run-budget.json";

/** Diagnostic-only fixed stages and coarse error classes. No path, file name,
 * identifier, record content or exception message can enter this envelope. */
export type StorageDiagnosticStage =
  | "operation"
  | "root_lstat"
  | "root_metadata"
  | "directory_lstat"
  | "directory_create"
  | "directory_metadata"
  | "directory_list"
  | "directory_identity"
  | "temporary_obligations"
  | "file_lstat"
  | "file_metadata"
  | "random_uuid"
  | "read_flags"
  | "read_open"
  | "read_fstat"
  | "read_bytes"
  | "read_decode"
  | "read_close"
  | "write_flags"
  | "write_data_validation"
  | "write_open"
  | "write_fstat"
  | "write_bytes"
  | "write_sync"
  | "write_close"
  | "write_rename"
  | "destination_identity"
  | "cleanup_metadata"
  | "cleanup_unlink"
  | "cleanup_absence"
  | "cleanup";
export type StorageDiagnosticClass =
  | "verified"
  | "not_found"
  | "permission_denied"
  | "storage_unavailable"
  | "storage_unsafe"
  | "storage_invalid"
  | "storage_failed"
  | "native_constants_unavailable"
  | "no_follow_unavailable"
  | "exclusive_create_flags_unavailable"
  | "read_access_flag_unavailable"
  | "unsupported_operation"
  | "invalid_argument"
  | "invalid_descriptor"
  | "unsafe_path"
  | "already_exists"
  | "read_only"
  | "capacity_unavailable"
  | "io_failed"
  | "type_error"
  | "operation_failed";
export interface StorageDiagnosticEvent {
  stage: StorageDiagnosticStage;
  outcome: "pass" | "blocked";
  code: StorageDiagnosticClass;
}

class StorageFlagFault extends SigninFault {
  constructor(
    readonly diagnosticClass:
      | "native_constants_unavailable"
      | "no_follow_unavailable"
      | "exclusive_create_flags_unavailable"
      | "read_access_flag_unavailable"
  ) {
    super("storage_unavailable");
  }
}

/** Do not inspect raw messages, stacks, paths, arguments or contents. */
export function classifyStorageDiagnostic(
  error: unknown
): StorageDiagnosticClass {
  if (error instanceof StorageFlagFault) return error.diagnosticClass;
  if (error instanceof SigninFault) {
    if (
      error.code === "storage_unavailable" ||
      error.code === "storage_unsafe" ||
      error.code === "storage_invalid" ||
      error.code === "storage_failed" ||
      error.code === "permission_denied"
    )
      return error.code;
    return "operation_failed";
  }
  if (typeof error === "object" && error !== null) {
    try {
      const code = "code" in error ? error.code : undefined;
      switch (code) {
        case "ERR_ACCESS_DENIED":
        case "EACCES":
        case "EPERM":
          return "permission_denied";
        case "ENOENT":
          return "not_found";
        case "ENOSYS":
        case "ENOTSUP":
        case "EOPNOTSUPP":
        case "ERR_METHOD_NOT_IMPLEMENTED":
          return "unsupported_operation";
        case "EINVAL":
        case "ERR_INVALID_ARG_TYPE":
        case "ERR_INVALID_ARG_VALUE":
        case "ERR_OUT_OF_RANGE":
          return "invalid_argument";
        case "EBADF":
          return "invalid_descriptor";
        case "ELOOP":
        case "ENOTDIR":
        case "EISDIR":
          return "unsafe_path";
        case "EEXIST":
          return "already_exists";
        case "EROFS":
          return "read_only";
        case "ENOSPC":
        case "EDQUOT":
          return "capacity_unavailable";
        case "EIO":
          return "io_failed";
      }
      if ("name" in error && error.name === "TypeError") return "type_error";
    } catch {
      /* no exception fields are emitted */
    }
  }
  return "operation_failed";
}

/** Required native flags must all be present. Bitwise coercion of undefined
 * constants to zero must never silently drop exclusivity or no-follow. */
export function privateStorageOpenFlags(
  fs: typeof Fs,
  mode: "read" | "write"
): number {
  const flags = fs.constants;
  const valid = (value: unknown, zeroAllowed = false): value is number =>
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= (zeroAllowed ? 0 : 1) &&
    value <= 0x7fffffff;
  if (!flags) throw new StorageFlagFault("native_constants_unavailable");
  if (!valid(flags.O_NOFOLLOW))
    throw new StorageFlagFault("no_follow_unavailable");
  if (mode === "read") {
    if (!valid(flags.O_RDONLY, true))
      throw new StorageFlagFault("read_access_flag_unavailable");
    return flags.O_RDONLY | flags.O_NOFOLLOW;
  }
  if (!valid(flags.O_WRONLY) || !valid(flags.O_CREAT) || !valid(flags.O_EXCL))
    throw new StorageFlagFault("exclusive_create_flags_unavailable");
  return flags.O_WRONLY | flags.O_CREAT | flags.O_EXCL | flags.O_NOFOLLOW;
}

export interface CredentialStoreDependencies {
  fs: typeof Fs;
  path: typeof Path;
  uid: number;
  randomUUID(): string;
  TextDecoder: typeof globalThis.TextDecoder;
  /** Supplied only to a credential-free diagnostic store instance. */
  diagnostic?: (event: StorageDiagnosticEvent) => void;
}

/** Resolves only the normal installed-host builtin seams; never reads storage here. */
export async function nativeCredentialStoreDependencies(): Promise<CredentialStoreDependencies> {
  try {
    if (typeof process !== "object" || typeof process.getuid !== "function")
      throw new SigninFault("storage_unavailable");
    const [fs, path, crypto, util] = await Promise.all([
      import("node:fs"),
      import("node:path"),
      import("node:crypto"),
      import("node:util"),
    ]);
    return {
      fs,
      path,
      uid: process.getuid(),
      randomUUID: () => crypto.randomUUID(),
      TextDecoder: util.TextDecoder,
    };
  } catch (error) {
    throw new SigninFault(errorCode(error, "storage_unavailable"));
  }
}

interface ConnectionMap {
  version: 1;
  selected: string | null;
  registrations: Registration[];
}
function missing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
function registration(value: unknown): Registration {
  const row = record(value);
  if (
    !row ||
    !validUuid(row.localId) ||
    !boundedString(row.clientId, 2048) ||
    !boundedString(row.subject, 2048) ||
    row.issuer !== AUTH_ORIGIN
  )
    throw new SigninFault("storage_invalid");
  return {
    localId: row.localId,
    clientId: row.clientId,
    issuer: row.issuer,
    subject: row.subject,
  };
}
function sameRegistration(left: Registration, right: Registration): boolean {
  return (
    left.localId === right.localId &&
    left.clientId === right.clientId &&
    left.issuer === right.issuer &&
    left.subject === right.subject
  );
}
function connection(value: unknown): StoredConnection {
  const row = record(value);
  const reg = registration(value);
  if (
    !row ||
    row.version !== 1 ||
    !validToken(row.accessToken) ||
    !validToken(row.refreshToken) ||
    typeof row.expiresAt !== "number" ||
    !Number.isSafeInteger(row.expiresAt) ||
    row.expiresAt <= 0 ||
    !Array.isArray(row.scopes)
  )
    throw new SigninFault("storage_invalid");
  const scopes: unknown[] = row.scopes;
  if (
    scopes.length < 1 ||
    scopes.length > 64 ||
    !scopes.every(
      (scope): scope is string =>
        boundedString(scope, 128) && /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope)
    ) ||
    new Set(scopes).size !== scopes.length
  )
    throw new SigninFault("storage_invalid");
  return {
    version: 1,
    ...reg,
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    expiresAt: row.expiresAt,
    scopes: [...scopes],
  };
}
function budget(value: unknown): RequestBudget {
  const row = record(value);
  if (
    !row ||
    row.version !== 1 ||
    !validUuid(row.runId) ||
    typeof row.attempts !== "number" ||
    !Number.isInteger(row.attempts) ||
    row.attempts < 0 ||
    row.attempts > MAX_ATTEMPTS
  )
    throw new SigninFault("storage_invalid");
  return { version: 1, runId: row.runId, attempts: row.attempts };
}

/** A private, fixture-owned directory beneath SDK storage. No other path is read. */
export class CredentialStore implements SigninPersistence {
  private readonly directory: string;
  constructor(
    private readonly storageDirectory: string | undefined,
    private readonly deps: CredentialStoreDependencies
  ) {
    if (
      !storageDirectory ||
      !deps.path.isAbsolute(storageDirectory) ||
      !Number.isSafeInteger(deps.uid) ||
      deps.uid < 0
    )
      throw new SigninFault("storage_unavailable");
    this.directory = deps.path.join(storageDirectory, SIGNIN_STORAGE_DIRECTORY);
  }

  /** Creates/validates a persisted UUID host identifier. */
  ensureHostId(): string {
    return this.protected(() => {
      const existing = this.read(HOST_FILE);
      if (existing !== undefined) {
        const row = record(existing);
        if (!row || row.version !== 1 || !validUuid(row.hostId))
          throw new SigninFault("storage_invalid");
        return row.hostId;
      }
      const hostId = this.uuid();
      this.write(HOST_FILE, { version: 1, hostId });
      return hostId;
    });
  }

  selectedRegistration(): Registration | undefined {
    return this.protected(() => {
      const map = this.loadMap();
      return map.registrations.find((row) => row.localId === map.selected);
    });
  }

  loadSelectedConnection(): StoredConnection | undefined {
    return this.protected(() => {
      const selected = this.selectedRegistration();
      if (!selected) return undefined;
      const raw = this.read(this.connectionFilename(selected.localId));
      if (raw === undefined) return undefined;
      const credentials = connection(raw);
      if (!sameRegistration(selected, credentials))
        throw new SigninFault("storage_invalid");
      return credentials;
    });
  }

  /** Mapping precedes a new credential file. Failed creation leaves at most an
   * uncredentialed registration; rotation is one atomic replacement. */
  saveConnection(value: StoredConnection): void {
    this.protected(() => {
      const checked = connection(value);
      const mapping = this.loadMap();
      const previous = mapping.registrations.find(
        (row) => row.localId === checked.localId
      );
      if (previous && !sameRegistration(previous, checked))
        throw new SigninFault("identity_mismatch");
      if (
        mapping.registrations.some(
          (row) =>
            row.clientId === checked.clientId && row.localId !== checked.localId
        )
      )
        throw new SigninFault("client_mismatch");
      if (
        mapping.selected &&
        mapping.selected !== checked.localId &&
        this.loadSelectedConnection()
      )
        throw new SigninFault("operation_busy");
      if (!previous) {
        if (mapping.registrations.length >= MAX_CONNECTIONS)
          throw new SigninFault("storage_invalid");
        // An unknown existing credential file is never overwritten.
        if (this.read(this.connectionFilename(checked.localId)) !== undefined)
          throw new SigninFault("storage_unsafe");
        mapping.registrations.push(registration(checked));
      } else {
        const old = this.read(this.connectionFilename(checked.localId));
        if (old !== undefined && !sameRegistration(connection(old), checked))
          throw new SigninFault("storage_invalid");
      }
      if (!previous || mapping.selected !== checked.localId) {
        mapping.selected = checked.localId;
        this.write(MAP_FILE, mapping);
      }
      this.write(this.connectionFilename(checked.localId), checked);
    });
  }

  /** Remove the named registration's credential-bearing file and reconcile
   * fixture-owned temporary obligations, even when either operation fails. */
  clearCredentials(localId: string): void {
    this.protected(() => {
      const cleanupOk = this.tryReconcileTemporaries();
      const known = this.loadMap().registrations.find(
        (row) => row.localId === localId
      );
      if (!known) throw new SigninFault("storage_invalid");
      this.remove(this.connectionFilename(localId));
      if (!cleanupOk) throw new SigninFault("storage_failed");
    }, false);
  }

  /** Final cleanup retains the host/registration mapping and persistent budget
   * only. A failed or unsafe temp remains an unresolved local cleanup obligation. */
  clearAllCredentials(): void {
    this.protected(() => {
      let failed = !this.tryReconcileTemporaries();
      for (const row of this.loadMap().registrations) {
        try {
          this.remove(this.connectionFilename(row.localId));
        } catch {
          failed = true;
        }
      }
      if (failed) throw new SigninFault("storage_failed");
    }, false);
  }

  getBudget(): RequestBudget {
    return this.protected(() => {
      const raw = this.read(BUDGET_FILE);
      if (raw !== undefined) return budget(raw);
      const next: RequestBudget = {
        version: 1,
        runId: this.uuid(),
        attempts: 0,
      };
      this.write(BUDGET_FILE, next);
      return next;
    });
  }

  /** Reserve before any inference Fetch; no reset exists, including on sign-out. */
  reserveInferenceAttempt(): RequestBudget {
    return this.protected(() => {
      const current = this.getBudget();
      if (current.attempts >= MAX_ATTEMPTS)
        throw new SigninFault("budget_exhausted");
      const next: RequestBudget = {
        ...current,
        attempts: current.attempts + 1,
      };
      this.write(BUDGET_FILE, next);
      return next;
    });
  }

  private observe<T>(
    stage: StorageDiagnosticStage,
    run: () => T,
    absentAllowed = false
  ): T {
    const diagnostic = this.deps.diagnostic;
    if (!diagnostic) return run();
    const emit = (event: StorageDiagnosticEvent) => {
      try {
        diagnostic(event);
      } catch {
        /* observation cannot alter storage */
      }
    };
    try {
      const value = run();
      emit({ stage, outcome: "pass", code: "verified" });
      return value;
    } catch (error) {
      const code = classifyStorageDiagnostic(error);
      emit({
        stage,
        outcome: absentAllowed && code === "not_found" ? "pass" : "blocked",
        code,
      });
      throw error;
    }
  }

  private protected<T>(run: () => T, reconcile = true): T {
    try {
      this.ensureDirectory();
      if (reconcile) this.reconcileTemporaries();
      return run();
    } catch (error) {
      throw new SigninFault(errorCode(error, "storage_failed"));
    }
  }
  private uuid(): string {
    return this.observe("random_uuid", () => {
      const value = this.deps.randomUUID();
      if (!validUuid(value)) throw new SigninFault("storage_failed");
      return value;
    });
  }
  private ensureDirectory(): Fs.Stats {
    const { fs, uid } = this.deps;
    if (!this.storageDirectory) throw new SigninFault("storage_unavailable");
    const storageDirectory = this.storageDirectory;
    const base = this.observe("root_lstat", () =>
      fs.lstatSync(storageDirectory)
    );
    this.observe("root_metadata", () => {
      if (
        !base.isDirectory() ||
        base.isSymbolicLink() ||
        base.uid !== uid ||
        (base.mode & 0o022) !== 0
      )
        throw new SigninFault("storage_unsafe");
    });
    let owned: Fs.Stats;
    try {
      owned = this.observe(
        "directory_lstat",
        () => fs.lstatSync(this.directory),
        true
      );
    } catch (error) {
      if (!missing(error)) throw error;
      try {
        this.observe("directory_create", () =>
          fs.mkdirSync(this.directory, { mode: 0o700 })
        );
      } catch (createError) {
        // A concurrent creation is accepted only after the exact ownership check.
        if (
          !(
            typeof createError === "object" &&
            createError !== null &&
            "code" in createError &&
            createError.code === "EEXIST"
          )
        )
          throw createError;
      }
      owned = this.observe("directory_lstat", () =>
        fs.lstatSync(this.directory)
      );
    }
    this.observe("directory_metadata", () => {
      if (
        !owned.isDirectory() ||
        owned.isSymbolicLink() ||
        owned.uid !== uid ||
        (owned.mode & 0o7777) !== 0o700
      )
        throw new SigninFault("storage_unsafe");
    });
    return owned;
  }
  private connectionFilename(id: string): string {
    if (!validUuid(id)) throw new SigninFault("storage_invalid");
    return `connection-${id}.json`;
  }
  private loadMap(): ConnectionMap {
    const raw = this.read(MAP_FILE);
    if (raw === undefined)
      return { version: 1, selected: null, registrations: [] };
    const map = record(raw);
    if (
      !map ||
      map.version !== 1 ||
      !(map.selected === null || validUuid(map.selected)) ||
      !Array.isArray(map.registrations) ||
      map.registrations.length > MAX_CONNECTIONS
    )
      throw new SigninFault("storage_invalid");
    const registrations = map.registrations.map(registration);
    if (
      new Set(registrations.map((row) => row.localId)).size !==
        registrations.length ||
      new Set(registrations.map((row) => row.clientId)).size !==
        registrations.length ||
      (map.selected !== null &&
        !registrations.some((row) => row.localId === map.selected))
    )
      throw new SigninFault("storage_invalid");
    return { version: 1, selected: map.selected, registrations };
  }
  private filePath(name: string): string {
    return this.deps.path.join(this.directory, name);
  }
  private checkFile(stat: Fs.Stats): void {
    this.observe("file_metadata", () => {
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.uid !== this.deps.uid ||
        (stat.mode & 0o7777) !== 0o600 ||
        stat.size < 1 ||
        stat.size > MAX_FILE_BYTES
      )
        throw new SigninFault("storage_unsafe");
    });
  }
  private stat(name: string): Fs.Stats | undefined {
    this.ensureDirectory();
    try {
      const info = this.observe(
        "file_lstat",
        () => this.deps.fs.lstatSync(this.filePath(name)),
        true
      );
      this.checkFile(info);
      return info;
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }
  private sameFile(a: Fs.Stats | undefined, b: Fs.Stats | undefined): boolean {
    return a === undefined || b === undefined
      ? a === b
      : a.dev === b.dev && a.ino === b.ino;
  }

  /** Only enumerate the private fixture directory, never traverse children or
   * read a temporary file. Exact generated names and private regular-file
   * identity are required; unrelated names are left untouched. */
  private reconcileTemporaries(): void {
    const { fs } = this.deps;
    const directory = this.ensureDirectory();
    const names = this.observe("directory_list", () =>
      fs.readdirSync(this.directory)
    );
    this.observe("directory_identity", () => {
      if (
        names.length > MAX_DIRECTORY_ENTRIES ||
        !this.sameFile(directory, this.ensureDirectory())
      )
        throw new SigninFault("storage_unsafe");
    });
    let failure: SigninFault | undefined;
    for (const name of names) {
      if (!TEMPORARY_NAME.test(name)) continue;
      try {
        this.removeOwnedTemporary(name, directory);
      } catch (error) {
        // Continue independent owned cleanup. Never expose the path or contents.
        failure = new SigninFault(
          errorCode(error) === "storage_unsafe"
            ? "storage_unsafe"
            : "storage_failed"
        );
      }
    }
    if (failure) throw failure;
    // A successful unlink must not be mistaken for absence: confirm the bounded
    // directory has no remaining matching obligations before reporting success.
    const remaining = this.observe("directory_list", () =>
      fs.readdirSync(this.directory)
    );
    this.observe("directory_identity", () => {
      if (
        remaining.length > MAX_DIRECTORY_ENTRIES ||
        !this.sameFile(directory, this.ensureDirectory())
      )
        throw new SigninFault("storage_unsafe");
    });
    this.observe("temporary_obligations", () => {
      if (remaining.some((name) => TEMPORARY_NAME.test(name)))
        throw new SigninFault("storage_failed");
    });
  }

  private tryReconcileTemporaries(): boolean {
    try {
      this.reconcileTemporaries();
      return true;
    } catch {
      return false;
    }
  }

  /** A matching file may be empty or partially written after a crash. Inspect
   * only metadata, require owner/mode/single-link/no-symlink, and verify absence
   * after unlink. Unsafe matching paths remain obligations, not delete targets. */
  private removeOwnedTemporary(
    name: string,
    expectedDirectory?: Fs.Stats,
    expectedFile?: Fs.Stats
  ): void {
    if (!TEMPORARY_NAME.test(name)) throw new SigninFault("storage_unsafe");
    const { fs } = this.deps;
    const directory = this.ensureDirectory();
    if (expectedDirectory && !this.sameFile(directory, expectedDirectory))
      throw new SigninFault("storage_unsafe");
    const target = this.filePath(name);
    let initial: Fs.Stats;
    try {
      initial = this.observe(
        "cleanup_metadata",
        () => fs.lstatSync(target),
        true
      );
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    const safe = (info: Fs.Stats): boolean =>
      info.isFile() &&
      !info.isSymbolicLink() &&
      info.uid === this.deps.uid &&
      info.nlink === 1 &&
      (info.mode & 0o7777) === 0o600;
    if (
      !safe(initial) ||
      (expectedFile && !this.sameFile(initial, expectedFile)) ||
      !this.sameFile(directory, this.ensureDirectory())
    )
      throw new SigninFault("storage_unsafe");
    let current: Fs.Stats;
    try {
      current = this.observe(
        "cleanup_metadata",
        () => fs.lstatSync(target),
        true
      );
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    if (!safe(current) || !this.sameFile(initial, current))
      throw new SigninFault("storage_unsafe");
    this.observe("cleanup_unlink", () => fs.unlinkSync(target));
    if (!this.sameFile(directory, this.ensureDirectory()))
      throw new SigninFault("storage_unsafe");
    this.observe("cleanup_absence", () => {
      try {
        fs.lstatSync(target);
      } catch (error) {
        if (missing(error)) return;
        throw error;
      }
      throw new SigninFault("storage_failed");
    });
  }

  /** Bounded no-follow open + owner/mode/identity checks on the opened descriptor. */
  private read(name: string): unknown {
    const initial = this.stat(name);
    if (!initial) return undefined;
    const { fs } = this.deps;
    const flags = this.observe("read_flags", () =>
      privateStorageOpenFlags(fs, "read")
    );
    const fd = this.observe("read_open", () =>
      fs.openSync(this.filePath(name), flags)
    );
    try {
      const opened = this.observe("read_fstat", () => fs.fstatSync(fd));
      this.checkFile(opened);
      if (!this.sameFile(initial, opened))
        throw new SigninFault("storage_unsafe");
      const bytes = new Uint8Array(MAX_FILE_BYTES + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const count = this.observe("read_bytes", () =>
          fs.readSync(fd, bytes, offset, bytes.length - offset, null)
        );
        if (count === 0) break;
        offset += count;
      }
      if (offset < 1 || offset > MAX_FILE_BYTES)
        throw new SigninFault("storage_unsafe");
      const decoder = new this.deps.TextDecoder("utf-8", { fatal: true });
      try {
        return this.observe(
          "read_decode",
          () => JSON.parse(decoder.decode(bytes.subarray(0, offset))) as unknown
        );
      } catch {
        throw new SigninFault("storage_invalid");
      }
    } finally {
      this.observe("read_close", () => fs.closeSync(fd));
    }
  }

  /** Exclusively create a 0600 temp and rename atomically in the same directory. */
  private write(name: string, value: object): void {
    const { fs } = this.deps;
    const initial = this.stat(name);
    const directory = this.ensureDirectory();
    const tempName = `.${name}.${this.uuid()}.tmp`;
    const temp = this.filePath(tempName);
    const destination = this.filePath(name);
    const data = JSON.stringify(value) + "\n";
    this.observe("write_data_validation", () => {
      if (data.length > MAX_FILE_BYTES) throw new SigninFault("storage_failed");
    });
    const flags = this.observe("write_flags", () =>
      privateStorageOpenFlags(fs, "write")
    );
    let owned = false;
    let ownedFile: Fs.Stats | undefined;
    let failure: SigninFault | undefined;
    try {
      const fd = this.observe("write_open", () =>
        fs.openSync(temp, flags, 0o600)
      );
      owned = true;
      try {
        ownedFile = this.observe("write_fstat", () => fs.fstatSync(fd));
        this.observe("write_bytes", () => fs.writeFileSync(fd, data, "utf8"));
        this.checkFile(this.observe("write_fstat", () => fs.fstatSync(fd)));
        this.observe("write_sync", () => fs.fsyncSync(fd));
      } finally {
        this.observe("write_close", () => fs.closeSync(fd));
      }
      this.observe("destination_identity", () => {
        if (
          !this.sameFile(directory, this.ensureDirectory()) ||
          !this.sameFile(initial, this.stat(name))
        )
          throw new SigninFault("storage_unsafe");
      });
      const replacement = this.observe("file_lstat", () => fs.lstatSync(temp));
      this.checkFile(replacement);
      this.observe("write_rename", () => fs.renameSync(temp, destination));
      owned = false;
      const final = this.stat(name);
      this.observe("destination_identity", () => {
        if (!this.sameFile(final, replacement))
          throw new SigninFault("storage_failed");
      });
    } catch (error) {
      failure = new SigninFault(errorCode(error, "storage_failed"));
    } finally {
      if (owned) {
        try {
          this.observe("cleanup", () =>
            this.removeOwnedTemporary(tempName, directory, ownedFile)
          );
        } catch {
          // The same secure generated filename remains a durable obligation.
          // Any later protected operation/restart/sign-out must reconcile it.
          failure = new SigninFault("storage_failed");
        }
      }
    }
    if (failure) throw failure;
  }
  private remove(name: string): void {
    if (!this.stat(name)) return;
    this.deps.fs.unlinkSync(this.filePath(name));
    if (this.stat(name)) throw new SigninFault("storage_failed");
  }
}
