## ADDED Requirements

### Requirement: MCP exposes exactly the seven frozen tools
The plugin runtime SHALL run the long-lived STDIO MCP lifecycle over the composed `RoutegoService`, SHALL advertise exactly `routego_status`, `routego_generate`, `routego_edit`, `routego_batch`, `routego_search_library`, `routego_manage_library`, and `routego_open_studio`, and MUST NOT expose Studio-only or Integration-internal operations.

#### Scenario: Codex initializes the plugin
- **WHEN** a fresh MCP client initializes and lists tools
- **THEN** it SHALL receive exactly the seven frozen names and their shared input schemas

#### Scenario: Internal stream or upload name is requested
- **WHEN** a client attempts to call an Integration or Studio operation as a tool
- **THEN** MCP SHALL return tool-not-found without dispatching it

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
The plugin process SHALL keep stdout protocol-only, write only recursively redacted diagnostics to stderr, recover Library state before readiness, and release HTTP listeners, sessions, event channels, streams, abort controllers, readers, timers, browser resources, temporary files, and MCP framing state on their defined lifecycle boundaries. Terminal, disconnect, cancellation, or invalid input SHALL close readers/channels but SHALL NOT revoke a validated ephemeral partial before its fixed five-minute descriptor expiry or explicit safe release; process shutdown SHALL revoke all ephemeral resources. It MUST NOT force `process.exit()` as a business result protocol.

#### Scenario: Operation completes successfully
- **WHEN** one MCP or HTTP operation returns
- **THEN** the process SHALL continue serving until explicit shutdown

#### Scenario: Process receives a supported termination signal
- **WHEN** shutdown begins during active requests
- **THEN** new work SHALL stop, active work SHALL be aborted/closed boundedly, transaction-owned temporary data SHALL be cleaned, and the process SHALL exit normally after lifecycle release

#### Scenario: Diagnostic contains a secret or image data
- **WHEN** an exception embeds a key, authorization header, session token, credential URL, path, data URL, or bytes
- **THEN** the logger and boundary response SHALL redact or omit it before output
