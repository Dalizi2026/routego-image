## ADDED Requirements

### Requirement: Local background removal is portable and isolated
The plugin SHALL perform local background removal with the U-2-Netp ONNX model through ONNX Runtime Web/WASM in a Node.js worker. It SHALL use no native addon, SHALL run one local removal at a time, and SHALL terminate the worker after completion, failure, cancellation, or timeout.

#### Scenario: Local removal succeeds
- **WHEN** an eligible opaque PNG is queued and the worker produces a valid mask within limits
- **THEN** the plugin SHALL create a transparent PNG rendition, release worker resources, and preserve the original rendition

#### Scenario: Multiple outputs require removal
- **WHEN** several generated outputs need local transparency
- **THEN** the plugin SHALL process them serially with local concurrency one while preserving output order and per-item outcomes

#### Scenario: Worker times out or crashes
- **WHEN** inference exceeds its deadline or the worker exits unexpectedly
- **THEN** the plugin SHALL terminate the worker, retain the original image, and return a structured local-processing failure without provider replay

### Requirement: Model and WASM assets are verified package resources
The packaged plugin SHALL include license notices and pinned, integrity-verified U-2-Netp model and required WASM resources. Runtime loading SHALL use contained package resources and MUST NOT download models or executable assets.

#### Scenario: Packaged assets are valid
- **WHEN** local removal initializes from an installed package
- **THEN** the loader SHALL verify expected resources and integrity before inference without network access

#### Scenario: Asset is missing or modified
- **WHEN** the model or required WASM resource is absent or fails integrity verification
- **THEN** local processing SHALL fail before inference, preserve the original image, and report an installation-integrity error

### Requirement: Alpha masks pass bounded quality gates
Before writing a transparent result, local processing SHALL validate decoded dimensions, finite normalized mask values, non-trivial foreground/background coverage, boundary behavior, and output alpha integrity. It SHALL reject empty, full, corrupt, dimension-mismatched, or otherwise anomalous masks.

#### Scenario: Mask is plausible
- **WHEN** foreground coverage and edge/alpha checks fall within approved bounds
- **THEN** the mask SHALL be composited at source dimensions and the written PNG SHALL be decoded and revalidated

#### Scenario: Mask is empty or full
- **WHEN** the predicted mask classifies effectively all pixels as foreground or background
- **THEN** the process SHALL reject it, delete any incomplete derived file, retain the original, and return a quality-gate failure

#### Scenario: Source exceeds resource limits
- **WHEN** decoded dimensions, pixel count, or input bytes exceed configured safe limits
- **THEN** local processing SHALL fail before allocation or inference with a structured limit error

### Requirement: Transparency fallback never causes another provider request
Local background removal SHALL operate only on bytes already returned by a completed provider request. Failure, low quality, opaque native output, or cancellation MUST NOT trigger regeneration, transport switching, or capability probing.

#### Scenario: Native transparency output is opaque
- **WHEN** response inspection finds no meaningful alpha
- **THEN** the same returned PNG SHALL be queued for local removal and provider request count SHALL remain unchanged

#### Scenario: Local removal fails
- **WHEN** inference or output validation fails
- **THEN** the generation result SHALL preserve the original image, expose a transparent-rendition failure, and SHALL NOT claim transparent success
