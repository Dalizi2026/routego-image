## ADDED Requirements

### Requirement: Real-relay acceptance requires explicit user authorization
No real provider request SHALL run until the user explicitly approves the relay/profile, credential use, synthetic acceptance inputs, potential charges, request count/budget, and the exact capability matrix to be exercised. Approval MUST NOT be inferred from apply authorization, stored configuration, or an earlier unrelated request.

#### Scenario: Integration implementation is complete but approval is absent
- **WHEN** offline gates pass without a current real-relay approval
- **THEN** the acceptance task SHALL remain pending and SHALL send no probe, generation, edit, or download request

#### Scenario: Approval is narrower than the matrix
- **WHEN** the user approves only selected request classes or a budget cap
- **THEN** acceptance SHALL execute only those classes within the cap and leave all others unverified

### Requirement: Acceptance uses synthetic controlled inputs and secret-safe evidence
Real-relay testing SHALL use clearly synthetic non-user images/masks/prompts, SHALL obtain the credential only through the approved local configuration path, and SHALL record only redacted endpoints, request shapes, status/response shapes, timings, capability evidence, request counts, `mayHaveBilled`, and output hashes/IDs. It MUST NOT store the key, authorization header, raw provider body, user image, or full image bytes in repository evidence or ordinary logs.

#### Scenario: Acceptance evidence is reviewed
- **WHEN** a real request completes or fails
- **THEN** reviewers SHALL be able to identify the exact transport/shape/outcome/cost risk without recovering a credential or image payload

### Requirement: Required real-relay matrix is truthful and ordered
Subject to approval, acceptance SHALL cover text generation, two ordered references, direct edit, mask edit bound to target slot zero, a batch with partial failure, and transparency. It SHALL record the actual selected Tier A/B/C transport, requested/effective parameters, provider request counts, artifacts, relationships, partial failures, and degraded behavior for every case.

#### Scenario: Required capability remains unknown or unsupported
- **WHEN** the approved relay cannot safely execute one matrix item
- **THEN** acceptance SHALL record it unavailable and SHALL NOT fabricate success, derive an endpoint, or substitute a local filter for model editing

#### Scenario: Batch partially fails
- **WHEN** at least one approved item succeeds and one fails
- **THEN** the result SHALL be partial with ordered item outcomes and no automatic replay of output/billing-risk tasks

#### Scenario: Transparency uses chromakey degradation
- **WHEN** native transparency is unavailable and the approved simple subject uses chromakey
- **THEN** acceptance SHALL verify PNG alpha edges, degraded/effective reporting, exactly one persisted/projected output artifact per slot under its existing identity, no added rendition/relationship role, conformance to the 33-item bound, and no claim of native support

#### Scenario: Chromakey processing fails after provider output
- **WHEN** the approved provider output is valid but local chromakey processing fails
- **THEN** acceptance SHALL verify that the provider original remains available under the same output identity, transparent success is not claimed, and no second durable original artifact is created

### Requirement: Capability evidence follows four-state rules
Acceptance SHALL transition scoped evidence to supported/unsupported/degraded only on conclusive allowed evidence. Authentication, timeout, 429, 5xx, moderation, and isolated model failures MUST remain transient and MUST NOT erase prior evidence or become unsupported.

#### Scenario: Protocol stably rejects Edits
- **WHEN** the explicitly configured/approved Edits route returns a stable unsupported response
- **THEN** only that provider/model/endpoint/transport/request shape MAY become unsupported

#### Scenario: Probe times out
- **WHEN** an approved request times out without conclusive protocol evidence
- **THEN** the prior state SHALL remain and the evidence SHALL record a sanitized transient failure

### Requirement: Codex and Studio share the same accepted Library records
For approved saved operations, the MCP result, Studio result/detail, and Library search SHALL identify the same operation asset/artifacts, exact source relationships, requested/effective metadata, and status. Unsaved operations SHALL not create hidden Library records.

#### Scenario: Saved edit is viewed in both clients
- **WHEN** an approved edit is invoked through Codex or Studio with Library saving enabled
- **THEN** both clients SHALL resolve the same output and source graph without path or credential leakage

### Requirement: Acceptance failure blocks release without destructive cleanup
Any incomplete, failing, over-budget, or unapproved matrix item SHALL block release readiness. Cleanup SHALL remove only acceptance-owned temporary data and SHALL not delete accepted Library records, legacy files, real configuration, or unrelated outputs.

#### Scenario: Acceptance stops early
- **WHEN** the budget is reached, the user withdraws approval, or a safety failure occurs
- **THEN** no new real request SHALL start, completed facts SHALL remain recorded, and release SHALL remain blocked
