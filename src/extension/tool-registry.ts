/**
 * Tool registry — the {@link ToolRuntime} implementation (Phase 5 Task 2,
 * ARCHITECTURE §8, §7, §6).
 *
 * Implements the seam the agent loop drives (`agent-loop.ts`):
 *  - {@link LiveToolRuntime.toolDefinitions} returns the shared {@link TOOL_DEFINITIONS}
 *    verbatim (NO `cache_control` — `claude-client.ts` stamps the final breakpoint,
 *    §15.1);
 *  - {@link LiveToolRuntime.classify} delegates to the shared {@link classify};
 *  - {@link LiveToolRuntime.executeRead} dispatches one read executor immediately;
 *  - {@link LiveToolRuntime.flushMutations} prepares every queued mutation (resolve
 *    refs, read state, validate — all OUTSIDE the transaction), checks the abort
 *    signal, then opens ONE `ctx.withinTransaction(...)` for the whole batch: each
 *    prepared plan's `run()` launches its sync setters / async ops, the callback
 *    `return`s `Promise.all([...])` of every launched op (never `await`s inside,
 *    §7), the transaction is awaited, and each call's `finalize()` builds its
 *    `tool_result` — in the SAME order as `calls`.
 *
 * ## Create-then-configure (named `live_create`, §7)
 * No SDK create method accepts a name at creation, so a named `live_create` finalize
 * locates the new object and queues a {@link PendingRename} instead of naming it
 * inline. After the create transaction settles, the registry applies EVERY queued
 * name in ONE shared second `withinTransaction` (so a batch with named creates costs
 * at most TWO undo steps, never one per name; a batch with no named creates stays at
 * exactly one — the rename transaction is skipped). The rename callbacks are
 * synchronous (`obj.name = ...`); the transaction itself is awaited (never `await`
 * inside, §7). The abort signal is re-checked BEFORE opening the rename transaction
 * — if cancelled between create and rename, every pending name is skipped and the
 * created object's ref is returned un-renamed with an honest note (§9).
 *
 * The runtime NEVER throws to the loop: a per-call failure becomes that call's
 * structured-error payload, and an unexpected transaction-level throw maps every
 * pending call to an `sdk_error` payload (R5: the transaction rolled back atomically,
 * so reporting failure for the whole batch is correct).
 */

import type { ApiVersion, ExtensionContext } from "@ableton-extensions/sdk";

import type Anthropic from "@anthropic-ai/sdk";

import type { ToolCall, ToolResultPayload, ToolRuntime } from "./agent-loop.js";
import { ReferenceTable } from "./references.js";
import { classify, TOOL_DEFINITIONS } from "../shared/tools.js";
import {
  executeGetClip,
  executeGetDeviceParams,
  executeGetProject,
  executeGetTrack,
  executeRenderAudio,
} from "./executors/read.js";
import {
  prepareCreate,
  prepareCreateClip,
  prepareDelete,
  prepareEditMidiNotes,
  prepareImportAudio,
  prepareInsertDevice,
  prepareModifyDeviceChain,
  prepareReplaceSample,
  prepareSetParam,
  prepareUpdateClip,
  prepareUpdateTrack,
  type MutationPlan,
  type PendingRename,
  type Prepared,
} from "./executors/mutation.js";
import { errorMessage, fail, sdkError } from "./executors/shared.js";

/**
 * The production {@link ToolRuntime}: wraps the SDK {@link ExtensionContext} and a
 * turn-scoped {@link ReferenceTable}. Construct one per agent turn (the table is
 * turn-scoped, §6).
 *
 * @typeParam V The SDK API version (defaults to the host's; tests pass the fake's).
 */
export class LiveToolRuntime<V extends ApiVersion> implements ToolRuntime {
  /**
   * @param ctx   The SDK extension context (real host or the test fake).
   * @param refs  The turn-scoped reference table (mints created refs, shifts on
   *              delete). Defaults to a fresh table.
   * @param signal Optional cancellation signal; re-checked before opening the
   *              transaction (§7 / R5 — never a half-applied batch on cancel).
   */
  constructor(
    private readonly ctx: ExtensionContext<V>,
    private readonly refs: ReferenceTable = new ReferenceTable(),
    private readonly signal?: AbortSignal
  ) {}

  /** The shared tool definitions (the cacheable tools prefix; §15.1). */
  toolDefinitions(): Anthropic.ToolUnion[] {
    // `TOOL_DEFINITIONS` is `readonly Anthropic.Tool[]`; `Tool` is a member of the
    // `ToolUnion`, so a shallow copy widens cleanly without `cache_control`.
    return [...TOOL_DEFINITIONS];
  }

  /** Read vs mutation classification (the loop partitions on this; §8/§4). */
  classify(toolName: string): "read" | "mutation" {
    return classify(toolName);
  }

  /**
   * Execute one read tool immediately (§8.1). Returns a structured payload;
   * never throws. `live_get_device_params` is the only async read (lazy
   * `getValue()` fan-out, §15).
   */
  async executeRead(call: ToolCall): Promise<ToolResultPayload> {
    try {
      switch (call.name) {
        case "live_get_project":
          return executeGetProject(this.ctx, call);
        case "live_get_track":
          return executeGetTrack(this.ctx, call);
        case "live_get_clip":
          return executeGetClip(this.ctx, call);
        case "live_get_device_params":
          return await executeGetDeviceParams(this.ctx, call);
        case "live_render_audio":
          return executeRenderAudio(call);
        default:
          return fail(call.id, {
            error: "unknown_tool",
            detail: `"${call.name}" is not a read tool`,
            hint: "use a registered live_get_* tool",
          });
      }
    } catch (e) {
      // Defensive: executors are written not to throw, but a getter surprise
      // must still become a structured error, never an unhandled rejection.
      return fail(
        call.id,
        sdkError(`read "${call.name}" failed: ${errorMessage(e)}`)
      );
    }
  }

  /**
   * Flush ALL queued mutations of one loop iteration as ONE undo step (§7).
   *
   * Sequence:
   *  1. **prepare** every call OUTSIDE the transaction (resolve refs, read state,
   *     validate). A prepare failure is recorded as that call's error payload.
   *  2. **abort check** — re-check the signal BEFORE opening the transaction
   *     (§7/R5). If aborted, return an `aborted` error for every not-yet-errored
   *     call; nothing is applied.
   *  3. **transaction** — open ONE `withinTransaction`; inside, call each plan's
   *     `run()` (sync-launch only, NO await) and collect the launched promises;
   *     `return Promise.all(promises)` from the callback. Await the transaction.
   *  4. **finalize** — build each call's payload in `calls` order; for prepared
   *     plans use the per-plan resolved value, for prepare-errors reuse the
   *     recorded error.
   *
   * Returns one payload per call, in the SAME order as `calls`. Never throws.
   */
  async flushMutations(calls: ToolCall[]): Promise<ToolResultPayload[]> {
    // Collects name-sets for named `live_create`s (applied in a SECOND txn, §7).
    const pendingRenames: PendingRename[] = [];

    // 1. Prepare every call outside the transaction.
    const prepared: Prepared[] = calls.map((call) =>
      this.prepare(call, pendingRenames)
    );

    // 2. Abort check BEFORE opening the transaction (§7 / R5).
    if (this.signal?.aborted) {
      return calls.map((call, i) => {
        const p = prepared[i];
        // Preserve a prepare-error if one already occurred; else report aborted.
        if (p.kind === "error") {
          return p.payload;
        }
        return fail(call.id, {
          error: "aborted",
          detail: "the mutation batch was cancelled before it was applied",
          hint: "no changes were made; re-issue the action to retry",
        });
      });
    }

    // Index the runnable plans so the transaction launches only those.
    const plans: { index: number; plan: MutationPlan }[] = [];
    prepared.forEach((p, index) => {
      if (p.kind === "plan") {
        plans.push({ index, plan: p.plan });
      }
    });

    // No runnable mutations (all prepare-errored) → return the errors directly.
    if (plans.length === 0) {
      return prepared.map((p, i) =>
        p.kind === "error"
          ? p.payload
          : fail(calls[i].id, sdkError("mutation produced no plan"))
      );
    }

    // 3. ONE transaction for the whole batch. run() is sync-launch; we collect the
    //    launched promises and Promise.all them as the callback's RETURN value —
    //    never awaiting inside the callback (§7).
    const finalizers = new Array<
      ((resolved: unknown) => ToolResultPayload) | null
    >(calls.length).fill(null);
    let resolvedValues: unknown[] = [];
    try {
      const batched = this.ctx.withinTransaction(() => {
        const promises: Promise<unknown>[] = [];
        // Map each plan's slot in the promises array back to its call index.
        const slotToIndex: number[] = [];
        for (const { index, plan } of plans) {
          const { promise, finalize } = plan.run();
          finalizers[index] = finalize;
          if (promise !== undefined) {
            slotToIndex.push(index);
            promises.push(promise);
          } else {
            // Sync-only mutation: finalize with `undefined` immediately after the
            // transaction settles (no promise to await).
            slotToIndex.push(-1 - index); // negative-encoded "no promise" marker
          }
        }
        // Return a promise that resolves to a per-index value map.
        return Promise.all(promises).then((settled) => ({
          settled,
          slotToIndex,
        }));
      });
      const { settled, slotToIndex } = await batched;
      // Distribute resolved values back to their call indices.
      resolvedValues = new Array<unknown>(calls.length).fill(undefined);
      let settledCursor = 0;
      for (const slot of slotToIndex) {
        if (slot >= 0) {
          resolvedValues[slot] = settled[settledCursor++];
        }
        // negative slots are sync-only → leave `undefined`.
      }
    } catch (e) {
      // R5: a throw rolls the whole transaction back atomically. Report every
      // runnable call as failed (prepare-errors keep their own payload).
      const detail = `transaction rolled back: ${errorMessage(e)}`;
      return calls.map((call, i) => {
        const p = prepared[i];
        if (p.kind === "error") {
          return p.payload;
        }
        return fail(call.id, sdkError(detail));
      });
    }

    // 4. Finalize in `calls` order. A named `live_create`'s finalize queues a
    //    PendingRename and returns a PROVISIONAL payload (overwritten in step 5).
    const payloads: ToolResultPayload[] = calls.map((call, i) => {
      const p = prepared[i];
      if (p.kind === "error") {
        return p.payload;
      }
      const finalize = finalizers[i];
      if (finalize === null) {
        return fail(call.id, sdkError("mutation plan did not run"));
      }
      try {
        return finalize(resolvedValues[i]);
      } catch (e) {
        return fail(
          call.id,
          sdkError(`failed to finalize "${call.name}": ${errorMessage(e)}`)
        );
      }
    });

    // 5. Apply queued names in ONE shared SECOND transaction (create-then-configure,
    //    §7). A batch with no named creates skips this entirely (stays one undo step).
    if (pendingRenames.length > 0) {
      this.applyPendingRenames(pendingRenames, calls, payloads);
    }

    return payloads;
  }

  /**
   * Apply every queued name-set in ONE second `withinTransaction` (§7), then
   * replace each create's provisional payload with its final one (fresh ref
   * reflecting the applied name). Re-checks the abort signal BEFORE opening the
   * transaction — if cancelled, no name is applied and each created object's ref is
   * returned un-renamed with an honest note (§9). The rename callbacks are
   * synchronous and so is `withinTransaction` (it returns the callback's `void`
   * result), so this method needs no `await` — it never `await`s inside the
   * transaction (§7).
   */
  private applyPendingRenames(
    pendingRenames: PendingRename[],
    calls: ToolCall[],
    payloads: ToolResultPayload[]
  ): void {
    // Abort BETWEEN create and rename → skip the rename, report honestly (§9).
    if (this.signal?.aborted) {
      this.replaceRenamePayloads(pendingRenames, calls, payloads, false);
      return;
    }
    try {
      // Synchronous setters only; await the transaction itself, not inside it (§7).
      this.ctx.withinTransaction(() => {
        for (const rename of pendingRenames) {
          rename.object.name = rename.desiredName;
        }
      });
      this.replaceRenamePayloads(pendingRenames, calls, payloads, true);
    } catch (e) {
      // The rename transaction rolled back: names were NOT applied — but the
      // objects WERE created (txn #1 committed atomically, R5). Report each as an
      // honest SUCCESS with the un-renamed ref + a "naming failed" note, NOT a pure
      // error: a bare error would hide the created object and risk a duplicate
      // re-create (the inverse §9 violation — claiming failure for a change that
      // did happen).
      const note = `created, but name not applied — naming failed: ${errorMessage(
        e
      )}`;
      this.replaceRenamePayloads(pendingRenames, calls, payloads, false, note);
    }
  }

  /**
   * Replace each pending-rename call's payload with its final result. When
   * `applied` is false, `notApplied` is the honest "name not applied" note
   * distinguishing the cancel path (default note) from the throw path.
   */
  private replaceRenamePayloads(
    pendingRenames: PendingRename[],
    calls: ToolCall[],
    payloads: ToolResultPayload[],
    applied: boolean,
    notApplied?: string
  ): void {
    for (const rename of pendingRenames) {
      const i = calls.findIndex((c) => c.id === rename.callId);
      if (i >= 0) {
        payloads[i] = rename.buildResult(applied, notApplied);
      }
    }
  }

  /** Dispatch one mutation tool to its prepare function (resolve/validate only). */
  private prepare(call: ToolCall, pendingRenames: PendingRename[]): Prepared {
    switch (call.name) {
      case "live_update_track":
        return prepareUpdateTrack(this.ctx, call);
      case "live_update_clip":
        return prepareUpdateClip(this.ctx, call);
      case "live_set_param":
        return prepareSetParam(this.ctx, call);
      case "live_edit_midi_notes":
        return prepareEditMidiNotes(this.ctx, call);
      case "live_create":
        return prepareCreate(this.ctx, call, this.refs, pendingRenames);
      case "live_create_clip":
        return prepareCreateClip(this.ctx, call);
      case "live_insert_device":
        return prepareInsertDevice(this.ctx, call);
      case "live_modify_device_chain":
        return prepareModifyDeviceChain(this.ctx, call);
      case "live_replace_sample":
        return prepareReplaceSample(call);
      case "live_delete":
        return prepareDelete(this.ctx, call, this.refs);
      case "live_import_audio":
        return prepareImportAudio(call);
      default:
        return {
          kind: "error",
          payload: fail(call.id, {
            error: "unknown_tool",
            detail: `"${call.name}" is not a mutation tool`,
            hint: "use a registered live_* mutation tool",
          }),
        };
    }
  }
}
