## MODIFIED Requirements

### Requirement: Safe route selection
The routing decision SHALL require explicit configured endpoint data and sufficient capability evidence for every requested feature, and SHALL return a structured unavailable decision when no verified route exists. A direct, user-approved image edit MAY use one selected configured image-input route whose matching evidence is `unknown` solely to establish that route's capability; it SHALL not imply support for another transport, endpoint, model, or input count.

#### Scenario: Legacy single-endpoint image input supported
- **WHEN** `single-endpoint-json` image data URL input is explicitly supported
- **THEN** image generation or edit routing MAY select that same configured endpoint and SHALL identify the selected transport as `single-endpoint-json`

#### Scenario: Explicit first edit has unknown evidence
- **WHEN** a user explicitly authorizes one direct edit and its configured single-endpoint image-input route is unknown
- **THEN** routing SHALL select only that route for one submission and SHALL preserve the request as a possible billable operation

#### Scenario: Image input remains unknown for automatic work
- **WHEN** an automatic image-input request has only unknown or unsupported capabilities
- **THEN** routing SHALL return `capability_unavailable` with no network instruction

#### Scenario: Explicit degraded continuation
- **WHEN** Responses state is unavailable but a verified image-input route can reuse the previous output as a new target
- **THEN** routing MAY return a degraded continuation decision that requires `degradedContinuation=true`

### Requirement: No silent transport replay
The system SHALL retain the selected provider transport and endpoint for the lifetime of an operation. A provider rejection, timeout, malformed output, partial output, or possible billing result MUST NOT trigger automatic replay through another transport.

#### Scenario: First edit route fails
- **WHEN** a capability-establishing direct edit fails after its selected provider request begins
- **THEN** the system SHALL return the sanitized failure and billing/output risk without retrying through multipart, Responses, or pure text generation
