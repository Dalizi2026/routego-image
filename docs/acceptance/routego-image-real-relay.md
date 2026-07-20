# Routego Image real-relay acceptance

This checklist prepares the later approval-gated acceptance run. Task 7.1 is offline only. It does not authorize a credential read, provider request, endpoint probe, image download, Library mutation, charge, installation, deployment, publication, or release.

## Before approval

The operator must record one current approval that binds all of the following:

- relay provider, local profile, model, and the SHA-256 fingerprint of the already configured HTTPS endpoint;
- acknowledgement that the approved local credential path will be used without logging or copying the credential;
- clearly synthetic prompts, reference images, edit target, mask, batch inputs, and transparency subject;
- potential charges, a total request ceiling, a total USD ceiling, and per-case request and USD ceilings;
- the exact ordered cases: text generation, two references, direct edit, mask edit at target slot zero, partial batch, and transparency;
- issue and expiry timestamps, withdrawal contact, and the SHA-256 fingerprint of a task-owned redacted evidence location.

An earlier approval, a broad apply instruction, stored provider configuration, or approval for only part of the matrix is not sufficient. Missing, expired, narrower, inconsistent, or over-budget approval must stop before the first request.

## Offline verification

Run this command from the repository root:

```sh
node scripts/run-real-relay-acceptance.mjs --dry-run
```

The command uses only deterministic synthetic records. Expected output has `status: "complete"`, `realRelayExecuted: false`, and `releaseReady: false`. Any other command-line mode is rejected until Task 7.2 receives fresh explicit user approval.

## Approved matrix

The later Task 7.2 runner must execute cases in this order without automatic replay:

1. Text generation: one saved operation and its selected provider transport.
2. Two references: two ordered source relationships preserved through Codex and Studio.
3. Direct edit: target and supporting/reference roles remain exact.
4. Mask edit: the mask is bound to target slot zero.
5. Partial batch: ordered successes and failures are retained; failed or billable outputs are not replayed automatically.
6. Transparency: native support is recorded only when conclusive. Chromakey is degraded, keeps one output identity per slot, adds no role, and stays within 33 renditions. If local chromakey fails, the provider original remains under that same identity and transparent success is not claimed.

Before every case, recheck approval expiry, withdrawal, remaining requests, remaining cost, and cancellation. Stop before starting a new request when any check fails. Keep completed redacted facts and leave release readiness blocked.

## Evidence rules

Allowed evidence is bounded metadata only:

- approval ID and timestamps;
- provider/profile/model identifiers and endpoint fingerprint, never the endpoint itself;
- selected transport and bounded request shape name;
- requested/effective parameters without prompts, images, paths, or credentials;
- sanitized status/response shape, timings, capability state, request count, cost, and `mayHaveBilled`;
- artifact IDs, output hashes, source relationship roles, partial failures, degradation facts, and shared Codex/Studio Library identity.

Never store or print an API key, authorization header, credential, full endpoint, query, raw provider body, local path, user image, image bytes, data URL, output image, or ordinary provider log. Authentication, timeout, rate limit, server, moderation, and isolated model failures remain transient; they do not become unsupported or erase prior evidence.

## Review and stop conditions

Acceptance remains incomplete and release remains blocked when any case is unapproved, unavailable, failing, transient, cancelled, over budget, or missing truthful evidence. Cleanup may remove only acceptance-owned temporary inputs and redacted evidence staging. It must not delete accepted Library records, real configuration, legacy files, credentials, user data, or unrelated outputs.

Task 7.2 may begin only after the user explicitly approves the exact profile, credential use, synthetic matrix, possible charges, request and cost ceilings, and evidence location for that run.
