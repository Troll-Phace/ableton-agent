# Approved Phase 15.3 F3C companion feasibility execution contract

Approved by coordinator 2026-11-28 after owner explicitly chose the standalone local companion. No Live-facing bridge or production integration in this checkpoint. Companion operates only with normal user permissions in its own foreground process; no sandbox bypass. Live personal consent and inference remain separately gated.

**F3C should be a user-launched standalone companion feasibility application, with no Live bridge in this checkpoint.** Reuse the reviewed OAuth/Responses core through explicit dependency injection; keep the installed fixture and production extension unchanged.

Verified clean branch: `phase/15-chatgpt-local-companion-feasibility`, HEAD `99541cf`, containing PR #8 merge `0909e47`. The native-host blocker remains specifically **durable file synchronization denied before OAuth**. No official HTTPS, account authorization, or inference success has been established.

I used the phase-plan contract and inspected the existing S2/S3 implementation. No files changed or live actions performed.

**Scope and architecture**

Anthony starts the companion himself as a foreground Node application from a reviewed local package. It runs with his ordinary OS permissions, owns its storage, and presents a local browser control panel. It is not launched by Live and does not receive filesystem operations delegated from Live.

No daemon, launch agent, privileged helper, background installation, permission changes, arbitrary process execution, or production integration. Live may remain closed throughout this checkpoint.

The current MIT license, merged through PR #7, resolves the earlier absent-license prerequisite. Record that source basis; account/workspace eligibility and actual route acceptance remain unverified. Official preview documentation still distinguishes eligible users and participating open-source/private clients. [Current eligibility](https://developers.openai.com/siwc/quickstart)

**Task ownership**

| ID | Owner | Exact files and outcome |
|---|---|---|
| C1 | Dot | New `docs/active/phase-15.3-companion-plan.md`; append F3C evidence to `docs/active/phase-15.3-results.md`; reconcile `.claude/state/progress.md` and `docs/CHATGPT_MIGRATION.md`. Preserve all native-host evidence. |
| C2 | Backend, `gpt-6.2-sol/high` | New `src/companion-feasibility/{main,runtime,storage,preflight}.ts`. Foreground lifecycle, private storage root, strict durability adapter, actual credential-free checks. |
| C3 | Backend, same role | New `src/companion-feasibility/{control-server,contracts}.ts` and `control-view.html`. Authenticated browser control surface and reviewed S2/S3 composition. |
| C4 | Backend, same role | New `scripts/build-chatgpt-companion.ts`, `docs/active/phase-15.3-companion-runbook.md`. Reproducible bundle inputs, dependency notices, installation/start/stop instructions. |
| C5 | Independent test-engineer, `gpt-6.2-sol/high` | New `tests/chatgpt-companion-{storage,control,runtime}.test.ts`, `tests/fixtures/chatgpt-companion.ts`. Independent regression, denial, restart, budget, package-isolation tests. |
| C6 | Dot | New `tsconfig.companion.json`; update root references and `tsconfig.tests.json` include only as needed. Integrate, verify, approve artifact for operator use. |
| C7 | Dot + Anthony | Credential-free packaged smoke, personal authorization, restart/refresh, three synthetic requests, cleanup. |
| C8 | Read-only code-reviewer + Dot | One close review; resolve blocking findings; checkpoint PR and stop for Anthony’s review. |

C2 publishes composition/storage interfaces before C3/C5. Backend and test then work independently with disjoint ownership. No new dependency is expected; retain the exact existing verifier pins.

**Reuse boundaries**

Import these existing SDK-free modules explicitly:

- `signin-contracts.ts`, `official-http.ts`, `id-token.ts`
- `oauth.ts`, `credential-store.ts`
- `responses.ts`, `signin-session.ts`
- The cancellation primitive from `contracts.ts`, if needed.

Do not import `feasibility/index.ts`, installed-host preflight wiring, runtime shim, SDK initialization, production config/session, executors, snapshots, or transcripts. Keep the existing modules in place; a shared-core relocation belongs to a later implementation phase.

`runtime.ts` constructs `OfficialHttp`, `OidcIdTokenVerifier`, `CredentialStore`, `OAuthLifecycle`, `SyntheticResponses`, and `SigninSession` with ordinary Node dependencies. Supply a **real companion preflight**, not hardcoded `HostPreflightEvidence` booleans.

If reuse requires changing shared behavior, stop that portion and give Dot the exact reason and regression impact before expanding ownership. In particular, do not weaken the store to make the new runtime pass.

**Companion storage contract**

Use a fixed application-owned root:

`~/Library/Application Support/Ableton Agent Feasibility Companion/`

Create only that directory tree under the user’s account; use the existing `p15-3-signin` child for reviewed records. Never read or copy the Live fixture’s storage, API keys, `.env`, existing auth tokens, or transcripts.

Before OAuth, establish:

- Owner-only root and credential directory; regular owner-only files.
- No-follow/exclusive creation, ownership and identity checks, bounded enumeration.
- Exact writes, file `fsync`, atomic same-directory rename, destination verification.
- Directory synchronization after rename and credential deletion, so the companion does not overstate rename/deletion durability.
- Fail-closed cleanup obligations across restart.
- No fallback path when any protection or synchronization is unavailable.

Implement a narrow filesystem adapter around the existing store that adds parent-directory synchronization after successful rename/unlink. It accepts only paths already confined to the companion store. A failure after rename is an **uncertain durable commit**, not a safe rollback: block further inference, preserve the record, and reconcile on restart without decrementing the request counter.

Use a fixed-port exclusive loopback listener as the process singleton guard, acquired before storage access. A second process or occupied port exits without touching credentials; no automatic alternate control port or stale-lock takeover. This avoids concurrent refresh/counter writers without introducing another service.

Credential-free testing must exercise write/sync/replace/read/delete and a two-process restart using synthetic values. File synchronization and process-restart proof do not justify claims of power-loss testing.

**Authenticated local control surface**

No Live-facing endpoint is needed. The only IPC is between the companion and its own control panel.

Bind the control server to `127.0.0.1` only; use a documented fixed high port, such as `17863`, with failure on collision. The OAuth callback uses its separate ephemeral loopback listener.

On an interactive terminal launch:

1. Generate a one-time 256-bit pairing code.
2. Show it only in the controlling terminal, never persistent logs or command arguments.
3. Open the fixed credential-free control-panel URL through `/usr/bin/open`, using argument-array invocation without a shell.
4. Anthony enters the pairing code locally.
5. Consume it once and establish an HttpOnly, SameSite=Strict session cookie plus a separate CSRF token.

Pairing expires after two minutes and five failed attempts. Noninteractive startup does not print secrets or start an unattended authorization flow.

Validate exact Host and Origin, reject cross-origin requests and CORS, require JSON and CSRF protection for actions, bound request bodies, and serve only embedded assets. No generic filesystem, URL-fetch, shell, code, prompt, or tool-execution endpoint.

Allow only fixed typed actions:

`status`, `preflight`, `sign_in`, `refresh`, `load_models`, `select_model`, `confirm_plan_only`, `run_roundtrip`, `run_cancellation`, `cancel`, `sign_out`, `quit`.

Validate model selection against the retrieved catalog. Eligibility is host-owned configuration derived from recorded evidence, never a browser-supplied flag.

Use the existing sanitized `SigninSnapshot`; no account identity, registration ID, OAuth token/code, authorization URL, raw provider text, or exception crosses this control interface. The browser stores no credentials or durable authentication state.

**OAuth and provider contract**

Retain the reviewed public-client flow: official authorize/token endpoints, PKCE S256, state/nonce validation, issued per-account client ID, stable companion host ID, loopback callback, validated ID token, and granted plan-use scope. New companion installation gets its own host lifecycle; do not copy or fabricate a prior registration. Anthony personally performs browser consent. [Official registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)

Preserve the established minimal fixture decision to discard the ID token after validation. Returning authorization can use the saved issued client ID and stable host ID without an ID-token hint; never invent a hint. Document this narrower behavior rather than claiming the full future account-management feature.

Serialize refresh and atomically replace rotating credentials. Sign-out attempts official session revocation and clears local credentials; distinguish confirmed local cleanup from unconfirmed remote revocation. Cancellation/quit invalidates operation generations so late callbacks cannot restore credentials. [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)

Use account-specific model discovery and the public Responses endpoint with OAuth bearer authorization. Preserve `store:false`, `stream:true`, developer instructions, full explicit history, and namespaced synthetic function support. No alternate backend, API key, hosted tool, or unsupported request field. [Inference route](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [preview restrictions](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

The durable **three-request cap** remains:

1. Request the fixed `feasibility.echo({value:"p15_3"})` call.
2. Return its constant result with the exact call ID and required output/history items; require completed acknowledgment.
3. Attempt cancellation of a short synthetic response after streaming begins.

Reserve before dispatch; failed and uncertain sends count. No reset on restart, sign-out, model change, or refresh; no automatic inference retry. If cancellation loses a race to completion, report “not demonstrated” and stop—no fourth request.

Anthony explicitly confirms plan use and disabled credit fallback before inference. If that cannot be established, remain connected but do not run. No claims that an application-side checkbox independently controls provider billing settings.

**Lifecycle and failure behavior**

Foreground only, with visible version/build and explicit Stop/Sign out controls. A 15-minute idle timeout cancels active work and exits after bounded cleanup; no automatic relaunch.

`quit` preserves validated credentials solely for the planned restart test; label that clearly. `sign_out` clears credentials and reports revocation status. SIGINT/SIGTERM stops listeners/readers and cleans transient state, but does not falsely promise network revocation. A crash may leave protected credentials; the runbook explains reopening and signing out.

Denial, absent scope, invalid identity, eligibility rejection, usage limits, unsupported capability, TLS/permission failure, and terminal refresh failure block dependent work. Do not repeatedly prompt or switch billing routes. Temporary network failures do not themselves prove revocation. [Official recovery behavior](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)

**Independent verification**

Preserve all **1218 existing tests** and prior artifacts. Add tests for:

- Exact composition and absence of SDK/production imports.
- Strict root/path validation, file and directory sync failures, post-rename uncertainty, restart cleanup.
- Single-instance rejection before storage access.
- Pairing expiry/replay/rate limits; wrong Host/Origin; CSRF; oversized or unknown commands; cookie/session expiry.
- No auth/inference from startup, unauthenticated actions, or missing operator gates.
- Persistent three-attempt cap across separate processes and restart.
- Refresh/sign-out/cancel races and terminal shutdown.
- Synthetic valid JWT through the actual bundled verifier.
- Secret sentinel exclusion from UI, diagnostics, output, assets, and package.
- Credential-free packaged smoke with fake network/browser seams and no external traffic.

Run lint, full Vitest, typecheck, existing dev build, and the new build command:

`npx --no-install tsx scripts/build-chatgpt-companion.ts`

Package under ignored `dist/chatgpt-companion/0.0.1/`: bundled `.cjs` entry, embedded/local static assets, runbook, license notices, dependency inventory, source-derived build ID, SHA256 manifest. No bundled SDK, runtime credentials, Node installer, `.env`, or source-tree lookup. Record required Node version and actual operator binary; Anthony launches with the reviewed Node executable. No unsigned-app or Gatekeeper bypass instructions.

**Operator sequence and completion**

1. Dot approves contract; implementation and offline tests finish.
2. Review the packaged artifact before real credentials.
3. Anthony starts the foreground package; verify version/hash and normal OS identity.
4. Run credential-free local storage/restart, callback, synthetic streaming/abort, and verifier checks.
5. Run bounded official HTTPS discovery/JWKS preflight; stop on failure.
6. Hand control to Anthony for personal consent.
7. Verify granted scopes, protected persistence, restart, and one explicit refresh.
8. Anthony chooses the model and confirms plan-only settings.
9. Run the bounded synthetic requests.
10. Sign out; verify local cleanup, report revocation status, stop the process.
11. Record sanitized evidence and open the checkpoint PR.

**GO means standalone companion feasibility only.** It does not establish an authenticated Live bridge, production migration, or preserved end-to-end Live tool behavior. Those remain later owner-reviewed work. If companion storage or official access fails, preserve the precise blocker and stop; do not weaken durability or introduce another route.

## Scope correction after first operator launch (2026-11-28)

0.0.1 correctly refused the existing other-writable Application Support ancestor (mode0707), before any pairing or OAuth; original companion storage root did not exist. The next exact fixed root is instead `~/Library/Ableton Agent Feasibility Companion/` under verified private Library. This is a revised design, never an automatic fallback. All selected-ancestor ownership, no-symlink and write-mode checks, private root/child 0700, file/directory sync, and fail-closed uncertainty remain mandatory. Do not change permissions on existing user folders or migrate any data; no prior companion credentials exist. Package 0.0.2; preserve 0.0.1. Independently test unsafe unselected Application Support, actual selected ancestor failures, and restart durability.
