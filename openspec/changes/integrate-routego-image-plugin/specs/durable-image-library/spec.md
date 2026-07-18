## ADDED Requirements

### Requirement: One operation asset owns exact source and output renditions
Library ingestion SHALL accept a preallocated logical operation asset containing ordered `source` renditions plus `partial` and `final` output renditions, SHALL commit them atomically with their exact relationships, and SHALL enforce a maximum of 33 total renditions.

#### Scenario: Upload-backed edit is saved
- **WHEN** Integration supplies a preallocated asset ID, target/supporting/mask source artifacts, and partial/final provider outputs
- **THEN** Library SHALL commit one operation asset whose source relationships point to the exact source artifact IDs and whose output relationships point to the exact partial/final artifact IDs

#### Scenario: Existing Library input is used
- **WHEN** an operation input already belongs to another Library asset/artifact
- **THEN** the new operation asset SHALL relate to that original owner and SHALL NOT duplicate or reclassify it as an upload-origin source rendition

#### Scenario: Ingestion exceeds the source and output bound
- **WHEN** an operation supplies more than 33 total renditions
- **THEN** Library SHALL reject the transaction before placing files or replacing the index

### Requirement: Primary and succeeded-state invariants are output only
The primary artifact SHALL identify a `partial` or `final` rendition and MUST NOT identify `source`. A succeeded asset SHALL contain at least one final output. A partial asset MAY select a final output when present or a partial output otherwise, but never a source input.

#### Scenario: Succeeded operation has only sources
- **WHEN** ingestion marks an asset succeeded without a final rendition
- **THEN** Library SHALL reject the transaction as an invalid operation graph

#### Scenario: Partial operation has sources and partial output
- **WHEN** an operation fails after receiving a valid partial image
- **THEN** Library MAY persist the partial operation with that partial output as primary while retaining the exact sources and billing/output error state

## MODIFIED Requirements

### Requirement: Validated image ingestion and deduplication
Only bounded valid PNG/JPEG/WebP bytes SHALL be ingested. MIME, magic, dimensions, size, optional claim, and SHA-256 SHALL agree. Physical blobs SHALL deduplicate by SHA-256 while logical assets preserve distinct metadata. Source renditions MAY use a MIME different from the effective output format; partial and final output renditions MUST continue to match the effective output format and applicable output claims.

#### Scenario: Duplicate content has different history
- **WHEN** identical bytes arrive with different prompts/tasks or as both an existing source and a new output
- **THEN** separate logical artifact identities SHALL reference one physical blob without losing phase or relationship ownership

#### Scenario: Mixed-format operation graph is ingested
- **WHEN** a PNG mask, JPEG reference, WebP supporting image, and PNG provider outputs belong to one saved operation
- **THEN** Library SHALL accept the validated source MIME diversity and SHALL enforce PNG only on the partial/final output renditions for that operation

#### Scenario: Output MIME differs from the effective format
- **WHEN** a partial or final rendition does not match the effective output format
- **THEN** ingestion SHALL fail before final placement or index commit without applying the source-MIME exception

#### Scenario: Extension disguises invalid bytes
- **WHEN** a filename extension does not match valid supported content
- **THEN** ingestion SHALL fail before final placement or index commit

### Requirement: Metadata, relationships, and locator resolution are complete
Assets SHALL retain frozen detail metadata, all ordered relationship roles, folder/deletion state, stable asset/artifact locators, and the exact ownership/phase of every source, partial, and final rendition. Library SHALL resolve locators to contained internal resources for Integration but SHALL NOT execute provider operations. Every relationship artifact ID MUST belong to its declared related asset, including source renditions owned by a preallocated operation asset.

#### Scenario: Edit detail is read
- **WHEN** an edit uses target/reference/supporting/mask/output from existing Library artifacts and upload-origin sources
- **THEN** detail SHALL preserve each ordered role, exact related asset/artifact ID, source/output phase, and requested/effective/execution/error state

#### Scenario: Relationship points to the wrong asset
- **WHEN** ingestion or index parsing finds that a relationship artifact is owned by another asset than `relatedAssetId`
- **THEN** the mutation/read SHALL fail as corrupt or invalid rather than repair, guess, or substitute the primary output

#### Scenario: Integration resolves a locator
- **WHEN** a valid asset/artifact/upload ID is requested internally
- **THEN** Library SHALL return contained path and verified metadata, never a provider result

#### Scenario: Exact source artifact is resolved for retry
- **WHEN** Studio retry selects a source relationship artifact ID from detail
- **THEN** Library SHALL resolve that exact source rendition and SHALL NOT redirect it to the asset primary output
