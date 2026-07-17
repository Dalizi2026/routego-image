## ADDED Requirements

### Requirement: Separate versioned settings and credentials
The system SHALL persist non-sensitive provider settings in versioned UTF-8 JSON and API keys in a separate versioned credential document beneath the new data root, without reading or migrating legacy configuration.

#### Scenario: New configuration initializes
- **WHEN** the new documents are absent
- **THEN** schema-version-1 empty documents SHALL be created without inspecting the legacy config

#### Scenario: Existing document is corrupt
- **WHEN** a document is malformed or has an unsupported version
- **THEN** the system SHALL fail with a sanitized configuration error and SHALL NOT replace it with defaults

### Requirement: Credentials are owner restricted
Credential files MUST be mode `0600` on POSIX and protected by an explicit current-user Windows ACL. Secret writes SHALL fail closed when protection cannot be applied or verified.

#### Scenario: POSIX key replacement
- **WHEN** a key is written on POSIX
- **THEN** the credential file SHALL have mode `0600`

#### Scenario: Windows ACL fails
- **WHEN** the current-user ACL operation fails
- **THEN** the key mutation SHALL fail without exposing or claiming to store the key

### Requirement: Configuration writes are concurrent and recoverable
Settings and credentials SHALL use bounded tokenized locks, temporary files, flush, atomic replacement, and validated recovery.

#### Scenario: Two writers contend
- **WHEN** two processes update settings concurrently
- **THEN** writes SHALL serialize or time out boundedly and the committed JSON SHALL remain valid

#### Scenario: Writer crashes before replacement
- **WHEN** a temporary document exists without a committed replacement
- **THEN** the previous valid document SHALL remain readable and recovery SHALL clean only transaction-owned debris

### Requirement: Complete profile and secret mutation persistence
The system SHALL implement read, upsert, remove, and set-active semantics with exact endpoint inputs, active selection, timestamps, cached models, and `unchanged | replace | clear` API-key operations.

#### Scenario: Key is preserved
- **WHEN** an upsert uses `unchanged`
- **THEN** the stored key SHALL remain unchanged and no result SHALL contain it

#### Scenario: Key is replaced or cleared
- **WHEN** an upsert uses `replace` or `clear`
- **THEN** only the credential document SHALL change for the secret and results SHALL expose only redacted presence metadata

#### Scenario: Active profile is removed
- **WHEN** the active profile is removed
- **THEN** active selection SHALL become unset rather than silently choosing another profile

### Requirement: Endpoints and capability evidence remain explicit
The system SHALL validate explicit endpoints, apply only the frozen legacy generation normalization, persist four-state scoped capability evidence, and perform no provider request.

#### Scenario: Only generation is configured
- **WHEN** a profile supplies only its generation endpoint
- **THEN** models/Edits/Responses endpoints and capabilities SHALL remain unset or unknown

#### Scenario: Transient evidence is stored
- **WHEN** authentication, timeout, rate-limit, moderation, 5xx, or isolated-model evidence is supplied
- **THEN** persistence SHALL preserve the prior state and SHALL NOT convert it to unsupported

#### Scenario: Degraded evidence is stored
- **WHEN** a weaker fallback is confirmed
- **THEN** the record SHALL include `degraded`, verification time, and a reason

### Requirement: Defaults and output-directory mutations are durable
The system SHALL implement frozen defaults and output-directory `unchanged | default | clear | replace` mutations and return only redacted output-directory state.

#### Scenario: Defaults are updated
- **WHEN** valid defaults are submitted
- **THEN** a subsequent settings read SHALL return them

#### Scenario: Output directory is defaulted or cleared
- **WHEN** `default` or `clear` is selected
- **THEN** their distinct durable state SHALL be preserved without a custom path

### Requirement: Replacement output paths are strictly validated
For `replace`, the server MUST canonicalize the confirmed absolute local path, reject roots, relative/NUL/traversal/URL/unsafe UNC, legacy roots, symlinked components, unsafe ownership, non-directories, and non-creatable destinations before persistence.

#### Scenario: Safe destination is selected
- **WHEN** a user-confirmed owned/creatable local directory passes every check
- **THEN** it SHALL be persisted and the response SHALL expose only a redacted display label

#### Scenario: Unsafe destination is selected
- **WHEN** any containment, symlink, ownership, type, or creatability check fails
- **THEN** settings SHALL remain unchanged and logs/results SHALL NOT echo the full path

### Requirement: Redaction is recursive and export safe
Settings reads, diagnostics, errors, and portable summaries MUST omit keys, headers, query credentials, credential paths, and unrestricted output paths.

#### Scenario: Settings are read after key storage
- **WHEN** Studio reads settings
- **THEN** it SHALL receive only `hasApiKey`, optional preview, redacted endpoints, defaults, and redacted output-directory state

