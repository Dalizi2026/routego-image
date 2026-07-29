## ADDED Requirements

### Requirement: Codex main-conversation image editing
The system SHALL expose `routego_edit` through MCP and loopback HTTP. It MUST accept one explicit target image, a non-empty edit prompt, zero through five ordered references, and non-empty edit invariants. The target SHALL be the first physical provider image input, and the references SHALL preserve their declared order.

#### Scenario: Controlled wardrobe edit
- **WHEN** a user supplies a target image, asks to change clothing, and states identity/background preservation conditions
- **THEN** the system SHALL submit an edit request that contains the target first, preserves the supplied conditions in the effective request, and reports the actual returned image result

#### Scenario: Missing edit constraints
- **WHEN** an edit omits its target image or gives empty invariants
- **THEN** the system SHALL reject it before reading an image or contacting a provider

#### Scenario: Too many reference images
- **WHEN** an edit supplies more than five reference images
- **THEN** the system SHALL reject it before provider routing

### Requirement: Image editing is isolated from Studio and batches
The system SHALL provide image editing only through the public Codex MCP/HTTP operation in this change. Studio SHALL retain its existing generation workflow and may expose only an optional explicit Edits endpoint field in existing Provider settings; it SHALL not derive that endpoint from generation configuration. `routego_batch` SHALL accept only generation operations.

#### Scenario: Studio remains generation-only
- **WHEN** the updated plugin starts Studio
- **THEN** no edit page, edit upload control, reference-image editing control, or mask editor SHALL be added by this capability; Provider settings MAY retain only a user-entered explicit Edits endpoint

#### Scenario: Edit is submitted to batch
- **WHEN** a batch item contains an edit operation
- **THEN** input validation SHALL reject the batch before any item starts

### Requirement: Editing results use the existing durable lifecycle
The system SHALL validate and stage edit inputs, execute the selected provider route once, materialize returned output, and preserve target/reference/output relationships through the existing Library path. A failed edit SHALL not be represented as a generation result.

#### Scenario: Saved edit succeeds
- **WHEN** a provider returns a valid edit output and `saveToLibrary` is true
- **THEN** the result SHALL identify a final artifact and the Library record SHALL preserve the target and reference relationships

#### Scenario: Provider cannot perform edit
- **WHEN** a provider rejects an edit request or returns no usable output
- **THEN** the system SHALL return a structured failed result with truthful output and billing flags and SHALL not substitute a text-only generation
