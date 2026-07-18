## ADDED Requirements

### Requirement: Authenticated fetch-stream creation lifecycle
Studio SHALL submit generate/edit streaming requests only through `POST /api/v1/studio/creation/stream` using the in-memory `x-routego-session` header and exact loopback origin. It SHALL accept only `text/event-stream; charset=utf-8`, parse bounded UTF-8 SSE data records, and enforce exactly one schema-valid `started` event first, zero or more `partial` events, exactly one `completed | failed` terminal event, one consistent `requestId`, strictly increasing sequence numbers, and EOF only after terminal. It MUST reject a missing/duplicate/late `started`, request-ID drift, `[DONE]` or any non-schema sentinel, EOF before terminal, missing/duplicate terminal, or post-terminal data, and SHALL release the fetch reader/channel on terminal, invalid input, disconnect, or abort without prematurely revoking validated partial resources.

#### Scenario: Valid stream succeeds
- **WHEN** the route emits one started event, ordered partial events, and one completed event
- **THEN** the started event SHALL be first and establish the request ID, Studio SHALL render each same-request validated partial as it arrives, promote the same-request completed result, close the reader after terminal and EOF, and ignore no required event

#### Scenario: Stream fails after partial output
- **WHEN** the route emits a partial artifact followed by a failed terminal event
- **THEN** Studio SHALL preserve the partial artifact and matching `receivedAnyOutput=true` and `mayHaveBilled=true` evidence, keep its protected resource fetchable through the original five-minute descriptor TTL, close the reader/channel, and SHALL NOT present automatic safe replay

#### Scenario: Stream framing or sequence is invalid
- **WHEN** content type, UTF-8, line/event size, JSON, schema, first/unique started rule, request ID, sequence order, terminal count, terminal-before-EOF rule, sentinel policy, or post-terminal data is invalid
- **THEN** Studio SHALL abort and clean up the stream, show a safe internal-contract failure, and SHALL NOT render unvalidated fields

#### Scenario: User cancels the stream
- **WHEN** the user cancels or leaves the active operation
- **THEN** Studio SHALL abort the fetch, cancel/release the reader and channel, preserve already validated partial facts and their original five-minute resource expiry, and stop accepting later events

#### Scenario: Partial resource expires or runtime shuts down
- **WHEN** a retained partial reaches its descriptor expiry or the plugin process shuts down
- **THEN** its protected fetch SHALL fail safely and Studio SHALL retain only the truthful expired/unavailable output fact without claiming the bytes remain accessible

### Requirement: Deterministic Studio mock streams rather than buffers
The development mock handler and Vite bridge SHALL expose `POST /api/v1/studio/creation/stream` and SHALL produce deterministic chunked started/partial/completed/failed fixtures without buffering a final fake response or placing image bytes, Base64, paths, credentials, or tokens in event JSON or logs.

#### Scenario: Browser tests request a partial stream
- **WHEN** the partial fixture is selected
- **THEN** the mock SHALL deliver multiple bounded chunks through the production Studio parser in deterministic order

#### Scenario: Invalid mock stream fixture is selected
- **WHEN** tests select missing/duplicate/late started, request-ID drift, invalid sequence/schema, `[DONE]`/non-schema sentinel, missing/duplicate terminal, post-terminal data, oversize frame, EOF-before-terminal, disconnect, or abort behavior
- **THEN** the production parser/workbench SHALL fail closed and the mock bridge SHALL release its stream resources

## MODIFIED Requirements

### Requirement: Honest creation outcomes
Studio SHALL render succeeded, partial, failed, and degraded creation results with protected artifacts, requested/effective parameters, relationships, failed slots, billing/output flags, and structured errors. For streamed generate/edit operations it SHALL render validated partial artifacts as they arrive, promote only a validated completed result, and preserve partial artifacts plus billing/output risk after a failed terminal event. Closing a stream SHALL release readers/channels but MUST NOT revoke a retained partial before its five-minute descriptor expiry or explicit safe release. It MUST NOT display a failed or unavailable operation as successful.

#### Scenario: Partial output is returned
- **WHEN** a creation result or stream contains partial artifacts and a failure
- **THEN** Studio SHALL preserve and label the partial images, show billing/output risk, and avoid presenting automatic safe replay

#### Scenario: Stream completes after partial images
- **WHEN** validated partial events are followed by a validated completed result
- **THEN** Studio SHALL retain the truthful final result and SHALL clean up superseded transient partial resources without losing requested/effective metadata

#### Scenario: Capability unavailable
- **WHEN** `studioEdit` or an image-input request returns `capability_unavailable`
- **THEN** Studio SHALL show the limitation, keep the draft, and SHALL NOT manufacture a local edit result

#### Scenario: Invalid terminal result follows valid partials
- **WHEN** a terminal event violates the frozen result schema after partial images were shown
- **THEN** Studio SHALL fail closed, retain only already validated partial facts and billing/output risk, and SHALL NOT promote the invalid result
