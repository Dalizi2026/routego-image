## MODIFIED Requirements

### Requirement: Provider route execution follows frozen capability decisions
Creation SHALL submit a provider request only after the frozen routing policy selects a configured route, and SHALL use exactly the selected endpoint, transport, request shape, model, and required capability scope. It MUST NOT derive or probe sibling endpoints, mutate capability records before a result, or switch transport after selection. A direct, explicitly user-approved `routego_edit` request MAY be the single capability-establishing request for its selected configured image-input route.

#### Scenario: Default capability remains unknown
- **WHEN** only one generation endpoint and API key are configured and an automatic image-input or stateful request has unknown image capabilities
- **THEN** Creation SHALL return `capability_unavailable` without making that network call

#### Scenario: Explicit first edit is selected
- **WHEN** the user explicitly authorizes a direct edit and the configured Tier A image-input shape is otherwise unknown
- **THEN** Creation SHALL submit one request only to that configured endpoint and SHALL not probe or try a sibling route

#### Scenario: Supported route is selected
- **WHEN** the required capabilities for an explicitly configured route are `supported` and within their limits
- **THEN** Creation SHALL serialize and submit only that selected route

#### Scenario: Unsupported route is rejected
- **WHEN** a required capability is `unsupported`
- **THEN** Creation SHALL return a structured unavailable result and SHALL NOT attempt another endpoint or transport

#### Scenario: Degraded route is selected
- **WHEN** the frozen routing policy selects a capability record in `degraded` state
- **THEN** Creation SHALL preserve the degradation reason/semantics in the effective execution and SHALL NOT claim native support

### Requirement: Tier A single-endpoint JSON adapter preserves the audited compatibility path
The Tier A adapter SHALL submit JSON only to the configured/normalized generation endpoint. Text generation SHALL use the audited model, prompt, variant, and size shape; a direct image edit SHALL include only the selected `image` or `images` data-URL field, edit prompt, and capability-authorized controls.

#### Scenario: Text-only Tier A generation
- **WHEN** the selected request shape is `single-endpoint-json:text`
- **THEN** the adapter SHALL send JSON without image, mask, Edits, Responses, models, or derived sibling-route fields

#### Scenario: Single-image Tier A edit
- **WHEN** a direct edit selects the scoped `image` data-URL shape for a target with no references
- **THEN** the adapter SHALL send exactly the validated target data URL in `image` and SHALL preserve the edit prompt

#### Scenario: Multiple-image Tier A edit
- **WHEN** a direct edit selects the scoped `images` data-URL shape with references
- **THEN** the adapter SHALL send the target followed by references in `images` order and report the selected transport as `single-endpoint-json`

### Requirement: Tier B Images adapter separates generations and explicit Edits multipart
The Tier B adapter SHALL use generation JSON for text-only generation and SHALL use multipart only when an explicit Edits endpoint and every required image/edit capability are available. The existing Provider settings form MAY persist that exact endpoint only when directly entered by the user; it SHALL not derive a sibling `/images/edits` URL. Multipart SHALL append the target as `image`, append each reference in declared order as `image[]`, and include only capability-authorized controls.

#### Scenario: Standard Images generation
- **WHEN** a text-only request selects `openai-images:generations-json`
- **THEN** the adapter SHALL post schema-authorized JSON to the configured generation endpoint

#### Scenario: Standard Edits multipart
- **WHEN** an edit selects the explicit Edits endpoint
- **THEN** multipart SHALL append the target first as `image`, append references in order as `image[]`, and include model/prompt/output controls only when allowed by the selected route

#### Scenario: Edits endpoint is absent
- **WHEN** no explicit Edits endpoint and no Tier A/Tier C route can satisfy an edit
- **THEN** Creation SHALL return `capability_unavailable` without deriving `/images/edits`

#### Scenario: Provider setting records an Edits endpoint
- **WHEN** a user enters a provider-supplied Edits endpoint in existing Provider settings
- **THEN** the settings save request SHALL preserve that exact endpoint, and SHALL not synthesize one when the field is empty
