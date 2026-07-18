## ADDED Requirements

### Requirement: One production object implements the complete local service
Integration SHALL compose one production `LocalRoutegoService` from the Library application service, Library resource/settings owners, Creation execution service, Studio lifecycle manager, and Integration orchestration. Public and Studio operations MUST use that object rather than duplicate business implementations.

#### Scenario: MCP and Studio call the same service
- **WHEN** Codex invokes a public tool and Studio invokes an internal operation against the same runtime
- **THEN** both SHALL observe the same provider configuration, capability evidence, Library index, asset identities, and lifecycle state

#### Scenario: A required component cannot recover
- **WHEN** Library recovery, configuration loading, or runtime initialization fails
- **THEN** the service SHALL report a structured degraded/failed state and SHALL NOT start a falsely ready provider path

### Requirement: Provider context comes only from Library-owned configuration
Integration SHALL load the exact selected provider profile, normalized configured endpoints, requested/default model, scoped capability records, and write-only credential through Library ownership for each operation, SHALL keep the credential only in memory, and SHALL supply bounded deadlines/retry policy to Creation without reading legacy files or guessing endpoints.

#### Scenario: Active provider is configured
- **WHEN** an operation requests a model available to the active profile
- **THEN** Integration SHALL construct a Creation runtime context using only that profile's exact endpoints, evidence, and credential

#### Scenario: Image capability is unknown or unsupported
- **WHEN** the requested physical-input feature lacks sufficient supported/degraded evidence
- **THEN** Creation SHALL receive no fabricated evidence and the operation SHALL return `capability_unavailable` without a provider request

#### Scenario: Configuration or credential is missing
- **WHEN** no active profile or credential exists
- **THEN** Integration SHALL return a sanitized configuration failure and SHALL NOT inspect legacy configuration or environment secrets

### Requirement: Model refresh and capability probes remain explicit
Integration SHALL implement non-billable model refresh only for an explicitly configured models endpoint and SHALL implement capability probes only after literal billable confirmation for one exact provider, model, transport, endpoint, and request shape. Probe evidence MUST preserve `unknown | supported | unsupported | degraded` rules and be persisted through Library ownership.

#### Scenario: Models endpoint is absent
- **WHEN** model refresh is requested without an explicitly configured models endpoint
- **THEN** the operation SHALL fail safely without deriving `/models` or sending credentials elsewhere

#### Scenario: Billable probe succeeds
- **WHEN** the user confirms one exact probe and the provider conclusively accepts it
- **THEN** Integration MAY persist supported evidence with validation time and `mayHaveBilled` while retaining no image bytes or credentials in the result/log

#### Scenario: Probe has a transient failure
- **WHEN** authentication, timeout, moderation, rate limit, 5xx, or isolated model failure occurs
- **THEN** the prior capability state SHALL remain and the result SHALL report only sanitized transient evidence

### Requirement: Studio locators are resolved before Creation execution
Integration SHALL resolve ordered asset, artifact, and upload locators through Library/upload ownership, validate their intended purposes, construct one path-based internal image request, and call Creation only after all required resources are resolved. Creation MUST NOT receive unresolved Studio locators.

#### Scenario: Studio edit uses mixed sources
- **WHEN** a Studio edit contains a Library target, uploaded supporting image, Library reference, and uploaded mask
- **THEN** Integration SHALL preserve exact order/role/label, bind the mask to target slot zero, and pass only verified contained paths to Creation

#### Scenario: One locator is expired or inconsistent
- **WHEN** a required upload is expired/consumed or a Library artifact does not belong to its declared asset
- **THEN** Integration SHALL fail before provider submission without substituting another asset or primary output

### Requirement: Output materialization is bounded and transactional
Integration SHALL decode Creation display data into a request-owned staging directory, revalidate MIME, magic, dimensions, byte length, and SHA-256, use exclusive non-overwriting names, and clean only transaction-owned temporary files. It MUST preserve valid partial output and billing evidence when later output, post-processing, ingestion, or copying fails.

#### Scenario: Multiple outputs are valid
- **WHEN** Creation returns ordered partial/final data URLs
- **THEN** Integration SHALL materialize each independently, preserve artifact IDs/slots/phases, and SHALL not lose earlier valid output because a later slot fails

#### Scenario: Output bytes are invalid
- **WHEN** decoded bytes violate the claimed image metadata or bounded format policy
- **THEN** that output SHALL fail validation and SHALL not become a Library artifact, browser resource, or successful path

### Requirement: Saved operations commit one durable source/output graph
When `saveToLibrary=true`, Integration SHALL preallocate one operation asset ID, retain exact upload-origin sources as Library source renditions, relate existing Library inputs to their original owners, ingest source/partial/final outputs atomically, and return artifact/asset identities that match the committed graph.

#### Scenario: Saved Studio edit succeeds
- **WHEN** an edit with upload-origin sources produces final output
- **THEN** Studio and Codex Library queries SHALL resolve the same operation asset, exact source relationships, output primary, and protected resources

#### Scenario: Library commit fails
- **WHEN** persistence rejects an invalid graph, conflict, unsafe path, or write failure
- **THEN** Integration SHALL not report a saved Library asset and SHALL preserve truthful provider output/billing facts as partial or failed

### Requirement: Unsaved and project-copy results remain honest
Studio operations with `saveToLibrary=false` SHALL use bounded expiring Integration resources without creating Library records. Public operations with `saveToLibrary=false` MUST have an approved output directory and SHALL use safe exclusive output placement. Project copies after Library ingestion SHALL use Library's contained non-overwriting copy behavior.

#### Scenario: Studio result is not saved
- **WHEN** Studio disables Library saving
- **THEN** the result SHALL use protected expiring resources, no durable asset ID, and cleanup after expiry/shutdown

#### Scenario: Public unsaved request lacks output directory
- **WHEN** a public operation disables Library saving and supplies no approved destination
- **THEN** Integration SHALL reject it before provider submission rather than create an unindexed durable file

#### Scenario: Project filename collides
- **WHEN** a requested copy name already exists
- **THEN** a versioned exclusive filename SHALL be returned and the existing file SHALL remain unchanged

### Requirement: Transparency processing is explicit and non-destructive
Integration SHALL use native transparency only with supported evidence and SHALL use bounded PNG chromakey processing only for `chromakey` or an explicitly eligible `auto` request. It SHALL preserve the provider original, record effective/degraded behavior and relationships, and MUST NOT claim successful complex transparency when edge semantics are unsafe or unconfirmed.

#### Scenario: Simple chromakey succeeds
- **WHEN** a PNG result uses the approved key background and passes bounded pixel processing
- **THEN** Integration SHALL return the processed PNG, retain the original relationship, and record chromakey as the effective/degraded transparency path

#### Scenario: Complex transparent subject is requested
- **WHEN** hair, fur, glass, smoke, liquid, or uncertain edges require a different model/parameter
- **THEN** Integration SHALL require explicit confirmation or return a structured limitation without silently damaging the output

#### Scenario: Post-processing fails after provider output
- **WHEN** PNG decode/encode or chromakey validation fails
- **THEN** the provider original SHALL remain an honest partial/output fact and the operation SHALL not report transparent success
