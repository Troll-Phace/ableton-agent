/**
 * Config store unit suite — Phase 10 persistence/secrets (docs/ARCHITECTURE.md
 * §10). Exercises `src/extension/config-store.ts` against a real OS temp dir.
 *
 * The integrity-critical invariants here are:
 *  - **Recovery, never throw**: a missing dir / missing file / malformed JSON /
 *    non-object JSON all recover to first-run defaults silently (no throw).
 *  - **Honest non-persistence**: an undefined `storageDirectory` yields a
 *    structured `{ ok:false, error:"no_storage_dir" }` write result — no phantom
 *    success.
 *  - **Key precedence** (`resolveApiKey`): config key wins, else
 *    `process.env.ANTHROPIC_API_KEY`, with an empty string treated as ABSENT.
 *  - **No-key-leak projection** (`toConfigState`): the webview-facing shape
 *    NEVER carries the key value — only the boolean `hasKey` + model.
 *  - **Storage isolation** (the `--storage-directory` dev override semantics):
 *    two distinct dirs never see each other's config.
 *
 * Real `fs` is used (the store is pure Node fs/path), so each test gets a fresh
 * `mkdtemp` dir torn down in `afterEach`. `process.env.ANTHROPIC_API_KEY` is
 * saved/restored around every test so env-fallback assertions are hermetic.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadConfig,
  resolveApiKey,
  resolveModel,
  saveConfig,
  toConfigState,
  type Config,
} from "../src/extension/config-store.js";
import { MODEL } from "../src/extension/claude-client.js";

/* -------------------------------------------------------------------------- */
/* Fixtures / lifecycle                                                       */
/* -------------------------------------------------------------------------- */

/** A fresh per-test storage dir; cleaned up in afterEach. */
let dir: string;

/** Saved env value restored after every test (hermetic env-fallback tests). */
let priorEnvKey: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abl-config-"));
  priorEnvKey = process.env.ANTHROPIC_API_KEY;
  // Default to a clean env so a leaked machine key never masks an assertion.
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (priorEnvKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = priorEnvKey;
  }
});

/** Absolute path to the on-disk config file under the per-test dir. */
function configFile(d: string): string {
  return join(d, "config.json");
}

/* -------------------------------------------------------------------------- */
/* Load / save round-trip                                                     */
/* -------------------------------------------------------------------------- */

describe("configStore_saveLoad_roundTrip", () => {
  it("configStore_saveThenLoad_returnsPersistedKeyModelDefaults", () => {
    const result = saveConfig(dir, {
      anthropicApiKey: "sk-ant-roundtrip",
      model: "claude-opus-4-20250514",
      defaults: { scopeToSelection: false, confirmDestructive: false },
    });
    expect(result).toEqual({ ok: true });

    const loaded = loadConfig(dir);
    expect(loaded.anthropicApiKey).toBe("sk-ant-roundtrip");
    expect(loaded.model).toBe("claude-opus-4-20250514");
    expect(loaded.defaults).toEqual({
      scopeToSelection: false,
      confirmDestructive: false,
    });
  });

  it("configStore_save_writesPrettyJsonToConfigJson", () => {
    saveConfig(dir, { model: "claude-3-5-haiku-20241022" });
    expect(existsSync(configFile(dir))).toBe(true);
    const raw = readFileSync(configFile(dir), "utf8");
    // Pretty-printed (2-space) and newline-terminated.
    expect(raw).toContain('"model": "claude-3-5-haiku-20241022"');
    expect(raw.endsWith("\n")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Undefined storage dir (first run / no storage granted)                     */
/* -------------------------------------------------------------------------- */

describe("configStore_undefinedDir_firstClassNoStorage", () => {
  it("configStore_loadUndefinedDir_returnsEmptyDefaults", () => {
    const loaded = loadConfig(undefined);
    expect(loaded.anthropicApiKey).toBeUndefined();
    expect(loaded.model).toBeUndefined();
    expect(loaded.defaults).toEqual({
      scopeToSelection: true,
      confirmDestructive: true,
    });
  });

  it("configStore_saveUndefinedDir_returnsNoStorageDirErrorNoThrow", () => {
    const result = saveConfig(undefined, { anthropicApiKey: "sk-ant-nowhere" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("no_storage_dir");
      // The detail must NEVER carry the key value (§10).
      expect(result.detail).not.toContain("sk-ant-nowhere");
    }
  });

  it("configStore_saveWriteFailure_returnsWriteFailedNoThrowNoKeyInDetail", () => {
    // Force a write failure: make the storage dir path itself a FILE so
    // mkdirSync(dir,{recursive}) / writeFileSync cannot create config.json
    // beneath it. saveConfig must map this to a structured write_failed result,
    // never throw, and never leak the key into the detail.
    const filePath = join(dir, "as-a-file");
    writeFileSync(filePath, "blocker", "utf8");

    let result: ReturnType<typeof saveConfig> | undefined;
    expect(() => {
      result = saveConfig(filePath, { anthropicApiKey: "sk-ant-write-fail" });
    }).not.toThrow();
    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.error).toBe("write_failed");
      expect(result.detail).not.toContain("sk-ant-write-fail");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Missing file → first-run defaults                                          */
/* -------------------------------------------------------------------------- */

describe("configStore_missingFile_firstRunDefaults", () => {
  it("configStore_loadMissingFile_returnsEmptyDefaults", () => {
    // Fresh dir, no config.json written.
    expect(existsSync(configFile(dir))).toBe(false);
    const loaded = loadConfig(dir);
    expect(loaded.anthropicApiKey).toBeUndefined();
    expect(loaded.defaults).toEqual({
      scopeToSelection: true,
      confirmDestructive: true,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Malformed / non-object recovery (NO throw)                                 */
/* -------------------------------------------------------------------------- */

describe("configStore_malformed_recoversToDefaultsNoThrow", () => {
  it("configStore_garbageJson_recoversToDefaultsWithoutThrowing", () => {
    writeFileSync(configFile(dir), "}{ not json at all", "utf8");
    let loaded: Config | undefined;
    expect(() => {
      loaded = loadConfig(dir);
    }).not.toThrow();
    expect(loaded?.anthropicApiKey).toBeUndefined();
    expect(loaded?.defaults).toEqual({
      scopeToSelection: true,
      confirmDestructive: true,
    });
  });

  it("configStore_arrayJson_recoversToDefaults", () => {
    // Valid JSON but not an object → recover to defaults.
    writeFileSync(configFile(dir), "[1, 2, 3]", "utf8");
    const loaded = loadConfig(dir);
    expect(loaded.anthropicApiKey).toBeUndefined();
    expect(loaded.defaults).toEqual({
      scopeToSelection: true,
      confirmDestructive: true,
    });
  });

  it("configStore_nonObjectScalarJson_recoversToDefaults", () => {
    // A bare JSON scalar (number) is valid JSON but not a config object.
    writeFileSync(configFile(dir), "42", "utf8");
    const loaded = loadConfig(dir);
    expect(loaded.anthropicApiKey).toBeUndefined();
    expect(loaded.model).toBeUndefined();
  });

  it("configStore_nullJson_recoversToDefaults", () => {
    writeFileSync(configFile(dir), "null", "utf8");
    const loaded = loadConfig(dir);
    expect(loaded.anthropicApiKey).toBeUndefined();
    expect(loaded.defaults).toEqual({
      scopeToSelection: true,
      confirmDestructive: true,
    });
  });

  it("configStore_malformedDefaultsBlock_fallsBackToDefaultDefaults", () => {
    // A well-formed top-level object with a malformed `defaults` (non-object).
    writeFileSync(
      configFile(dir),
      JSON.stringify({ model: "m", defaults: "oops" }),
      "utf8"
    );
    const loaded = loadConfig(dir);
    expect(loaded.model).toBe("m");
    expect(loaded.defaults).toEqual({
      scopeToSelection: true,
      confirmDestructive: true,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* resolveApiKey precedence                                                   */
/* -------------------------------------------------------------------------- */

describe("configStore_resolveApiKey_precedence", () => {
  it("configStore_resolveApiKey_configKeyWinsOverEnv", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-env";
    const config: Config = { anthropicApiKey: "sk-ant-config" };
    expect(resolveApiKey(config)).toBe("sk-ant-config");
  });

  it("configStore_resolveApiKey_fallsBackToEnvWhenNoConfigKey", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-env";
    expect(resolveApiKey({})).toBe("sk-ant-env");
  });

  it("configStore_resolveApiKey_emptyConfigKeyTreatedAsAbsentFallsToEnv", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-env";
    // An empty-string config key must NOT shadow the env fallback.
    expect(resolveApiKey({ anthropicApiKey: "" })).toBe("sk-ant-env");
  });

  it("configStore_resolveApiKey_emptyEnvKeyTreatedAsAbsentReturnsUndefined", () => {
    process.env.ANTHROPIC_API_KEY = "";
    expect(resolveApiKey({})).toBeUndefined();
  });

  it("configStore_resolveApiKey_undefinedWhenNeitherSet", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(resolveApiKey({})).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* resolveModel precedence                                                    */
/* -------------------------------------------------------------------------- */

describe("configStore_resolveModel_precedence", () => {
  it("configStore_resolveModel_configModelWins", () => {
    expect(resolveModel({ model: "claude-opus-4-20250514" })).toBe(
      "claude-opus-4-20250514"
    );
  });

  it("configStore_resolveModel_fallsBackToDefaultModelWhenAbsent", () => {
    expect(resolveModel({})).toBe(MODEL);
  });
});

/* -------------------------------------------------------------------------- */
/* toConfigState — NEVER leaks the key                                        */
/* -------------------------------------------------------------------------- */

describe("configStore_toConfigState_neverLeaksKey", () => {
  it("configStore_toConfigState_hasKeyTrueModelButNoKeyValue", () => {
    const config: Config = {
      anthropicApiKey: "sk-ant-secret-do-not-leak",
      model: "claude-opus-4-20250514",
    };
    const state = toConfigState(config);
    expect(state.hasKey).toBe(true);
    expect(state.model).toBe("claude-opus-4-20250514");

    // No property of the projection may hold the key string, and serializing
    // the whole shape must not surface it anywhere.
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain("sk-ant-secret-do-not-leak");
    for (const value of Object.values(state)) {
      expect(value).not.toBe("sk-ant-secret-do-not-leak");
    }
  });

  it("configStore_toConfigState_envOnlyKeyStillReadsAsHasKeyTrue", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-env-only";
    const state = toConfigState({ model: "m" });
    expect(state.hasKey).toBe(true);
    expect(JSON.stringify(state)).not.toContain("sk-ant-env-only");
  });

  it("configStore_toConfigState_hasKeyFalseWhenNoKeyAnywhere", () => {
    delete process.env.ANTHROPIC_API_KEY;
    const state = toConfigState({});
    expect(state.hasKey).toBe(false);
    expect(state.model).toBe(MODEL);
  });
});

/* -------------------------------------------------------------------------- */
/* saveConfig shallow-merge preserves untouched fields                        */
/* -------------------------------------------------------------------------- */

describe("configStore_saveConfig_shallowMerge", () => {
  it("configStore_partialSave_preservesUntouchedKeyWhenOnlyModelChanges", () => {
    saveConfig(dir, { anthropicApiKey: "sk-ant-keep" });
    // A subsequent model-only save must NOT clear the stored key.
    const result = saveConfig(dir, { model: "claude-3-5-haiku-20241022" });
    expect(result).toEqual({ ok: true });

    const loaded = loadConfig(dir);
    expect(loaded.anthropicApiKey).toBe("sk-ant-keep");
    expect(loaded.model).toBe("claude-3-5-haiku-20241022");
  });

  it("configStore_partialSave_preservesUntouchedModelWhenOnlyKeyChanges", () => {
    saveConfig(dir, { model: "claude-opus-4-20250514" });
    saveConfig(dir, { anthropicApiKey: "sk-ant-new" });

    const loaded = loadConfig(dir);
    expect(loaded.model).toBe("claude-opus-4-20250514");
    expect(loaded.anthropicApiKey).toBe("sk-ant-new");
  });
});

/* -------------------------------------------------------------------------- */
/* Storage isolation (--storage-directory dev override semantics)             */
/* -------------------------------------------------------------------------- */

describe("configStore_storageIsolation", () => {
  it("configStore_twoDistinctDirs_doNotSeeEachOtherConfig", () => {
    const dirB = mkdtempSync(join(tmpdir(), "abl-config-b-"));
    try {
      saveConfig(dir, { anthropicApiKey: "sk-ant-A", model: "model-A" });
      saveConfig(dirB, { anthropicApiKey: "sk-ant-B", model: "model-B" });

      const a = loadConfig(dir);
      const b = loadConfig(dirB);
      expect(a.anthropicApiKey).toBe("sk-ant-A");
      expect(a.model).toBe("model-A");
      expect(b.anthropicApiKey).toBe("sk-ant-B");
      expect(b.model).toBe("model-B");
    } finally {
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});
