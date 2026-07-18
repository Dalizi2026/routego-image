# Library Portability Specification

## Purpose

Define dependency-free, bounded, credential-free ZIP export and import for selected new Library assets with atomic recovery and cross-platform safety.

## Requirements

### Requirement: Credential-free versioned manifest
Exports SHALL contain a versioned UTF-8 manifest for selected assets, folders, relationships, and blob integrity metadata, without keys, headers, tokens, absolute paths, provider bodies, or staging paths.

#### Scenario: Export is inspected
- **WHEN** selected assets are exported
- **THEN** the manifest SHALL contain enough portable logical/blob data to import them without source-machine secrets or paths

### Requirement: Bounded standards-compatible ZIP export
Export SHALL write UTF-8 regular entries, central directory, and EOCD using only store/deflate, then flush and publish via an exclusive versioned path and protected resource descriptor.

#### Scenario: Target exists
- **WHEN** the requested archive name exists
- **THEN** a distinct versioned filename SHALL be published without replacement

#### Scenario: Export is interrupted
- **WHEN** publication does not commit
- **THEN** no successful descriptor SHALL be returned and recovery SHALL remove only its temporary file

### Requirement: Defensive ZIP structural limits
Import MUST parse the central directory first and reject encryption, multi-disk, unsupported methods, duplicate canonical names, absolute/drive/UNC/backslash/NUL/traversal names, symlink/special entries, excessive names/counts/sizes/totals, and excessive expansion ratios.

#### Scenario: Traversal entry exists
- **WHEN** an entry escapes its portable relative root
- **THEN** the archive SHALL be rejected before final file/index mutation

#### Scenario: Compression bomb exceeds policy
- **WHEN** declared or observed limits are exceeded
- **THEN** processing SHALL stop before allocating/writing beyond policy

### Requirement: Archive and image integrity are verified
Import SHALL verify local/central consistency, CRC-32, manifest SHA-256, size, supported image magic/MIME/dimensions, and every referenced entry before commit.

#### Scenario: CRC or SHA differs
- **WHEN** bytes do not match ZIP or manifest integrity data
- **THEN** the transaction SHALL fail and corrupted content SHALL not be indexed

#### Scenario: Manifest entry is missing
- **WHEN** an asset references a missing/duplicate blob entry
- **THEN** import SHALL fail before durable mutation

### Requirement: Import is collision safe and deduplicated
Existing identical blobs SHALL be reused; exact records MAY be skipped; conflicting asset/folder/relationship IDs SHALL be remapped consistently; existing files MUST NOT be overwritten.

#### Scenario: Blob already exists
- **WHEN** SHA-256 matches a valid existing blob
- **THEN** imported logical assets SHALL reuse it

#### Scenario: ID conflicts with different data
- **WHEN** an imported ID is occupied by another record
- **THEN** a new ID SHALL be assigned and all in-archive references rewritten consistently

### Requirement: Upload-backed import is single consume
Studio import SHALL accept only a finalized `zip-import` upload resource and mark it consumed only after the import commits successfully.

#### Scenario: Import fails validation
- **WHEN** archive validation fails
- **THEN** the upload SHALL remain failed/finalized according to policy but SHALL NOT be falsely marked consumed

#### Scenario: Import commits
- **WHEN** records and index commit
- **THEN** upload status SHALL become consumed and reuse SHALL fail

### Requirement: Portable mutation is atomic and reports partial outcomes
ZIP import/export SHALL journal files and index intent, use one atomic commit point, recover interruption, and return ordered per-item success/failure/skipped outcomes.

#### Scenario: Crash before index commit
- **WHEN** imported files exist without committed records
- **THEN** recovery SHALL remove only new unreferenced transaction files and retain reused/existing data

#### Scenario: Item conflicts at commit
- **WHEN** one otherwise valid asset becomes ineligible
- **THEN** eligible items MAY commit and the overall result SHALL be partial with an honest failed item

### Requirement: UTF-8 archives are cross-platform
Manifests and names SHALL preserve Chinese, emoji, spaces, and forward-slash portable paths without native dependencies or source-machine separators.

#### Scenario: Archive crosses operating systems
- **WHEN** Windows output is imported on POSIX or vice versa
- **THEN** metadata and safe names SHALL round-trip without absolute-path interpretation or replacement characters

### Requirement: Legacy data is never implicit portability input
Only explicitly selected new Library assets and supplied new-format ZIP resources SHALL participate. Legacy config/images/plugin data MUST remain untouched.

#### Scenario: Legacy files exist
- **WHEN** portability runs beside legacy data
- **THEN** those files SHALL not be discovered, packaged, imported, overwritten, or deleted
