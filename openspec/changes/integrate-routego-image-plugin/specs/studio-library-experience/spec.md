## ADDED Requirements

### Requirement: Retry reconstruction uses exact ordered relationship artifacts
Studio SHALL reconstruct a Library retry draft from the selected asset's ordered target, reference, supporting, and mask relationships using each relationship's exact artifact ID and related asset ownership. It MUST NOT reconstruct physical inputs from asset-level parameter IDs or substitute the primary output when a required source artifact is unavailable.

#### Scenario: Upload-origin edit is retried
- **WHEN** detail contains source renditions for the original target, supporting images, and mask
- **THEN** Studio SHALL build artifact locators for those exact ordered source artifact IDs and SHALL bind the mask to target slot zero

#### Scenario: Existing Library reference is retried
- **WHEN** a relationship points to an artifact owned by another Library asset
- **THEN** Studio SHALL preserve that exact related asset/artifact locator and its order/role/label

#### Scenario: Retry graph is ambiguous
- **WHEN** a required edit target is missing or duplicated, more than one mask exists, a relationship lacks an artifact ID, or artifact ownership is inconsistent
- **THEN** Studio SHALL fail closed with a safe retry-unavailable message and SHALL NOT fall back to an asset primary output

## MODIFIED Requirements

### Requirement: Retry, edit, download, and ZIP flows
Eligible assets SHALL support retry/edit handoff, protected download, ZIP export, and ZIP import. Retry SHALL use exact ordered relationship artifact IDs and fail closed on missing, ambiguous, or inconsistent physical-input relationships. Edit-again SHALL deliberately use the selected output artifact as the new target. ZIP import MUST reserve/upload/finalize a single-consume resource before mutation preflight; export SHALL use the returned protected ZIP resource.

#### Scenario: ZIP import completes
- **WHEN** a valid ZIP upload is finalized and import is confirmed
- **THEN** Studio SHALL execute the preflighted import, show imported/skipped counts, and prevent false reuse of a consumed resource

#### Scenario: Asset is downloaded
- **WHEN** the user downloads an allowed rendition
- **THEN** Studio SHALL fetch the protected resource with the current session and trigger a browser download without exposing a local path

#### Scenario: User retries an operation
- **WHEN** detail contains one valid ordered relationship graph for its original physical inputs
- **THEN** Studio SHALL hand off a path-free draft using exact artifact locators and current capability gates

#### Scenario: User edits the result again
- **WHEN** the user chooses edit on an eligible output
- **THEN** Studio SHALL use that selected output asset/artifact as the new target without confusing it with retry reconstruction of the original source graph
