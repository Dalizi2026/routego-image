## Why

PD-002 found that the frozen Foundation baseline does not expose enough browser-safe shared contracts, deterministic mock behavior, or workspace importers for the already approved Creation, Library, and Studio changes. The gap must be corrected centrally before those lanes apply so they do not independently mutate shared schemas or the root lockfile.

## What Changes

- Extend browser-safe shared contracts with local Studio/service operations for settings reads, provider-profile writes with write-only API-key mutation semantics, model refresh, explicitly confirmed billable capability probes, folder listing/reordering, asset detail, protected browser resources, and destructive/ZIP/batch library mutation preflight plus per-item partial results.
- Preserve the seven public MCP tools, their tool names, and `routegoOperationNames`; the new operations are internal local-service subinterfaces that share the same contract package and business layer.
- Extend the deterministic mock application service with synthetic provider settings, folders, asset relationships/details, protected browser-resource descriptors, and success/failure/partial/degraded fixtures without reading credentials, local configuration, or user images.
- Add minimal workspace importers for `packages/creation`, `packages/library`, and `packages/studio`; Creation and Library use workspace dependencies only, while Studio declares React, ReactDOM, Vite, the React Vite plugin, and their type packages.
- Update the committed workspace lockfile and root TypeScript references so a clean frozen install can resolve and validate all three downstream packages.
- Add regression coverage for browser safety, redaction, preflight/partial-failure semantics, package exports, browser-safe contract output, deterministic mocks, and absence of native runtime dependencies.
- Do not implement provider transport, Library persistence/filesystem behavior, Studio pages or mask editing, plugin manifest/install/release behavior, or any new public MCP tool.

## Capabilities

### New Capabilities

None. This corrective change completes already approved Foundation capabilities rather than adding product scope.

### Modified Capabilities

- `shared-image-contracts`: Add browser-safe settings, provider-profile, folder, asset-detail, protected-resource, preflight, and per-item mutation schemas.
- `local-service-boundaries`: Add composable Studio/local service subinterfaces that reuse the shared business layer while leaving the seven public Routego operations frozen.
- `provider-capability-model`: Separate non-billable model refresh from explicitly confirmed billable capability probes and preserve four-state evidence semantics.
- `foundation-security`: Require write-only API-key mutations and session-protected relative browser resources that never disclose arbitrary local paths or credentials.
- `workspace-foundation`: Add the three downstream package importers and the approved Studio React/Vite dependency baseline to the committed workspace graph.
- `foundation-verification`: Add strict regression gates for the new contracts, mocks, importers, exports, browser safety, clean frozen install, and pure-JavaScript dependency graph.

## Impact

- Affected code: `packages/contracts/**`, `packages/mock-relay/**`, minimal `packages/creation/**`, `packages/library/**`, `packages/studio/**`, root TypeScript/workspace dependency configuration, and `pnpm-lock.yaml`.
- Affected APIs: browser-safe internal Studio/local-service schemas and interfaces only; the seven public MCP tools and existing operation names remain unchanged.
- Dependency impact: Creation and Library add no third-party dependencies; Studio adds only the approved React/Vite packages and types. No native runtime dependency is introduced.
- Downstream impact: Creation, Library, and Studio remain paused until this change is committed, strictly validated, merged by the Program Controller, and announced with a new frozen baseline SHA.
