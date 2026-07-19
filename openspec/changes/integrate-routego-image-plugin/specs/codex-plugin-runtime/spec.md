## ADDED Requirements

### Requirement: MCP exposes exactly the seven frozen tools
The plugin runtime SHALL run the long-lived STDIO MCP lifecycle over the composed `RoutegoService`, SHALL advertise exactly `routego_status`, `routego_generate`, `routego_edit`, `routego_batch`, `routego_search_library`, `routego_manage_library`, and `routego_open_studio`, and MUST NOT expose Studio-only or Integration-internal operations.

#### Scenario: Codex initializes the plugin
- **WHEN** a fresh MCP client initializes and lists tools
- **THEN** it SHALL receive exactly the seven frozen names and their shared input schemas

#### Scenario: Internal stream or upload name is requested
- **WHEN** a client attempts to call an Integration or Studio operation as a tool
- **THEN** MCP SHALL return tool-not-found without dispatching it

### Requirement: Public MCP success projection remains schema-valid and image-payload safe
After validating a service success result against its frozen public output schema, the MCP runtime SHALL serialize structured text through a public-success projection rather than diagnostic/error redaction. The projection SHALL preserve every schema-defined public field, including current-call public result paths and the fresh one-time `routego_open_studio` launch token. Generate, edit, and batch structured text MUST omit or replace image data URLs and binary payloads, while validated final images SHALL remain available as MCP image content. Structured errors, caught exceptions, framing failures, logger output, Authorization values, credentials, arbitrary diagnostic URLs, and binary diagnostic data SHALL remain recursively redacted.

#### Scenario: Codex opens Studio from MCP content
- **WHEN** `routego_open_studio` returns a validated fresh loopback launch URL
- **THEN** MCP structured text SHALL still satisfy `routegoOpenStudioResultSchema`, contain the one-time token required for immediate bootstrap, and preserve no unrelated diagnostic query or credential

#### Scenario: Generate, edit, or batch returns image display data
- **WHEN** a validated success result contains final image data URLs and optional partial image data
- **THEN** structured text SHALL contain no image Base64 or bytes, validated final images SHALL be emitted through MCP image content, and all other schema-defined public success fields SHALL remain intact

#### Scenario: Failure contains a credential or arbitrary URL query
- **WHEN** an invalid output, thrown error, framing failure, or logger diagnostic contains Authorization, credentials, a data URL, bytes, or an arbitrary query-bearing URL
- **THEN** the error and diagnostic boundaries SHALL recursively redact those values without applying that diagnostic transformation to a validated public success result

### Requirement: Routego Image Skill is thin, relocatable, and secret safe
The Skill SHALL map user intent to the seven MCP tools, distinguish variants from independent batch tasks, inspect status/capability evidence before dependent operations, display only current-call validated paths/content, and use plugin-relative/runtime-provided resources. It MUST NOT hardcode a personal plugin directory, request a complete key in chat, run legacy scripts, scan output folders, or fabricate success.

#### Scenario: User requests an unconfirmed edit
- **WHEN** status reports required image capability unknown or unsupported
- **THEN** the Skill SHALL explain the limitation and SHALL not call an edit path as though it were supported

#### Scenario: Current call returns final images
- **WHEN** a tool returns validated final paths and image content
- **THEN** the Skill SHALL present those exact results and SHALL not reuse an older file or flood ordinary context with intermediate images

### Requirement: Studio bootstrap and static assets are loopback contained
The runtime SHALL bind only `127.0.0.1` or `::1`, SHALL require a valid short-lived launch token for bootstrap HTML, SHALL serve only contained allowlisted Studio static assets with correct MIME/size/ETag, and SHALL provide no directory listing, arbitrary file read, LAN bind, wildcard CORS, or cookie authentication.

#### Scenario: Studio opens with a valid launch token
- **WHEN** `routego_open_studio` returns a fresh URL and the browser requests it before expiry
- **THEN** the runtime SHALL serve no-store HTML, Studio SHALL remove the token from the visible URL, and later API requests SHALL use only the in-memory session header

#### Scenario: Static path traversal is attempted
- **WHEN** a request uses traversal, encoded separators, a symlink escape, or an unallowlisted asset
- **THEN** the runtime SHALL reject it without revealing a filesystem path

### Requirement: Sessions support safe listener reuse
The runtime SHALL maintain a bounded set of cryptographically random expiring session tokens for one loopback listener. Reusing the listener SHALL issue a fresh token without invalidating other unexpired sessions, and expired/mismatched tokens SHALL fail constant-time authorization without disclosure.

#### Scenario: Studio is opened twice with reuse enabled
- **WHEN** an existing listener is healthy
- **THEN** both unexpired sessions SHALL remain independently valid and the result SHALL mark the listener reused

#### Scenario: Session expires
- **WHEN** a protected request presents an expired token
- **THEN** the request SHALL fail before service/resource invocation and the token SHALL be removed from active state

### Requirement: Protected JSON, upload, resource, and stream routes share policy
All non-static local routes SHALL require an active session header and exact matching loopback origin, reject cookies and wildcard CORS, validate bounded inputs/outputs, and redact returned/logged failures. Upload and resource bytes SHALL travel only through their protected binary routes. Streaming generate/edit SHALL use only `POST /api/v1/studio/creation/stream`, and that route SHALL emit only frozen path-free events in the exact first-started/partials/one-terminal state machine.

#### Scenario: Upload content is accepted
- **WHEN** a PUT matches a live reservation, session, origin, purpose, MIME, declared size, actual bounded size, and expiry
- **THEN** the runtime SHALL stream it to Library staging without buffering/logging image bytes or Base64

#### Scenario: Protected image or ZIP is fetched
- **WHEN** a live descriptor is requested with its session and origin
- **THEN** the runtime SHALL resolve contained backing data, verify MIME/size/ETag, stream it with safe headers, and forward no provider credential

#### Scenario: Stream request is unauthorized
- **WHEN** a generate/edit fetch-stream request lacks the current session or matching origin
- **THEN** it SHALL fail before creation execution and SHALL emit no SSE body

#### Scenario: Stream route or sentinel differs from the contract
- **WHEN** a client requests another streaming path or a producer emits `[DONE]` or another non-schema sentinel
- **THEN** the runtime SHALL reject it without routing a second stream surface or treating the sentinel as completion

### Requirement: Runtime lifecycle releases every resource
The plugin process SHALL keep stdout protocol-only, write only recursively redacted diagnostics to stderr, recover Library state before readiness, and release HTTP listeners, sessions, event channels, streams, abort controllers, readers, timers, browser resources, temporary files, and MCP framing state on their defined lifecycle boundaries. Every ephemeral descriptor expiry SHALL be fixed at registration no later than `min(registration time + 5 minutes, owning session expiry)`. Terminal, disconnect, cancellation, invalid input, or browser object-URL revocation SHALL close client/stream resources but SHALL NOT shorten that server descriptor expiry; descriptor/session expiry and process shutdown SHALL revoke server resources. The runtime MUST NOT force `process.exit()` as a business result protocol.

When an HTTP response write applies backpressure, the loopback host SHALL race the pending `drain` against response close/error and request abort, stop writing after disconnect, and explicitly return the active response-body iterator from `finally` so producer cleanup runs promptly.

#### Scenario: Session-capped descriptor expires
- **WHEN** a resource is registered for a session with less than five minutes remaining
- **THEN** its descriptor SHALL expire with the session, allow protected fetch only before that exact boundary, and reject access at or after expiry

#### Scenario: Client disconnects during real loopback-host backpressure
- **WHEN** `IntegrationLoopbackHttpHost` streams a large protected resource over a real loopback connection, actual response backpressure is active, and the client disconnects while the host is waiting for `drain`
- **THEN** the host SHALL promptly resolve the wait, stop writing, return the active response-body iterator, and allow the producer `finally` to close its reader, channel, file, and ephemeral lease exactly once; the immutable descriptor expiry SHALL remain unchanged and the runtime SHALL NOT replay the request, duplicate cleanup, or disclose resource bytes, paths, session values, or credentials

#### Scenario: Operation completes successfully
- **WHEN** one MCP or HTTP operation returns
- **THEN** the process SHALL continue serving until explicit shutdown

#### Scenario: Process receives a supported termination signal
- **WHEN** shutdown begins during active requests
- **THEN** new work SHALL stop, active work SHALL be aborted/closed boundedly, transaction-owned temporary data SHALL be cleaned, and the process SHALL exit normally after lifecycle release

#### Scenario: Diagnostic contains a secret or image data
- **WHEN** an exception embeds a key, authorization header, session token, credential URL, path, data URL, or bytes
- **THEN** the logger and boundary response SHALL redact or omit it before output
