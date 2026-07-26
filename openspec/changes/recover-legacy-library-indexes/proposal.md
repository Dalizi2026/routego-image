## Why

Routego Image 1.0 shipped a version-2 Library index reader that rejects real version-1 generation Libraries. The resulting startup recovery error is currently surfaced as an unconfigured provider, so users can save a valid provider profile yet be unable to generate images or access Studio normally after upgrading.

This is a distribution defect: repairing one local index does not protect other plugin users. The plugin needs an explicit, recoverable upgrade path for the supported legacy Library shape and an honest status when migration is still required.

## What Changes

- Add a read-only detector and deterministic preflight for legacy version-1 generation-only Library indexes.
- Add an explicit Studio-only confirmation flow that creates a recovery copy, validates the index under the Library lock, and atomically promotes a version-2 replacement only when every legacy record is safely convertible.
- Keep unsupported legacy data unchanged and provide a sanitized migration-required state instead of reporting the provider as unconfigured.
- Add browser-safe local migration contracts/routes, Studio recovery UI, regression coverage, and packaged-plugin smoke coverage for the upgrade path.
- **BREAKING:** Legacy version-1 Library indexes that contain records outside the supported generation-only subset will remain blocked rather than being silently discarded or partially upgraded.

## Capabilities

### New Capabilities
- `legacy-library-recovery`: Detect, preflight, confirm, recover, and verify compatible legacy Library index upgrades without provider execution.

### Modified Capabilities
- `durable-image-library`: Versioned index opening and recovery must distinguish a repairable legacy index from corruption and preserve incompatible data.
- `local-service-boundaries`: Studio-only migration operations must be authenticated, schema-validated, and excluded from the seven public MCP tools.
- `studio-application-shell`: Studio must present a blocking, actionable legacy-Library migration state without losing valid provider configuration.
- `studio-settings-experience`: Completion of provider configuration must reflect the saved profile independently from a non-provider Library migration requirement.

## Impact

Affected areas are the shared browser-safe contracts, Library index parser/store and recovery, Integration status/HTTP routes, Studio bootstrap and migration UI, tests, plugin package smoke checks, and release documentation. The change makes no provider request, reads no credential value into the browser, and does not alter the seven public MCP tool definitions.
