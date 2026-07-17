# Image Job Execution Specification

## Purpose

Defines truthful, bounded, and cancellable image-operation execution, retry, continuation, variant, and batch behavior.

## Requirements
### Requirement: A single executor owns generate and edit lifecycle semantics
Creation SHALL expose one resolved-request executor for generate and edit operations that validates input, selects the route, plans effective parameters, submits provider requests, normalizes outputs, and returns a frozen schema-valid result without reading persisted configuration or Library locator state.

#### Scenario: Resolved generation succeeds
- **WHEN** a valid resolved generate request has an available route and the provider returns valid output
- **THEN** the executor SHALL return `succeeded` with requested/effective parameters, artifacts, relationships, and truthful execution counts

#### Scenario: Capability is unavailable before submission
- **WHEN** route selection cannot satisfy a required feature
- **THEN** the executor SHALL return `failed` with `capability_unavailable`, zero provider requests, no fabricated artifact, and user-confirmation retry disposition

### Requirement: Variant execution distinguishes native variants from same-transport fan-out
Creation SHALL treat `count` as variants of one prompt, use one native `n=count` request only when scoped native-variant support permits it, and otherwise MAY execute same-transport `count=1` child requests for the user-requested slots while preserving order, per-slot outcomes, and the true provider request count.

#### Scenario: Native variants are supported
- **WHEN** the selected route supports the requested native variant count
- **THEN** Creation SHALL use one provider request and map its ordered outputs to slots

#### Scenario: Native variants are unavailable but single output is available
- **WHEN** the user requested multiple variants and the same selected transport can safely execute single-output requests
- **THEN** Creation SHALL fan out only the requested number of same-transport child calls, SHALL not mark native variants supported, and SHALL report every call and failed slot

#### Scenario: Fan-out partially fails
- **WHEN** some requested variant slots succeed and others fail
- **THEN** the operation SHALL return `partial` with successful artifacts and one structured failed-slot result per failed variant

### Requirement: Automatic retries are limited to safe same-transport pre-generation failures
Creation SHALL allow at most two automatic retries after the initial attempt and only for same-transport pre-generation 429/5xx failures with no output and no billing risk. It MUST NOT retry timeout, authentication, moderation, cancellation, validation failure, partial output, possible billing, or a different transport automatically.

#### Scenario: Eligible provider 5xx is retried
- **WHEN** a pre-generation 5xx has no output/billing risk and the attempt limit is not reached
- **THEN** Creation SHALL wait the bounded backoff and retry the identical endpoint, transport, request shape, model, and effective parameters

#### Scenario: Retry-After is present
- **WHEN** an eligible 429 includes a valid bounded `Retry-After`
- **THEN** Creation SHALL honor the bounded value without exceeding the total operation deadline

#### Scenario: Failure is not safe to replay
- **WHEN** output was received, billing is possible, the failure is timeout/auth/moderation/cancelled, or the next transport differs
- **THEN** Creation SHALL stop automatically and return the structured outcome without replay

### Requirement: Stage deadlines and cancellation remain active
Creation SHALL enforce separate response-header, body/stream, download, and total-operation deadlines, SHALL propagate caller cancellation, and SHALL preserve received output on timeout or cancellation.

#### Scenario: Body stalls after headers
- **WHEN** response headers arrive but the body or stream exceeds its deadline
- **THEN** Creation SHALL abort the body, return a timeout-stage failure, and SHALL not silently lower quality or retry another transport

#### Scenario: Caller cancels a running operation
- **WHEN** the supplied abort signal is triggered
- **THEN** pending network work SHALL be aborted, received artifacts SHALL be preserved, and no new attempts SHALL start

### Requirement: Continuation is native when available and explicitly degraded otherwise
Creation SHALL use Responses state only on a verified Responses route. When state is unavailable, it MAY execute degraded continuation only if Integration supplies a resolved previous output and a verified Tier A/B image-input route, and SHALL set `degradedContinuation=true`.

#### Scenario: Native Responses continuation
- **WHEN** previous response/image/file identifiers and required state capabilities are supported
- **THEN** Creation SHALL preserve those identifiers in the Responses request and SHALL not re-upload a previous output

#### Scenario: Resolved previous output fallback
- **WHEN** state is unavailable, degraded continuation is allowed, and Integration provides the previous output as a resolved target
- **THEN** Creation SHALL use the verified image-input route and mark the result degraded without querying Library paths

#### Scenario: Previous output is unavailable
- **WHEN** state is unavailable and no resolved previous output is supplied
- **THEN** Creation SHALL return `capability_unavailable` without fabricating continuation

### Requirement: Batch execution is bounded, ordered, and honest
Creation SHALL execute 1 through 20 validated independent tasks with requested concurrency 1 through 10, preserve input order and IDs, isolate task failures, and return one result for every task with an overall status derived from item outcomes.

#### Scenario: Mixed batch completes
- **WHEN** ordered tasks produce succeeded, partial, and failed results
- **THEN** the batch SHALL return `partial`, keep exact task order, and preserve each result/error and provider request count

#### Scenario: One task fails
- **WHEN** a task fails without a caller-wide cancellation
- **THEN** unrelated queued/running tasks SHALL continue within the concurrency bound

#### Scenario: Batch is cancelled
- **WHEN** the caller cancels the batch
- **THEN** no new tasks SHALL start, running tasks SHALL receive cancellation, completed results SHALL remain, and pending tasks SHALL return structured cancelled outcomes

### Requirement: Execution never reports false success or hides billing risk
Succeeded operations SHALL contain final artifacts and no top-level error; failed operations SHALL contain a structured error; partial operations SHALL preserve artifacts, failed slots, or errors. Execution and error billing/output flags MUST agree.

#### Scenario: Provider returned output before failure
- **WHEN** any output was received before an operation failed
- **THEN** the result SHALL be partial or failed-with-partial artifacts, `receivedAnyOutput=true`, `mayHaveBilled=true`, and a non-automatic retry disposition

#### Scenario: Provider returned no usable output
- **WHEN** all attempts end without a valid final or partial artifact
- **THEN** Creation SHALL return `failed` and SHALL not reuse an old file or unrelated output as the current result
