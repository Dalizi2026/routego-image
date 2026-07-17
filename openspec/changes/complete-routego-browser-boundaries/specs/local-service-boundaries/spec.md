## MODIFIED Requirements

### Requirement: Composable local service subinterfaces
The system SHALL define settings, Library, upload, and path-free Studio creation subinterfaces and SHALL compose them with `RoutegoService` into one local application-service interface implemented by a single business-layer object. The seven public `RoutegoService` methods and public operation registry MUST remain unchanged.

#### Scenario: HTTP dispatches a Studio-only operation
- **WHEN** the loopback HTTP adapter dispatches a validated Studio settings, Library, upload-control, or path-free creation request
- **THEN** it SHALL call the corresponding method on the same local service object that supplies the seven public Routego operations

#### Scenario: MCP depends on the public subset
- **WHEN** an MCP adapter is constructed
- **THEN** it SHALL be able to depend only on `RoutegoService` without seeing or exposing Studio-only operation definitions

#### Scenario: Studio creation is registered internally
- **WHEN** path-free generate, edit, batch, upload, search, or settings mutation operations are added
- **THEN** none SHALL appear in `routegoOperationNames`, receive an MCP tool name, or alter a public operation definition

## ADDED Requirements

### Requirement: Upload control plane and binary route remain separate
The local service boundary SHALL expose JSON reserve, finalize, status, and discard methods while binary bytes are carried only by the protected relative upload route described by reservation metadata. The future HTTP adapter MUST validate session, matching loopback origin, declared/actual size, MIME policy, and expiry before accepting or authorizing bytes.

#### Scenario: JSON upload control operation is dispatched
- **WHEN** Studio reserves, finalizes, inspects, or discards an upload resource
- **THEN** the local service SHALL receive only schema-validated metadata and stable IDs, not bytes or Base64

#### Scenario: Binary upload route is called without protection
- **WHEN** a future binary request lacks the current session, has a mismatched origin, exceeds policy, uses invalid MIME, or is expired
- **THEN** the adapter SHALL reject it before Library staging/finalization and SHALL not invoke Creation

### Requirement: Creation consumes resolved resources through Integration
The Studio creation service SHALL accept path-free locators and return path-free results. Library/upload storage SHALL own locator resolution and resource metadata; Creation SHALL execute only resolved internal image requests; Integration SHALL compose the resolver and executor into `LocalRoutegoService` without either lane querying the other's filesystem.

#### Scenario: Studio edit uses Library and upload locators
- **WHEN** Integration receives a valid Studio edit with asset/artifact/upload references
- **THEN** it SHALL resolve resources through Library/upload ownership, construct one internal `ImageOperationRequest`, call Creation, and project the result back through path-free schemas

#### Scenario: A lane attempts cross-filesystem access
- **WHEN** Creation tries to locate Library files or Library tries to execute provider operations
- **THEN** the architecture SHALL reject that responsibility as out of lane and require Integration composition

### Requirement: Studio SSE uses validated shared event projections
The future loopback SSE adapter SHALL serialize only shared path-free `started`, `partial`, `completed`, and `failed` event schemas and SHALL validate each service event before transmission.

#### Scenario: Invalid event is produced
- **WHEN** a service event contains a path, data URL, credential, invalid sequence/status combination, or inconsistent billing/output flags
- **THEN** the adapter SHALL fail closed with an internal-contract error instead of streaming invalid data

