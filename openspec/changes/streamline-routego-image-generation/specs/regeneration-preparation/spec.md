## ADDED Requirements

### Requirement: Safe generation information is copyable
For an eligible generation record, the Library browser service SHALL produce clipboard text containing the prompt, safe requested/effective parameters, record ID, and zero through five stable reference IDs. It MUST NOT contain API keys, authentication headers, local paths, file URLs, image bytes, Base64, or unrestricted external URLs.

#### Scenario: Information is copied from a referenced generation
- **WHEN** the user requests generation information for an eligible record
- **THEN** the returned text SHALL preserve prompt, safe parameters, record ID, and ordered reference IDs without sensitive fields

#### Scenario: Record is missing or ineligible
- **WHEN** the requested record is absent or is a legacy edit record
- **THEN** the service SHALL return a structured failure and SHALL NOT place partial or unsafe text on the clipboard

### Requirement: Regeneration preparation is read-only and path-free
The public `routego_prepare_regeneration` operation SHALL accept either an explicit eligible generation record ID or no ID, in which case it SHALL read the current mark. It SHALL return a schema-valid recipe consumable by `routego_generate`, containing prompt, safe generation controls, and zero through five reference IDs. The operation MUST NOT generate, probe, connect to a provider, mutate the mark, increment provider request counts, or return paths or credentials.

#### Scenario: Explicit record is prepared
- **WHEN** a caller supplies an eligible generation record ID
- **THEN** the tool SHALL return its safe generation recipe without network or Library mutation

#### Scenario: Current mark is prepared
- **WHEN** no record ID is supplied and a valid current mark exists
- **THEN** the tool SHALL prepare the marked record's safe recipe and leave the mark unchanged

#### Scenario: No valid current mark exists
- **WHEN** no record ID is supplied and the mark is absent, stale, or ineligible
- **THEN** the tool SHALL return a structured not-found or conflict error without fabricating a recipe

#### Scenario: Recipe references are invalid
- **WHEN** any referenced record is missing, no longer readable, or would exceed five references
- **THEN** preparation SHALL fail closed with an itemized safe error and SHALL NOT return an incomplete recipe as success

### Requirement: Regeneration requires a separate user-authorized generation
Preparing or copying a recipe SHALL never submit it. Generation SHALL occur only when the user explicitly invokes `routego_generate` from the main conversation.

#### Scenario: Preparation succeeds
- **WHEN** a safe recipe is returned
- **THEN** provider request count SHALL remain zero until a separate explicit generation invocation occurs

#### Scenario: Separate generation succeeds
- **WHEN** the user submits the prepared recipe through `routego_generate`
- **THEN** the current mark SHALL remain unchanged after success
