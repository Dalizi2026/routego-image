## MODIFIED Requirements

### Requirement: Multi-selection and safe Library mutations
The Library SHALL support multi-selection only for folder assignment/removal, ZIP export, and image comparison. It SHALL NOT expose soft delete, restore, permanent delete, bulk download, edit, or direct generation actions.

#### Scenario: Selected assets are assigned to a folder
- **WHEN** the user applies a valid folder mutation to selected active generation assets
- **THEN** Studio SHALL execute the preflighted mutation and show one honest outcome for every item

#### Scenario: Unsupported selection action is attempted
- **WHEN** a client attempts a removed delete, restore, edit, or direct-generation selection action
- **THEN** strict validation or route handling SHALL reject it without mutating the Library or calling a provider

### Requirement: Detail and source-result comparison
The Library SHALL show validated generation parameters, execution metadata, structured errors, folders, renditions, zero through five ordered reference relationships, allowed actions, and an accessible image comparison. It SHALL NOT display edit records or edit relationship roles.

#### Scenario: Generation detail opens
- **WHEN** the user opens a succeeded or partial generation asset
- **THEN** Studio SHALL resolve protected resources, label its generation references and outputs, and show available comparison without exposing paths

#### Scenario: Comparison is adjusted
- **WHEN** the user drags or keyboard-adjusts the comparison divider
- **THEN** the compared images SHALL remain aligned and the divider value SHALL be announced accessibly

### Requirement: Retry, edit, download, and ZIP flows
Eligible generation assets SHALL support protected single-image download, ZIP export, ZIP import, safe generation-information copying, and current-image marking. ZIP import MUST reserve/upload/finalize a single-consume resource before mutation preflight; export SHALL use the returned protected ZIP resource. Studio SHALL NOT call generation from these actions.

#### Scenario: ZIP import completes
- **WHEN** a valid ZIP upload is finalized and import is confirmed
- **THEN** Studio SHALL execute the preflighted import, show imported/skipped counts, and prevent false reuse of a consumed resource

#### Scenario: Asset is downloaded
- **WHEN** the user downloads an allowed rendition
- **THEN** Studio SHALL fetch the protected resource with the current session and trigger a browser download without exposing a local path

#### Scenario: Generation information is copied
- **WHEN** the user selects “复制生成信息” for an eligible record
- **THEN** Studio SHALL copy prompt, safe parameters, record ID, and reference IDs without local paths or credentials

#### Scenario: Image is marked
- **WHEN** the user selects “标记图片” for an eligible record
- **THEN** Studio SHALL persist it as the single current mark, replacing any prior mark, without starting generation

## REMOVED Requirements

### Requirement: Trash retention interface
**Reason**: The Library no longer exposes Trash, soft deletion, restore, or permanent deletion.
**Migration**: A separately confirmed upgrade migration permanently removes legacy Trash generation data after preflight and recovery preparation.
