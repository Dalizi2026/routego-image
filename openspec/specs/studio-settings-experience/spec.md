# Studio Settings Experience Specification

## Purpose

Defines provider-profile, write-only secret, model refresh, confirmed probe, capability-state, defaults, output-directory, and safe-diagnostic requirements for Routego Studio.

## Requirements

### Requirement: Provider profile management
Settings SHALL list redacted provider profiles and support create/update, remove, and active selection using frozen endpoint/profile schemas. Existing secrets MUST never be loaded into the browser form.

#### Scenario: Provider profile is edited
- **WHEN** the user changes a profile name, endpoints, model, active state, or API-key mutation
- **THEN** Studio SHALL submit a strict profile input and render only the returned redacted descriptor

#### Scenario: Profile removal fails
- **WHEN** the service rejects removal of an active or missing profile
- **THEN** Studio SHALL preserve the profile list and show the structured safe error without exposing credentials

### Requirement: Write-only API-key controls
The API-key control SHALL express `unchanged`, `replace`, or `clear`; replacement values SHALL use a password field, remain only until submission, be cleared afterward, and MUST NOT appear in rendered results, browser storage, logs, errors, or snapshots.

#### Scenario: API key is replaced
- **WHEN** the user explicitly chooses replace and submits a non-empty value
- **THEN** Studio SHALL send it only in the write input, clear the field after completion, and show only `hasApiKey` and optional preview metadata

### Requirement: Separate model refresh and capability probes
Settings SHALL label model refresh as non-billable and capability probes as potentially billable. A probe MUST require explicit confirmation and SHALL display the returned scoped state, evidence, degradation reason, and `mayHaveBilled` value.

#### Scenario: Models are refreshed
- **WHEN** the user refreshes models
- **THEN** Studio SHALL call the non-billable refresh operation and SHALL NOT describe it as an image capability test

#### Scenario: Probe is requested
- **WHEN** the user chooses a capability probe
- **THEN** Studio SHALL explain potential cost, require confirmation, submit the exact provider/model/capability/transport/request shape, and update capability-gated controls from the validated result

### Requirement: Four-state capability presentation
Settings and dependent controls SHALL distinguish `unknown`, `supported`, `unsupported`, and `degraded`. Transient authentication, timeout, rate-limit, moderation, or provider failures MUST remain transient and MUST NOT be displayed as permanent unsupported evidence.

#### Scenario: Probe has a transient failure
- **WHEN** a probe returns a transient structured error
- **THEN** Studio SHALL retain the previous capability state, show the safe failure, and keep unconfirmed dependent controls disabled

### Requirement: Defaults and output-directory updates
Settings SHALL edit the complete generation defaults and the distinct output-directory operations `unchanged`, `default`, `clear`, and confirmed `replace`. Successful output SHALL display only redacted configured/display state.

#### Scenario: Defaults are saved
- **WHEN** the user submits valid default model/output controls
- **THEN** Studio SHALL send one complete defaults object and update the workbench defaults from the validated settings result

#### Scenario: Output directory is replaced
- **WHEN** the user enters an absolute local candidate and explicitly confirms replacement
- **THEN** Studio SHALL submit it only in the settings mutation, clear the raw form value afterward, and render only the redacted returned display

### Requirement: Secret-safe diagnostics and states
Settings SHALL provide loading, empty, success, conflict, validation, service failure, and retry states without including a full key, submitted path, authorization value, session token, or provider response body.

#### Scenario: Settings update fails
- **WHEN** a profile, defaults, probe, or output-directory operation fails
- **THEN** Studio SHALL show only the structured safe message and preserve unrelated unsaved form state

