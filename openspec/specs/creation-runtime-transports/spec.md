# Creation Runtime Transports Specification

## Purpose

Defines the reusable MCP and loopback HTTP transport requirements for the Routego Image Creation layer.

## Requirements
### Requirement: STDIO MCP exposes exactly the frozen public tools
The Creation MCP adapter SHALL implement the required JSON-RPC/MCP initialize, tool-list, and tool-call lifecycle over STDIO, SHALL advertise exactly the seven frozen public tool definitions, and MUST NOT expose Studio-only upload, settings, Library, or creation operation names as MCP tools.

#### Scenario: Client initializes and lists tools
- **WHEN** an MCP client completes initialization and requests the tool list
- **THEN** the adapter SHALL return exactly the seven frozen tool names with input JSON Schemas derived from their frozen Zod schemas

#### Scenario: Studio-only operation is requested as a tool
- **WHEN** a client attempts to call a Studio operation name through MCP
- **THEN** the adapter SHALL return a method/tool-not-found error and SHALL not dispatch it

### Requirement: MCP validates both sides of tool dispatch
The MCP adapter SHALL parse tool arguments through the matching frozen input schema, call the injected `RoutegoService` method once, validate its output schema, and fail closed on invalid input or service output.

#### Scenario: Tool input is invalid
- **WHEN** tool arguments violate the shared schema or include unknown fields
- **THEN** the service SHALL not be invoked and MCP SHALL return a sanitized invalid-request result

#### Scenario: Service output violates the contract
- **WHEN** the injected service returns an invalid success value
- **THEN** MCP SHALL return an internal-contract failure rather than serialize false success

#### Scenario: Final image content is available
- **WHEN** a validated public image result includes final display data
- **THEN** MCP SHALL return sanitized structured JSON text plus final image content with the validated MIME, while omitting ordinary intermediate images

### Requirement: Loopback HTTP binds and authorizes locally
The reusable HTTP runtime SHALL bind only to `127.0.0.1` or `::1`, SHALL apply injected short-lived session-token and exact loopback-origin policy, SHALL reject cookie authentication and wildcard CORS, and SHALL never reveal the expected token.

#### Scenario: Valid protected request
- **WHEN** a request originates from an allowed loopback origin and presents the current session token
- **THEN** the runtime SHALL apply exact CORS headers and continue to schema dispatch

#### Scenario: Invalid bind, origin, or token
- **WHEN** startup requests a wildcard/LAN address or a protected request has a missing/mismatched token or origin
- **THEN** startup/request handling SHALL fail before service invocation without revealing credentials

### Requirement: HTTP dispatch uses frozen operation definitions
The HTTP runtime SHALL route registered public operations to an injected `RoutegoService` and registered Studio JSON operations to an injected `LocalRoutegoService`, decode bounded UTF-8 query/JSON input, validate input and output with the frozen definitions, and return sanitized structured HTTP errors.

#### Scenario: Public JSON operation is called
- **WHEN** an HTTP request matches a frozen public operation method/path
- **THEN** it SHALL use that public definition and dispatch to the corresponding public service method

#### Scenario: Studio path-free operation is called
- **WHEN** a request matches a frozen Studio generate/edit/batch or another Studio JSON definition
- **THEN** it SHALL validate the path-free DTO and call the injected composed local service without resolving locators itself

#### Scenario: Unmatched binary/resource route is received
- **WHEN** a request targets an Integration-owned upload-content or protected-resource route
- **THEN** Creation SHALL delegate only through an explicitly injected extension handler and SHALL not read Library/upload storage directly

#### Scenario: Body is invalid or oversized
- **WHEN** UTF-8 JSON is malformed, exceeds the configured bound, or violates its schema
- **THEN** the service SHALL not be invoked and the runtime SHALL return a sanitized 4xx error

### Requirement: Studio SSE serializes only validated path-free events
The HTTP runtime SHALL provide SSE/event-broker primitives that validate every `StudioImageOperationEvent`, preserve monotonic sequence order and billing/output flags, use no-cache streaming headers, and terminate cleanly on completed, failed, cancelled, or disconnected streams.

#### Scenario: Partial and final events are streamed
- **WHEN** Integration publishes validated started, partial, and completed events for a resolved Studio operation
- **THEN** the runtime SHALL serialize them in order without paths, data URLs, bytes, credentials, or unrestricted URLs

#### Scenario: Invalid event is published
- **WHEN** an event violates the shared schema or has inconsistent output/billing flags
- **THEN** the stream SHALL fail closed with a sanitized internal-contract event/error

#### Scenario: Client disconnects
- **WHEN** the SSE client disconnects before completion
- **THEN** the runtime SHALL unsubscribe and propagate cancellation through the injected event source without leaking resources

### Requirement: Runtime diagnostics and lifecycle are process safe
MCP and HTTP runtimes SHALL use UTF-8, write only protocol data to their protocol channels, emit only redacted diagnostics through an injected logger, release listeners/readers/timers on shutdown, and SHALL NOT use stdout marker lines or forced `process.exit()` as a business result protocol.

#### Scenario: Business operation succeeds
- **WHEN** a tool or HTTP operation completes successfully
- **THEN** the adapter SHALL return the validated result and continue serving until explicitly shut down

#### Scenario: Diagnostic contains sensitive data
- **WHEN** a runtime exception includes an API key, authorization header, session token, credential-bearing URL, or image data
- **THEN** the logger and returned boundary error SHALL redact it before output

### Requirement: Runtime tests are deterministic and offline
Transport tests SHALL use injected in-memory streams, loopback listeners, deterministic clocks/tokens, and Foundation mock services/relay fixtures without real credentials, user images, external network, or legacy files.

#### Scenario: Test suite runs offline
- **WHEN** the Creation transport suite runs on a supported development platform
- **THEN** MCP, HTTP, session/origin, SSE, failure, and shutdown scenarios SHALL complete deterministically without a billable or external request

