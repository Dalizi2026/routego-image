## ADDED Requirements

### Requirement: Library source renditions are isolated from public image artifacts
The shared package SHALL define a Library-only rendition phase `source` in addition to Library `partial` and `final` phases, SHALL bound one Library asset to at most 33 renditions, and MUST keep the public `ImageArtifact` phase schema exactly `partial | final` and the public MCP operation set exactly unchanged.

#### Scenario: Library detail contains uploaded sources
- **WHEN** a persisted operation asset contains uploaded target, reference, supporting, or mask inputs
- **THEN** its Library renditions MAY identify those exact artifacts with phase `source` without making `source` valid in a public image operation result

#### Scenario: Public artifact attempts to use source phase
- **WHEN** a public MCP image result contains an artifact with phase `source`
- **THEN** shared validation SHALL fail closed and no new public tool or artifact phase SHALL be advertised

#### Scenario: Rendition limit is exceeded
- **WHEN** a Library asset detail contains more than 33 combined source, partial, and final renditions
- **THEN** shared input/output validation SHALL reject it before persistence or browser serialization

## MODIFIED Requirements

### Requirement: Complete browser-safe asset detail contracts
The shared package SHALL define an asset-detail result containing stable asset/artifact identifiers, prompt and model metadata, requested and effective image parameters, execution metadata, structured errors, folder membership and deletion state, allowed actions, up to 33 ordered Library renditions using `source | partial | final`, and ordered relationships using `source`, `target`, `reference`, `supporting`, `mask`, and `output` roles. A primary rendition MUST reference an output phase rather than a source phase, and every relationship artifact identifier MUST belong to its declared related asset.

#### Scenario: Studio opens an asset detail
- **WHEN** an existing asset detail is requested
- **THEN** the result SHALL include complete generation/edit parameters, current folder state, allowed actions, errors when present, and enough ordered relationships and exact rendition identifiers to distinguish every source, target, reference, supporting image, mask, partial output, and final output

#### Scenario: Uploaded source is represented honestly
- **WHEN** an operation saved to the Library used a finalized upload rather than an existing Library asset
- **THEN** detail SHALL expose that input as a `source` rendition owned by the operation asset and the matching relationship SHALL reference its exact artifact identifier without fabricated generate/edit metadata for a separate asset

#### Scenario: Primary points to a source
- **WHEN** a service returns a source rendition as `primaryArtifactId`
- **THEN** output validation SHALL fail closed as an internal-contract error

#### Scenario: Relationship artifact ownership is inconsistent
- **WHEN** a relationship declares an artifact that does not belong to its `relatedAssetId`
- **THEN** output validation SHALL fail closed rather than serialize an ambiguous retry or comparison graph

#### Scenario: Detail is not available
- **WHEN** the requested asset does not exist or is not visible in the current state
- **THEN** the service SHALL return a structured `not_found` or access error and SHALL NOT fabricate detail data
