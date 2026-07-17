## ADDED Requirements

### Requirement: Non-billable refresh and confirmed billable probes are distinct
Provider settings SHALL model model refresh as non-billable metadata retrieval and capability probing as a separate explicitly confirmed action that may generate output or charge the user.

#### Scenario: Refresh uses only non-billable evidence
- **WHEN** a model refresh is requested without a billable probe
- **THEN** the operation SHALL use only configured metadata or an explicitly configured models endpoint and SHALL NOT send generation, edit, or Responses image requests

#### Scenario: Probe is explicitly confirmed
- **WHEN** the user confirms a billable probe for a provider, model, capability, transport, and request shape
- **THEN** the operation MAY authorize only that described probe and SHALL report `mayHaveBilled` and sanitized evidence

### Requirement: Probe results preserve four-state evidence rules
Capability-probe results SHALL represent `unknown`, `supported`, `unsupported`, or `degraded` using the existing evidence rules, and transient authentication, rate-limit, timeout, 5xx, moderation, or isolated model failures MUST NOT become unsupported evidence.

#### Scenario: Probe succeeds
- **WHEN** the explicitly confirmed request returns conclusive protocol success
- **THEN** the scoped capability MAY become `supported` with successful-request evidence and a validation time

#### Scenario: Protocol stably rejects the feature
- **WHEN** the explicitly confirmed request returns a stable protocol-level unsupported response
- **THEN** the scoped capability MAY become `unsupported` with protocol-rejection evidence

#### Scenario: Probe has a transient failure
- **WHEN** the probe receives authentication failure, rate limit, timeout, moderation block, 5xx, or an isolated model error
- **THEN** the prior capability state SHALL remain unchanged and the result SHALL report only a sanitized transient outcome

#### Scenario: Only a weaker fallback is possible
- **WHEN** the capability can be completed only with weaker semantics such as re-uploading a previous output
- **THEN** the result SHALL be `degraded` with a degradation reason and SHALL NOT claim native support
