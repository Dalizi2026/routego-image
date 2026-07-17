## ADDED Requirements

### Requirement: Synchronous provider image results are normalized in order
Creation SHALL parse supported Images and Responses JSON shapes into ordered normalized outputs, including Base64 and result URL forms, and SHALL preserve provider response/image identifiers when available. Empty, malformed, or ambiguous success bodies MUST NOT become successful operations.

#### Scenario: Images Base64 response
- **WHEN** an Images response contains ordered `data[].b64_json` values
- **THEN** Creation SHALL decode, validate, and preserve their output slots in the normalized artifacts

#### Scenario: Images URL response
- **WHEN** an Images response contains ordered `data[].url` values
- **THEN** Creation SHALL materialize each URL under the safe download policy before creating an artifact

#### Scenario: Responses JSON result
- **WHEN** a Responses body contains completed image-generation call outputs
- **THEN** Creation SHALL extract final images plus provider response/image identifiers and SHALL not expose unrelated raw response fields

#### Scenario: Successful status has no image
- **WHEN** a 2xx provider response contains no valid final or partial image output
- **THEN** Creation SHALL return `invalid_response` rather than false success

### Requirement: Base64 and downloaded bytes are validated before artifact creation
Creation SHALL bound encoded/decoded content, validate PNG/JPEG/WebP magic and detected MIME, reject invalid or oversize payloads, and assign MIME from validated bytes rather than request assumptions.

#### Scenario: Bare Base64 format differs from the request
- **WHEN** decoded provider bytes have a valid image format different from the requested format
- **THEN** Creation SHALL record the detected MIME in the artifact and preserve the effective/result discrepancy without mislabeling the bytes

#### Scenario: Encoded content is invalid or oversized
- **WHEN** Base64 is malformed, decodes beyond the configured limit, or has unsupported image magic
- **THEN** Creation SHALL return a structured parse/download failure and SHALL not create a valid final artifact

### Requirement: Result URL downloads follow credential and redirect safety policy
Creation SHALL evaluate the frozen download policy for the initial resource URL and every redirect, SHALL omit provider authorization by default, SHALL bound redirects, bytes, MIME, and deadlines, and SHALL reject unsafe protocols, userinfo, cleartext non-loopback targets, and invalid redirects.

#### Scenario: Cross-origin image URL is returned
- **WHEN** the provider returns a valid HTTPS image URL on another origin without an explicit authenticated-download policy
- **THEN** Creation SHALL download without forwarding provider authorization

#### Scenario: Authenticated same-origin policy is explicit
- **WHEN** same-origin authorization is explicitly enabled and every redirect remains on the provider origin
- **THEN** Creation MAY forward authorization while revalidating every target

#### Scenario: Redirect changes origin
- **WHEN** an authenticated download redirects to another origin
- **THEN** Creation SHALL strip credentials, revalidate the new target, and fail if the target violates policy

### Requirement: SSE framing and event normalization are streaming safe
Creation SHALL parse LF and CRLF SSE, comments, multiple `data:` lines, explicit event names, `[DONE]`, fragmented chunks, JSON failures, partial image events, completed items, and provider error/failure events without losing already received output.

#### Scenario: Fragmented multiline event
- **WHEN** an SSE event is split across chunks and contains multiple data lines
- **THEN** the codec SHALL reconstruct one ordered event and pass its decoded value to the transport-specific normalizer

#### Scenario: Partial then complete
- **WHEN** the provider emits partial images followed by a completed final image
- **THEN** Creation SHALL emit monotonic partial events and return the final artifact while retaining requested partial metadata

#### Scenario: Stream fails after partial output
- **WHEN** an error/failure/invalid event occurs after a partial image
- **THEN** Creation SHALL preserve the partial artifact, set `receivedAnyOutput=true` and `mayHaveBilled=true`, and forbid automatic replay

### Requirement: Provider failures are mapped to sanitized structured errors
Creation SHALL classify HTTP/provider errors by stage into frozen error codes/categories/retry dispositions, preserve safe HTTP/provider codes when useful, limit and redact diagnostic details, and never return raw bodies, headers, credentials, or image data.

#### Scenario: Authentication or moderation failure
- **WHEN** the provider returns an authentication/authorization or moderation response
- **THEN** Creation SHALL return `auth_failed` or `moderation_blocked`, mark it non-automatic, and SHALL not record the capability as unsupported

#### Scenario: Rate limit or provider 5xx before output
- **WHEN** a 429 or 5xx response contains no output and is classified before generation
- **THEN** the structured error SHALL expose the safe retry disposition needed by the executor without claiming success

#### Scenario: Provider body contains a secret or data URL
- **WHEN** the raw error embeds an authorization value, credential-bearing URL, or image data
- **THEN** the structured error and diagnostics SHALL redact those values before crossing any boundary

### Requirement: Artifact and relationship metadata remain internally consistent
Normalized results SHALL use unique stable request-local artifact IDs, preserve slots and phases, record input/output relationships, and keep execution, top-level error, partial artifacts, and billing/output flags mutually consistent with the frozen result schemas.

#### Scenario: Partial result is assembled
- **WHEN** one output slot succeeds or emits partial data and another slot fails
- **THEN** the result SHALL be `partial`, include the received artifacts and failed slot error, and report the actual provider request count

#### Scenario: Invalid relationship is assembled
- **WHEN** a relationship references an absent artifact or an artifact is placed in the wrong phase collection
- **THEN** output validation SHALL fail closed as an internal contract error
