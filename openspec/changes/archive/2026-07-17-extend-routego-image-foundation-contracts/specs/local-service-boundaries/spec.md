## ADDED Requirements

### Requirement: Frozen public operation surface
The Foundation Extension SHALL keep `routegoOperationNames`, the seven public MCP tool names, their public operation definitions, and the `RoutegoService` public methods unchanged.

#### Scenario: Internal Studio operations are added
- **WHEN** settings, detail, resource, folder, or preflight operations are registered for loopback HTTP/Studio use
- **THEN** none of those operations SHALL appear in `routegoOperationNames` or receive a public MCP tool name

### Requirement: Composable local service subinterfaces
The system SHALL define settings and Library Studio-service subinterfaces and SHALL compose them with `RoutegoService` into one local application-service interface implemented by a single business-layer object.

#### Scenario: HTTP dispatches a Studio-only operation
- **WHEN** the loopback HTTP adapter dispatches a validated Studio settings or Library request
- **THEN** it SHALL call the corresponding method on the same local service object that supplies the seven public Routego operations

#### Scenario: MCP depends on the public subset
- **WHEN** an MCP adapter is constructed
- **THEN** it SHALL be able to depend only on `RoutegoService` without seeing or exposing Studio-only operation definitions

### Requirement: Local operation boundary validation
Every Studio/local operation definition SHALL reference shared browser-safe input and output schemas, and adapters SHALL validate both sides of dispatch.

#### Scenario: Invalid Studio input
- **WHEN** a Studio request contains an invalid secret mutation, unsafe resource value, missing confirmation, or unknown field
- **THEN** the local service SHALL not be invoked and a structured invalid-request error SHALL be returned

#### Scenario: Invalid local service result
- **WHEN** a local service implementation returns a result that leaks a secret/path or violates a shared schema
- **THEN** the adapter SHALL fail closed with a structured internal-contract error

### Requirement: Deterministic local-service mock coverage
The Foundation mock SHALL implement the composed local service interface and SHALL provide deterministic synthetic settings, folder, asset-detail, relationship, browser-resource, success, failure, partial, and degraded outcomes.

#### Scenario: Downstream Studio repeats a mock request
- **WHEN** the same local operation, input, fixture, and request identifier are used repeatedly
- **THEN** the mock SHALL return the same schema-valid result without reading environment credentials, user configuration, local images, or Library files

#### Scenario: Partial mutation fixture is selected
- **WHEN** a bulk mutation uses the partial fixture
- **THEN** the mock SHALL return at least one successful item and one structured failed item with overall partial status
