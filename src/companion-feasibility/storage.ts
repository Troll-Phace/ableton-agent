import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";

import {
  CredentialStore,
  SIGNIN_STORAGE_DIRECTORY,
  privateStorageOpenFlags,
} from "../extension/feasibility/credential-store.js";
import {
  SigninFault,
  errorCode,
  record,
  validUuid,
  type RequestBudget,
} from "../extension/feasibility/signin-contracts.js";
import {
  DiagnosticBudget,
  DIAGNOSTIC_AUTHORIZATION_FILE,
  DIAGNOSTIC_BUDGET_FILE,
  type DiagnosticRecordName,
  type DiagnosticRecordStore,
} from "./diagnostic-budget.js";
import {
  SDK_AUTHORIZATION_FILE,
  SDK_BUDGET_FILE,
  SdkBudget,
  type SdkRecordName,
  type SdkRecordStore,
} from "./sdk-budget.js";
import {
  SDK_TOOL_AUTHORIZATION_FILE,
  SDK_TOOL_BUDGET_FILE,
  type SdkToolRecordName,
  type SdkToolRecordStore,
} from "./sdk-tool-budget.js";

export const COMPANION_ROOT_NAME = "Ableton Agent Feasibility Companion";
const MAX_BYTES = 131072;
const MAX_ENTRIES = 128;
const MARKER = "companion-preflight.json";
const PROOF = "companion-preflight-proof.json";
const ORIGINAL_BUDGET = "run-budget.json";
const UUID =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const RECORD_PATTERN = new RegExp(
  `^(?:host\\.json|connections\\.json|run-budget\\.json|connection-${UUID}\\.json|companion-preflight(?:-proof)?\\.json|response-diagnostic-(?:budget|authorization)\\.json|sdk-diagnostic-(?:budget|authorization)\\.json|sdk-tool-roundtrip-(?:budget|authorization)\\.json)$`
);
const TEMP_PATTERN = new RegExp(
  `^\\.(?:host\\.json|connections\\.json|run-budget\\.json|connection-${UUID}\\.json|companion-preflight(?:-proof)?\\.json|response-diagnostic-(?:budget|authorization)\\.json|sdk-diagnostic-(?:budget|authorization)\\.json|sdk-tool-roundtrip-(?:budget|authorization)\\.json)\\.${UUID}\\.tmp$`
);
const SYNTHETIC_TEMP = new RegExp(
  `^\\.companion-preflight(?:-proof)?\\.json\\.${UUID}\\.tmp$`
);
const ORIGINAL_TEMP = new RegExp(`^\\.run-budget\\.json\\.${UUID}\\.tmp$`);
const DIAGNOSTIC_TEMP =
  /^\.response-diagnostic-(?:budget|authorization)\.json\./;
const SDK_TEMP = /^\.sdk-diagnostic-(?:budget|authorization)\.json\./;
const SDK_TOOL_TEMP = /^\.sdk-tool-roundtrip-(?:budget|authorization)\.json\./;
type SmallRecordName =
  | typeof MARKER
  | typeof PROOF
  | typeof ORIGINAL_BUDGET
  | DiagnosticRecordName
  | SdkRecordName
  | SdkToolRecordName;

export type CompanionStorageIssue =
  | "storage_unsafe"
  | "storage_unavailable"
  | "storage_failed"
  | "permission_denied"
  | "directory_sync_unsupported"
  | "directory_sync_failed"
  | "uncertain_commit";
export class CompanionStorageFault extends SigninFault {
  constructor(readonly issue: CompanionStorageIssue) {
    super(
      issue === "storage_unsafe" ||
        issue === "storage_unavailable" ||
        issue === "permission_denied"
        ? issue
        : "storage_failed"
    );
  }
}
export interface CompanionStorageHealth {
  state: "ready" | "uncertain_commit";
  issue?: CompanionStorageIssue;
}
export interface CompanionStorageDependencies {
  fs: typeof fs;
  path: typeof path;
  homeDirectory: string;
  uid: number;
  randomUUID(): string;
  TextDecoder: typeof globalThis.TextDecoder;
}
/** Resolve ordinary process capabilities only; no filesystem access. */
export function nativeCompanionStorageDependencies(): CompanionStorageDependencies {
  if (typeof process.getuid !== "function")
    throw new CompanionStorageFault("storage_unavailable");
  return {
    fs,
    path,
    homeDirectory: homedir(),
    uid: process.getuid(),
    randomUUID,
    TextDecoder,
  };
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
function errno(error: unknown): unknown {
  try {
    return typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
  } catch {
    return undefined;
  }
}
function issue(error: unknown): CompanionStorageIssue {
  if (error instanceof CompanionStorageFault) return error.issue;
  const code = errorCode(error, "storage_failed");
  return code === "storage_unsafe" ||
    code === "storage_unavailable" ||
    code === "permission_denied"
    ? code
    : "storage_failed";
}
function same(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
function ownedDirectory(
  info: fs.Stats,
  uid: number,
  privateMode: boolean
): boolean {
  return (
    info.isDirectory() &&
    !info.isSymbolicLink() &&
    info.uid === uid &&
    (privateMode ? (info.mode & 0o7777) === 0o700 : (info.mode & 0o022) === 0)
  );
}
function ownedFile(info: fs.Stats, uid: number): boolean {
  return (
    info.isFile() &&
    !info.isSymbolicLink() &&
    info.uid === uid &&
    info.nlink === 1 &&
    (info.mode & 0o7777) === 0o600
  );
}
function optionalStat(native: typeof fs, file: string): fs.Stats | undefined {
  try {
    return native.lstatSync(file);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}
interface DirectoryIdentity {
  name: string;
  stat: fs.Stats;
  privateMode: boolean;
}
function verifyDirectory(
  deps: CompanionStorageDependencies,
  entry: DirectoryIdentity
): fs.Stats {
  const info = deps.fs.lstatSync(entry.name);
  if (
    !ownedDirectory(info, deps.uid, entry.privateMode) ||
    !same(info, entry.stat)
  )
    throw new CompanionStorageFault("storage_unsafe");
  return info;
}
function directoryFlags(native: typeof fs): number {
  const flags = native.constants;
  if (
    !flags ||
    !Number.isSafeInteger(flags.O_RDONLY) ||
    flags.O_RDONLY < 0 ||
    !Number.isSafeInteger(flags.O_DIRECTORY) ||
    flags.O_DIRECTORY <= 0 ||
    !Number.isSafeInteger(flags.O_NOFOLLOW) ||
    flags.O_NOFOLLOW <= 0
  )
    throw new CompanionStorageFault("directory_sync_unsupported");
  return flags.O_RDONLY | flags.O_DIRECTORY | flags.O_NOFOLLOW;
}
/** Mandatory directory fsync; no supported fallback or skipped sync. */
function syncDirectory(
  deps: CompanionStorageDependencies,
  entry: DirectoryIdentity
): void {
  try {
    verifyDirectory(deps, entry);
    const fd = deps.fs.openSync(entry.name, directoryFlags(deps.fs));
    try {
      const opened = deps.fs.fstatSync(fd);
      if (
        !same(opened, entry.stat) ||
        !ownedDirectory(opened, deps.uid, entry.privateMode)
      )
        throw new CompanionStorageFault("storage_unsafe");
      deps.fs.fsyncSync(fd);
    } finally {
      deps.fs.closeSync(fd);
    }
    verifyDirectory(deps, entry);
  } catch (error) {
    if (error instanceof CompanionStorageFault) throw error;
    const code = errno(error);
    if (
      ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EISDIR"].includes(
        typeof code === "string" ? code : ""
      )
    )
      throw new CompanionStorageFault("directory_sync_unsupported");
    if (errorCode(error) === "permission_denied")
      throw new CompanionStorageFault("permission_denied");
    throw new CompanionStorageFault("directory_sync_failed");
  }
}

/** Fixed path directly under the owner-private Library. No alternate path,
 * Application Support lookup, migration, or Live storage access. */
export function companionStorageRoot(
  homeDirectory: string,
  paths: typeof path = path
): string {
  if (
    !paths.isAbsolute(homeDirectory) ||
    paths.resolve(homeDirectory) !== homeDirectory ||
    homeDirectory === paths.parse(homeDirectory).root
  )
    throw new CompanionStorageFault("storage_unsafe");
  return paths.join(homeDirectory, "Library", COMPANION_ROOT_NAME);
}
function prepareDirectories(
  deps: CompanionStorageDependencies
): DirectoryIdentity[] {
  if (!Number.isSafeInteger(deps.uid) || deps.uid < 0)
    throw new CompanionStorageFault("storage_unavailable");
  const root = companionStorageRoot(deps.homeDirectory, deps.path);
  const names = [
    deps.homeDirectory,
    deps.path.join(deps.homeDirectory, "Library"),
    root,
    deps.path.join(root, SIGNIN_STORAGE_DIRECTORY),
  ];
  const entries: DirectoryIdentity[] = [];
  try {
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const privateMode = i >= 2;
      let stat = optionalStat(deps.fs, name);
      const parent = entries.at(-1);
      if (!stat) {
        if (!parent) throw new CompanionStorageFault("storage_unavailable");
        verifyDirectory(deps, parent);
        deps.fs.mkdirSync(name, { mode: 0o700 });
        stat = deps.fs.lstatSync(name);
        if (!ownedDirectory(stat, deps.uid, privateMode))
          throw new CompanionStorageFault("storage_unsafe");
        // Preserve uncertain mkdir after a sync failure; never roll back/delete.
        syncDirectory(deps, parent);
      }
      if (!ownedDirectory(stat, deps.uid, privateMode))
        throw new CompanionStorageFault("storage_unsafe");
      entries.push({ name, stat, privateMode });
    }
    // Every restart reconciles the actual directory entries before opening a
    // record. An ambiguous earlier rename/unlink never becomes an assumed rollback.
    for (const entry of [...entries].reverse()) syncDirectory(deps, entry);
    return entries;
  } catch (error) {
    throw new CompanionStorageFault(issue(error));
  }
}

interface Descriptor {
  file: string;
  mode: "read" | "write";
  initial?: fs.Stats;
  size?: number;
  synced?: fs.Stats;
}
interface Prepared {
  stat: fs.Stats;
  size: number;
}
export interface CompanionStorageProbe {
  outcome: "pass" | "blocked";
  code:
    | "restart_required"
    | "durability_verified"
    | CompanionStorageIssue
    | "storage_invalid";
  fileSync: boolean;
  directorySync: boolean;
  atomicReplacement: boolean;
  readVerified: boolean;
  deleteVerified: boolean;
  restartVerified: boolean;
}

/** Strict adapter for the reviewed store. Paths may only be fixed records or
 * exact generated temps inside its private child. No arbitrary fs passthrough. */
export class CompanionStorage {
  readonly store: CredentialStore;
  private readonly entries: DirectoryIdentity[];
  private readonly root: DirectoryIdentity;
  private readonly child: DirectoryIdentity;
  private readonly descriptors = new Map<number, Descriptor>();
  private readonly prepared = new Map<string, Prepared>();
  private uncertain?: CompanionStorageIssue;
  private readonly adapter: typeof fs;

  constructor(
    private readonly deps: CompanionStorageDependencies,
    private readonly freezeOriginalBudget = false,
    private readonly freezeDiagnosticBudget = false,
    private readonly freezeSdkBudget = false
  ) {
    this.entries = prepareDirectories(deps);
    const root = this.entries[2];
    const child = this.entries[3];
    this.root = root;
    this.child = child;
    const native = deps.fs;
    // Structural SDK-free adapter intentionally exposes only the used methods.
    this.adapter = {
      constants: native.constants,
      lstatSync: (name: string) => {
        this.assertReady();
        this.verifyTree();
        if (name !== this.root.name && name !== this.child.name)
          this.file(name);
        return native.lstatSync(name);
      },
      readdirSync: (name: string) => {
        this.assertReady();
        this.verifyTree();
        if (name !== this.child.name)
          throw new CompanionStorageFault("storage_unsafe");
        const names = native.readdirSync(name);
        if (names.length > MAX_ENTRIES)
          throw new CompanionStorageFault("storage_unsafe");
        return names;
      },
      mkdirSync: () => {
        throw new CompanionStorageFault("storage_unsafe");
      },
      openSync: (name: string, flags: number, mode?: number) =>
        this.open(name, flags, mode),
      fstatSync: (fd: number) => this.descriptorStat(fd),
      readSync: (
        fd: number,
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number | null
      ) => {
        this.assertReady();
        const descriptor = this.descriptors.get(fd);
        if (
          descriptor?.mode !== "read" ||
          position !== null ||
          !ArrayBuffer.isView(buffer) ||
          offset < 0 ||
          length < 0 ||
          offset + length > buffer.byteLength ||
          buffer.byteLength > MAX_BYTES + 1
        )
          throw new CompanionStorageFault("storage_unsafe");
        this.descriptorStat(fd);
        return native.readSync(fd, buffer, offset, length, position);
      },
      writeFileSync: (fd: number, data: string, encoding?: string) =>
        this.write(fd, data, encoding),
      fsyncSync: (fd: number) => this.syncFile(fd),
      closeSync: (fd: number) => this.close(fd),
      renameSync: (from: string, to: string) => this.rename(from, to),
      unlinkSync: (name: string) => this.unlink(name),
    } as unknown as typeof fs;
    this.store = new CredentialStore(this.root.name, {
      fs: this.adapter,
      path: deps.path,
      uid: deps.uid,
      randomUUID: () => deps.randomUUID(),
      TextDecoder: deps.TextDecoder,
    });
  }

  health(): CompanionStorageHealth {
    return this.uncertain
      ? { state: "uncertain_commit", issue: this.uncertain }
      : { state: "ready" };
  }
  assertReady(): void {
    if (this.uncertain) throw new CompanionStorageFault("uncertain_commit");
  }
  private verifyTree(): void {
    for (const entry of this.entries) verifyDirectory(this.deps, entry);
  }
  private file(name: string): string {
    if (
      typeof name !== "string" ||
      this.deps.path.resolve(name) !== name ||
      this.deps.path.dirname(name) !== this.child.name
    )
      throw new CompanionStorageFault("storage_unsafe");
    const base = this.deps.path.basename(name);
    if (!RECORD_PATTERN.test(base) && !TEMP_PATTERN.test(base))
      throw new CompanionStorageFault("storage_unsafe");
    return base;
  }
  private safeStat(name: string): fs.Stats {
    const value = this.deps.fs.lstatSync(name);
    if (!ownedFile(value, this.deps.uid))
      throw new CompanionStorageFault("storage_unsafe");
    return value;
  }
  private postMutation(run: () => void): void {
    try {
      run();
    } catch (error) {
      this.uncertain = issue(error);
      throw new CompanionStorageFault("uncertain_commit");
    }
  }
  private open(name: string, flags: number, mode?: number): number {
    this.assertReady();
    this.verifyTree();
    const base = this.file(name);
    const native = this.deps.fs;
    const readFlags = privateStorageOpenFlags(native, "read");
    const writeFlags = privateStorageOpenFlags(native, "write");
    let descriptor: Descriptor;
    if (
      flags === readFlags &&
      mode === undefined &&
      RECORD_PATTERN.test(base)
    ) {
      const initial = this.safeStat(name);
      if (initial.size < 1 || initial.size > MAX_BYTES)
        throw new CompanionStorageFault("storage_unsafe");
      descriptor = { file: name, mode: "read", initial };
    } else if (
      flags === writeFlags &&
      mode === 0o600 &&
      TEMP_PATTERN.test(base)
    ) {
      if (this.freezeOriginalBudget && ORIGINAL_TEMP.test(base))
        throw new CompanionStorageFault("storage_unsafe");
      if (this.freezeDiagnosticBudget && DIAGNOSTIC_TEMP.test(base))
        throw new CompanionStorageFault("storage_unsafe");
      if (this.freezeSdkBudget && SDK_TEMP.test(base))
        throw new CompanionStorageFault("storage_unsafe");
      if (optionalStat(native, name))
        throw new CompanionStorageFault("storage_unsafe");
      descriptor = { file: name, mode: "write" };
    } else throw new CompanionStorageFault("storage_unsafe");
    const fd = native.openSync(name, flags, mode);
    this.descriptors.set(fd, descriptor);
    return fd;
  }
  private descriptorStat(fd: number): fs.Stats {
    this.assertReady();
    this.verifyTree();
    const descriptor = this.descriptors.get(fd);
    if (!descriptor) throw new CompanionStorageFault("storage_unsafe");
    const stat = this.deps.fs.fstatSync(fd);
    if (
      !ownedFile(stat, this.deps.uid) ||
      !same(stat, this.safeStat(descriptor.file)) ||
      (descriptor.initial && !same(stat, descriptor.initial))
    )
      throw new CompanionStorageFault("storage_unsafe");
    descriptor.initial ??= stat;
    return stat;
  }
  private write(fd: number, data: string, encoding?: string): void {
    this.assertReady();
    const descriptor = this.descriptors.get(fd);
    if (
      descriptor?.mode !== "write" ||
      typeof data !== "string" ||
      (encoding !== undefined && encoding !== "utf8") ||
      descriptor.size !== undefined
    )
      throw new CompanionStorageFault("storage_unsafe");
    const size = Buffer.byteLength(data, "utf8");
    if (size < 1 || size > MAX_BYTES || this.descriptorStat(fd).size !== 0)
      throw new CompanionStorageFault("storage_unsafe");
    this.deps.fs.writeFileSync(fd, data, "utf8");
    if (this.descriptorStat(fd).size !== size)
      throw new CompanionStorageFault("storage_failed");
    descriptor.size = size;
  }
  private syncFile(fd: number): void {
    this.assertReady();
    const descriptor = this.descriptors.get(fd);
    if (descriptor?.mode !== "write" || descriptor.size === undefined)
      throw new CompanionStorageFault("storage_unsafe");
    const before = this.descriptorStat(fd);
    if (before.size !== descriptor.size)
      throw new CompanionStorageFault("storage_failed");
    this.deps.fs.fsyncSync(fd);
    const after = this.descriptorStat(fd);
    if (!same(before, after) || after.size !== descriptor.size)
      throw new CompanionStorageFault("storage_failed");
    descriptor.synced = after;
  }
  private close(fd: number): void {
    const descriptor = this.descriptors.get(fd);
    if (!descriptor) throw new CompanionStorageFault("storage_unsafe");
    try {
      this.deps.fs.closeSync(fd);
      if (
        descriptor.mode === "write" &&
        descriptor.synced &&
        descriptor.size !== undefined
      )
        this.prepared.set(descriptor.file, {
          stat: descriptor.synced,
          size: descriptor.size,
        });
    } finally {
      this.descriptors.delete(fd);
    }
  }
  private rename(from: string, to: string): void {
    this.assertReady();
    this.verifyTree();
    const sourceName = this.file(from);
    const targetName = this.file(to);
    if (
      this.freezeSdkBudget &&
      (targetName === SDK_AUTHORIZATION_FILE || targetName === SDK_BUDGET_FILE)
    )
      throw new CompanionStorageFault("storage_unsafe");
    if (
      this.freezeDiagnosticBudget &&
      (targetName === DIAGNOSTIC_AUTHORIZATION_FILE ||
        targetName === DIAGNOSTIC_BUDGET_FILE)
    )
      throw new CompanionStorageFault("storage_unsafe");
    if (this.freezeOriginalBudget && targetName === ORIGINAL_BUDGET)
      throw new CompanionStorageFault("storage_unsafe");
    const native = this.deps.fs;
    const prepared = this.prepared.get(from);
    if (
      !TEMP_PATTERN.test(sourceName) ||
      !RECORD_PATTERN.test(targetName) ||
      !sourceName.startsWith(`.${targetName}.`) ||
      !prepared
    )
      throw new CompanionStorageFault("storage_unsafe");
    const source = this.safeStat(from);
    if (!same(source, prepared.stat) || source.size !== prepared.size)
      throw new CompanionStorageFault("storage_unsafe");
    const prior = optionalStat(native, to);
    if (prior && !ownedFile(prior, this.deps.uid))
      throw new CompanionStorageFault("storage_unsafe");
    try {
      native.renameSync(from, to);
    } catch (error) {
      try {
        const remaining = optionalStat(native, from);
        const dest = optionalStat(native, to);
        if (
          !remaining ||
          !same(source, remaining) ||
          (prior ? !dest || !same(prior, dest) : dest !== undefined)
        )
          this.uncertain = "uncertain_commit";
      } catch {
        this.uncertain = "uncertain_commit";
      }
      if (this.uncertain) throw new CompanionStorageFault("uncertain_commit");
      throw error;
    }
    this.prepared.delete(from);
    this.postMutation(() => {
      const verify = () => {
        this.verifyTree();
        const final = this.safeStat(to);
        if (
          !same(final, source) ||
          final.size !== prepared.size ||
          optionalStat(native, from)
        )
          throw new CompanionStorageFault("storage_failed");
      };
      verify();
      syncDirectory(this.deps, this.child);
      verify();
    });
  }
  private unlink(name: string): void {
    this.assertReady();
    this.verifyTree();
    const base = this.file(name);
    if (
      this.freezeSdkBudget &&
      (base === SDK_AUTHORIZATION_FILE ||
        base === SDK_BUDGET_FILE ||
        SDK_TEMP.test(base))
    )
      throw new CompanionStorageFault("storage_unsafe");
    if (
      this.freezeDiagnosticBudget &&
      (base === DIAGNOSTIC_AUTHORIZATION_FILE ||
        base === DIAGNOSTIC_BUDGET_FILE ||
        DIAGNOSTIC_TEMP.test(base))
    )
      throw new CompanionStorageFault("storage_unsafe");
    if (
      this.freezeOriginalBudget &&
      (base === ORIGINAL_BUDGET || ORIGINAL_TEMP.test(base))
    )
      throw new CompanionStorageFault("storage_unsafe");
    const native = this.deps.fs;
    const initial = this.safeStat(name);
    try {
      native.unlinkSync(name);
    } catch (error) {
      try {
        const remaining = optionalStat(native, name);
        if (!remaining || !same(initial, remaining))
          this.uncertain = "uncertain_commit";
      } catch {
        this.uncertain = "uncertain_commit";
      }
      if (this.uncertain) throw new CompanionStorageFault("uncertain_commit");
      throw error;
    }
    this.prepared.delete(name);
    this.postMutation(() => {
      const verify = () => {
        this.verifyTree();
        if (optionalStat(native, name))
          throw new CompanionStorageFault("storage_failed");
      };
      verify();
      syncDirectory(this.deps, this.child);
      verify();
    });
  }

  private uuid(): string {
    const value = this.deps.randomUUID();
    if (!validUuid(value)) throw new CompanionStorageFault("storage_failed");
    return value;
  }
  private syntheticPath(name: SmallRecordName): string {
    return this.deps.path.join(this.child.name, name);
  }
  private syntheticRead(name: SmallRecordName): unknown {
    this.assertReady();
    this.verifyTree();
    const target = this.syntheticPath(name);
    if (!optionalStat(this.deps.fs, target)) return undefined;
    const fd = this.adapter.openSync(
      target,
      privateStorageOpenFlags(this.deps.fs, "read")
    );
    try {
      const stat = this.adapter.fstatSync(fd);
      if (stat.size > 256) throw new SigninFault("storage_invalid");
      const buffer = new Uint8Array(257);
      let offset = 0;
      while (offset < buffer.length) {
        const count = this.adapter.readSync(
          fd,
          buffer,
          offset,
          buffer.length - offset,
          null
        );
        if (!count) break;
        offset += count;
      }
      if (offset !== stat.size || offset < 1 || offset > 256)
        throw new SigninFault("storage_invalid");
      try {
        return JSON.parse(
          new this.deps.TextDecoder("utf-8", { fatal: true }).decode(
            buffer.subarray(0, offset)
          )
        ) as unknown;
      } catch {
        throw new SigninFault("storage_invalid");
      }
    } finally {
      this.adapter.closeSync(fd);
    }
  }
  private syntheticWrite(
    name: Exclude<SmallRecordName, typeof ORIGINAL_BUDGET>,
    value: object
  ): void {
    const target = this.syntheticPath(name);
    const temp = this.deps.path.join(
      this.child.name,
      `.${name}.${this.uuid()}.tmp`
    );
    let owned = false;
    try {
      const fd = this.adapter.openSync(
        temp,
        privateStorageOpenFlags(this.deps.fs, "write"),
        0o600
      );
      owned = true;
      try {
        this.adapter.writeFileSync(fd, JSON.stringify(value) + "\n", "utf8");
        this.adapter.fsyncSync(fd);
      } finally {
        this.adapter.closeSync(fd);
      }
      this.adapter.renameSync(temp, target);
      owned = false;
      if (JSON.stringify(this.syntheticRead(name)) !== JSON.stringify(value))
        throw new CompanionStorageFault("storage_failed");
    } finally {
      if (owned && !this.uncertain && optionalStat(this.deps.fs, temp))
        this.adapter.unlinkSync(temp);
    }
  }
  /** Read the existing original budget only. Missing, non-1/3 or orphaned
   * reservations fail closed, with no creation, migration or reset. */
  frozenOriginalBudget(): RequestBudget {
    if (!this.freezeOriginalBudget) throw new SigninFault("storage_invalid");
    this.assertReady();
    this.verifyTree();
    if (
      this.adapter
        .readdirSync(this.child.name)
        .some((name) => name.startsWith(".run-budget.json."))
    )
      throw new SigninFault("storage_invalid");
    const row = record(this.syntheticRead(ORIGINAL_BUDGET));
    if (
      !row ||
      Object.keys(row).length !== 3 ||
      row.version !== 1 ||
      !validUuid(row.runId) ||
      row.attempts !== 1
    )
      throw new SigninFault("storage_invalid");
    return { version: 1, runId: row.runId, attempts: 1 };
  }
  /** Narrow record seam using the same checked write/fsync/rename/dir-sync path. */
  diagnosticRecords(): DiagnosticRecordStore {
    if (!this.freezeOriginalBudget) throw new SigninFault("storage_invalid");
    const checked = (name: DiagnosticRecordName) => {
      if (
        name !== DIAGNOSTIC_AUTHORIZATION_FILE &&
        name !== DIAGNOSTIC_BUDGET_FILE
      )
        throw new SigninFault("storage_invalid");
      return name;
    };
    return {
      assertOriginalFrozen: () => {
        this.frozenOriginalBudget();
      },
      assertNoDiagnosticTemporaries: () => {
        this.assertReady();
        if (
          this.adapter
            .readdirSync(this.child.name)
            .some((name) => DIAGNOSTIC_TEMP.test(name))
        )
          throw new SigninFault("storage_invalid");
      },
      read: (name) => this.syntheticRead(checked(name)),
      write: (name, value) => {
        if (this.freezeDiagnosticBudget)
          throw new SigninFault("budget_exhausted");
        this.frozenOriginalBudget();
        this.syntheticWrite(checked(name), value);
      },
    };
  }
  /** Only the new SDK experiment can write its two fixed records. Both earlier
   * allowances are read-only and must verify exactly 1/3 and exhausted 1/1. */
  sdkDiagnosticRecords(): SdkRecordStore {
    if (!this.freezeOriginalBudget || !this.freezeDiagnosticBudget)
      throw new SigninFault("storage_invalid");
    const prior = new DiagnosticBudget(this.diagnosticRecords());
    const assertHistoricalFrozen = () => {
      this.frozenOriginalBudget();
      const status = prior.status();
      if (status.state !== "exhausted" || status.attempts !== 1)
        throw new SigninFault("storage_invalid");
    };
    const assertNoSdkTemporaries = () => {
      this.assertReady();
      if (
        this.adapter
          .readdirSync(this.child.name)
          .some((name) => SDK_TEMP.test(name))
      )
        throw new SigninFault("storage_invalid");
    };
    const checked = (name: SdkRecordName) => {
      if (name !== SDK_AUTHORIZATION_FILE && name !== SDK_BUDGET_FILE)
        throw new SigninFault("storage_invalid");
      return name;
    };
    return {
      assertHistoricalFrozen,
      assertNoSdkTemporaries,
      read: (name) => this.syntheticRead(checked(name)),
      write: (name, value) => {
        assertHistoricalFrozen();
        assertNoSdkTemporaries();
        if (this.freezeSdkBudget) throw new SigninFault("budget_exhausted");
        this.syntheticWrite(checked(name), value);
      },
    };
  }
  /** All three historical records remain read-only in the new tool experiment. */
  sdkToolDiagnosticRecords(): SdkToolRecordStore {
    if (
      !this.freezeOriginalBudget ||
      !this.freezeDiagnosticBudget ||
      !this.freezeSdkBudget
    )
      throw new SigninFault("storage_invalid");
    const priorSdk = new SdkBudget(this.sdkDiagnosticRecords());
    const assertHistoricalFrozen = () => {
      const status = priorSdk.status();
      if (status.state !== "exhausted" || status.attempts !== 1)
        throw new SigninFault("storage_invalid");
    };
    const assertNoSdkToolTemporaries = () => {
      this.assertReady();
      if (
        this.adapter
          .readdirSync(this.child.name)
          .some((name) => SDK_TOOL_TEMP.test(name))
      )
        throw new SigninFault("storage_invalid");
    };
    const checked = (name: SdkToolRecordName) => {
      if (name !== SDK_TOOL_AUTHORIZATION_FILE && name !== SDK_TOOL_BUDGET_FILE)
        throw new SigninFault("storage_invalid");
      return name;
    };
    return {
      assertHistoricalFrozen,
      assertNoSdkToolTemporaries,
      read: (name) => this.syntheticRead(checked(name)),
      write: (name, value) => {
        assertHistoricalFrozen();
        assertNoSdkToolTemporaries();
        this.syntheticWrite(checked(name), value);
      },
    };
  }
  /** Actual synthetic write/sync/replace/read/delete; first run leaves a private
   * synthetic marker, a distinct process validates it, persists proof and deletes it.
   * Later credential restart checks re-exercise durability without requiring
   * another artificial restart. No existing account record is read here. */
  probeDurability(pid: number): CompanionStorageProbe {
    const proof: CompanionStorageProbe = {
      outcome: "blocked",
      code: "storage_failed",
      fileSync: false,
      directorySync: false,
      atomicReplacement: false,
      readVerified: false,
      deleteVerified: false,
      restartVerified: false,
    };
    try {
      this.assertReady();
      this.verifyTree();
      if (!Number.isSafeInteger(pid) || pid < 1)
        throw new CompanionStorageFault("storage_unavailable");
      const names = this.adapter.readdirSync(this.child.name);
      for (const name of names)
        if (SYNTHETIC_TEMP.test(name))
          this.adapter.unlinkSync(this.deps.path.join(this.child.name, name));
      const rawProof = this.syntheticRead(PROOF);
      const priorProof = record(rawProof);
      if (
        rawProof !== undefined &&
        (!priorProof ||
          priorProof.version !== 1 ||
          priorProof.marker !== "p15_3" ||
          priorProof.restartVerified !== true ||
          Object.keys(priorProof).length !== 3)
      )
        throw new SigninFault("storage_invalid");
      const raw = this.syntheticRead(MARKER);
      const marker = record(raw);
      if (
        raw !== undefined &&
        (!marker ||
          marker.version !== 1 ||
          marker.marker !== "p15_3" ||
          typeof marker.pid !== "number" ||
          !Number.isSafeInteger(marker.pid) ||
          marker.pid < 1 ||
          (marker.stage !== "initial" && marker.stage !== "replacement") ||
          Object.keys(marker).length !== 4)
      )
        throw new SigninFault("storage_invalid");
      if (priorProof) {
        if (marker) this.adapter.unlinkSync(this.syntheticPath(MARKER));
      } else if (marker?.stage === "replacement") {
        if (marker.pid === pid)
          return {
            ...proof,
            code: "restart_required",
            fileSync: true,
            directorySync: true,
            atomicReplacement: true,
            readVerified: true,
          };
        this.syntheticWrite(PROOF, {
          version: 1,
          marker: "p15_3",
          restartVerified: true,
        });
        this.adapter.unlinkSync(this.syntheticPath(MARKER));
        return {
          outcome: "pass",
          code: "durability_verified",
          fileSync: true,
          directorySync: true,
          atomicReplacement: true,
          readVerified: true,
          deleteVerified: true,
          restartVerified: true,
        };
      }
      this.syntheticWrite(MARKER, {
        version: 1,
        marker: "p15_3",
        pid,
        stage: "initial",
      });
      this.syntheticWrite(MARKER, {
        version: 1,
        marker: "p15_3",
        pid,
        stage: "replacement",
      });
      proof.fileSync =
        proof.directorySync =
        proof.atomicReplacement =
        proof.readVerified =
          true;
      if (!priorProof) {
        proof.code = "restart_required";
        return proof;
      }
      this.adapter.unlinkSync(this.syntheticPath(MARKER));
      proof.deleteVerified = proof.restartVerified = true;
      proof.outcome = "pass";
      proof.code = "durability_verified";
      return proof;
    } catch (error) {
      proof.code = this.uncertain
        ? "uncertain_commit"
        : errorCode(error) === "storage_invalid"
          ? "storage_invalid"
          : issue(error);
      return proof;
    }
  }
}

/** Call only after the fixed-port singleton is acquired. */
export function createCompanionStorage(
  deps: CompanionStorageDependencies = nativeCompanionStorageDependencies(),
  freezeOriginalBudget = false,
  freezeDiagnosticBudget = false,
  freezeSdkBudget = false
): CompanionStorage {
  return new CompanionStorage(
    deps,
    freezeOriginalBudget,
    freezeDiagnosticBudget,
    freezeSdkBudget
  );
}
