import * as fs from "node:fs";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CredentialStore,
  privateStorageOpenFlags,
} from "../src/extension/feasibility/credential-store.js";
import { verifyPrivateStorage } from "../src/extension/feasibility/index.js";
import { OAuthLifecycle } from "../src/extension/feasibility/oauth.js";
import {
  ACCESS,
  REFRESH,
  CLIENT,
  SUBJECT,
  LOCAL_ID,
  makeConnection,
  makeStorage,
  makeOAuthFixture,
  REVOKE,
  DETAIL,
} from "./fixtures/chatgpt-signin.js";

const disposals: (() => void)[] = [];
function fixture() {
  const instance = makeStorage();
  disposals.push(instance.dispose);
  return instance;
}
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});

describe("S5 private sign-in persistence", () => {
  it("stores host ID, registration and credentials privately; reloads across store instances", () => {
    const f = fixture();
    const host = f.store.ensureHostId();
    const connection = makeConnection();
    f.store.saveConnection(connection);
    const restart = new CredentialStore(f.base, f.deps);
    expect(restart.ensureHostId()).toBe(host);
    expect(restart.loadSelectedConnection()).toEqual(connection);
    expect(restart.selectedRegistration()).toEqual({
      localId: LOCAL_ID,
      clientId: CLIENT,
      issuer: connection.issuer,
      subject: SUBJECT,
    });
    expect(fs.statSync(f.directory).mode & 0o777).toBe(0o700);
    for (const file of fs.readdirSync(f.directory)) {
      const stat = fs.lstatSync(f.file(file));
      expect(stat.mode & 0o777).toBe(0o600);
      expect(stat.uid).toBe(f.deps.uid);
      expect(stat.nlink).toBe(1);
      expect(stat.isFile()).toBe(true);
    }
    expect(fs.readFileSync(f.file("connections.json"), "utf8")).not.toContain(
      ACCESS
    );
    expect(fs.readFileSync(f.file("connections.json"), "utf8")).not.toContain(
      REFRESH
    );
  });

  it("rotates both tokens in one atomic same-directory replacement and leaves no temp artifact", () => {
    const f = fixture();
    f.store.saveConnection(makeConnection());
    const rotated = makeConnection({
      accessToken: "synthetic-rotated-access",
      refreshToken: "synthetic-rotated-refresh",
      expiresAt: 1_900_000_000_000,
    });
    const renameSync = vi.fn<typeof fs.renameSync>((from, to) => {
      expect(basename(String(to))).toBe("connection-" + LOCAL_ID + ".json");
      expect(String(from).startsWith(f.directory + "/")).toBe(true);
      expect(fs.statSync(from).mode & 0o777).toBe(0o600);
      expect(JSON.parse(fs.readFileSync(to, "utf8")) as unknown).toEqual(
        makeConnection()
      );
      expect(JSON.parse(fs.readFileSync(from, "utf8")) as unknown).toEqual(
        rotated
      );
      fs.renameSync(from, to);
    });
    const store = new CredentialStore(f.base, {
      ...f.deps,
      fs: { ...fs, renameSync },
    });
    store.saveConnection(rotated);
    expect(renameSync).toHaveBeenCalledTimes(1);
    expect(f.store.loadSelectedConnection()).toEqual(rotated);
    expect(
      fs.readdirSync(f.directory).some((file) => file.endsWith(".tmp"))
    ).toBe(false);
  });

  it("fails an injected replacement error without partial rotation or owned temp file", () => {
    const f = fixture();
    f.store.saveConnection(makeConnection());
    const renameSync = vi.fn<typeof fs.renameSync>(() => {
      throw Object.assign(new Error(DETAIL), { code: "EACCES" });
    });
    const store = new CredentialStore(f.base, {
      ...f.deps,
      fs: { ...fs, renameSync },
    });
    expect(() =>
      store.saveConnection(
        makeConnection({
          accessToken: "synthetic-new-access",
          refreshToken: "synthetic-new-refresh",
        })
      )
    ).toThrow("permission_denied");
    expect(renameSync).toHaveBeenCalledTimes(1);
    expect(f.store.loadSelectedConnection()).toEqual(makeConnection());
    expect(
      fs.readdirSync(f.directory).some((file) => file.endsWith(".tmp"))
    ).toBe(false);
  });

  it("rejects a failed first credential creation, retaining only uncredentialed registration", () => {
    const f = fixture();
    const renameSync = vi.fn<typeof fs.renameSync>((from, to) => {
      if (String(to).endsWith("connection-" + LOCAL_ID + ".json"))
        throw new Error(DETAIL);
      fs.renameSync(from, to);
    });
    const store = new CredentialStore(f.base, {
      ...f.deps,
      fs: { ...fs, renameSync },
    });
    expect(() => store.saveConnection(makeConnection())).toThrow(
      "storage_failed"
    );
    expect(f.store.selectedRegistration()?.localId).toBe(LOCAL_ID);
    expect(f.store.loadSelectedConnection()).toBeUndefined();
    expect(fs.readdirSync(f.directory)).toEqual(["connections.json"]);
  });

  it("persists the three-attempt budget over restarts and sign-out; never resets", () => {
    const f = fixture();
    const initial = f.store.getBudget();
    expect(initial.attempts).toBe(0);
    expect(f.store.reserveInferenceAttempt()).toEqual({
      ...initial,
      attempts: 1,
    });
    const restarted = new CredentialStore(f.base, f.deps);
    expect(restarted.reserveInferenceAttempt()).toEqual({
      ...initial,
      attempts: 2,
    });
    restarted.saveConnection(makeConnection());
    restarted.clearAllCredentials();
    expect(restarted.reserveInferenceAttempt()).toEqual({
      ...initial,
      attempts: 3,
    });
    expect(() =>
      new CredentialStore(f.base, f.deps).reserveInferenceAttempt()
    ).toThrow("budget_exhausted");
    expect(restarted.getBudget()).toEqual({ ...initial, attempts: 3 });
  });

  it("fails budget reservation when atomic persistence fails without advancing the stored counter", () => {
    const f = fixture();
    const initial = f.store.getBudget();
    const store = new CredentialStore(f.base, {
      ...f.deps,
      fs: {
        ...fs,
        renameSync: () => {
          throw new Error(DETAIL);
        },
      },
    });
    expect(() => store.reserveInferenceAttempt()).toThrow("storage_failed");
    expect(f.store.getBudget()).toEqual(initial);
    expect(fs.readdirSync(f.directory)).toEqual(["run-budget.json"]);
  });

  it("clears known credential files, preserving host and registration plus budget only", () => {
    const f = fixture();
    const host = f.store.ensureHostId();
    f.store.getBudget();
    f.store.saveConnection(makeConnection());
    f.store.clearCredentials(LOCAL_ID);
    expect(f.store.loadSelectedConnection()).toBeUndefined();
    expect(f.store.selectedRegistration()?.clientId).toBe(CLIENT);
    const second = makeConnection({
      localId: "22222222-2222-4222-8222-222222222222",
      clientId: "synthetic-second-client",
    });
    f.store.saveConnection(second);
    f.store.clearAllCredentials();
    expect(f.store.loadSelectedConnection()).toBeUndefined();
    expect(f.store.ensureHostId()).toBe(host);
    expect(fs.readdirSync(f.directory).sort()).toEqual([
      "connections.json",
      "host.json",
      "run-budget.json",
    ]);
  });

  it("rejects inconsistent registrations and does not switch away from an active connection", () => {
    const f = fixture();
    f.store.saveConnection(makeConnection());
    expect(() =>
      f.store.saveConnection(
        makeConnection({ subject: "synthetic-other-subject" })
      )
    ).toThrow("identity_mismatch");
    expect(() =>
      f.store.saveConnection(
        makeConnection({ localId: "22222222-2222-4222-8222-222222222222" })
      )
    ).toThrow("client_mismatch");
    expect(() =>
      f.store.saveConnection(
        makeConnection({
          localId: "22222222-2222-4222-8222-222222222222",
          clientId: "synthetic-other-client",
        })
      )
    ).toThrow("operation_busy");
    expect(f.store.loadSelectedConnection()).toEqual(makeConnection());
  });

  it.each([
    "mode",
    "symlink",
    "hardlink",
    "directory",
    "empty",
    "oversize",
  ] as const)(
    "rejects unsafe %s fixture-owned file without overwrite",
    (kind) => {
      const f = fixture();
      fs.mkdirSync(f.directory, { mode: 0o700 });
      const target = f.file("host.json");
      const sibling = join(f.base, "fixture-sibling");
      if (kind === "directory") fs.mkdirSync(target);
      else if (kind === "symlink" || kind === "hardlink") {
        fs.writeFileSync(sibling, "synthetic-only", { mode: 0o600 });
        if (kind === "symlink") fs.symlinkSync(sibling, target);
        else fs.linkSync(sibling, target);
      } else
        fs.writeFileSync(
          target,
          kind === "empty"
            ? ""
            : kind === "oversize"
              ? "x".repeat(131073)
              : "synthetic-only",
          { mode: kind === "mode" ? 0o644 : 0o600 }
        );
      const before = fs.lstatSync(target);
      expect(() => f.store.ensureHostId()).toThrow("storage_unsafe");
      expect(fs.lstatSync(target)).toMatchObject({
        ino: before.ino,
        mode: before.mode,
        size: before.size,
        nlink: before.nlink,
      });
      if (kind === "symlink" || kind === "hardlink")
        expect(fs.readFileSync(sibling, "utf8")).toBe("synthetic-only");
    }
  );

  it.each([
    "base-mode",
    "owned-mode",
    "owned-symlink",
    "owner",
    "relative",
  ] as const)("rejects unsafe directory condition %s", (kind) => {
    const f = fixture();
    if (kind === "base-mode") fs.chmodSync(f.base, 0o777);
    if (kind === "owned-mode") fs.mkdirSync(f.directory, { mode: 0o755 });
    if (kind === "owned-symlink") {
      const sibling = join(f.base, "fixture-owned-other");
      fs.mkdirSync(sibling, { mode: 0o700 });
      fs.symlinkSync(sibling, f.directory);
    }
    if (kind === "owner")
      expect(() =>
        new CredentialStore(f.base, {
          ...f.deps,
          uid: f.deps.uid + 1,
        }).ensureHostId()
      ).toThrow("storage_unsafe");
    else if (kind === "relative")
      expect(() => new CredentialStore("test-relative", f.deps)).toThrow(
        "storage_unavailable"
      );
    else expect(() => f.store.ensureHostId()).toThrow("storage_unsafe");
  });

  it("rejects invalid bounded metadata and does not reset a corrupt budget", () => {
    const f = fixture();
    const initial = f.store.getBudget();
    fs.writeFileSync(
      f.file("run-budget.json"),
      JSON.stringify({ ...initial, attempts: 4 })
    );
    expect(() => f.store.reserveInferenceAttempt()).toThrow("storage_invalid");
    expect(
      JSON.parse(fs.readFileSync(f.file("run-budget.json"), "utf8")) as unknown
    ).toEqual({ ...initial, attempts: 4 });
    expect(() =>
      f.store.saveConnection(
        makeConnection({ accessToken: "synthetic invalid whitespace" })
      )
    ).toThrow("storage_invalid");
    expect(() =>
      f.store.saveConnection(makeConnection({ scopes: ["openid", "openid"] }))
    ).toThrow("storage_invalid");
  });

  it("rejects mismatched disk identity, and cleanup preserves an unrelated test-owned file", () => {
    const f = fixture();
    f.store.saveConnection(makeConnection());
    const selected = f.file("connection-" + LOCAL_ID + ".json");
    fs.writeFileSync(
      selected,
      JSON.stringify(makeConnection({ subject: "synthetic-other-subject" }))
    );
    expect(() => f.store.loadSelectedConnection()).toThrow("storage_invalid");
    fs.writeFileSync(f.file("unrelated.json"), "synthetic unrelated file", {
      mode: 0o600,
    });
    f.store.clearAllCredentials();
    expect(fs.existsSync(selected)).toBe(false);
    expect(fs.readFileSync(f.file("unrelated.json"), "utf8")).toBe(
      "synthetic unrelated file"
    );
  });

  it("deletes a corrupt but privately owned credential file for a known registration", () => {
    const f = fixture();
    f.store.saveConnection(makeConnection());
    const file = f.file("connection-" + LOCAL_ID + ".json");
    fs.writeFileSync(file, "not JSON");
    expect(() => f.store.loadSelectedConnection()).toThrow("storage_invalid");
    f.store.clearCredentials(LOCAL_ID);
    expect(fs.existsSync(file)).toBe(false);
    expect(f.store.selectedRegistration()?.localId).toBe(LOCAL_ID);
  });
});

/** Fault only the actual fixture-created credential replacement and its owned
 * deletion. No path outside the test directory, no real credentials. */
function leaveOwnedCredentialTemp(
  f: ReturnType<typeof fixture>,
  rotate: boolean
) {
  const hostId = f.store.ensureHostId();
  const budget = f.store.getBudget();
  if (rotate) f.store.saveConnection(makeConnection());
  const destination = f.file("connection-" + LOCAL_ID + ".json");
  let tempPath: string | undefined;
  let denyDeletion = true;
  const renameSync = vi.fn<typeof fs.renameSync>((from, to) => {
    if (String(to) === destination) {
      tempPath = String(from);
      throw Object.assign(new Error(DETAIL), { code: "EACCES" });
    }
    fs.renameSync(from, to);
  });
  const unlinkSync = vi.fn<typeof fs.unlinkSync>((file) => {
    if (denyDeletion && tempPath !== undefined && String(file) === tempPath)
      throw Object.assign(new Error(DETAIL), { code: "EACCES" });
    fs.unlinkSync(file);
  });
  const deps = { ...f.deps, fs: { ...fs, renameSync, unlinkSync } };
  const store = new CredentialStore(f.base, deps);
  const replacement = makeConnection({
    accessToken: "synthetic-unremoved-access",
    refreshToken: "synthetic-unremoved-refresh",
  });
  expect(() => store.saveConnection(replacement)).toThrow("storage_failed");
  const temp = tempPath;
  if (!temp) throw new Error("Expected a fixture-created failed replacement");
  expect(temp.startsWith(f.directory + "/")).toBe(true);
  expect(fs.lstatSync(temp).mode & 0o777).toBe(0o600);
  expect(fs.readFileSync(temp, "utf8")).toContain(replacement.accessToken);
  expect(fs.readFileSync(temp, "utf8")).toContain(replacement.refreshToken);
  expect(unlinkSync).toHaveBeenCalledWith(temp);
  const unrelated = f.file("unrelated-test-file.tmp");
  fs.writeFileSync(unrelated, "test-owned unrelated file", { mode: 0o600 });
  return {
    store,
    deps,
    temp,
    unrelated,
    hostId,
    budget,
    unlinkSync,
    permitDeletion: () => {
      denyDeletion = false;
    },
  };
}

describe("S8 durable credential cleanup obligations", () => {
  it.each([false, true])(
    "reports failed owned-temp deletion after initial write or rotation (rotate=%s), persists the obligation across instances, and recovers without touching unrelated files",
    (rotate) => {
      const f = fixture();
      const failed = leaveOwnedCredentialTemp(f, rotate);
      expect(() => failed.store.clearAllCredentials()).toThrow(
        "storage_failed"
      );
      expect(fs.existsSync(failed.temp)).toBe(true);
      const restarted = new CredentialStore(f.base, failed.deps);
      expect(() => restarted.loadSelectedConnection()).toThrow(
        "storage_failed"
      );
      expect(() => restarted.getBudget()).toThrow("storage_failed");
      expect(() => restarted.clearAllCredentials()).toThrow("storage_failed");
      expect(fs.existsSync(failed.temp)).toBe(true);
      expect(fs.readFileSync(failed.unrelated, "utf8")).toBe(
        "test-owned unrelated file"
      );
      failed.permitDeletion();
      const recovered = new CredentialStore(f.base, failed.deps);
      expect(recovered.getBudget()).toEqual(failed.budget);
      expect(fs.existsSync(failed.temp)).toBe(false);
      recovered.clearAllCredentials();
      expect(recovered.loadSelectedConnection()).toBeUndefined();
      expect(recovered.ensureHostId()).toBe(failed.hostId);
      expect(recovered.getBudget()).toEqual(failed.budget);
      expect(recovered.selectedRegistration()?.clientId).toBe(CLIENT);
      expect(fs.readFileSync(failed.unrelated, "utf8")).toBe(
        "test-owned unrelated file"
      );
      expect(
        failed.unlinkSync.mock.calls.some(
          ([file]) => String(file) === failed.unrelated
        )
      ).toBe(false);
    }
  );

  it("leaves a fixture-created temporary file with unsafe permissions as an unresolved cleanup obligation", () => {
    const f = fixture();
    const failed = leaveOwnedCredentialTemp(f, true);
    failed.permitDeletion();
    fs.chmodSync(failed.temp, 0o644);
    const restarted = new CredentialStore(f.base, failed.deps);
    expect(() => restarted.loadSelectedConnection()).toThrow("storage_unsafe");
    expect(() => restarted.clearAllCredentials()).toThrow("storage_failed");
    expect(fs.existsSync(failed.temp)).toBe(true);
    expect(fs.statSync(failed.temp).mode & 0o777).toBe(0o644);
    fs.chmodSync(failed.temp, 0o600);
    restarted.clearAllCredentials();
    expect(fs.existsSync(failed.temp)).toBe(false);
    expect(fs.readFileSync(failed.unrelated, "utf8")).toBe(
      "test-owned unrelated file"
    );
  });

  it("does not report sign-out local cleanup complete until a failed credential replacement is actually removed", async () => {
    const f = fixture();
    const failed = leaveOwnedCredentialTemp(f, true);
    const oauth = makeOAuthFixture(f);
    // If the normal primary credential is still readable, the fake revocation
    // can complete; if the storage check is blocked, no remote action is needed.
    oauth.network.enqueueDiscovery();
    oauth.network.enqueue(REVOKE, new Response(null, { status: 204 }));
    const lifecycle = new OAuthLifecycle({
      ...oauth.deps,
      store: failed.store,
    });
    const incomplete = await lifecycle.signOut();
    expect(incomplete.localCleared).toBe(false);
    expect(fs.existsSync(failed.temp)).toBe(true);
    expect(JSON.stringify(incomplete)).not.toContain("synthetic-unremoved");
    const restarted = new CredentialStore(f.base, failed.deps);
    const retry = makeOAuthFixture(f);
    retry.network.enqueueDiscovery();
    retry.network.enqueue(REVOKE, new Response(null, { status: 204 }));
    const restartedLifecycle = new OAuthLifecycle({
      ...retry.deps,
      store: restarted,
    });
    expect((await restartedLifecycle.signOut()).localCleared).toBe(false);
    expect(fs.existsSync(failed.temp)).toBe(true);
    failed.permitDeletion();
    const finalStore = new CredentialStore(f.base, failed.deps);
    const final = makeOAuthFixture(f);
    final.network.enqueueDiscovery();
    final.network.enqueue(REVOKE, new Response(null, { status: 204 }));
    expect(
      (await new OAuthLifecycle({ ...final.deps, store: finalStore }).signOut())
        .localCleared
    ).toBe(true);
    expect(fs.existsSync(failed.temp)).toBe(false);
    expect(finalStore.loadSelectedConnection()).toBeUndefined();
    expect(fs.readFileSync(failed.unrelated, "utf8")).toBe(
      "test-owned unrelated file"
    );
    expect(final.network.unexpected).toEqual([]);
    expect(oauth.browser).not.toHaveBeenCalled();
    expect(retry.browser).not.toHaveBeenCalled();
    expect(final.browser).not.toHaveBeenCalled();
  });
});

describe("S5 mandatory native storage flags", () => {
  it.each([
    ["missing constants", undefined, "native_constants_unavailable"],
    [
      "missing no-follow",
      { ...fs.constants, O_NOFOLLOW: undefined },
      "no_follow_unavailable",
    ],
    [
      "zero no-follow",
      { ...fs.constants, O_NOFOLLOW: 0 },
      "no_follow_unavailable",
    ],
    [
      "missing exclusive",
      { ...fs.constants, O_EXCL: undefined },
      "exclusive_create_flags_unavailable",
    ],
    [
      "nonnumeric create",
      { ...fs.constants, O_CREAT: "synthetic-not-a-number" },
      "exclusive_create_flags_unavailable",
    ],
    [
      "zero write access",
      { ...fs.constants, O_WRONLY: 0 },
      "exclusive_create_flags_unavailable",
    ],
  ] as const)(
    "fails before opening a file when required write flags are invalid (%s)",
    (_label, constants, code) => {
      const f = fixture();
      const openSync = vi.fn<typeof fs.openSync>((...args) =>
        fs.openSync(...args)
      );
      const fsyncSync = vi.fn<typeof fs.fsyncSync>((fd) => fs.fsyncSync(fd));
      const deps = {
        ...f.deps,
        fs: {
          ...fs,
          constants: constants as unknown as typeof fs.constants,
          openSync,
          fsyncSync,
        },
      };
      const report = verifyPrivateStorage(f.base, deps);
      expect(report.verified).toBe(false);
      expect(report.lastFailure).toEqual({
        phase: "ensure_host_id",
        stage: "write_flags",
        outcome: "blocked",
        code,
      });
      expect(report.rows.some((row) => row.stage === "write_open")).toBe(false);
      expect(openSync).not.toHaveBeenCalled();
      expect(fsyncSync).not.toHaveBeenCalled();
      expect(fs.readdirSync(f.directory)).toEqual([]);
      expect(JSON.stringify(report)).not.toContain(f.base);
      expect(JSON.stringify(report)).not.toContain("synthetic-not-a-number");
    }
  );

  it("keeps zero O_RDONLY valid but rejects missing read flags before touching the synthetic file", () => {
    const f = fixture();
    const hostId = f.store.ensureHostId();
    expect(privateStorageOpenFlags(fs, "read")).toBe(
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    expect(privateStorageOpenFlags(fs, "write")).toBe(
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW
    );
    const openSync = vi.fn<typeof fs.openSync>((...args) =>
      fs.openSync(...args)
    );
    const report = verifyPrivateStorage(f.base, {
      ...f.deps,
      fs: {
        ...fs,
        constants: {
          ...fs.constants,
          O_RDONLY: undefined,
        } as unknown as typeof fs.constants,
        openSync,
      },
    });
    expect(report.verified).toBe(false);
    expect(report.lastFailure).toEqual({
      phase: "ensure_host_id",
      stage: "read_flags",
      outcome: "blocked",
      code: "read_access_flag_unavailable",
    });
    expect(openSync).not.toHaveBeenCalled();
    expect(fs.readdirSync(f.directory)).toEqual(["host.json"]);
    expect(f.store.ensureHostId()).toBe(hostId);
    expect(JSON.stringify(report)).not.toContain(hostId);
    expect(JSON.stringify(report)).not.toContain(f.base);
  });
});
