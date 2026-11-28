# Approved Phase 15.3 F3/F5 sign-in feasibility execution contract

Approved by coordinator 2026-11-27 for offline implementation only. Live OAuth is barred until official integration eligibility is established and Anthony personally consents. Any licensing change is separately owner-gated; dependency choice/version is verified by coordinator before addition. No actual provider request by implementors or tests.

**F3/F5 plan: isolated official sign-in and synthetic inference feasibility.** Dot may approve implementation and offline testing; live authorization remains blocked until eligibility is established and Anthony personally starts consent.

Verified clean checkout: `phase/15-chatgpt-signin-feasibility`, HEAD `1616815`, containing PR #6 merge `998cbcb`. F2C passed twice using local builtin constructors and native Fetch without global supplementation. No files changed, credentials accessed, authentication attempted, or provider requests made during planning.

**1. Eligibility gate—currently unresolved**

Current official documentation covers open-source and locally hosted apps, but the quickstart limits plan usage to all open-source partners and **selected private clients**. The absence of a repository license means public visibility is insufficient evidence that this application meets the open-source category. Local execution alone does not establish that it is a selected private client. [Overview](https://developers.openai.com/siwc/token-sharing-open-source), [current eligibility statement](https://developers.openai.com/siwc/quickstart)

Before actual OAuth, Dot must record one supported basis:

- Official confirmation that this locally hosted application qualifies under the preview; or
- Evidence of its selection/approval as a private client; or
- An independently owner-authorized licensing decision followed by verification against the applicable requirements.

Do not add a license, describe the project as qualifying open source, or use successful endpoint access as a substitute for integration eligibility. If the basis remains unresolved, finish the offline implementation/checkpoint and report **eligibility pending; live authorization not run**. Anthony’s account/workspace eligibility and granted plan permission remain additional runtime gates.

**2. Ownership and sequence**

| ID | Owner | Exact paths and deliverable |
|---|---|---|
| S1 | Dot | New `docs/active/phase-15.3-signin-plan.md`; update current summary and append evidence in `docs/active/phase-15.3-results.md`; update `.claude/state/progress.md`. Preserve original F2/F2C records. Record eligibility source and outstanding decisions. |
| S2 | Backend, `gpt-6.2-sol/high` | New `src/extension/feasibility/signin-contracts.ts`, `official-http.ts`, `credential-store.ts`, `oauth.ts`, `id-token.ts`. Implement bounded host-only lifecycle and injectable seams. |
| S3 | Backend, same role | New `src/extension/feasibility/responses.ts`, `signin-session.ts`. Implement account catalog, three-request budget, fixed function round trip, cancellation, and sanitized state projection. |
| S4 | Backend, same role | Modify fixture `index.ts` and `scripts/build-chatgpt-feasibility.ts`; new `src/extension/feasibility/signin-view.html`. Version `0.0.3`, nonce-protected controls, explicit operator gates. Preserve original probe modules. |
| S5 | Independent test-engineer, `gpt-6.2-sol/high` | New `tests/chatgpt-signin-{oauth,storage,responses,session}.test.ts`, `tests/fixtures/chatgpt-signin.ts`. Offline tests and package-isolation verification; no backend file ownership. |
| S6 | Dot | `package.json`, `package-lock.json` only for the reviewed JWT verification dependency; integrate build/test findings. |
| S7 | Dot + Anthony | Normal installed preflight, personal OAuth, restart/refresh, bounded inference, cleanup; record sanitized results. |
| S8 | Read-only code-reviewer + Dot | One close review, blocking corrections, final checks and checkpoint PR. Stop for Anthony’s review before advancing. |

S2 establishes interfaces before S3/S5. Backend and test may then work concurrently; Dot alone owns documentation and dependency changes. No production provider, tool, transcript, transport, or webview migration.

Select a bundled maintained JWT verifier using Node crypto—`jsonwebtoken`—rather than handwritten signature verification. Pin the reviewed version and lockfile resolution; bundle its dependency closure explicitly. Its verification interface supports algorithm, issuer, audience, and nonce constraints. Verify its actual installed-host operation before handling real tokens. Do not introduce OpenAI SDK, Undici, or external runtime module resolution. [Verifier documentation](https://github.com/auth0/node-jsonwebtoken)

**3. Interfaces and lifecycle**

All side effects are injected: native Fetch/controller, local URL/TextDecoder, Node crypto, filesystem, callback server, browser launcher, clock, and timers.

Host-only state:

```text
idle
→ preflight_ready
→ awaiting_consent
→ validating
→ connected
→ model_selected
→ running_roundtrip
→ roundtrip_complete
→ running_cancellation
→ finished
```

Explicit alternative states: `denied`, `plan_disabled`, `reconnect_required`, `blocked`, `cancelled`, `failed`, `signed_out`.

One authorization attempt and one network operation at a time. An operation-generation ID prevents late callbacks, completed refreshes, or streams from restoring a signed-out/cancelled session.

The UI receives only fixed state/error codes, a generic account label such as “Connection 1,” model display names/slugs, counters, and sanitized results. It never receives tokens, client/subject identifiers, state/nonce/verifier values, authorization URLs, token responses, or raw exceptions.

Use the proven **local-constructor lane only**. No global supplementation or fallback transport. Native Fetch uses string URLs, plain headers, default TLS validation, and `redirect:"error"`.

**4. Official authorization contract**

Use the system browser at `https://auth.openai.com/api/accounts/authorize`. Initial registration uses `dynamic_agent_client`, `agent_name_hint=Ableton Agent`, and a persisted UUID-based `ext_agent_host_id`. Start `http://127.0.0.1:<port>/auth/callback` first; generate fresh PKCE S256, state, and nonce. Request `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, resource `https://api.openai.com/v1`.

Consume a valid callback once. Validate state before errors; require the issued client ID for registration. Exchange at `https://auth.openai.com/api/accounts/oauth/token` using that ID, code, verifier, identical redirect URI, and resource. No client secret.

Validate signature, issuer, audience, expiry, and nonce; returning identity/client must match the selected registration. Require token-response plan-use scope before inference. Keep per-registration credentials protected and atomically written. [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)

Load official discovery from `https://auth.openai.com/.well-known/openid-configuration`; accept the documented issuer and HTTPS auth-origin endpoints only. Fetch JWKS through the bounded native HTTP seam. Reject token-supplied key URLs, ambiguous keys, unsigned tokens, unsupported algorithms, and malformed claims. The website documentation supplies the shared OIDC validation contract, not a replacement confidential-client registration flow. [Discovery and validation](https://developers.openai.com/siwc/website)

Callback hardening is implementation-specific: exact GET path, bounded query length, reject duplicate security parameters, no reflected values, no-store response, no third-party content. Wrong-state requests do not consume the valid pending attempt. Timeout after five minutes; cancel closes the listener and discards pending secrets. Browser invocation uses fixed `/usr/bin/open`, argument-array execution, no shell, no logged URL.

**5. Storage, refresh, and cleanup**

Use only an owned `p15-3-signin/` directory beneath SDK `storageDirectory`; never read legacy config, transcripts, `.env`, credential managers, or Codex credentials.

Proposed files:

- `host.json`: stable fixture-host ID and version.
- `connections.json`: registration mappings and selected opaque local record ID.
- `connection-<generated-local-id>.json`: validated identity, issued client ID, tokens, scopes, expiry.
- `run-budget.json`: persistent attempt count and run identifier; no secrets.

Require owner-controlled directory and `0700` mode; files `0600`, regular, owned, nonsymlink, bounded size, atomic same-directory replacement. Reject unsafe existing paths. Never downgrade to plaintext in another directory. Fail closed if counter or credential persistence fails.

Serialize refresh; replace rotated credentials together. On terminal refresh invalidation, clear unusable tokens and require a fresh owner-started sign-in. Preserve registration/host identity. Temporary transport failures do not imply revocation. Sign-out stops requests, attempts the discovered revocation endpoint, then clears local tokens; report remote revocation as unconfirmed if it cannot be verified. [Session lifecycle](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), [recovery rules](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)

The fixture is temporary, but credentials may persist across the specifically requested restart test. Final cleanup signs out and deletes credential-bearing files and transient synthetic history; retain only nonsecret host/registration mapping until the owner removes the fixture. Do not claim secure erasure of disk media.

**6. Synthetic inference contract**

Fetch `GET https://api.openai.com/v1/models` with the selected access token. Read `models`, retain server ordering for entries with `visibility:"list"`, show `display_name`, and send Anthony’s selected `slug`. Empty/malformed catalogs block inference. Use only `POST https://api.openai.com/v1/responses`; count success only on `response.completed`. [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)

Every request uses `store:false`, `stream:true`, explicit input array, and developer instructions. Omit unsupported preview fields, including `previous_response_id`, output-token limits, temperature, and cache-retention controls. No hosted tools. [Preview restrictions](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

Use one namespace `feasibility`, containing strict function `echo` with:

```json
{
  "type": "object",
  "properties": {
    "value": {"type": "string", "enum": ["p15_3"]}
  },
  "required": ["value"],
  "additionalProperties": false
}
```

The first request asks for that call. After a completed response, accept exactly one fully assembled `feasibility.echo` invocation with unique call ID and exact validated arguments. Execute only an in-memory constant return: `{"ok":true,"value":"p15_3"}`.

The second request sends original input, complete returned output—including required reasoning items—and one matching `function_call_output`. Require completed final text acknowledging the fixed marker. Reject additional calls, unknown namespaces, duplicate IDs, incomplete arguments, or mismatched output. No dynamic dispatcher or access to the 17 Live tools.

Request three is a small synthetic text response used solely for cancellation. Abort after the first text delta, record local reader/request termination and cleanup. Do not claim cancellation prevented all server-side generation or billing. If it completes before abort, record cancellation **not demonstrated**; do not send a fourth request.

Persistently reserve each attempt **before** invoking Fetch. All failures, uncertain sends, and cancellations consume that slot. Restarts, reconnects, and model changes never reset the three-attempt budget. No automatic inference retries or automatic 401 refresh-and-replay.

Bound SSE to 60 seconds/request, 1 MiB total, 128 KiB/event, and 10,000 events. Support fragmented UTF-8 and SSE framing; terminate on malformed JSON, exceeded limits, failed/incomplete terminal states, or interrupted streams. Keep synthetic history in memory only.

**7. Independent acceptance tests**

All automated tests use fake HTTP/browser/clock seams, generated test signing keys, and test-owned temporary directories. Default network behavior rejects every request; tests never load real environment credentials.

Required cases:

- PKCE/state/nonce; one-time callback; denial; replay; wrong state; missing/different client; timeout and cancellation races.
- Valid signature and every invalid claim/key/algorithm case; unknown JWKS key; malformed discovery; redirects and endpoint rejection.
- Unsafe storage, atomic replacement failure, rotation, restart loading, sign-out, late refresh after sign-out, persistent request budget.
- Missing scopes; no catalog/model; expired/revoked credentials; temporary network failure.
- Split SSE/UTF-8, exact call/output pairing, full returned-history preservation, duplicate/unknown calls, premature EOF, failure after deltas, abort and bounded cleanup.
- Zero inference without eligibility/operator/model/plan-only gates; zero fourth attempt; no replay after ambiguous outcomes.
- Secret-bearing sentinel values absent from logs, UI, error reports, artifacts, and callback responses.
- Bundle contains only fixture, pinned SDK, and explicitly reviewed verifier dependencies; production bundle excludes feasibility modules.
- Existing **1041 tests remain intact**; new tests add coverage.

**8. Installed sequence and handoff**

1. Dot approves the plan and resolves eligibility evidence independently of coding.
2. Complete offline implementation, tests, typecheck, lint, build, and bounded review.
3. Build fixture `0.0.3` with source-derived ID, package hash, dependency/version inventory, and explicit webview inclusion. Preserve `0.0.1`/`0.0.2` artifacts. Verify clean staging and archive contents; do not claim byte-identical ZIP reproducibility unless tested.
4. Install normally on Live `12.4.25b2`; verify artifact/build identity. Preserve production extension and use the disposable Set.
5. Run no-credential preflight: native HTTPS discovery/JWKS, synthetic JWT verification using bundled verifier, private storage, callback binding, and native transport. Any permission/TLS/module failure stops before OAuth.
6. Hand control to Anthony for **Continue with ChatGPT** and personal login/consent. Agents do not inspect credentials or consent-page details.
7. Validate connection; restart Live and verify protected persistence. Perform one explicit serialized refresh test and catalog retrieval. Failure stops inference.
8. Anthony selects the model and confirms this run is plan-only with credit fallback disabled. If that cannot be established, do not send model requests.
9. Run the two-request synthetic round trip and single cancellation request.
10. Sign out, report revocation/cleanup, and record evidence.

Denial or missing plan permission produces `plan_disabled`, not repeated consent prompts or a fallback. Ineligibility, region/policy rejection, usage limits, unsupported capability, or routing failure stops dependent work. Preserve allowlisted status/error classes and body shape; do not publish raw provider diagnostic text. [Official error behavior](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)

Existing commands: `npm run lint`, `npm test`, `npx --no-install tsc -b`, `npm run build:dev`, and the fixture build script. Run configured framework checks when harness files change. Never run `npm start` or the Anthropic schema probe for this work.

Evidence must identify source revision, artifact/build hash, host versions, eligibility basis, scope names, selected model slug, request counts, terminal states, usage counts if supplied, refresh/restart/cancellation/cleanup outcomes. No account identifiers, tokens, callback contents, URLs with parameters, or raw transcripts.

**Completion:** F3/F5 pass only with eligible official authorization, protected persistence/refresh, completed synthetic function round trip, demonstrated cancellation, and cleanup on the exact installed artifact. Otherwise deliver an honest blocked checkpoint. Neither result authorizes Phase 15.4 automatically; Anthony reviews the concrete PR first.

## Owner authorization and eligibility checkpoint (2026-11-27)

Anthony authorized MIT licensing and related eligibility work. A focused
[PR #7](https://github.com/Troll-Phace/ableton-agent/pull/7) adds the license
for project-authored work, excludes third-party material, and makes the
existing pinned Ableton archives local-only while preserving build paths.
No history rewrite; historical vendor archive removal requires a separate
decision. Actual eligible registration and account entitlement are still
unverified; no live OAuth until owner reviews/merges the prerequisite.

Official [UI guidelines](https://developers.openai.com/siwc/ui-ux-guidelines)
also apply to S4: use the approved Continue with ChatGPT format; on first
plan-enabled sign-in show the distinct dismissible plan-use welcome once;
display the plan-use indicator beside model selection and offer the official
Manage usage link when connected and on usage-limit errors. Clearly
distinguish plan use from any credit charges. Fixture has no paid fallback,
no pricing plans and no purchase actions. Review these with a credential-free
mock before live consent.

PR #7 merged by Anthony (0959efc, verified). This resolves the absent
license prerequisite. The documented OSS local-host flow may be tested
only after all offline and installed no-credential preflight gates,
using the official authorization endpoint and Anthony’s personal consent.
Provider acceptance and plan entitlement are not presumed.
