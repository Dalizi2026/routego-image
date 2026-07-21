## MODIFIED Requirements

### Requirement: Complete creation controls
The workbench SHALL support text generation with prompt, size, aspect ratio, format, count, and transparency controls using the frozen Studio schemas. Size and aspect ratio SHALL be mutually exclusive except for `auto`; transparency SHALL force PNG, and choosing JPEG or WebP SHALL disable transparency. Quality and other advanced defaults SHALL remain configurable in Settings but SHALL NOT appear in the workbench.

#### Scenario: Text-only generation
- **WHEN** the user submits a valid prompt and approved output controls
- **THEN** Studio SHALL send a generation request and render the validated effective parameters and result

#### Scenario: Specific size is selected
- **WHEN** the user selects a non-`auto` size
- **THEN** aspect ratio SHALL return to `auto` before submission

#### Scenario: Specific aspect ratio is selected
- **WHEN** the user selects a preset or valid custom `W:H` ratio
- **THEN** size SHALL return to `auto` before submission

#### Scenario: Transparency and format interact
- **WHEN** transparency is enabled or a non-PNG format is selected
- **THEN** Studio SHALL respectively force PNG or disable transparency and SHALL submit a valid combination

#### Scenario: Invalid control value
- **WHEN** prompt, count, custom ratio, or another visible control is invalid
- **THEN** Studio SHALL show field-level guidance and SHALL NOT dispatch the operation

### Requirement: Ordered batch workflows
The workbench SHALL allow 1 through 20 ordered text-generation tasks with stable identity, fixed concurrency two, per-item prompt/size/aspect ratio/count, and submission-time global format/transparency. It SHALL expose add, remove, submit-all, cancel, and result-summary behavior but SHALL NOT expose sorting or concurrency controls.

#### Scenario: Mixed batch completes
- **WHEN** batch items succeed and fail
- **THEN** Studio SHALL keep submitted order, show one honest outcome for every item, and label the batch partial

#### Scenario: Batch is invalid
- **WHEN** task IDs repeat, limits are exceeded, or an item draft is invalid
- **THEN** Studio SHALL block batch dispatch and identify the affected task

#### Scenario: Global setting changes after submit
- **WHEN** format, transparency, provider, or model changes while a batch is active
- **THEN** active items SHALL keep their submitted snapshot and future submissions SHALL use the new values

## REMOVED Requirements

### Requirement: Path-free file upload lifecycle
**Reason**: Studio no longer accepts generation references, edit targets, supporting inputs, or masks.
**Migration**: Remove unfinished Studio image uploads and drafts through the schema upgrade; main-conversation reference generation continues through public tool inputs.

### Requirement: Provider capability gating
**Reason**: CapabilityLedger and CapabilityHint UI are removed to simplify the workbench.
**Migration**: Keep server-side capability validation and return structured failures through the normal result state without rendering capability controls.

### Requirement: Retry and edit handoff
**Reason**: Studio must not edit or directly regenerate Library images.
**Migration**: Use Library copy/mark actions and the read-only `routego_prepare_regeneration` tool to prepare a new main-conversation request.
