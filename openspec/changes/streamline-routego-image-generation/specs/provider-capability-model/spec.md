## MODIFIED Requirements

### Requirement: Safe route selection
The routing decision SHALL require explicit configured endpoint data and sufficient capability evidence for every provider-bound requested feature. Text generation SHALL remain eligible when text capability is `unknown` under the established baseline rule; reference-image generation SHALL require supported or explicitly degraded image-input evidence. Transparency SHALL use a supported native route when confirmed and otherwise SHALL select ordinary PNG generation followed by local background removal without a billable probe.

#### Scenario: Legacy single-endpoint image input supported
- **WHEN** `single-endpoint-json` image data URL input is explicitly supported
- **THEN** reference-image generation MAY select that same configured endpoint and SHALL identify the selected transport as `single-endpoint-json`

#### Scenario: Image input still unknown
- **WHEN** a request contains reference images but every configured image-input capability is `unknown` or `unsupported`
- **THEN** routing SHALL return `capability_unavailable` with no network instruction

#### Scenario: Native transparency is supported
- **WHEN** native transparency is confirmed for the snapshotted provider/model/endpoint
- **THEN** routing SHALL request native transparent PNG output

#### Scenario: Native transparency is unknown or unsupported
- **WHEN** transparency is requested and native capability is `unknown` or `unsupported`
- **THEN** routing SHALL request an ordinary PNG and mark the result for local background removal without probing or replaying the provider request

### Requirement: Billable validation requires confirmation
The capability model SHALL distinguish synthetic/documentary evidence from a real provider probe, and any probe that can generate an image or charge the user MUST require explicit user confirmation. Unknown transparency SHALL fall back to local processing and MUST NOT initiate a probe automatically.

#### Scenario: Automatic status refresh
- **WHEN** status is refreshed without explicit confirmation for a billable test
- **THEN** the system SHALL use only non-billable evidence and SHALL NOT send a generation request

#### Scenario: Transparency capability is unknown
- **WHEN** a transparent result is requested without confirmed native support
- **THEN** the system SHALL choose local post-processing and SHALL NOT probe the provider

## ADDED Requirements

### Requirement: Native transparency results are verified
Provider response processing SHALL inspect the decoded PNG alpha channel before declaring native transparency successful.

#### Scenario: Native response is opaque
- **WHEN** a native transparency request returns a valid but fully opaque PNG
- **THEN** the returned image SHALL be passed to local background removal without making another provider request

#### Scenario: Native response contains meaningful alpha
- **WHEN** the returned PNG passes alpha coverage and validity checks
- **THEN** it SHALL be accepted as the transparent result without local processing
