## ADDED Requirements

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
