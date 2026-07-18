## ADDED Requirements

### Requirement: Authenticated fetch-stream creation lifecycle
Studio SHALL submit generate/edit streaming requests through an Integration-owned protected fetch route using the in-memory session header and exact loopback origin. It SHALL accept only `text/event-stream; charset=utf-8`, parse bounded UTF-8 SSE framing, validate every event with the frozen schema, require strictly increasing sequence numbers and exactly one terminal event, and release the reader on completion, failure, invalid input, or abort.

#### Scenario: Valid stream succeeds
- **WHEN** the route emits one started event, ordered partial events, and one completed event
- **THEN** Studio SHALL render each validated partial as it arrives, promote the completed result, close the reader, and ignore no required event

#### Scenario: Stream fails after partial output
- **WHEN** the route emits a partial artifact followed by a failed terminal event
- **THEN** Studio SHALL preserve the partial artifact and matching `receivedAnyOutput=true` and `mayHaveBilled=true` evidence and SHALL NOT present automatic safe replay

#### Scenario: Stream framing or sequence is invalid
- **WHEN** content type, UTF-8, line/event size, JSON, schema, sequence order, terminal count, or post-terminal data is invalid
- **THEN** Studio SHALL abort and clean up the stream, show a safe internal-contract failure, and SHALL NOT render unvalidated fields

#### Scenario: User cancels the stream
- **WHEN** the user cancels or leaves the active operation
- **THEN** Studio SHALL abort the fetch, cancel/release the reader, preserve already validated partial facts, and stop accepting later events

### Requirement: Deterministic Studio mock streams rather than buffers
The development mock handler and Vite bridge SHALL expose the same fetch-stream route and SHALL produce deterministic chunked started/partial/completed/failed fixtures without buffering a final fake response or placing image bytes, Base64, paths, credentials, or tokens in event JSON or logs.

#### Scenario: Browser tests request a partial stream
- **WHEN** the partial fixture is selected
- **THEN** the mock SHALL deliver multiple bounded chunks through the production Studio parser in deterministic order

#### Scenario: Invalid mock stream fixture is selected
- **WHEN** tests select invalid sequence, invalid schema, oversize frame, or abort behavior
- **THEN** the production parser/workbench SHALL fail closed and the mock bridge SHALL release its stream resources

## MODIFIED Requirements

### Requirement: Honest creation outcomes
Studio SHALL render succeeded, partial, failed, and degraded creation results with protected artifacts, requested/effective parameters, relationships, failed slots, billing/output flags, and structured errors. For streamed generate/edit operations it SHALL render validated partial artifacts as they arrive, promote only a validated completed result, and preserve partial artifacts plus billing/output risk after a failed terminal event. It MUST NOT display a failed or unavailable operation as successful.

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
