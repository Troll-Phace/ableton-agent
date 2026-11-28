# Phase 15.3 — standalone companion feasibility operator runbook

**Scope:** This reviewed local package tests the documented ChatGPT sign-in and synthetic Responses path as an ordinary foreground macOS process, independently of Ableton Live. It is not a Live extension, service, privileged helper, production migration, or Live bridge. Live can remain closed. No automatic install or launch, no API key, and no paid fallback.

## Package and prerequisite verification

The offline build command in the repository root is:

```sh
npx --no-install tsx scripts/build-chatgpt-companion.ts
```

The package is produced in `dist/chatgpt-companion/0.0.3/`. Copy or keep that directory as a unit. It contains `companion.cjs` (including the static control HTML), this runbook, project license, exact third-party notices, dependency inventory, and `SHA256SUMS`. It does not contain the Ableton SDK, account credentials, a Node installer, or production extension files. The package requires Node **24.14.1 or later** on macOS and a controlling interactive terminal. No permission, Gatekeeper or sandbox changes are part of this test.

Before running, Dot and Anthony review the exact version/build ID and digest. From the package directory:

```sh
shasum -a 256 -c SHA256SUMS
command -v node
node --version
node companion.cjs --version
```

Compare the entry digest and build ID with the approved artifact evidence. Record the actual Node binary and version (locally; redact any user-specific path when reporting). If the file hashes do not match, the Node version is unsupported, or the binary is not the reviewed ordinary-user executable, stop. Do not run as root or with elevated permissions.

## Foreground launch and pairing

With user authorization, in the same interactive terminal:

```sh
node companion.cjs
```

The version/build identity is printed first. The singleton binds the fixed `127.0.0.1:17863` port before opening its own storage. A port collision is a stop condition, not a request to choose another port or terminate another process. The companion uses the ordinary system browser to open the fixed control panel. No account sign-in or inference starts at launch.

Enter the terminal's one-time pairing code at the local panel. Do not share, record, copy into logs, or send the code. The code expires in two minutes or after five failed attempts; it cannot be reused. It establishes an ephemeral HttpOnly SameSite=Strict local session and an in-memory CSRF token, not an OpenAI credential. Browser reload can rebootstrap only the current valid local session. If pairing or the session expires, stop/relaunch instead of attempting weaker access. The panel is served only on the fixed loopback origin. The session and foreground process time out after 15 minutes without authenticated operator activity; passive status polling does not reset that deadline.

## Credential-free and official-route gates

1. Select **Run preflight**. All checks are actual rather than assumed: protected storage, file and directory synchronization, atomic replacement, native synthetic streaming and pending-read abort, callback binding, and bundled JWT verification.
2. A fresh storage root will report `restart_required`. Select **Stop (preserve credentials for restart)**, confirm the terminal reports cleanup complete, then relaunch the same approved package and pair again. Repeat preflight. The synthetic marker proves process restart, not power-loss safety.
3. Once every local gate passes, that explicit preflight action may retrieve bounded official HTTPS discovery/JWKS. It does not start OAuth. Stop on storage, permission, TLS, transport, discovery or verification failure. Do not change directories, weaken storage checks, use alternate endpoints, or substitute API credits.
4. Only after Dot reviews those results and Anthony personally agrees to consent, select **Continue with ChatGPT**. This uses the documented public-client flow with a separate loopback OAuth callback. Anthony personally reviews the consent screen; do not share callback URLs, codes, tokens or account identity.
5. A successful connection must have the ChatGPT plan-use scope. The MIT source license is the reviewed integration basis, not proof of account entitlement, registration acceptance or a supported plan. This spike discards the ID token after validation; returning sign-in uses the saved issued client ID and stable companion host ID, without fabricating an ID-token hint.
6. For the planned persistence test, stop (preserving validated credentials), relaunch, pair again, and run preflight. Verify the persisted connection and perform only one explicit refresh. A failed terminal refresh blocks dependent work.

Versions 0.0.2 and 0.0.3 use the same fixed private root: `~/Library/Ableton Agent Feasibility Companion/`, with child `p15-3-signin`. Version 0.0.1 correctly refused an other-writable Application Support ancestor before creating its root or starting authorization. The revised root is directly below the owner-private Library; this is a new reviewed fixed layout, not a runtime fallback or migration. Do not launch the retained 0.0.1 or 0.0.2 artifacts, alter existing directory permissions, or access/copy files from the earlier location. The companion still checks ownership, no symlinks and no group/other write permission on home and Library; its root and credential child must both be exactly 0700. It is distinct from the installed Live fixture.

Version 0.0.3 corrects the official authorization host-ID format. The [OpenAI host-ID documentation](https://developers.openai.com/siwc/token-sharing-open-source#a-client-vs-an-agent-host) requires a UUID-based identifier to be a persisted UUIDv4 URI. Before authorization, a valid legacy bare UUIDv4 record is atomically replaced by its canonical `urn:uuid:` URI using the same UUID, not a new host identity. Invalid host records fail closed. The durable inference budget is unchanged and no account record is migrated. Both initial registration and returning authorization use the same persisted URI. Do not edit or remove the old host record yourself; the reviewed storage operation performs this migration.

Do not open, copy or edit credential files or reset the budget. A synchronization failure after a rename is an uncertain commit; stop and review rather than assuming rollback. The validated persisted record and counter are reconciled on restart.

## Explicit plan-only synthetic experiment

After successful restart/refresh:

1. Load the account-specific model catalog and explicitly choose an available model; no default model is selected.
2. Open the fixed **Manage usage** link (ChatGPT settings) and independently verify plan-only use and disabled credit fallback. In the companion confirm both statements. The application confirmation does not itself control provider billing settings.
3. Run the fixed synthetic function round trip. It uses two durable attempts, first for `feasibility.echo({value:"p15_3"})` and second for its constant output/acknowledgment.
4. Only if the round trip completes, run the final synthetic cancellation check. It uses the third durable attempt. If cancellation loses the race, record "not demonstrated" and stop; do not send a fourth request.

Each reservation is persisted before dispatch. Failed or uncertain sends count; no automatic replay, model substitution, counter reset, alternate provider or paid fallback exists. Denial, invalid identity, missing plan scope, account/eligibility rejection, usage limits or unsupported capability block dependent work.

## Cleanup and evidence

Select **Sign out and clear local credentials** when the experiment ends. Verify the sanitized local cleanup result and remote revocation result separately; unconfirmed remote revocation is not success. Then select **Stop** and verify terminal cleanup status. Ctrl-C/SIGTERM and idle timeout cancel work and stop the foreground listener but do not revoke or clear credentials. Normal stop preserves validated credentials solely for the planned restart test; a crash may leave protected credentials. If necessary, reopen the same reviewed package, pair, and use explicit sign-out; do not manually tamper with its records.

Report only the build ID, checksum, Node version, coarse preflight evidence, gate outcomes, attempt count, cleanup and revocation classifications. Never share pairing codes, cookie/CSRF values, credentials, registration IDs, raw account identity, provider content or exceptions. If a stop result says `pending`, the CLI exits nonzero; do not assume cleanup or revocation completed.

**GO means standalone companion feasibility only.** It does not establish a Live-facing authentication bridge or preserved Live tool behavior. Production integration remains a separate reviewed phase.
