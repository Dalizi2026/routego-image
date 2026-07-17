# Provider Capability Model Specification

## Purpose

Defines how Routego Image represents provider protocols, capability evidence, routing, and safe validation.

## Requirements
### Requirement: Explicit provider protocol tiers
The provider model SHALL distinguish `single-endpoint-json`, `openai-images`, and `openai-responses` protocols, SHALL distinguish `exact-generation-endpoint` from `legacy-api-base`, and SHALL treat the configured exact image-generation endpoint as the default text-generation route.

#### Scenario: Default provider configuration
- **WHEN** the user has supplied only one image-generation endpoint and an API key
- **THEN** the provider model SHALL enable only the configured single-endpoint text route and SHALL leave image input, Edits, and Responses capabilities unconfirmed

#### Scenario: Unconfigured derived endpoint
- **WHEN** an adapter can syntactically derive `/images/edits`, `/responses`, `/models`, or another path from the configured endpoint
- **THEN** the model SHALL NOT treat the derived path as configured or supported

#### Scenario: Explicit legacy API base
- **WHEN** the user selects `legacy-api-base` compatibility for a base URL
- **THEN** the model MAY apply the audited `/v1/images/generations` normalization rule while keeping models, Edits, and Responses endpoints unset

#### Scenario: Unsafe endpoint syntax
- **WHEN** an endpoint uses a non-HTTP(S) protocol, URL userinfo, or non-loopback cleartext HTTP
- **THEN** the provider configuration SHALL reject it before storing or using credentials

### Requirement: Four-state capabilities with evidence
Each provider/model/endpoint capability SHALL have exactly one state from `unknown`, `supported`, `unsupported`, or `degraded`, together with its evidence source and validation time when known.

#### Scenario: Unknown capability
- **WHEN** no success, provider documentation, explicit user configuration, or stable protocol-level rejection exists
- **THEN** the capability state SHALL remain `unknown`

#### Scenario: Supported capability
- **WHEN** a capability is confirmed by an explicit successful request, authoritative provider documentation, or explicit user configuration
- **THEN** the state MAY become `supported` with the confirmation source recorded

#### Scenario: Unsupported capability
- **WHEN** a provider gives a stable protocol-level unsupported response or authoritative documentation states that the capability is unavailable
- **THEN** the state MAY become `unsupported` with the evidence recorded

#### Scenario: Degraded capability
- **WHEN** the system can complete only an approximate workflow with weaker semantics or lost provider state
- **THEN** the state SHALL be `degraded` and include the degradation reason

### Requirement: Transient failures do not become unsupported evidence
Authentication failures, rate limits, timeouts, 5xx responses, moderation blocks, and isolated model failures MUST NOT transition a capability to `unsupported`.

#### Scenario: Authentication failure during validation
- **WHEN** a capability request returns an authentication or authorization failure
- **THEN** the model SHALL preserve the prior capability state and record only a sanitized transient validation outcome

#### Scenario: Timeout or provider failure
- **WHEN** validation times out or receives a 429 or 5xx response
- **THEN** the model SHALL preserve the prior capability state and SHALL NOT infer permanent protocol support or lack of support

### Requirement: Safe route selection
The routing decision SHALL require explicit configured endpoint data and sufficient capability evidence for every requested feature, and SHALL return a structured unavailable decision when no verified route exists.

#### Scenario: Legacy single-endpoint image input supported
- **WHEN** `single-endpoint-json` image data URL input is explicitly supported
- **THEN** image generation or edit routing MAY select that same configured endpoint and SHALL identify the selected transport as `single-endpoint-json`

#### Scenario: Image input still unknown
- **WHEN** a request contains a target or reference image but every configured image-input capability is `unknown` or `unsupported`
- **THEN** routing SHALL return `capability_unavailable` with no network instruction

#### Scenario: Explicit degraded continuation
- **WHEN** Responses state is unavailable but a verified image-input route can reuse the previous output as a new target
- **THEN** routing MAY return a degraded continuation decision that requires `degradedContinuation=true`

### Requirement: Billable validation requires confirmation
The capability model SHALL distinguish synthetic/documentary evidence from a real provider probe, and any probe that can generate an image or charge the user MUST require explicit user confirmation.

#### Scenario: Automatic status refresh
- **WHEN** status is refreshed without explicit confirmation for a billable test
- **THEN** the system SHALL use only non-billable evidence and SHALL NOT send a generation, edit, or Responses image request

### Requirement: No silent transport replay
The routing contract MUST NOT authorize switching transports and replaying the same operation after a timeout, rate limit, 5xx response, or partial result.

#### Scenario: Partial result from Responses
- **WHEN** a Responses operation has emitted any partial image result and then fails
- **THEN** the routing decision SHALL preserve the partial outcome and SHALL NOT instruct an automatic retry through Images or the single endpoint

### Requirement: Capability evidence is scoped
Capability evidence SHALL be scoped by provider, model, endpoint, transport, and relevant request shape, including separate single-image and multi-image capabilities.

#### Scenario: Single image support verified
- **WHEN** a provider accepts one Tier A `image` data URL
- **THEN** the model SHALL NOT infer support for an `images` array or more than one image

