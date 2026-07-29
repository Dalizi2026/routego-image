## MODIFIED Requirements

### Requirement: A single executor owns generate and edit lifecycle semantics
Creation SHALL expose one resolved-request executor for generate and edit operations that validates input, selects the route, plans effective parameters, submits provider requests, normalizes outputs, and returns a frozen schema-valid result without reading persisted configuration or Library locator state. Integration SHALL route direct public edits through the same staging, output materialization, and result persistence lifecycle used by generation.

#### Scenario: Resolved generation succeeds
- **WHEN** a valid resolved generate request has an available route and the provider returns valid output
- **THEN** the executor SHALL return `succeeded` with requested/effective parameters, artifacts, relationships, and truthful execution counts

#### Scenario: Resolved edit succeeds
- **WHEN** a valid resolved edit has a target, references, invariants, and an available route that returns valid output
- **THEN** the executor SHALL return `succeeded` with the edit request, final artifacts, target/reference relationships, and truthful execution counts

#### Scenario: Capability is unavailable before submission
- **WHEN** route selection cannot satisfy a required feature
- **THEN** the executor SHALL return `failed` with `capability_unavailable`, zero provider requests, no fabricated artifact, and user-confirmation retry disposition

### Requirement: Batch execution is bounded, ordered, and honest
Creation SHALL execute 1 through 20 validated independent generation tasks with requested concurrency 1 through 10, preserve input order and IDs, isolate task failures, and return one result for every task with an overall status derived from item outcomes.

#### Scenario: Mixed batch completes
- **WHEN** ordered generation tasks produce succeeded, partial, and failed results
- **THEN** the batch SHALL return `partial`, keep exact task order, and preserve each result/error and provider request count

#### Scenario: Edit is included in batch
- **WHEN** a caller includes an edit operation in a batch
- **THEN** validation SHALL reject the entire batch before any task has begun

#### Scenario: One task fails
- **WHEN** one generation task fails without a caller-wide cancellation
- **THEN** unrelated queued/running tasks SHALL continue within the concurrency bound

#### Scenario: Batch is cancelled
- **WHEN** the caller cancels the batch
- **THEN** no new tasks SHALL start, running tasks SHALL receive cancellation, completed results SHALL remain, and pending tasks SHALL return structured cancelled outcomes
