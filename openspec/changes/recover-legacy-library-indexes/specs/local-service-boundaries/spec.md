## ADDED Requirements

### Requirement: Private legacy Library migration boundary
The composed local service SHALL expose authenticated Studio-only read/preflight and exact-confirmation migration methods using shared path-free schemas. These methods SHALL be excluded from the seven public `RoutegoService` operations and MCP tool registration, SHALL validate input and output at the adapter boundary, and SHALL execute zero provider requests.

#### Scenario: Studio confirms a legacy migration
- **WHEN** an authenticated Studio request submits a valid current fingerprint and explicit confirmation
- **THEN** the local service SHALL dispatch the private migration method and return its schema-valid redacted result without adding an MCP tool

