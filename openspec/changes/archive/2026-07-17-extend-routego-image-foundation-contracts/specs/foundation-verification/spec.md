## ADDED Requirements

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
