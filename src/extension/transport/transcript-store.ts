/**
 * Conversation-transcript persistence — durable, cross-session continuity for the
 * chat agent (docs/ARCHITECTURE.md §10 "Conversation transcript →
 * `storageDirectory/sessions/*.json` … Re-fed each turn to fake continuity (no
 * background mode)"; §4 data flow).
 *
 * The host has **no background mode**: the extension runs only while invoked, and
 * the in-memory transcript on a {@link ChatSession} dies with the modal. To carry
 * a conversation across launches we mirror the transcript to disk after every turn
 * and, on the next launch, restore the most-recently-written session — so the user
 * can close Live, reopen, and pick the thread back up.
 *
 * **Layout:** one file per session at
 * `<storageDirectory>/sessions/<sessionId>.json`, whose body is the raw JSON of the
 * `Anthropic.MessageParam[]` transcript array. The `sessionId` is a filesystem-safe
 * `crypto.randomUUID()` (no path separators, no reserved chars) and doubles as the
 * filename stem. "Latest" is decided by `fs.statSync` mtime, so a freshly persisted
 * session always wins the next restore.
 *
 * **Discipline (§10):**
 *  - Filesystem access stays inside `storageDirectory` — never elsewhere.
 *  - `storageDirectory` is `string | undefined` (the SDK may not provide one); an
 *    undefined dir is a first-class **no-op** for writes and yields `null` for
 *    loads. Persistence is best-effort: a failure here must NEVER break a turn, so
 *    **no exported function throws** — every I/O path is wrapped and converts to an
 *    honest `console.debug`/`console.warn`/`console.error` (the host's only sink)
 *    plus a no-op / `null` return.
 *  - Transcript bodies are never logged above `debug`; logs carry only structural
 *    context (paths, counts, error messages), never message content.
 *
 * **SDK-free:** depends solely on `node:fs` / `node:path` / `node:crypto`. The only
 * `@anthropic-ai/sdk` reference is the **type-only** `Anthropic.MessageParam`
 * import (erased at compile time); the Extensions SDK is never imported. This
 * module loads after the runtime shim, so `crypto.randomUUID` is available.
 */

import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type Anthropic from "@anthropic-ai/sdk";

/** Log prefix mirroring the host's `console.*` convention. */
const LOG_PREFIX = "[transcript-store]";

/** Sub-directory (under `storageDirectory`) that holds the per-session files. */
const SESSIONS_DIR = "sessions";

/** Extension of a persisted session file. */
const FILE_EXT = ".json";

/**
 * Mint a fresh, filesystem-safe session id usable directly as a filename stem.
 *
 * Uses `crypto.randomUUID()` — its output (lowercase hex + hyphens) contains no
 * path separators, no reserved characters, and no whitespace, so it is safe on
 * every target filesystem with no sanitization required.
 *
 * @returns A unique session id, e.g. `"f47ac10b-58cc-4372-a567-0e02b2c3d479"`.
 */
export function newSessionId(): string {
  return randomUUID();
}

/**
 * Persist a transcript to `<storageDir>/sessions/<sessionId>.json` (best-effort).
 *
 * Writes the raw JSON of `messages`, creating the `sessions/` directory
 * recursively if needed. This is called after every turn, so it must be cheap and
 * silent on the happy path and **must never throw** — a persistence failure is
 * logged honestly and swallowed so the turn that triggered it still completes.
 *
 * @param storageDir The SDK storage directory, or `undefined`. When `undefined`
 *   this is a no-op (one `console.debug`) — there is nowhere durable to write.
 * @param sessionId  The session id / filename stem (see {@link newSessionId}).
 * @param messages   The full transcript to mirror to disk.
 */
export function persistTranscript(
  storageDir: string | undefined,
  sessionId: string,
  messages: Anthropic.MessageParam[]
): void {
  if (storageDir === undefined) {
    console.debug(
      `${LOG_PREFIX} no storageDirectory — skipping transcript persist`
    );
    return;
  }

  try {
    const dir = join(storageDir, SESSIONS_DIR);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${sessionId}${FILE_EXT}`);
    writeFileSync(file, JSON.stringify(messages), "utf8");
    console.debug(
      `${LOG_PREFIX} persisted ${String(messages.length)} message(s) → ${file}`
    );
  } catch (err) {
    console.error(
      `${LOG_PREFIX} failed to persist transcript for session "${sessionId}"`,
      err
    );
  }
}

/**
 * Restore the most-recently-written transcript for cross-session continuity
 * (best-effort).
 *
 * Scans `<storageDir>/sessions/` for `*.json` files and picks the one with the
 * newest `fs.statSync` mtime, then parses it. On any miss — `undefined` dir,
 * missing/empty `sessions/`, or a newest file that is unreadable / not valid
 * JSON / not an array — it returns `null` (honest recovery, no throw). It does not
 * fall back to older files if the newest is corrupt: a single honest `warn` and a
 * fresh session is the simpler, safer behavior.
 *
 * @param storageDir The SDK storage directory, or `undefined`.
 * @returns `{ sessionId, messages }` for the newest readable session, or `null`
 *   when there is nothing valid to restore.
 */
export function loadLatestTranscript(
  storageDir: string | undefined
): { sessionId: string; messages: Anthropic.MessageParam[] } | null {
  if (storageDir === undefined) {
    console.debug(
      `${LOG_PREFIX} no storageDirectory — starting a fresh session`
    );
    return null;
  }

  const dir = join(storageDir, SESSIONS_DIR);

  let newest: { sessionId: string; path: string; mtimeMs: number } | null =
    null;
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (!entry.endsWith(FILE_EXT)) {
        continue;
      }
      const path = join(dir, entry);
      let mtimeMs: number;
      try {
        const stat = statSync(path);
        if (!stat.isFile()) {
          continue;
        }
        mtimeMs = stat.mtimeMs;
      } catch (err) {
        // A single entry we cannot stat (e.g. removed mid-scan) is skipped, not fatal.
        console.debug(
          `${LOG_PREFIX} skipping unstattable entry "${entry}"`,
          err
        );
        continue;
      }
      if (newest === null || mtimeMs > newest.mtimeMs) {
        newest = {
          sessionId: entry.slice(0, -FILE_EXT.length),
          path,
          mtimeMs,
        };
      }
    }
  } catch (err) {
    // Missing `sessions/` (ENOENT) is the common first-run case — debug, not warn.
    console.debug(
      `${LOG_PREFIX} no readable sessions directory at "${dir}" — fresh session`,
      err
    );
    return null;
  }

  if (newest === null) {
    console.debug(`${LOG_PREFIX} no persisted sessions found — starting fresh`);
    return null;
  }

  try {
    const raw = readFileSync(newest.path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn(
        `${LOG_PREFIX} newest session "${newest.sessionId}" is not an array — ignoring, fresh session`
      );
      return null;
    }
    const messages = parsed as Anthropic.MessageParam[];
    console.debug(
      `${LOG_PREFIX} restored ${String(messages.length)} message(s) from session "${newest.sessionId}"`
    );
    return { sessionId: newest.sessionId, messages };
  } catch (err) {
    console.warn(
      `${LOG_PREFIX} newest session "${newest.sessionId}" is corrupt or unreadable — ignoring, fresh session`,
      err
    );
    return null;
  }
}
