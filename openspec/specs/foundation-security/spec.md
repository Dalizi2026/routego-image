# Foundation Security Specification

## Purpose

Defines the durable security requirements for the Routego Image foundation.

## Requirements
### Requirement: Recursive secret and image-data redaction
Diagnostics and mock observations SHALL recursively redact API keys, authorization and cookie headers, bearer values, session tokens, credential-bearing query parameters, and image data payloads without mutating the source value.

#### Scenario: Nested sensitive fields
- **WHEN** a diagnostic value contains sensitive fields at multiple object or array depths
- **THEN** every sensitive value SHALL be replaced with a non-secret marker and the original value SHALL remain unchanged

#### Scenario: Error message contains bearer token
- **WHEN** a provider or runtime error embeds a bearer token in free text
- **THEN** the safe diagnostic output SHALL redact the token before logging or returning the error

### Requirement: Loopback-only binding
Local HTTP and mock server configuration SHALL permit binding only to `127.0.0.1` or `::1` and SHALL reject wildcard, LAN, or public addresses.

#### Scenario: Valid loopback bind
- **WHEN** the service requests `127.0.0.1` or `::1`
- **THEN** the security policy SHALL accept the bind address

#### Scenario: Public bind rejected
- **WHEN** the service requests `0.0.0.0`, `::`, a LAN address, or a hostname resolving outside loopback
- **THEN** the security policy SHALL reject startup before a listener is created

### Requirement: Session and origin protection
Protected loopback HTTP operations SHALL require a cryptographically random short-lived session token, constant-time token comparison, and an allowed matching loopback origin without wildcard CORS or cookie authentication.

#### Scenario: Valid local request
- **WHEN** a request presents the current session token and an allowed loopback origin
- **THEN** the request SHALL pass the boundary authorization policy

#### Scenario: Missing or incorrect token
- **WHEN** a protected request omits the token or presents a different value
- **THEN** the request SHALL be rejected without revealing the expected token

#### Scenario: Cross-site request
- **WHEN** a request presents a non-loopback or mismatched origin even with a valid token
- **THEN** the request SHALL be rejected and no wildcard CORS permission SHALL be emitted

### Requirement: Non-destructive path containment
Path safety helpers SHALL reject NUL input, traversal outside an approved root, and ambiguous cross-root paths before later lanes access files, and SHALL never target legacy plugin/config/library paths for deletion or overwrite.

#### Scenario: Contained output path
- **WHEN** a normalized candidate path remains within its approved root
- **THEN** the helper SHALL return the resolved contained path

#### Scenario: Traversal attempt
- **WHEN** a candidate path escapes the approved root through relative segments, drive changes, UNC changes, or sibling-prefix confusion
- **THEN** the helper SHALL reject it before any filesystem mutation

#### Scenario: Legacy path supplied
- **WHEN** a destructive operation targets a legacy plugin, legacy configuration, or legacy image-library root
- **THEN** the safety policy SHALL reject the operation

### Requirement: Repository safety gate
The repository SHALL provide an automated safety check that fails on likely committed API keys, authentication headers, local configuration, user-image fixtures, generated image outputs, or test/report caches.

#### Scenario: Synthetic contract fixtures
- **WHEN** tests use explicitly synthetic identifiers or in-memory image payloads that cannot be mistaken for user data or credentials
- **THEN** the safety check SHALL allow them

#### Scenario: Secret-like tracked content
- **WHEN** a tracked source or fixture contains a likely real key or authorization header value
- **THEN** the safety check SHALL fail with a file location while avoiding echoing the full secret

### Requirement: Safe provider resource download policy
Provider authorization SHALL NOT be forwarded to image result URLs by default, and any future authenticated download policy MUST be explicit, same-origin constrained, and revalidated on every redirect.

#### Scenario: Provider returns an arbitrary image URL
- **WHEN** an image response contains a URL without an explicit authenticated-download policy
- **THEN** the downloader policy SHALL omit provider authorization credentials

#### Scenario: Redirect changes origin
- **WHEN** an authenticated resource request redirects to another origin
- **THEN** the policy SHALL remove credentials and require the new target to pass protocol, address, size, and type validation

### Requirement: UTF-8 and safe endpoint diagnostics
Text contracts, JSON, diagnostics, and repository documents SHALL use UTF-8, and endpoint diagnostics SHALL redact URL userinfo, query credentials, and fragments.

#### Scenario: International input and path
- **WHEN** a contract contains Chinese text, emoji, spaces, or platform-specific newlines in a permitted string/path field
- **THEN** UTF-8 serialization and parsing SHALL preserve the value without replacement characters

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
