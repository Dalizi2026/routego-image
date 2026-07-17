## Why

PD-004 confirmed that the frozen Foundation contracts still expose server-local paths to browser-facing flows and do not model the reverse resource lifecycle from Studio uploads into local image execution. Creation, Library, and Studio cannot safely freeze or apply their approved changes until one Foundation-owned gate supplies path-free contracts and a deterministic non-empty mock baseline.

## What Changes

- Add a Studio-only session upload lifecycle for image, reference, target, supporting, mask, and ZIP-import resources: reservation, protected binary-route metadata, finalization, status, discard, expiry, integrity metadata, reuse policy, and structured failures.
- Add path-free Studio generate, edit, and batch contracts using only `assetId`, `artifactId`, or `uploadResourceId`, with ordered image roles, target-slot-zero mask binding, complete image controls, path-free artifacts/relationships/errors, and started/partial/completed/failed SSE events.
- Add a path-free Studio Library search operation that reuses the public search filter/cursor semantics while returning stable IDs, metadata, folder/status state, and optional protected thumbnail descriptors without `filePath`.
- Add settings mutation for defaults and output-directory `unchanged | default | clear | replace` semantics. Custom output directories use an explicit user-confirmed local configuration path input that the future server must strictly validate; results expose only redacted configured/display state.
- Extend the deterministic local-service mock with a non-empty synthetic gallery, stable filtering/pagination, aligned detail/relationship/resource IDs, upload success/failure/expiry/discard/ZIP single-consume behavior, path-free creation success/partial/degraded fixtures, and stateful settings updates.
- Preserve `routegoOperationNames`, the seven public MCP tool names, existing path-based public MCP contracts, and `RoutegoService`. Every new operation remains Studio-only within `LocalRoutegoService`.
- Keep implementation ownership limited to `packages/contracts/**`, `packages/mock-relay/**`, focused tests, and this change's OpenSpec artifacts.

### Non-goals

- No real binary storage, filesystem persistence, checksum/type/dimension probing, provider transport, billable request, HTTP/session/origin adapter, Studio UI, plugin manifest, installation, release, or data migration.
- No new public MCP operation, third-party dependency, root dependency/lockfile change, or product implementation in Creation, Library, or Studio.
- No browser-supplied arbitrary local path for image operations or Library search, no unrestricted external image URL, and no credential or image-byte/Base64 value in JSON results, mock observations, or logs.

## Capabilities

### New Capabilities

None. This corrective gate completes the already approved Foundation browser boundary.

### Modified Capabilities

- `shared-image-contracts`: Add upload lifecycle, path-free Studio creation/batch/SSE, path-free Library search, and defaults/output-directory mutation contracts while retaining the public path-based MCP schemas.
- `local-service-boundaries`: Add Studio upload, creation, search, and settings subinterfaces/operation definitions to `LocalRoutegoService` without changing the public operation registry.
- `foundation-security`: Require protected upload URLs, purpose/MIME/size/expiry/integrity enforcement metadata, single-consume ZIP behavior, path/URL/credential-free browser DTOs, and redacted settings mutation results.
- `foundation-verification`: Require the complete browser-boundary scenario matrix, deterministic non-empty mock data, public-operation freeze, browser-safe source/declaration/emitted audits, and strict safe clean delivery.

## Impact

- Affected code: `packages/contracts/**`, `packages/mock-relay/**`, and their focused tests.
- Affected APIs: new Studio-only local service contracts and schemas; existing public MCP inputs/results and all seven public tool names remain unchanged.
- Downstream systems: Library later implements upload staging/resource resolution, Creation executes already resolved internal image requests, Integration composes both behind real HTTP/session/origin/binary streaming, and Studio consumes only the new path-free surface.
- Dependencies: no package, root manifest, lockfile, workspace, runtime dependency, or native-addon change.
