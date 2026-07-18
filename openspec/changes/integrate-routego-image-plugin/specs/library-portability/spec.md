## ADDED Requirements

### Requirement: Source rendition graphs round-trip without semantic loss
ZIP export/import SHALL preserve every selected asset's source, partial, and final rendition phases, exact artifact IDs, primary output, relationships, checksums, and ownership graph within the 33-rendition-per-asset bound.

#### Scenario: Operation with uploaded sources is exported and imported
- **WHEN** an asset contains source target/reference/supporting/mask renditions and partial/final outputs
- **THEN** import SHALL recreate an equivalent operation graph whose ordered relationships resolve to the same remapped exact artifact owners and whose primary remains an output

#### Scenario: Identifier collision requires remapping
- **WHEN** imported source/output asset or artifact IDs conflict with existing different records
- **THEN** import SHALL remap all affected rendition, primary, and relationship references consistently without converting a source into an output

#### Scenario: Imported graph exceeds the bounded capacity
- **WHEN** a manifest asset contains more than 33 renditions or relationships refer outside the validated graph
- **THEN** import SHALL reject the archive before durable file or index mutation

## MODIFIED Requirements

### Requirement: Credential-free versioned manifest
Exports SHALL contain a versioned UTF-8 manifest for selected assets, folders, source/partial/final renditions, primary output, relationships, and blob integrity metadata, without keys, headers, tokens, absolute paths, provider bodies, or staging paths. The manifest SHALL bound each asset to at most 33 renditions and SHALL retain exact relationship artifact ownership.

#### Scenario: Export is inspected
- **WHEN** selected assets are exported
- **THEN** the manifest SHALL contain enough portable logical/blob data to import their complete source/output graphs without source-machine secrets or paths

#### Scenario: Manifest attempts to encode a source primary
- **WHEN** an exported record identifies a source rendition as primary or omits the final output of a succeeded asset
- **THEN** export validation SHALL fail and SHALL NOT publish a successful ZIP descriptor

### Requirement: Archive and image integrity are verified
Import SHALL verify local/central consistency, CRC-32, manifest SHA-256, size, supported image magic/MIME/dimensions, rendition phase and bounds, primary-output invariants, exact relationship ownership, and every referenced entry before commit.

#### Scenario: CRC or SHA differs
- **WHEN** source, partial, final, or manifest bytes do not match ZIP or manifest integrity data
- **THEN** the transaction SHALL fail and corrupted content SHALL not be indexed

#### Scenario: Manifest entry is missing
- **WHEN** an asset references a missing/duplicate blob or rendition entry
- **THEN** import SHALL fail before durable mutation

#### Scenario: Relationship ownership is inconsistent
- **WHEN** a relationship artifact does not belong to its declared related asset after collision remapping
- **THEN** import SHALL fail before commit rather than substitute another artifact
