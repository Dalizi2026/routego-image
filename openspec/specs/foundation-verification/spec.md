# Foundation Verification Specification

## Purpose

Defines the durable verification, provenance, compatibility, and delivery requirements for the Routego Image foundation.

## Requirements
### Requirement: Contract and security regression suites
Foundation SHALL provide automated tests for shared schema parsing, cross-field limits, provider states and routing, structured errors, redaction, loopback/session/origin policy, path containment, application-service dispatch, and mock relay fixtures.

#### Scenario: Foundation implementation changes
- **WHEN** a shared contract, provider decision, boundary, mock, or security helper changes
- **THEN** the relevant Vitest regression tests SHALL run and SHALL fail on incompatible behavior

### Requirement: Provider fixture coverage
Tests SHALL cover text-only single endpoint, single endpoint with `image` data URL, standard Edits multipart, and Responses JSON/SSE-shaped provider contracts without contacting a real relay.

#### Scenario: Offline test run
- **WHEN** the Foundation test suite runs without API credentials or network access
- **THEN** all provider contract fixtures SHALL execute deterministically and SHALL not create billable requests

### Requirement: Downstream browser test foundation
Foundation SHALL provide shared Playwright configuration that the Studio lane can consume, while Studio retains ownership of browser test files and browser journeys.

#### Scenario: Studio adds browser tests
- **WHEN** the Studio lane creates Playwright tests
- **THEN** those tests SHALL use the Foundation-owned root configuration without duplicating workspace or contract setup

### Requirement: Cross-platform continuous integration
Continuous integration SHALL run frozen dependency installation, repository safety checks, type checking, build, and Foundation contract/security/mock tests on Windows, Ubuntu, and macOS using Node.js 20.19 or newer.

#### Scenario: Platform-specific regression
- **WHEN** path, shell, packaging, or runtime behavior works on one platform but fails on another supported platform
- **THEN** at least one CI matrix job SHALL fail before integration

### Requirement: Evidence-backed upstream provenance
Before Foundation is complete, the repository SHALL record audited `CookSleep/gpt_image_playground` commit `a10477581b3d43ac98d39777e4445625a9db113d`, `Copyright (c) 2026 CookSleep`, its complete MIT license, approved reuse boundaries, and required third-party notice using the completed Upstream Reuse Audit as evidence.

#### Scenario: Provenance recorded
- **WHEN** approved upstream-derived logic is identified for later extraction
- **THEN** the provenance record SHALL identify the pinned source commit and license obligations without vendoring the upstream repository or build outputs

### Requirement: Evidence-backed legacy compatibility checklist
Before Foundation is complete, the repository SHALL record the verified legacy endpoint normalization, request/response behavior, security risks, preserved compatibility requirements, and intentionally retired limitations using the completed Legacy Plugin Audit as evidence.

#### Scenario: Legacy source remains untouched
- **WHEN** Foundation records a compatibility requirement from the legacy audit
- **THEN** it SHALL reference the evidence without modifying, migrating, deleting, or committing files from `C:\Users\MLTZ\plugins\routego-image`

### Requirement: Strict OpenSpec and clean delivery
Foundation SHALL pass `openspec validate --all --strict --no-interactive`, all relevant automated tests, and a clean Git status check before being reported ready for integration.

#### Scenario: Hidden incomplete item
- **WHEN** a task, test, audit dependency, safety check, or strict validation remains incomplete or failing
- **THEN** the change SHALL NOT be reported complete or ready for downstream apply

### Requirement: Foundation Extension contract regression suite
Automated tests SHALL cover provider-profile secret mutations, non-billable refresh, confirmed billable probes, folder listing/reordering, complete asset detail and relationships, protected browser resources, mutation preflight, per-item partial failure, and the frozen seven public operations.

#### Scenario: Shared contract changes regress behavior
- **WHEN** a new schema permits secret/path leakage, ambiguous confirmation, missing item outcomes, or a changed public operation name
- **THEN** the contract test suite SHALL fail

### Requirement: Deterministic mock regression suite
Automated tests SHALL validate synthetic settings, folders, asset details, relationships, browser resources, and success/failure/partial/degraded local-service fixtures without credentials, user images, local configuration, Library files, or network access.

#### Scenario: Offline mock tests run
- **WHEN** mock tests execute in an isolated environment without credentials or user data
- **THEN** they SHALL be deterministic, schema-valid, and free of filesystem/network reads for those inputs

### Requirement: Browser-safe package verification
The built contracts package SHALL be importable by browser code and SHALL contain no Node built-in import in source, declarations, or emitted JavaScript.

#### Scenario: Contract package is built
- **WHEN** the contracts package build output and dependency graph are inspected
- **THEN** no `node:` import or Node-only dependency SHALL be reachable from the public browser export

### Requirement: Importer, export, and frozen-install verification
Verification SHALL perform a clean frozen dependency installation, typecheck, build, tests, and package-export checks for Creation, Library, Studio, contracts, Foundation, and mock relay.

#### Scenario: Importer or lockfile is incomplete
- **WHEN** an importer is absent from the lockfile, cannot resolve a declared dependency, fails build/typecheck, or exposes a broken package export
- **THEN** the Foundation Extension SHALL NOT be reported complete

### Requirement: Strict, safe, and clean delivery
The change SHALL pass `openspec validate --all --strict --no-interactive`, repository safety, native-runtime dependency inspection, diff-scope review, and final Git cleanliness before completion is announced.

#### Scenario: Hidden or out-of-scope residue exists
- **WHEN** validation fails, an unapproved file/dependency appears, generated artifacts remain tracked/unignored, or Git is dirty
- **THEN** tasks SHALL remain incomplete and no dependency-complete message SHALL be sent

### Requirement: Browser upload lifecycle regression suite
Automated tests SHALL cover every upload purpose, reservation policy metadata, protected relative route validation, success finalization metadata, image reuse, ZIP single consumption, status, discard, expiry, not-found, invalid MIME, oversize, checksum failure, consumed state, strict unknown-field rejection, and absence of bytes/Base64/path/credentials.

#### Scenario: Upload contracts or mock behavior regress
- **WHEN** a change permits unsafe metadata, false success, repeated ZIP consumption, or missing integrity/status fields
- **THEN** the focused contracts or mock test suite SHALL fail

### Requirement: Path-free Studio creation and SSE regression suite
Automated tests SHALL cover text-only generate, reference upload generate, Library/upload target edit with ordered supporting images and mask slot zero, complete parameter limits/invariants, success/partial/failure/degraded results, started/partial/completed/failed SSE, billing/output flags, ordered mixed batch outcomes, and capability-unavailable behavior without fabricated success.

#### Scenario: Studio creation DTO leaks server-only data
- **WHEN** a Studio request/result/event/error/artifact includes a local path, data URL, Base64, external resource URL, credential, or public MCP-only field
- **THEN** schema validation or browser-safe audit SHALL fail

### Requirement: Non-empty deterministic gallery regression suite
The mock suite SHALL validate a non-empty synthetic gallery containing generate and edit assets, succeeded/partial/deleted states, multiple folders, stable filtering/sorting/pagination, and IDs aligned across search, detail, relationships, resources, retry/edit handoff, and creation locators.

#### Scenario: Same seeded search is repeated
- **WHEN** identical search input and cursor are applied to fresh mock instances
- **THEN** results, order, identifiers, thumbnails, totals, and next cursor SHALL be identical

#### Scenario: Search/detail/resource identifiers drift
- **WHEN** a search row is used for detail and browser resource lookup
- **THEN** tests SHALL prove the returned asset/artifact IDs resolve to the same seeded asset graph

### Requirement: Stateful settings mock regression suite
Automated tests SHALL prove defaults and output-directory `unchanged | default | clear | replace` mutations are schema-valid, path-redacted, deterministic, and reflected by subsequent `readSettings` calls in the same mock instance.

#### Scenario: Settings are updated and reread
- **WHEN** the mock updates defaults or output-directory selection
- **THEN** a later read SHALL return the synthesized new state without exposing the submitted full path

### Requirement: Public operation and ownership freeze verification
Verification SHALL assert that `routegoOperationNames`, the seven MCP tool names, public operation definitions, existing public path-based inputs/results, and `RoutegoService` remain semantically unchanged. It SHALL also assert no Creation, Library, Studio, root dependency, lockfile, transport, persistence, UI, manifest, install, or release file is modified.

#### Scenario: Internal operation leaks into public MCP surface
- **WHEN** a Studio upload, creation, search, or settings operation appears in a public registry or receives a tool name
- **THEN** the freeze test and scope audit SHALL fail

### Requirement: Browser-safe source declaration and emitted-output audit
The contracts source, generated declarations, and emitted JavaScript reachable from browser exports SHALL contain no Node built-in import and no Studio DTO field or schema that permits local paths, image bytes/Base64, unrestricted external image URLs, or provider credentials.

#### Scenario: Contracts package is built
- **WHEN** browser-safe exports are inspected after build
- **THEN** source, declarations, and emitted code SHALL pass the Node-import and forbidden-boundary audit

### Requirement: Strict safe deterministic clean delivery
Before completion, the change SHALL pass strict OpenSpec validation, repository safety, typecheck, build, all tests, seven package-export checks, browser-safe audits, public-operation freeze, repeated mock determinism, diff-scope review, and final Git cleanliness. Each task MUST be verified and committed before its checkbox is updated.

#### Scenario: Hidden incomplete or out-of-scope residue exists
- **WHEN** any validation fails, a generated/cache artifact remains, Git is dirty, a task lacks a commit, or an out-of-scope file/dependency is present
- **THEN** the task SHALL remain incomplete and `[BROWSER_BOUNDARY_COMPLETE]` SHALL NOT be sent
