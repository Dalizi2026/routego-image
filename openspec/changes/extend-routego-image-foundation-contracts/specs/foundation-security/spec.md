## ADDED Requirements

### Requirement: API keys are write-only across Studio boundaries
Studio/local settings inputs MAY carry a replacement API key only for the `replace` mutation, but no shared result, mock observation, diagnostic, or error SHALL return the replacement value. `unchanged` and `clear` MUST carry no secret value.

#### Scenario: Replacement key is submitted
- **WHEN** Studio submits a provider-profile update with `replace`
- **THEN** the service boundary SHALL accept the value only as write input and SHALL return only `hasApiKey` and optional `apiKeyPreview`

#### Scenario: Result attempts to expose a key
- **WHEN** a service or mock result includes `apiKey`, authorization data, or the submitted replacement value
- **THEN** shared output validation or repository safety verification SHALL fail

### Requirement: Browser image resources are relative and session protected
Browser-facing asset resources SHALL use relative, session-scoped identifiers or URLs, SHALL expire, and SHALL require the loopback session policy on retrieval. They MUST NOT disclose local filesystem paths, provider authorization, or unrestricted external resource URLs.

#### Scenario: Protected resource is issued
- **WHEN** the local service issues a browser image resource descriptor
- **THEN** it SHALL include a relative identifier/URL, expiry, and validated MIME/dimension metadata for a later session-authorized request

#### Scenario: Session expires or does not match
- **WHEN** a browser attempts to retrieve the resource after expiry or with a missing/incorrect session
- **THEN** the future HTTP resource boundary SHALL reject access without revealing a local path or credential

### Requirement: Browser ZIP and mutation inputs do not accept arbitrary local paths
Studio-facing ZIP import/export and destructive/bulk mutation contracts SHALL use stable asset IDs, preflight IDs, and session-scoped upload/resource IDs rather than browser-supplied filesystem paths.

#### Scenario: Browser supplies a filesystem path
- **WHEN** a Studio mutation or ZIP request includes an absolute or relative local filesystem path where a resource ID is required
- **THEN** shared validation SHALL reject the request before any filesystem operation

#### Scenario: Legacy data remains untouched
- **WHEN** a preflight references a legacy plugin, configuration, or image-library identifier/path indirectly
- **THEN** the service SHALL return a structured safety error and SHALL NOT authorize deletion, overwrite, import, or migration
