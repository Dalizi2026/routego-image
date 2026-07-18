## ADDED Requirements

### Requirement: Node.js 20.19+ CI runs on all supported operating systems
Continuous integration SHALL run on Windows, Ubuntu, and macOS using Node.js 20.19 or newer and SHALL execute frozen installation, repository safety, strict OpenSpec validation, typecheck, build, all unit/contract/integration tests, package exports, browser verification, plugin packaging, and temporary-install smoke.

#### Scenario: Platform-specific behavior regresses
- **WHEN** paths, permissions, signals, loopback addresses, process launch, packaging, or runtime behavior fails on one supported operating system
- **THEN** that matrix job SHALL fail before Integration can be reported ready

#### Scenario: Unsupported Node version is used
- **WHEN** runtime/package smoke uses Node older than 20.19
- **THEN** it SHALL fail with a clear unsupported-runtime result rather than continue silently

### Requirement: Offline end-to-end composition is deterministic
Integration verification SHALL use isolated temporary roots, deterministic clocks/IDs/tokens, synthetic images/ZIPs, Foundation mock relay fixtures, and no real credentials, external network, user data, or legacy files.

#### Scenario: Full offline flow runs
- **WHEN** tests execute text generation, upload-reference generation, edit with mask, partial batch, Library search/detail/retry, protected resources, Studio stream, and project copying
- **THEN** results SHALL be schema-valid, deterministic, non-overwriting, and shared between Codex and Studio

#### Scenario: Environment contains real credentials or data
- **WHEN** CI/developer environment variables or home files contain unrelated real state
- **THEN** offline verification SHALL neither read it nor change its outcomes

### Requirement: PD-005 corrective gates have dedicated regressions
Verification SHALL prove the Library-only source phase and exact 17+12+4=33 bound, public phase/tool freeze, mixed source/output MIME, output-only primary, exact relationship ownership, no extra chromakey rendition/role, ZIP round-trip/remapping, fail-closed retry reconstruction, the exact authenticated `POST /api/v1/studio/creation/stream` route, first/unique started and request-ID consistency, framing/schema/sequence/terminal-before-EOF/sentinel validation, failure-after-partial preservation through immutable `min(registration + 5 minutes, session expiry)` descriptors, independent reader/channel and browser object-URL cleanup, normal five-minute-capable and near-expiry sessions, exact pre/post-expiry fetch behavior, immediate shutdown revocation, and genuine mock chunking.

#### Scenario: Public surface drifts
- **WHEN** `source` becomes a public image artifact phase or an eighth tool appears
- **THEN** contract/export/integration tests SHALL fail

#### Scenario: Retry or stream silently substitutes data
- **WHEN** a relationship is ambiguous or an SSE event is invalid
- **THEN** verification SHALL require a fail-closed result and SHALL reject primary-output fallback or unvalidated rendering

### Requirement: Security and repository audits cover the shipped graph
Verification SHALL audit tracked files and the packaged artifact for secrets, auth headers, session values, image/Base64 payloads, unrestricted URLs, arbitrary paths, traversal, symlink/junction escapes, unsafe redirects, legacy access, native dependencies, generated residue, and source-location leakage.

#### Scenario: Secret-like content is introduced
- **WHEN** source, test, diagnostics, package, or smoke evidence contains a likely real key or credential-bearing value
- **THEN** the gate SHALL fail while redacting the value

#### Scenario: Package contains user or build data
- **WHEN** a raster/config/Library/cache/report/source-map residue appears outside the explicit synthetic/brand allowlist
- **THEN** the gate SHALL fail before delivery

### Requirement: Final offline delivery is strict and clean
Before `[INTEGRATION_PLAN_READY]` may later become apply-complete delivery, every approved offline implementation task SHALL have focused verification, an implementation commit, and its subsequent task-state record; the complete repository SHALL pass strict validation, full tests, diff-scope audit, and clean Git status.

#### Scenario: Hidden incomplete work remains
- **WHEN** any task, test, package, platform job, scope audit, commit record, or Git-clean check is missing or failing
- **THEN** Integration SHALL remain incomplete and real-relay/release gates SHALL not be reported ready
