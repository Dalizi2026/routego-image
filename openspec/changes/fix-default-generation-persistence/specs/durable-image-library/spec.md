## ADDED Requirements

### Requirement: Validated provider outputs persist by detected image type
The Library SHALL atomically ingest validated PNG, JPEG, and WebP output renditions using their detected MIME type and corresponding extension when Integration supplies and byte-validation confirms the detected provider MIME. Unverified output renditions that disagree with the effective output-format preference SHALL remain rejected.

#### Scenario: JPEG output is saved after a PNG preference
- **WHEN** Integration supplies a valid JPEG rendition with matching detected MIME, dimensions, size, and checksum for an operation whose effective format is PNG
- **THEN** the Library SHALL commit the JPEG blob and metadata atomically with a JPEG extension and SHALL retain the operation's requested/effective parameters unchanged

#### Scenario: Unverified output format differs from the request
- **WHEN** a direct Library ingestion supplies an output rendition whose detected MIME differs from the effective output-format preference without an Integration-verified detected MIME claim
- **THEN** the Library SHALL reject the ingestion before publishing a blob or committing index metadata

#### Scenario: Output bytes are inconsistent
- **WHEN** an output rendition's bytes do not match its supplied detected MIME, dimensions, size, or checksum
- **THEN** the Library SHALL reject the ingestion before publishing a blob or committing index metadata
