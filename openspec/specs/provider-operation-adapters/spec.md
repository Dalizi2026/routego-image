# Provider Operation Adapters Specification

## Purpose

Defines capability-gated request preparation and serialization for the supported provider transport tiers.

## Requirements
### Requirement: Provider route execution follows frozen capability decisions
Creation SHALL submit a provider request only after the frozen routing policy selects a configured route, and SHALL use exactly the selected endpoint, transport, request shape, model, and required capability scope. It MUST NOT derive or probe sibling endpoints, mutate capability records, or switch transport after selection.

#### Scenario: Default capability remains unknown
- **WHEN** only one generation endpoint and API key are configured and image input, Edits, and Responses records are `unknown`
- **THEN** Creation SHALL allow the text-generation baseline only and SHALL return `capability_unavailable` for an image-input or stateful request without making that network call

#### Scenario: Supported route is selected
- **WHEN** the required capabilities for an explicitly configured route are `supported` and within their limits
- **THEN** Creation SHALL serialize and submit only that selected route

#### Scenario: Unsupported route is rejected
- **WHEN** a required capability is `unsupported`
- **THEN** Creation SHALL return a structured unavailable result and SHALL NOT attempt another endpoint or transport

#### Scenario: Degraded route is selected
- **WHEN** the frozen routing policy selects a capability record in `degraded` state
- **THEN** Creation SHALL preserve the degradation reason/semantics in the effective execution and SHALL NOT claim native support

### Requirement: Resolved local image inputs are validated once before serialization
Creation SHALL accept only path-based public or Integration-resolved internal image requests, SHALL read inputs without mutation, and SHALL validate file readability, bounded size, PNG/JPEG/WebP magic and MIME, total image count, target/reference/supporting order, and mask constraints before any provider submission. Creation MUST NOT resolve Studio asset, artifact, or upload locators.

#### Scenario: Ordered edit inputs are prepared
- **WHEN** an internal edit contains one target, ordered supporting images, ordered references, and an optional valid mask
- **THEN** the prepared sequence SHALL place the target first, preserve the remaining relative order and roles, and bind the mask only to target slot zero

#### Scenario: Mask is invalid
- **WHEN** a mask exceeds 50 MiB, is not PNG with alpha, differs from the target dimensions, is unreadable, or has no target
- **THEN** Creation SHALL return a structured validation failure and SHALL make zero provider requests

#### Scenario: Studio locator reaches Creation unresolved
- **WHEN** Creation is given an `assetId`, `artifactId`, or `uploadResourceId` instead of an internal resolved path
- **THEN** it SHALL reject the responsibility boundary and SHALL NOT query Library or upload storage

### Requirement: Tier A single-endpoint JSON adapter preserves the audited compatibility path
The Tier A adapter SHALL submit JSON only to the configured/normalized generation endpoint. Text generation SHALL use the audited model, prompt, variant, and size shape; image inputs SHALL use only the separately evidenced `image` or `images` data-URL field and capability-authorized controls.

#### Scenario: Text-only Tier A generation
- **WHEN** the selected request shape is `single-endpoint-json:text`
- **THEN** the adapter SHALL send JSON without image, mask, Edits, Responses, models, or derived sibling-route fields

#### Scenario: Single-image Tier A operation
- **WHEN** the scoped `image` data-URL shape is supported for one input
- **THEN** the adapter SHALL send exactly one validated data URL in `image` and SHALL NOT infer `images` support

#### Scenario: Multiple-image Tier A operation
- **WHEN** the separately scoped `images` request shape and multi-image capability are supported
- **THEN** the adapter SHALL send the prepared ordered data URLs in `images` and report the selected transport as `single-endpoint-json`

### Requirement: Tier B Images adapter separates generations and explicit Edits multipart
The Tier B adapter SHALL use generation JSON for text-only generation and SHALL use multipart only when an explicit Edits endpoint and every required image/edit capability are available. Multipart SHALL preserve deterministic target/reference/supporting order and mask binding.

#### Scenario: Standard Images generation
- **WHEN** a text-only request selects `openai-images:generations-json`
- **THEN** the adapter SHALL post schema-authorized JSON to the configured generation endpoint

#### Scenario: Standard Edits multipart
- **WHEN** an edit or image-input request selects the explicit Edits endpoint
- **THEN** multipart SHALL append the target as the first image part, append supporting/references in prepared order, append at most one mask after the target image, and include only capability-authorized controls

#### Scenario: Edits endpoint is absent
- **WHEN** input images are present but no explicit Edits endpoint or verified Tier A/Tier C route can satisfy them
- **THEN** Creation SHALL return `capability_unavailable` without deriving `/images/edits`

### Requirement: Tier C Responses adapter uses only explicit state and streaming capabilities
The Responses adapter SHALL send image-generation tool requests only to the explicit Responses endpoint and SHALL encode action, prompt, ordered local inputs, file/image IDs, previous response ID, and output controls only when their scoped capabilities are available.

#### Scenario: Stateful Responses edit
- **WHEN** Responses state and requested ID input capabilities are supported
- **THEN** the request SHALL preserve the supplied previous response/image/file identifiers and selected `action` without falling back to another transport

#### Scenario: Streaming is requested
- **WHEN** both streaming and the requested partial-image capability are available
- **THEN** the adapter SHALL request streaming/partial output and route the response through the shared streaming parser

#### Scenario: Responses capability is unknown
- **WHEN** a Responses endpoint is configured but the required request shape remains `unknown`
- **THEN** Creation SHALL not treat the endpoint string as proof and SHALL not submit the request

### Requirement: Effective provider parameters are capability bounded and honest
Creation SHALL produce a schema-valid effective request before submission, SHALL send non-default size, quality, format, compression, moderation, partial-image, native-transparency, and native-variant controls only when their scoped capabilities and limits allow them, and SHALL not silently lower quality or change transport.

#### Scenario: Requested control exceeds a capability limit
- **WHEN** a requested size, quality, format, variant count, input count, or partial-image count is outside the selected capability limits
- **THEN** Creation SHALL fail before submission with the applicable limit details

#### Scenario: Provider default is retained
- **WHEN** a control remains `auto` and no effective override is required
- **THEN** Creation SHALL preserve `auto` rather than invent an unsupported provider-specific value

#### Scenario: Sensitive request is observed diagnostically
- **WHEN** request preparation or submission fails while an API key or image data is in memory
- **THEN** all returned/logged diagnostics SHALL be recursively redacted and SHALL not contain credentials, authorization headers, data URLs, or image bytes
