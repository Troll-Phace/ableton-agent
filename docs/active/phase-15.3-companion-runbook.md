# Phase 15.3 — SDK synthetic tool roundtrip (offline checkpoint)

**Scope:** companion 0.0.7 is an offline implementation and packaging checkpoint for the official SDK's fixed synthetic echo roundtrip. There is no usable native allowance, and no live provider request or OAuth/account operation is authorized by this checkpoint. Do not launch the companion to sign in or dispatch. The successful prior SDK text proof and earlier diagnostics remain historical evidence. Live can remain closed; no Live bridge, tool dispatcher or production integration is present.

## Package verification

From the repository root:

```sh
node --import tsx scripts/build-chatgpt-companion.ts
cd dist/chatgpt-companion/0.0.7
shasum -a 256 -c SHA256SUMS
node companion.cjs --version
```

The package contains companion.cjs (including the control panel), this runbook, license, third-party notices, exact dependency inventory and SHA256SUMS. Requires ordinary-user macOS Node >=24.14.1. The SDK is pinned to 7.65.0. Compare the exact build ID, entry digest and manifest digest with the owner-reviewed checkpoint. Previous 0.0.1–0.0.6 packages are historical evidence; preserve them and do not launch for replay. The version command is inert and makes no request.

## Offline acceptance

The official SDK's documented public Responses endpoint and normal streaming are reused through the same bounded transport as the successful text adapter. Selected OAuth connection and catalog model, personal consent, plan-only/no credit fallback, `store:false`, `stream:true`, zero retries, logging disabled, bounded consumption and application deadlines remain mandatory. Synthetic Fetch and synthetic two-step reservation are test-only injection seams; the packaged runtime strips them and will not dispatch either request.

The original 1/3, previous diagnostic exhausted 1/1, and successful SDK text exhausted 1/1 all remain read-only and byte-identical. No new live budget file exists. Missing, malformed or uncertain historical accounting blocks a synthetic run. Never inspect, copy, edit or delete real records, reset an allowance, launch earlier packages, switch providers, use a paid fallback, or register an alternate account.

The actual SDK offline fixtures exercise only the following fixed sequence:

1. Reserve synthetic step 1, then send the fixed input and strict namespace `feasibility.echo` definition. The app validates a completed terminal containing exactly one matching function call, unique bounded IDs and exact unique-key `{"value":"p15_3"}` arguments. No partial frame can execute anything.
2. The sole local operation is the constant in-memory `{"ok":true,"value":"p15_3"}` echo. Build bounded explicit history from the original input and the required complete returned output/context, including returned reasoning context and the unchanged matching call ID. Reserve synthetic step 2 before dispatching the continuation. Require a completed final marker, without further function activity.
3. Stop after the second request. Failed/incomplete/interrupted streams, invalid calls, timeout, cancellation or uncertain reservation do not count as successful completion. No retry, third request, restart resume, or general tool execution is available. Only fixed sanitized counts and state codes are retained; raw returned content, IDs, arguments, reasoning and credentials are never projected or persisted.

Any later live roundtrip requires a separately explicit owner authorization for up to two new requests and another reviewed checkpoint implementing an independent durable cap. Review this offline PR first; do not launch it to sign in or infer. A later owner-operated success would establish synthetic SDK tool roundtrip feasibility only, not real Live tool behavior, cancellation proof or a production integration.
