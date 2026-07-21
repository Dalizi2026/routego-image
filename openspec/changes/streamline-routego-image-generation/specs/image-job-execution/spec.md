## MODIFIED Requirements

### Requirement: A single executor owns generate and edit lifecycle semantics
Creation SHALL expose one resolved-request executor for generation that validates input, selects the route, plans effective parameters, snapshots provider and model selection, submits at most one provider request per planned generation attempt, normalizes outputs, and returns a frozen schema-valid result without reading persisted configuration or Library locator state. Creation SHALL NOT expose edit execution.

#### Scenario: Resolved generation succeeds
- **WHEN** a valid resolved generation request has an available route and the provider returns valid output
- **THEN** the executor SHALL return `succeeded` with requested/effective parameters, artifacts, relationships, snapshotted provider/model identity, and truthful execution counts

#### Scenario: Capability is unavailable before submission
- **WHEN** route selection cannot satisfy a required feature
- **THEN** the executor SHALL return `failed` with `capability_unavailable`, zero provider requests, no fabricated artifact, and user-confirmation retry disposition

#### Scenario: Provider switches during execution
- **WHEN** the active provider changes after a request is submitted
- **THEN** the running request SHALL continue with its snapshotted provider/model and the new provider SHALL apply only to later submissions

### Requirement: Automatic retries are limited to safe same-transport pre-generation failures
Creation SHALL NOT automatically replay a real generation request after any provider response, transport failure, timeout, cancellation, authentication failure, moderation result, rate limit, or server error. A failure SHALL return its structured outcome, provider request count, and possible-billing warning so only a new user-authorized operation can retry.

#### Scenario: Provider returns 429 or 5xx
- **WHEN** a real generation attempt returns a rate-limit or server error
- **THEN** Creation SHALL stop after that attempt and SHALL NOT issue an automatic replay

#### Scenario: Provider times out
- **WHEN** the provider deadline expires without a conclusive response
- **THEN** Creation SHALL report timeout and possible billing without retrying or switching transport

#### Scenario: User starts a new request
- **WHEN** the user explicitly submits generation again after reviewing a failure
- **THEN** the new operation SHALL have a new identity and SHALL not be represented as an automatic retry of the failed operation

### Requirement: Batch execution is bounded, ordered, and honest
Creation SHALL execute 1 through 20 validated independent generation tasks with fixed concurrency two, preserve input order and IDs, isolate task failures, and return one result for every task with an overall status derived from item outcomes. It SHALL reject edit tasks and caller-supplied concurrency.

#### Scenario: Mixed batch completes
- **WHEN** ordered tasks produce succeeded, partial, and failed results
- **THEN** the batch SHALL return `partial`, keep exact task order, and preserve each result/error and provider request count

#### Scenario: One task fails
- **WHEN** a task fails without a caller-wide cancellation
- **THEN** unrelated queued or running tasks SHALL continue within concurrency two

#### Scenario: Batch is cancelled
- **WHEN** the caller cancels the batch
- **THEN** no new tasks SHALL start, running tasks SHALL receive cancellation, completed results SHALL remain, and pending tasks SHALL return structured cancelled outcomes

#### Scenario: Edit task is submitted
- **WHEN** any batch item requests editing
- **THEN** the entire invalid batch SHALL be rejected before any provider request

## REMOVED Requirements

### Requirement: Continuation is native when available and explicitly degraded otherwise
**Reason**: Continuation and edit semantics are removed from the product scope.
**Migration**: Prepare a new independent generation recipe with `routego_prepare_regeneration`, then submit it through `routego_generate` only after user action.
