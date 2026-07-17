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

### Requirement: Browser upload resources are session scoped and policy bounded
Upload reservation and binary-route metadata SHALL be relative, short-lived, session/origin protected, purpose bound, MIME restricted, and size bounded. Upload JSON, structured errors, diagnostics, and mock observations MUST NOT contain raw bytes, Base64, full local paths, provider credentials, authorization headers, cookies, or session-token values.

#### Scenario: Protected upload route is issued
- **WHEN** a valid upload reservation is created
- **THEN** the route descriptor SHALL require the current session and matching loopback origin and SHALL expose only relative routing and policy metadata

#### Scenario: Sensitive upload content reaches a diagnostic boundary
- **WHEN** an error or observation contains upload bytes, Base64, a token, credential, or staging path
- **THEN** redaction/output validation SHALL remove or reject the sensitive value before logging or serialization

### Requirement: Upload integrity, expiry, and consumption fail closed
The future upload owner MUST detect MIME from bytes, enforce maximum bytes while streaming, compute SHA-256, validate an expected checksum when present, record image dimensions when available, expire/discard resources, and enforce reusable-image versus single-consume-ZIP policy before Integration resolves any resource.

#### Scenario: Declared and detected MIME differ
- **WHEN** uploaded bytes do not match the purpose's allowed detected MIME policy
- **THEN** finalization SHALL fail with `upload_invalid_type` and the resource SHALL not be resolved for Creation or ZIP import

#### Scenario: Stream exceeds maximum bytes
- **WHEN** the binary route receives more than the reservation maximum
- **THEN** it SHALL stop accepting data, return `upload_oversize`, and dispose of incomplete staging safely

#### Scenario: Resource is expired, discarded, or consumed
- **WHEN** Integration attempts to resolve an upload after expiry/discard or a ZIP after its successful single consumption
- **THEN** resolution SHALL fail without revealing a storage path and without reusing bytes

### Requirement: Studio image and search DTOs are path and credential free
Studio generate/edit/batch inputs, results, events, errors, relationships, artifacts, Library search rows, and thumbnails SHALL contain only approved stable identifiers, metadata, and protected relative resources. They MUST NOT contain local paths, file URLs, unrestricted external URLs, provider credentials, request headers, image bytes, Base64, or data URLs.

#### Scenario: Public MCP artifact is projected to Studio
- **WHEN** Integration converts a path-based public/internal execution artifact into a Studio result
- **THEN** it SHALL replace path/display data with `artifactId` plus a protected `BrowserResourceDescriptor`

#### Scenario: Unsafe value crosses the Studio boundary
- **WHEN** a Studio DTO contains a path-like field, external URL, credential-like field, or encoded image payload
- **THEN** shared output validation and browser-safe audits SHALL fail

### Requirement: Output-directory replacement is explicitly confirmed and server validated
The only Studio contract allowed to carry a local configuration path SHALL be output-directory `replace` with literal user confirmation. The future server MUST canonicalize and strictly validate that path, reject relative/NUL/traversal/root/legacy-protected/unsafe-symlink/non-local destinations, and verify a safe user-controlled destination before persistence. Results and logs MUST NOT echo the full submitted path.

#### Scenario: Safe replacement is submitted
- **WHEN** the user explicitly confirms a candidate output directory
- **THEN** the future settings service SHALL validate it server-side before storing and SHALL return only redacted configured/display state

#### Scenario: Unsafe or unconfirmed path is submitted
- **WHEN** confirmation is absent or the path is relative, root-level, NUL-containing, traversal-like, legacy-protected, unsafe through symlink resolution, or not a safe local destination
- **THEN** the service SHALL reject it without changing settings or exposing sensitive path details

### Requirement: Legacy and real user data remain untouched
This corrective gate SHALL use only synthetic in-memory mock state and SHALL NOT read, mutate, import, delete, or migrate real configuration, credentials, upload bytes, user images, Library indexes, legacy plugin data, or legacy paths.

#### Scenario: Tests run in an environment containing real local data
- **WHEN** contract and mock tests execute on a developer machine
- **THEN** their outcome SHALL be independent of environment variables, home-directory files, network access, real keys, and user images
