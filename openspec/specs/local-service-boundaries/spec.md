# Local Service Boundaries Specification

## Purpose

Defines the durable transport-neutral service and mock relay boundaries used by Routego Image.

## Requirements
### Requirement: One application-service interface
The system SHALL define one transport-neutral application-service interface for the seven public Routego operations, and future MCP and HTTP adapters SHALL call that interface rather than separate business implementations.

#### Scenario: MCP request dispatch
- **WHEN** a valid MCP tool request is received
- **THEN** the MCP adapter SHALL map it to the shared operation identifier and application-service method

#### Scenario: HTTP request dispatch
- **WHEN** a valid loopback HTTP request is received on a registered Routego route
- **THEN** the HTTP adapter SHALL map it to the same operation identifier, schema, and application-service method as MCP

### Requirement: Boundary validation on both sides
Transport adapters SHALL validate input before dispatch and validate application-service output before serialization.

#### Scenario: Invalid transport input
- **WHEN** input parsing fails at an MCP or HTTP boundary
- **THEN** the application service SHALL not be invoked and a structured invalid-request error SHALL be returned

#### Scenario: Invalid service result
- **WHEN** an application service returns a value that violates the shared result schema
- **THEN** the adapter SHALL fail closed with a structured internal-contract error rather than serialize invalid success data

### Requirement: Deterministic mock application service
Foundation SHALL provide a deterministic mock implementation of the application-service interface for downstream Studio and adapter development.

#### Scenario: Repeated mock request
- **WHEN** the same mock fixture and request identifier are used repeatedly
- **THEN** the mock service SHALL return the same schema-valid outcome without reading real configuration, API keys, or user images

#### Scenario: Configured mock failure
- **WHEN** a test selects a failure or partial-success fixture
- **THEN** the mock service SHALL return the corresponding structured error or per-item outcome without reporting false success

### Requirement: Explicit mock relay protocols
The mock relay SHALL support explicitly selected fixtures for text-only single endpoint, image-capable single endpoint, standard Images, and Responses-shaped behavior, while exposing only the single generation endpoint by default.

#### Scenario: Default unconfigured Edits path
- **WHEN** a test calls an Edits or Responses path on the default mock relay
- **THEN** the relay SHALL return a protocol-level not-found or unsupported response and SHALL NOT auto-enable that protocol

#### Scenario: Legacy image data URL request
- **WHEN** the image-capable single-endpoint fixture receives JSON containing `image` or `images` data URLs
- **THEN** it SHALL return a deterministic image-shaped success and preserve sanitized evidence that the configured single endpoint was used

#### Scenario: Explicit standard protocol fixture
- **WHEN** a test enables the Images or Responses fixture
- **THEN** only the explicitly configured routes and response shapes for that fixture SHALL become available

### Requirement: Sanitized mock observations
Mock relay observations SHALL retain only the method, path, content type, redacted headers, and sanitized request shape required for assertions.

#### Scenario: Authorization and image input received
- **WHEN** a mock request includes an authorization header and an image data URL
- **THEN** the recorded observation SHALL contain neither the credential value nor the image bytes/base64 payload

### Requirement: No legacy process-exit result protocol
The application boundary SHALL return structured values from a long-running service interface and SHALL NOT use stdout marker lines plus forced process exit as a public success/failure protocol.

#### Scenario: Successful result lifecycle
- **WHEN** an operation completes successfully after multiple fetch-like activities
- **THEN** the service SHALL return the validated success value and release resources normally without requiring `process.exit()`

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
