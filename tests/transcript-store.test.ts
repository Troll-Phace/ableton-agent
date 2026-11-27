/**
 * Transcript-store unit suite — Phase 10 cross-session continuity
 * (docs/ARCHITECTURE.md §10: "Conversation transcript → sessions/*.json …
 * Re-fed each turn to fake continuity"). Exercises
 * `src/extension/transport/transcript-store.ts` against a real OS temp dir.
 *
 * Invariants under test:
 *  - **Round-trip**: `persistTranscript` → `loadLatestTranscript` returns the
 *    same `Anthropic.MessageParam[]` verbatim, including tool_use / tool_result
 *    content blocks.
 *  - **Survives across "sessions"**: a fresh `loadLatestTranscript` (no shared
 *    in-memory state) restores an identical transcript persisted earlier.
 *  - **Newest wins**: with multiple session files, the one with the newest mtime
 *    is restored (mtimes pinned via `fs.utimesSync` for determinism).
 *  - **Honest recovery, never throw**: corrupt file / missing dir / undefined
 *    dir → `null` (loads) or no-op (writes), never an exception.
 *
 * Real `fs` is used (the store is pure Node fs/path/crypto). Each test gets a
 * fresh `mkdtemp` dir torn down in `afterEach`.
 */

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type Anthropic from "@anthropic-ai/sdk";

import {
  loadLatestTranscript,
  newSessionId,
  persistTranscript,
} from "../src/extension/transport/transcript-store.js";

/* -------------------------------------------------------------------------- */
/* Fixtures / lifecycle                                                       */
/* -------------------------------------------------------------------------- */

/** A fresh per-test storage dir; cleaned up in afterEach. */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abl-transcript-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The sessions sub-directory under a storage dir. */
function sessionsDir(d: string): string {
  return join(d, "sessions");
}

/** A simple two-message transcript. */
function simpleTranscript(): Anthropic.MessageParam[] {
  return [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
  ];
}

/**
 * A realistic transcript carrying tool_use / tool_result content blocks, to
 * prove structural fidelity across the JSON round-trip.
 */
function richTranscript(): Anthropic.MessageParam[] {
  return [
    { role: "user", content: "rename track 0 to Drums" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Renaming the track now." },
        {
          type: "tool_use",
          id: "toolu_abc123",
          name: "live_update_track",
          input: { track: "track:0:Old", name: "Drums" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_abc123",
          content: '{"ok":true,"ref":"track:0:Drums"}',
        },
      ],
    },
    { role: "assistant", content: "Done — renamed to Drums." },
  ];
}

/* -------------------------------------------------------------------------- */
/* newSessionId                                                               */
/* -------------------------------------------------------------------------- */

describe("transcriptStore_newSessionId", () => {
  it("transcriptStore_newSessionId_isUniqueFilesystemSafeUuid", () => {
    const a = newSessionId();
    const b = newSessionId();
    expect(a).not.toBe(b);
    // UUID shape: lowercase hex + hyphens only — no path separators / reserved.
    expect(a).toMatch(/^[0-9a-f-]+$/);
    expect(a).not.toContain("/");
    expect(a).not.toContain("\\");
  });
});

/* -------------------------------------------------------------------------- */
/* Round-trip                                                                 */
/* -------------------------------------------------------------------------- */

describe("transcriptStore_persistLoad_roundTrip", () => {
  it("transcriptStore_persistThenLoad_returnsSameMessagesAndSessionId", () => {
    const id = newSessionId();
    const messages = simpleTranscript();
    persistTranscript(dir, id, messages);

    const restored = loadLatestTranscript(dir);
    expect(restored).not.toBeNull();
    expect(restored?.sessionId).toBe(id);
    expect(restored?.messages).toEqual(messages);
  });

  it("transcriptStore_roundTrip_preservesToolUseAndToolResultBlocks", () => {
    const id = newSessionId();
    const messages = richTranscript();
    persistTranscript(dir, id, messages);

    const restored = loadLatestTranscript(dir);
    expect(restored).not.toBeNull();
    // Deep-equal proves tool_use/tool_result blocks survived unchanged.
    expect(restored?.messages).toEqual(messages);
  });
});

/* -------------------------------------------------------------------------- */
/* Survives across "sessions"                                                 */
/* -------------------------------------------------------------------------- */

describe("transcriptStore_survivesAcrossSessions", () => {
  it("transcriptStore_freshLoadAfterPersist_restoresIdenticalMessages", () => {
    // "Session 1": persist under an id, then drop all in-memory references.
    const id = newSessionId();
    const original = richTranscript();
    persistTranscript(dir, id, original);

    // "Session 2": a completely separate load call (no shared state) restores
    // the same transcript — the cross-launch continuity guarantee (§10).
    const restored = loadLatestTranscript(dir);
    expect(restored?.sessionId).toBe(id);
    expect(restored?.messages).toEqual(original);
  });
});

/* -------------------------------------------------------------------------- */
/* Newest (by mtime) wins                                                     */
/* -------------------------------------------------------------------------- */

describe("transcriptStore_newestWins", () => {
  it("transcriptStore_multipleSessions_restoresNewestByMtime", () => {
    mkdirSync(sessionsDir(dir), { recursive: true });

    const older: Anthropic.MessageParam[] = [{ role: "user", content: "old" }];
    const newer: Anthropic.MessageParam[] = [{ role: "user", content: "new" }];

    const olderPath = join(sessionsDir(dir), "older-session.json");
    const newerPath = join(sessionsDir(dir), "newer-session.json");
    writeFileSync(olderPath, JSON.stringify(older), "utf8");
    writeFileSync(newerPath, JSON.stringify(newer), "utf8");

    // Pin mtimes deterministically so "newest" is unambiguous regardless of the
    // sub-millisecond write order (atime, mtime in seconds since epoch).
    utimesSync(olderPath, 1_000, 1_000);
    utimesSync(newerPath, 2_000, 2_000);

    const restored = loadLatestTranscript(dir);
    expect(restored?.sessionId).toBe("newer-session");
    expect(restored?.messages).toEqual(newer);
  });

  it("transcriptStore_persistOverExisting_makesItNewestAndRestoresIt", () => {
    mkdirSync(sessionsDir(dir), { recursive: true });
    const stalePath = join(sessionsDir(dir), "stale.json");
    writeFileSync(stalePath, JSON.stringify([{ role: "user", content: "x" }]));
    // Make the stale one clearly older.
    utimesSync(stalePath, 1_000, 1_000);

    // A fresh persist writes "now" — strictly newer than the pinned stale file.
    const id = newSessionId();
    const fresh = simpleTranscript();
    persistTranscript(dir, id, fresh);

    const restored = loadLatestTranscript(dir);
    expect(restored?.sessionId).toBe(id);
    expect(restored?.messages).toEqual(fresh);
  });
});

/* -------------------------------------------------------------------------- */
/* Corrupt / missing recovery (NO throw)                                      */
/* -------------------------------------------------------------------------- */

describe("transcriptStore_recovery", () => {
  it("transcriptStore_corruptNewestFile_returnsNullNoThrow", () => {
    mkdirSync(sessionsDir(dir), { recursive: true });
    writeFileSync(join(sessionsDir(dir), "broken.json"), "}{ not json", "utf8");

    let restored: ReturnType<typeof loadLatestTranscript> | undefined;
    expect(() => {
      restored = loadLatestTranscript(dir);
    }).not.toThrow();
    expect(restored).toBeNull();
  });

  it("transcriptStore_nonArrayJson_returnsNull", () => {
    mkdirSync(sessionsDir(dir), { recursive: true });
    // Valid JSON object, but a transcript must be an array.
    writeFileSync(
      join(sessionsDir(dir), "obj.json"),
      JSON.stringify({ role: "user", content: "nope" }),
      "utf8"
    );
    expect(loadLatestTranscript(dir)).toBeNull();
  });

  it("transcriptStore_missingSessionsDir_returnsNull", () => {
    // Fresh storage dir with no sessions/ subdir at all.
    expect(readdirSync(dir)).toHaveLength(0);
    expect(loadLatestTranscript(dir)).toBeNull();
  });

  it("transcriptStore_emptySessionsDir_returnsNull", () => {
    mkdirSync(sessionsDir(dir), { recursive: true });
    expect(loadLatestTranscript(dir)).toBeNull();
  });

  it("transcriptStore_undefinedDir_persistNoOpAndLoadNull", () => {
    // Undefined dir: persist is a silent no-op (no throw); load returns null.
    expect(() => {
      persistTranscript(undefined, newSessionId(), simpleTranscript());
    }).not.toThrow();
    expect(loadLatestTranscript(undefined)).toBeNull();
  });

  it("transcriptStore_nonJsonExtensionFiles_ignored", () => {
    mkdirSync(sessionsDir(dir), { recursive: true });
    // A stray non-.json file must be ignored, not treated as a session.
    writeFileSync(join(sessionsDir(dir), "README.txt"), "ignore me", "utf8");
    expect(loadLatestTranscript(dir)).toBeNull();
  });

  it("transcriptStore_jsonNamedSubdirectory_skippedNotTreatedAsSession", () => {
    mkdirSync(sessionsDir(dir), { recursive: true });
    // A *directory* whose name ends in .json must be skipped (it is not a file),
    // and a real session file alongside it still wins.
    mkdirSync(join(sessionsDir(dir), "decoy.json"), { recursive: true });
    const id = newSessionId();
    const messages = simpleTranscript();
    persistTranscript(dir, id, messages);

    const restored = loadLatestTranscript(dir);
    expect(restored?.sessionId).toBe(id);
    expect(restored?.messages).toEqual(messages);
  });

  it("transcriptStore_persistWriteFailure_swallowedNoThrow", () => {
    // Make `sessions/` a FILE so mkdirSync(dir,{recursive}) / writeFileSync fail
    // (a path component is not a directory). persistTranscript must log + swallow
    // — never throw out of a turn.
    writeFileSync(sessionsDir(dir), "i am a file, not a dir", "utf8");
    expect(() => {
      persistTranscript(dir, newSessionId(), simpleTranscript());
    }).not.toThrow();
  });
});
