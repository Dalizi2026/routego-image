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
