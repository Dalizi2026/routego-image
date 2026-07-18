# Durable Image Library Specification

## Purpose

Define durable upload, gallery, resource, folder, recycle-bin, and locator behavior for the new Routego Image Library while keeping Studio boundaries path-free and legacy data untouched.

## Requirements

### Requirement: Real upload staging and lifecycle
The system SHALL implement reserve, binary staging, finalize, status, discard, expiry, and consumption for all frozen upload purposes with contained server paths and no browser path exposure.

#### Scenario: Upload is reserved
- **WHEN** a valid reservation is made
- **THEN** a stable ID, purpose policy, bounded maximum, protected relative PUT route, expiry, and correct reuse policy SHALL be stored

#### Scenario: Stream exceeds its maximum
- **WHEN** staged bytes exceed the reserved maximum
- **THEN** writing SHALL stop, incomplete bytes SHALL be removed, and status SHALL fail with `upload_oversize`

#### Scenario: Resource expires or is discarded
- **WHEN** expiry/discard occurs
- **THEN** staged bytes SHALL be safely removed and later resolution SHALL fail without revealing a path

### Requirement: Upload finalization validates integrity and type
Finalization MUST detect MIME from bytes, calculate SHA-256, check expected checksum/declared size/purpose MIME, extract image dimensions, and reject unsupported or corrupt content.

#### Scenario: Image finalizes
- **WHEN** valid PNG/JPEG/WebP bytes match policy
- **THEN** status SHALL become finalized with exact MIME, size, SHA-256, and dimensions

#### Scenario: Mask or ZIP type is wrong
- **WHEN** a mask is not PNG or ZIP import is not a ZIP archive
- **THEN** finalization SHALL fail with `upload_invalid_type` and the resource SHALL not resolve

#### Scenario: Checksum differs
- **WHEN** finalized SHA-256 differs from the reservation
- **THEN** finalization SHALL fail with `upload_checksum_failed`

### Requirement: Image uploads are reusable and ZIP uploads single consume
Finalized image-like resources SHALL remain resolvable until expiry/discard; a ZIP upload SHALL be consumed only after a successful committed import and SHALL not be reusable afterward.

#### Scenario: Image is resolved twice
- **WHEN** Integration resolves a finalized image upload more than once before expiry
- **THEN** both resolutions MAY return the same contained resource metadata

#### Scenario: ZIP import commits
- **WHEN** a ZIP import successfully commits
- **THEN** its upload SHALL become consumed, staged ZIP bytes SHALL be disposed safely, and later use SHALL return `upload_consumed`

### Requirement: Versioned validated JSON Library index
The system SHALL store a schema-versioned UTF-8 JSON index with monotonic revision and explicit corruption/version failure. Missing MAY initialize; invalid existing MUST NOT be reset.

#### Scenario: Index is missing
- **WHEN** a new approved Library root is opened
- **THEN** a valid empty version-1 index SHALL be created without scanning legacy images

#### Scenario: Index is corrupt
- **WHEN** JSON or structural validation fails
- **THEN** the original SHALL be preserved and operations SHALL stop with a sanitized error

### Requirement: Index and multi-file mutations are atomic and recoverable
Every mutation SHALL use bounded locks, revision checks, temporary files, atomic replacement, and journals whose document replacement is the commit point.

#### Scenario: Concurrent writers mutate
- **WHEN** two processes mutate the same index
- **THEN** they SHALL serialize or conflict/time out without losing a committed update

#### Scenario: Crash occurs around commit
- **WHEN** files were created or marked for deletion around an interrupted index commit
- **THEN** recovery SHALL retain referenced files, remove only journal-owned unreferenced files, and never delete unknown files

### Requirement: Validated image ingestion and deduplication
Only bounded valid PNG/JPEG/WebP bytes SHALL be ingested. MIME, magic, dimensions, size, optional claim, and SHA-256 SHALL agree. Physical blobs SHALL deduplicate by SHA-256 while logical assets preserve distinct metadata.

#### Scenario: Duplicate content has different history
- **WHEN** identical bytes arrive with different prompts/tasks
- **THEN** separate logical assets SHALL reference one physical blob

#### Scenario: Extension disguises invalid bytes
- **WHEN** a filename extension does not match valid supported content
- **THEN** ingestion SHALL fail before final placement or index commit

### Requirement: Files are placed without overwrite
Library and project copies SHALL use detected extensions and exclusive versioned names. Existing same-name files MUST remain unchanged.

#### Scenario: Name collides
- **WHEN** a target filename exists
- **THEN** a distinct numeric/versioned name SHALL be created or identical content deduplicated

### Requirement: Metadata, relationships, and locator resolution are complete
Assets SHALL retain frozen detail metadata, all ordered relationship roles, folder/deletion state, and stable asset/artifact locators. Library SHALL resolve locators to contained internal resources for Integration but SHALL NOT execute provider operations.

#### Scenario: Edit detail is read
- **WHEN** an edit uses target/reference/supporting/mask/output
- **THEN** detail SHALL preserve each ordered role and requested/effective/execution/error state

#### Scenario: Integration resolves a locator
- **WHEN** a valid asset/artifact/upload ID is requested internally
- **THEN** Library SHALL return contained path and verified metadata, never a provider result

### Requirement: Public and path-free search share semantics
Public search and Studio search SHALL use identical filters, sorting, limits, and stable cursors from one snapshot. Public results MAY include server paths; Studio results MUST use IDs and protected thumbnails only.

#### Scenario: Studio paginates gallery
- **WHEN** Studio applies filters and a cursor
- **THEN** stable path-free rows SHALL align with detail/resource IDs and not duplicate the cursor item

#### Scenario: Cursor is malformed
- **WHEN** cursor encoding/sort does not match
- **THEN** search SHALL return invalid-request rather than guessing

### Requirement: Many-to-many folders are ordered and conflict safe
Folders SHALL support create/rename/list/reorder/assign/remove, with multiple memberships, normalized unique active names, and complete-set reorder validation.

#### Scenario: Reorder omits a folder
- **WHEN** the ordered list does not contain every active folder exactly once
- **THEN** prior order SHALL remain and a conflict SHALL be returned

### Requirement: Protected browser resources are short lived
Thumbnail/preview/original/ZIP descriptors SHALL map random resource IDs to contained files, validated metadata, ETag, and expiry. Descriptors MUST NOT expose backing paths.

#### Scenario: Resource expires
- **WHEN** an expired resource is resolved
- **THEN** it SHALL be removed/rejected without revealing its file path

### Requirement: Recycle, restore, and permanent deletion are honest
Soft delete SHALL retain bytes and record previous status, deletion time, and 30-day purge eligibility. Restore SHALL reverse it. Permanent deletion SHALL revalidate preflight/confirmation per item and delete a blob only after its final reference is removed.

#### Scenario: One item changes after preflight
- **WHEN** one target becomes ineligible
- **THEN** other items MAY succeed, that item SHALL fail, and overall status SHALL be partial

#### Scenario: Shared blob still has a reference
- **WHEN** one duplicate asset is permanently deleted
- **THEN** the physical blob SHALL remain for survivors

### Requirement: Protected legacy roots are never mutated
All destructive paths SHALL be contained in approved new roots and reject traversal, drive/UNC changes, NUL, sibling confusion, and every protected legacy root.

#### Scenario: Legacy path is referenced
- **WHEN** upload, ingest, resource, cleanup, or deletion resolves to legacy data
- **THEN** mutation SHALL fail before filesystem access
