> 非权威草稿：等待两份审计最终报告后重新核对。不得用于 OpenSpec apply。

## ADDED Requirements

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

### Requirement: Browser-stack mock smoke test
Foundation SHALL provide a Playwright-ready test configuration and at least one browser-stack request smoke test against a loopback mock boundary.

#### Scenario: Browser request to mock boundary
- **WHEN** the Playwright smoke test sends a valid request to the loopback mock server
- **THEN** it SHALL receive a shared-schema-valid response and the mock observation SHALL remain sanitized

### Requirement: Cross-platform continuous integration
Continuous integration SHALL run frozen dependency installation, repository safety checks, type checking, build, contract/security tests, and browser smoke tests on Windows, Ubuntu, and macOS using Node.js 20.19 or newer.

#### Scenario: Platform-specific regression
- **WHEN** path, shell, packaging, or runtime behavior works on one platform but fails on another supported platform
- **THEN** at least one CI matrix job SHALL fail before integration

### Requirement: Evidence-backed upstream provenance
Before Foundation is complete, the repository SHALL record the exact audited `CookSleep/gpt_image_playground` commit, its MIT license attribution, approved reuse boundaries, and required third-party notice using the completed Upstream Reuse Audit as evidence.

#### Scenario: Audit evidence unavailable
- **WHEN** the upstream audit has not supplied an exact commit and attribution
- **THEN** the provenance task SHALL remain incomplete and no placeholder SHA or invented notice SHALL be committed

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
