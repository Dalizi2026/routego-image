# Studio Library Experience Specification

## Purpose

Defines the path-free gallery, folder, mutation, trash, detail, comparison, download, retry, edit-handoff, and ZIP requirements for Routego Studio.

## Requirements

### Requirement: Path-free gallery search and browsing
The Library SHALL provide waterfall/card browsing, query, model/date/kind/size/status/folder/deleted filters, sorting, cursor pagination, protected thumbnails, loading, empty, failure, and retry states using `searchStudioLibrary` without consuming local paths.

#### Scenario: Gallery is filtered
- **WHEN** the user changes search filters or sorting
- **THEN** Studio SHALL request the frozen path-free search input, reset stale pagination, and render only validated rows and protected thumbnails

#### Scenario: Search fails
- **WHEN** the Library search returns a structured failure or invalid result
- **THEN** Studio SHALL retain the user's filters, show a safe error/retry state, and SHALL NOT render fabricated assets

### Requirement: Folder management and multi-folder assignment
The Library SHALL support folder listing, create, rename, complete reordering, and assigning/removing selected assets across multiple folders with refreshed counts and structured conflict handling.

#### Scenario: Folders are reordered
- **WHEN** the user commits a new complete folder order
- **THEN** Studio SHALL submit unique ordered folder IDs and render the validated resulting order

#### Scenario: Assets are assigned to folders
- **WHEN** one or more assets and folders are selected
- **THEN** Studio SHALL preflight/execute the assignment where required, show per-item outcomes, and refresh affected folder and asset state

### Requirement: Multi-selection and safe Library mutations
The Library SHALL support multi-selection, soft delete, restore, permanent delete, folder changes, download, and ZIP export through contract-valid operations. Risky actions MUST use preflight, exact confirmations, and per-item outcomes.

#### Scenario: Permanent deletion is requested
- **WHEN** selected trash items are preflighted for permanent deletion
- **THEN** Studio SHALL display eligible/blocked items and require the exact permanent-delete confirmation before execution

#### Scenario: Mutation partially fails
- **WHEN** some selected items succeed and others fail or are skipped
- **THEN** Studio SHALL show the overall partial state and an outcome for every item without claiming total success

### Requirement: Trash retention interface
Studio SHALL provide a dedicated trash view showing deleted timestamps, restore, and permanent-delete actions while treating soft deletion as the normal delete path and warning that the configured retention policy is 30 days.

#### Scenario: Active asset is deleted
- **WHEN** the user deletes an active asset
- **THEN** Studio SHALL request soft deletion and move the refreshed asset out of the active gallery into the trash view

### Requirement: Detail and source-result comparison
The Library SHALL show validated asset parameters, execution metadata, structured errors, folders, allowed actions, renditions, and ordered source/target/reference/supporting/mask/output relationships. Eligible images SHALL support an accessible source/result comparison.

#### Scenario: Edit detail opens
- **WHEN** the user opens a partial or succeeded edit asset
- **THEN** Studio SHALL resolve protected resources for its related inputs/output, label every relationship, and show the available comparison without exposing paths

#### Scenario: Comparison is adjusted
- **WHEN** the user drags or keyboard-adjusts the comparison divider
- **THEN** the source and result SHALL remain aligned and the divider value SHALL be announced accessibly

### Requirement: Retry, edit, download, and ZIP flows
Eligible assets SHALL support retry/edit handoff, protected download, ZIP export, and ZIP import. ZIP import MUST reserve/upload/finalize a single-consume resource before mutation preflight; export SHALL use the returned protected ZIP resource.

#### Scenario: ZIP import completes
- **WHEN** a valid ZIP upload is finalized and import is confirmed
- **THEN** Studio SHALL execute the preflighted import, show imported/skipped counts, and prevent false reuse of a consumed resource

#### Scenario: Asset is downloaded
- **WHEN** the user downloads an allowed rendition
- **THEN** Studio SHALL fetch the protected resource with the current session and trigger a browser download without exposing a local path

