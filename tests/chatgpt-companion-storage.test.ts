import * as fs from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  companionStorageRoot,
  createCompanionStorage,
  type CompanionStorageDependencies,
} from "../src/companion-feasibility/storage.js";
import { companionHome } from "./fixtures/chatgpt-companion.js";
import {
  makeConnection,
  LOCAL_ID,
  DETAIL,
  HOST_UUID,
  HOST_URI,
} from "./fixtures/chatgpt-signin.js";

const disposals: (() => void)[] = [];
function home() {
  const f = companionHome();
  disposals.push(f.dispose);
  return f;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dispose of disposals.splice(0)) dispose();
});
const fault = (code: string) => Object.assign(new Error(DETAIL), { code });
function safeFailure(value: unknown) {
  expect(JSON.stringify(value)).not.toContain(DETAIL);
}

/** Models only the known unrelated legacy sibling in a test-owned home. */
function unsafeLegacySibling(f: ReturnType<typeof home>) {
  const library = join(f.home, "Library");
  fs.mkdirSync(library, { mode: 0o700 });
  const sibling = join(library, "Application Support");
  fs.mkdirSync(sibling, { mode: 0o700 });
  const sentinel = join(sibling, "unrelated-fixture-sentinel.txt");
  fs.writeFileSync(sentinel, "synthetic unrelated sentinel", { mode: 0o600 });
  fs.chmodSync(sibling, 0o707);
  const stat = fs.lstatSync(sibling);
  expect(stat.mode & 0o777).toBe(0o707);
  return { sibling, sentinel, stat };
}
function unchangedSibling(value: ReturnType<typeof unsafeLegacySibling>) {
  expect(fs.lstatSync(value.sibling)).toMatchObject({
    ino: value.stat.ino,
    mode: value.stat.mode,
    uid: value.stat.uid,
    mtimeMs: value.stat.mtimeMs,
    ctimeMs: value.stat.ctimeMs,
  });
  expect(fs.readdirSync(value.sibling)).toEqual([
    "unrelated-fixture-sentinel.txt",
  ]);
  expect(fs.readFileSync(value.sentinel, "utf8")).toBe(
    "synthetic unrelated sentinel"
  );
}

describe("F3C strict companion storage", () => {
  it("uses the fixed owner-private Library child without any filesystem operation on unsafe Application Support", () => {
    const f = home();
    const legacy = unsafeLegacySibling(f);
    // Match the real reported owner-only home modes with only synthetic paths.
    fs.chmodSync(f.home, 0o750);
    const touched: string[] = [];
    const guardedFs = new Proxy(
      { ...fs },
      {
        get(target, key, receiver) {
          const value: unknown = Reflect.get(target, key, receiver);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            for (const arg of args) {
              if (
                typeof arg === "string" &&
                (arg === legacy.sibling || arg.startsWith(legacy.sibling + "/"))
              ) {
                touched.push(String(key));
                throw new Error("Unrelated synthetic sibling accessed");
              }
            }
            return Reflect.apply(value, target, args) as unknown;
          };
        },
      }
    );
    const deps = { ...f.deps, fs: guardedFs };
    expect(companionStorageRoot(f.home)).toBe(f.root);
    const storage = createCompanionStorage(deps);
    expect(storage.probeDurability(12345)).toMatchObject({
      code: "restart_required",
      fileSync: true,
      directorySync: true,
      atomicReplacement: true,
      readVerified: true,
    });
    const second = createCompanionStorage(deps);
    expect(second.probeDurability(23456)).toMatchObject({
      outcome: "pass",
      code: "durability_verified",
      fileSync: true,
      directorySync: true,
      deleteVerified: true,
      restartVerified: true,
    });
    expect(fs.lstatSync(f.root).mode & 0o777).toBe(0o700);
    expect(fs.lstatSync(f.directory).mode & 0o777).toBe(0o700);
    expect(fs.lstatSync(join(f.home, "Library")).mode & 0o777).toBe(0o700);
    expect(fs.lstatSync(f.home).mode & 0o777).toBe(0o750);
    expect(touched).toEqual([]);
    unchangedSibling(legacy);
  });

  it("creates only the fixed owner-private child tree and syncs real file metadata", () => {
    const f = home();
    expect(companionStorageRoot(f.home)).toBe(f.root);
    const storage = createCompanionStorage(f.deps);
    expect(fs.readdirSync(f.home)).toEqual(["Library"]);
    expect(fs.readdirSync(join(f.home, "Library"))).toEqual([
      "Ableton Agent Feasibility Companion",
    ]);
    expect(fs.statSync(f.root).mode & 0o777).toBe(0o700);
    expect(fs.statSync(f.directory).mode & 0o777).toBe(0o700);
    expect(storage.health()).toEqual({ state: "ready" });
    const id = storage.store.ensureHostId();
    storage.store.saveConnection(makeConnection());
    const restart = createCompanionStorage(f.deps);
    expect(restart.store.ensureHostId()).toBe(id);
    expect(restart.store.loadSelectedConnection()).toEqual(makeConnection());
    for (const name of fs.readdirSync(f.directory)) {
      const stat = fs.lstatSync(f.file(name));
      expect(stat.mode & 0o777).toBe(0o600);
      expect(stat.uid).toBe(f.deps.uid);
      expect(stat.nlink).toBe(1);
      expect(stat.isFile()).toBe(true);
    }
  });
  it.each(["relative", "root", "noncanonical"] as const)(
    "rejects %s home path without fallback",
    (kind) => {
      const f = home();
      const input =
        kind === "relative"
          ? "relative-test"
          : kind === "root"
            ? "/"
            : f.home + "/../synthetic-home";
      expect(() => companionStorageRoot(input)).toThrow("storage_unsafe");
      expect(fs.readdirSync(f.home)).toEqual([]);
    }
  );
  it.each([
    "root-mode",
    "child-mode",
    "library-mode",
    "home-mode",
    "owner",
  ] as const)("rejects unsafe %s without rewriting permissions", (kind) => {
    const f = home();
    createCompanionStorage(f.deps);
    const target =
      kind === "root-mode"
        ? f.root
        : kind === "child-mode"
          ? f.directory
          : kind === "library-mode"
            ? join(f.home, "Library")
            : f.home;
    if (kind !== "owner")
      fs.chmodSync(
        target,
        kind === "home-mode" ? 0o777 : kind === "library-mode" ? 0o707 : 0o755
      );
    expect(() =>
      createCompanionStorage({
        ...f.deps,
        uid: kind === "owner" ? f.deps.uid + 1 : f.deps.uid,
      })
    ).toThrow("storage_unsafe");
    if (kind !== "owner")
      expect(fs.statSync(target).mode & 0o777).toBe(
        kind === "home-mode" ? 0o777 : kind === "library-mode" ? 0o707 : 0o755
      );
  });
  it("refuses a symbolic companion root and leaves a test-owned sibling unchanged", () => {
    const f = home();
    fs.mkdirSync(join(f.home, "Library"), { mode: 0o700 });
    const other = join(f.workspace, "unrelated");
    fs.mkdirSync(other, { mode: 0o700 });
    fs.writeFileSync(join(other, "sentinel"), "unrelated");
    fs.symlinkSync(other, f.root);
    expect(() => createCompanionStorage(f.deps)).toThrow("storage_unsafe");
    expect(fs.lstatSync(f.root).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(join(other, "sentinel"), "utf8")).toBe("unrelated");
  });
  it("requires native directory fsync before any record is opened", () => {
    const f = home();
    const fileSync = vi.fn<typeof fs.fsyncSync>((fd) => {
      if (fs.fstatSync(fd).isDirectory()) throw fault("EACCES");
      fs.fsyncSync(fd);
    });
    expect(() =>
      createCompanionStorage({ ...f.deps, fs: { ...fs, fsyncSync: fileSync } })
    ).toThrow("permission_denied");
    expect(fileSync).toHaveBeenCalled();
    expect(fs.existsSync(f.directory)).toBe(false);
  });
  it.each([undefined, 0])(
    "does not silently coerce missing/zero O_DIRECTORY flags (%s)",
    (flag) => {
      const f = home();
      const deps = {
        ...f.deps,
        fs: {
          ...fs,
          constants: {
            ...fs.constants,
            O_DIRECTORY: flag,
          } as unknown as typeof fs.constants,
        },
      };
      try {
        createCompanionStorage(deps);
        throw new Error("Expected blocked storage");
      } catch (error) {
        expect(error).toMatchObject({
          issue: "directory_sync_unsupported",
          code: "storage_failed",
        });
        safeFailure(error);
      }
      expect(fs.existsSync(f.directory)).toBe(false);
    }
  );
  it("orders file sync before rename, directory sync after rename and after credential deletion", () => {
    const f = home();
    const operations: string[] = [];
    const fsyncSync = vi.fn<typeof fs.fsyncSync>((fd) => {
      operations.push(
        fs.fstatSync(fd).isDirectory() ? "directory_sync" : "file_sync"
      );
      fs.fsyncSync(fd);
    });
    const renameSync = vi.fn<typeof fs.renameSync>((from, to) => {
      operations.push("rename");
      fs.renameSync(from, to);
    });
    const unlinkSync = vi.fn<typeof fs.unlinkSync>((name) => {
      operations.push("unlink");
      fs.unlinkSync(name);
    });
    const storage = createCompanionStorage({
      ...f.deps,
      fs: { ...fs, fsyncSync, renameSync, unlinkSync },
    });
    operations.length = 0;
    storage.store.ensureHostId();
    expect(operations).toEqual(["file_sync", "rename", "directory_sync"]);
    storage.store.saveConnection(makeConnection());
    operations.length = 0;
    storage.store.clearAllCredentials();
    expect(operations).toEqual(["unlink", "directory_sync"]);
    expect(fs.existsSync(f.file("connection-" + LOCAL_ID + ".json"))).toBe(
      false
    );
  });
  it("blocks file-sync denial before rename and durably cleans the private temp", () => {
    const f = home();
    const ops: string[] = [];
    const storage = createCompanionStorage({
      ...f.deps,
      fs: {
        ...fs,
        fsyncSync: (fd) => {
          if (!fs.fstatSync(fd).isDirectory()) {
            ops.push("file_sync_denied");
            throw fault("EACCES");
          }
          ops.push("directory_sync");
          fs.fsyncSync(fd);
        },
        renameSync: (from, to) => {
          ops.push("rename");
          fs.renameSync(from, to);
        },
        unlinkSync: (file) => {
          ops.push("unlink");
          fs.unlinkSync(file);
        },
      },
    });
    ops.length = 0;
    expect(() => storage.store.ensureHostId()).toThrow("permission_denied");
    expect(ops).toEqual(["file_sync_denied", "unlink", "directory_sync"]);
    expect(storage.health()).toEqual({ state: "ready" });
    expect(fs.readdirSync(f.directory)).toEqual([]);
  });
  it("tracks post-rename directory-sync uncertainty, preserves committed counter, and reconciles on restart without decrement", () => {
    const f = home();
    let deny = false,
      afterReserve = false;
    const deps: CompanionStorageDependencies = {
      ...f.deps,
      fs: {
        ...fs,
        renameSync: (from, to) => {
          fs.renameSync(from, to);
          if (deny && String(to) === f.file("run-budget.json"))
            afterReserve = true;
        },
        fsyncSync: (fd) => {
          if (afterReserve && fs.fstatSync(fd).isDirectory())
            throw fault("EACCES");
          fs.fsyncSync(fd);
        },
      },
    };
    const storage = createCompanionStorage(deps);
    const initial = storage.store.getBudget();
    deny = true;
    expect(() => storage.store.reserveInferenceAttempt()).toThrow(
      "storage_failed"
    );
    expect(storage.health()).toEqual({
      state: "uncertain_commit",
      issue: "permission_denied",
    });
    expect(() => storage.assertReady()).toThrow("storage_failed");
    expect(() => storage.store.reserveInferenceAttempt()).toThrow(
      "storage_failed"
    );
    expect(
      JSON.parse(fs.readFileSync(f.file("run-budget.json"), "utf8")) as unknown
    ).toEqual({ ...initial, attempts: 1 });
    const restart = createCompanionStorage(f.deps);
    expect(restart.health()).toEqual({ state: "ready" });
    expect(restart.store.getBudget()).toEqual({ ...initial, attempts: 1 });
    expect(restart.store.reserveInferenceAttempt()).toEqual({
      ...initial,
      attempts: 2,
    });
  });
  it("does not claim durably completed credential deletion after directory-sync uncertainty", () => {
    const f = home();
    let deny = false,
      unlinked = false;
    const storage = createCompanionStorage({
      ...f.deps,
      fs: {
        ...fs,
        unlinkSync: (file) => {
          fs.unlinkSync(file);
          if (
            deny &&
            String(file) === f.file("connection-" + LOCAL_ID + ".json")
          )
            unlinked = true;
        },
        fsyncSync: (fd) => {
          if (unlinked && fs.fstatSync(fd).isDirectory()) throw fault("EACCES");
          fs.fsyncSync(fd);
        },
      },
    });
    const id = storage.store.ensureHostId();
    storage.store.saveConnection(makeConnection());
    const budget = storage.store.getBudget();
    deny = true;
    expect(() => storage.store.clearAllCredentials()).toThrow("storage_failed");
    expect(storage.health()).toEqual({
      state: "uncertain_commit",
      issue: "permission_denied",
    });
    const restart = createCompanionStorage(f.deps);
    expect(restart.store.loadSelectedConnection()).toBeUndefined();
    expect(restart.store.ensureHostId()).toBe(id);
    expect(restart.store.getBudget()).toEqual(budget);
  });
  it("retains failed owned temp cleanup obligations across restart and safely reconciles them", () => {
    const f = home();
    const clean = createCompanionStorage(f.deps);
    clean.store.saveConnection(makeConnection());
    let temp: string | undefined;
    const failingDeps: CompanionStorageDependencies = {
      ...f.deps,
      fs: {
        ...fs,
        renameSync: (from, to) => {
          if (String(to) === f.file("connection-" + LOCAL_ID + ".json")) {
            temp = String(from);
            throw fault("EACCES");
          }
          fs.renameSync(from, to);
        },
        unlinkSync: (file) => {
          if (String(file) === temp) throw fault("EACCES");
          fs.unlinkSync(file);
        },
      },
    };
    const failing = createCompanionStorage(failingDeps);
    expect(() =>
      failing.store.saveConnection(
        makeConnection({ accessToken: "synthetic-replacement-access" })
      )
    ).toThrow("storage_failed");
    if (!temp) throw new Error("Expected fixture-owned temp");
    expect(fs.existsSync(temp)).toBe(true);
    const unrelated = f.file("unrelated-fixture.tmp");
    fs.writeFileSync(unrelated, "test unrelated", { mode: 0o600 });
    const restartBlocked = createCompanionStorage(failingDeps);
    expect(() => restartBlocked.store.loadSelectedConnection()).toThrow(
      "storage_failed"
    );
    expect(() => restartBlocked.store.clearAllCredentials()).toThrow(
      "storage_failed"
    );
    expect(fs.existsSync(temp)).toBe(true);
    const recovered = createCompanionStorage(f.deps);
    recovered.store.clearAllCredentials();
    expect(fs.existsSync(temp)).toBe(false);
    expect(recovered.store.loadSelectedConnection()).toBeUndefined();
    expect(fs.readFileSync(unrelated, "utf8")).toBe("test unrelated");
  });
});

describe("F3C real separate synthetic process persistence", () => {
  it("proves durability across distinct child processes, same-PID repeat is not restart, and three reservations survive process boundaries", async () => {
    const f = home();
    const legacy = unsafeLegacySibling(f);
    const compiled = await build({
      entryPoints: ["src/companion-feasibility/storage.ts"],
      bundle: true,
      platform: "node",
      format: "cjs",
      write: false,
      logLevel: "silent",
    });
    const bundle = compiled.outputFiles[0]?.text;
    if (!bundle) throw Error("Missing synthetic process bundle");
    const script = join(f.workspace, "storage-check.cjs");
    // No real home, environment credentials or network. Child only receives a
    // test-owned home path and a fixed action, emits sanitized evidence/counts.
    fs.writeFileSync(
      script,
      bundle +
        `
      ;(() => {
        const nativeFs = require("node:fs"), nativePath = require("node:path"), nativeCrypto = require("node:crypto");
        const store = module.exports.createCompanionStorage({fs:nativeFs,path:nativePath,homeDirectory:process.argv[2],uid:process.getuid(),randomUUID:nativeCrypto.randomUUID,TextDecoder});
        if (process.argv[3] === "probe") console.log(JSON.stringify({pid:process.pid,first:store.probeDurability(process.pid),second:store.probeDurability(process.pid)}));
        else if (process.argv[3] === "reserve") {
          try { console.log(JSON.stringify({attempts:store.store.reserveInferenceAttempt().attempts})); }
          catch (error) { console.log(JSON.stringify({code:error.code})); }
        }
      })();
    `,
      { mode: 0o600 }
    );
    function run(action: "probe" | "reserve"): Record<string, unknown> {
      const result = spawnSync(process.execPath, [script, f.home, action], {
        env: {},
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 64 * 1024,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain(f.home);
      return JSON.parse(result.stdout) as Record<string, unknown>;
    }
    const first = run("probe");
    expect(first.first).toMatchObject({
      outcome: "blocked",
      code: "restart_required",
      fileSync: true,
      directorySync: true,
      atomicReplacement: true,
      readVerified: true,
      restartVerified: false,
    });
    expect(first.second).toMatchObject({
      outcome: "blocked",
      code: "restart_required",
    });
    const second = run("probe");
    expect(second.pid).not.toBe(first.pid);
    expect(second.first).toMatchObject({
      outcome: "pass",
      code: "durability_verified",
      fileSync: true,
      directorySync: true,
      deleteVerified: true,
      restartVerified: true,
    });
    expect(second.second).toMatchObject({
      outcome: "pass",
      restartVerified: true,
    });
    expect(fs.existsSync(f.file("companion-preflight.json"))).toBe(false);
    expect(run("reserve")).toEqual({ attempts: 1 });
    expect(run("reserve")).toEqual({ attempts: 2 });
    expect(run("reserve")).toEqual({ attempts: 3 });
    expect(run("reserve")).toEqual({ code: "budget_exhausted" });
    expect(createCompanionStorage(f.deps).store.getBudget().attempts).toBe(3);
    unchangedSibling(legacy);
  }, 20000);
});

describe("F3C durable host URI conversion", () => {
  it("durably migrates same synthetic UUID to its URI without resetting request budget or registration", () => {
    const f = home();
    const initial = createCompanionStorage(f.deps);
    initial.store.ensureHostId();
    initial.store.saveConnection(makeConnection());
    const budget = initial.store.reserveInferenceAttempt();
    fs.writeFileSync(
      f.file("host.json"),
      JSON.stringify({ version: 1, hostId: HOST_UUID }) + "\n"
    );
    const ops: string[] = [];
    const storage = createCompanionStorage({
      ...f.deps,
      fs: {
        ...fs,
        fsyncSync: (fd) => {
          ops.push(
            fs.fstatSync(fd).isDirectory() ? "directory_sync" : "file_sync"
          );
          fs.fsyncSync(fd);
        },
        renameSync: (from, to) => {
          expect(String(to)).toBe(f.file("host.json"));
          ops.push("rename");
          fs.renameSync(from, to);
        },
      },
    });
    ops.length = 0;
    expect(storage.store.ensureHostId()).toBe(HOST_URI);
    expect(ops).toEqual(["file_sync", "rename", "directory_sync"]);
    expect(storage.store.loadSelectedConnection()).toEqual(makeConnection());
    expect(storage.store.getBudget()).toEqual(budget);
    const restarted = createCompanionStorage(f.deps);
    expect(restarted.store.ensureHostId()).toBe(HOST_URI);
    expect(restarted.store.getBudget()).toEqual(budget);
  });
  it("keeps the same underlying host and counter after uncertain post-conversion directory sync, reconciling on restart", () => {
    const f = home();
    const initial = createCompanionStorage(f.deps);
    initial.store.ensureHostId();
    const budget = initial.store.reserveInferenceAttempt();
    fs.writeFileSync(
      f.file("host.json"),
      JSON.stringify({ version: 1, hostId: HOST_UUID }) + "\n"
    );
    let renamed = false;
    const failing = createCompanionStorage({
      ...f.deps,
      fs: {
        ...fs,
        renameSync: (from, to) => {
          fs.renameSync(from, to);
          if (String(to) === f.file("host.json")) renamed = true;
        },
        fsyncSync: (fd) => {
          if (renamed && fs.fstatSync(fd).isDirectory()) throw fault("EACCES");
          fs.fsyncSync(fd);
        },
      },
    });
    expect(() => failing.store.ensureHostId()).toThrow("storage_failed");
    expect(failing.health()).toEqual({
      state: "uncertain_commit",
      issue: "permission_denied",
    });
    expect(() => failing.store.reserveInferenceAttempt()).toThrow(
      "storage_failed"
    );
    expect(
      JSON.parse(fs.readFileSync(f.file("host.json"), "utf8")) as unknown
    ).toMatchObject({ hostId: HOST_URI });
    const restart = createCompanionStorage(f.deps);
    expect(restart.store.ensureHostId()).toBe(HOST_URI);
    expect(restart.store.getBudget()).toEqual(budget);
  });
});
