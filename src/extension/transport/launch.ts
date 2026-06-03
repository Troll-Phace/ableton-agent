/**
 * Activation-time launch wiring for Spike R3 **Outcome D** (localhost full-duplex
 * WS, act-in-place; docs/ARCHITECTURE.md §5 Activation & Lifecycle, §11 Transport).
 *
 * This module owns the side that `activate()` cannot do inline without blocking:
 *  - starting the long-lived {@link TransportServer} once per session (before any
 *    modal is opened), so the webview always has a same-origin socket to connect
 *    to (§11, spike 3.2 variant (b));
 *  - registering the single `live.launchAgent` command + its `AudioTrack`
 *    context-menu action (this phase uses ONE scope — Phase 16 adds the rest;
 *    Phase 11 seeds a snapshot from the clicked-object {@link Handle} the handler
 *    already accepts but currently ignores);
 *  - opening the chat modal **fire-and-forget** in the launch handler. Spike 3.1
 *    proved that **awaiting** `showModalDialog` parks the host event loop (the
 *    promise resolves only on modal CLOSE), so the modal is opened with
 *    `void ...showModalDialog(...).then(onClose).catch(onError)` and **never**
 *    awaited. This is the one place the project's "no raw `.then()`" style rule
 *    is intentionally violated — awaiting here deadlocks the whole agent.
 *
 * Lifecycle model (documented so re-launch + double-launch are predictable):
 *  - **One server, reused** for the whole activation. **One {@link ChatSession}
 *    per open modal**, created when the modal opens and `dispose()`d when it
 *    closes (the `showModalDialog` promise resolving). A fresh launch builds a
 *    fresh session against the same server, so each chat starts clean.
 *  - **Double-launch is a no-op:** if the user triggers the action while a modal
 *    is already open, we log and return rather than opening a second modal or
 *    leaking a second session (the SDK exposes no "focus existing modal" call).
 *  - On modal close we dispose the session and clear the open flag, so the next
 *    launch opens cleanly.
 *
 * **Key discipline (§10):** the Anthropic API key never crosses into anything the
 * webview receives — this module only passes the server's nonce connect URL to
 * `showModalDialog`; the key stays in Node, inside the {@link ChatSession}.
 *
 * The host's only log sink is `console.*` (code-style "Error handling"), so every
 * caught failure logs structured context rather than throwing into the host.
 */

import type { ExtensionContext, Handle } from "@ableton-extensions/sdk";

import { TransportServer } from "./server.js";
import { ChatSession } from "./session.js";

/**
 * The SDK API version this extension is pinned to (matches the
 * `initialize(activation, "1.0.0")` call in `activate`). The launch wiring is
 * concrete on this version because the `ContextMenuScope` string literals (e.g.
 * `"AudioTrack"`) only exist for `"1.0.0"`; a free generic version would not
 * accept them.
 */
type LaunchApiVersion = "1.0.0";

/** Log prefix mirroring the host's `console.*` convention. */
const LOG_PREFIX = "[launch]";

/** Command id Live invokes when the context-menu action is triggered. */
const LAUNCH_COMMAND_ID = "live.launchAgent";

/** Human-readable title shown in Live's context menu for the action. */
const LAUNCH_TITLE = "Chat with Claude…";

/**
 * Single context-menu scope wired this phase. Phase 16 registers the remaining
 * §16 scopes against the same command; the handler already tolerates any
 * clicked-object argument (it ignores it until Phase 11 seeds a snapshot).
 */
const LAUNCH_SCOPE = "AudioTrack" as const;

/** Modal dimensions — the design-system default (§11 / DESIGN_SYSTEM). */
const MODAL_WIDTH = 420;
const MODAL_HEIGHT = 560;

/**
 * Handle to the running launch wiring, returned by {@link startLaunchWiring} so
 * the caller (or a future deactivate path) can tear it down. Phase 1's `activate`
 * has no deactivate hook, but exposing teardown keeps the server lifecycle
 * explicit and lets activation perform best-effort cleanup on a partial failure.
 */
export interface LaunchHandle {
  /** The long-lived transport server backing every modal this session. */
  readonly server: TransportServer;
  /**
   * Tear everything down: dispose any open session, unregister the context-menu
   * action, and close the server. Best-effort and idempotent; never throws.
   */
  dispose(): Promise<void>;
}

/**
 * Start the Outcome-D launch wiring: bring up the transport server, register the
 * `live.launchAgent` command + `AudioTrack` context-menu action, and arm the
 * fire-and-forget modal open.
 *
 * Awaits only the server `start()` and the context-menu registration — never the
 * modal (which is opened later, in the launch handler, and never awaited). On any
 * failure during setup the partially-started server is closed (best-effort) and
 * the error is rethrown so `activate()` can log it.
 *
 * @param ctx The initialized SDK extension context (pinned to API `"1.0.0"`).
 * @returns A {@link LaunchHandle} for teardown.
 */
export async function startLaunchWiring(
  ctx: ExtensionContext<LaunchApiVersion>
): Promise<LaunchHandle> {
  const server = new TransportServer();

  let url: string;
  try {
    ({ url } = await server.start());
  } catch (err) {
    console.error(`${LOG_PREFIX} transport server failed to start`, err);
    // Nothing else is wired yet; best-effort close so no socket lingers.
    await server.close().catch((closeErr) => {
      console.error(
        `${LOG_PREFIX} cleanup close after start failure`,
        closeErr
      );
    });
    throw err instanceof Error ? err : new Error(String(err));
  }

  // Per-activation launch state. `modalOpen` guards against double-launch;
  // `session` is the current modal's session (one per open) or null when closed.
  let modalOpen = false;
  let session: ChatSession<LaunchApiVersion> | null = null;

  /**
   * The command handler Live invokes on the context-menu action. For object
   * scopes (like `AudioTrack`) Live passes the clicked object's {@link Handle} as
   * the first argument. We accept it but ignore it this phase — Phase 11 will use
   * it to scope the initial snapshot from the clicked track. Opens the modal
   * fire-and-forget.
   *
   * The callback signature matches the SDK's `registerCommand` contract exactly
   * (`(...args: unknown[]) => void`); the first arg, when present, is the clicked
   * `AudioTrack` {@link Handle}. We capture it for Phase 11 but do not read it.
   *
   * @param args Live's command arguments; `args[0]` is the clicked {@link Handle}.
   */
  const onLaunch = (...args: unknown[]): void => {
    // The clicked-object handle (Phase 11 uses it to scope the snapshot). Cast
    // is sound: the SDK passes the triggered object's handle as `args[0]` for
    // object scopes like `AudioTrack`. Captured but intentionally unused now.
    const clickedObject = args[0] as Handle | undefined;
    void clickedObject;

    if (modalOpen) {
      // Double-launch: a modal is already open. The SDK offers no "focus modal"
      // call, so the correct, non-crashing behavior is to no-op.
      console.debug(`${LOG_PREFIX} launch ignored — modal already open`);
      return;
    }
    modalOpen = true;

    // Build the session BEFORE opening the modal so its `server.onMessage`
    // dispatcher is wired by the time the webview connects and sends `ready`.
    const activeSession = new ChatSession<LaunchApiVersion>(ctx, server);
    session = activeSession;

    const onClose = (): void => {
      console.debug(`${LOG_PREFIX} modal closed — disposing session`);
      activeSession.dispose();
      if (session === activeSession) {
        session = null;
      }
      modalOpen = false;
    };

    const onError = (err: unknown): void => {
      console.error(`${LOG_PREFIX} showModalDialog rejected`, err);
      activeSession.dispose();
      if (session === activeSession) {
        session = null;
      }
      modalOpen = false;
    };

    // FIRE-AND-FORGET — MUST NOT be awaited. Spike 3.1: awaiting this parks the
    // host event loop until the modal closes, deadlocking the agent. The promise
    // resolves on modal CLOSE; we treat that as teardown via `onClose`.
    void ctx.ui
      .showModalDialog(url, MODAL_WIDTH, MODAL_HEIGHT)
      .then(onClose)
      .catch(onError);
  };

  ctx.commands.registerCommand(LAUNCH_COMMAND_ID, onLaunch);

  let unregisterAction: () => Promise<void>;
  try {
    unregisterAction = await ctx.ui.registerContextMenuAction(
      LAUNCH_SCOPE,
      LAUNCH_TITLE,
      LAUNCH_COMMAND_ID
    );
  } catch (err) {
    console.error(
      `${LOG_PREFIX} failed to register "${LAUNCH_COMMAND_ID}" on ${LAUNCH_SCOPE}`,
      err
    );
    await server.close().catch((closeErr) => {
      console.error(
        `${LOG_PREFIX} cleanup close after register failure`,
        closeErr
      );
    });
    throw err instanceof Error ? err : new Error(String(err));
  }

  console.log(`${LOG_PREFIX} ready — "${LAUNCH_TITLE}" on ${LAUNCH_SCOPE}`);

  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) {
      return;
    }
    disposed = true;
    if (session !== null) {
      session.dispose();
      session = null;
    }
    modalOpen = false;
    try {
      await unregisterAction();
    } catch (err) {
      console.error(
        `${LOG_PREFIX} failed to unregister context-menu action`,
        err
      );
    }
    await server.close().catch((err) => {
      console.error(`${LOG_PREFIX} failed to close transport server`, err);
    });
  };

  return { server, dispose };
}
