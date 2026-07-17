## Context

The archived Foundation change established browser-safe Zod contracts, seven public Routego operations, a transport-neutral `RoutegoService`, and deterministic provider/mock fixtures. Downstream startup audits found that the approved Studio settings and Library experiences still lack shared contracts and that the three downstream workspace packages do not yet exist as importers in the lockfile.

This change is the only Foundation Extension apply-owner. It owns shared contracts, deterministic mock boundaries, root workspace/lock corrections, and minimal downstream package scaffolds. Creation, Library, and Studio remain paused and may not implement their product behavior until this branch is merged by the Program Controller.

Frozen dependencies and constraints:

- `routegoOperationNames`, `routegoOperationDefinitions`, and the seven public MCP tool names remain byte-for-byte semantically frozen.
- Existing image/provider/error schemas remain the source for image execution, four-state capability evidence, and structured failures.
- The user may have only one exact generation endpoint and an API key; no sibling endpoint is inferred or probed without an explicit contract action.
- Browser code must not receive arbitrary local paths, API keys, authorization headers, or user image bytes through settings/detail/resource metadata.
- No provider transport, Library persistence, Studio page, plugin manifest, installer, or release behavior is implemented here.
- Runtime output must remain portable to Node.js 20.19+ without a native addon requirement.

Exclusive file ownership for this change:

- `openspec/changes/extend-routego-image-foundation-contracts/**`
- `packages/contracts/**`
- `packages/mock-relay/**`
- minimal `packages/creation/**`, `packages/library/**`, and `packages/studio/**`
- root package/workspace/TypeScript importer configuration, `.gitignore`, package export and repository safety checks, and `pnpm-lock.yaml`

## Goals / Non-Goals

**Goals:**

- Freeze complete browser-safe settings and Library schemas before downstream implementation begins.
- Provide one composable local business-service type that includes the existing seven public operations plus Studio-only settings and Library subinterfaces.
- Make secret mutation write-only and make image delivery to the browser session-protected and path-free.
- Model mutation preflight, confirmation, per-item outcomes, and partial failure for destructive, bulk, and ZIP workflows.
- Extend deterministic mocks with useful synthetic settings, folders, asset details, relationships, resources, and outcome fixtures.
- Make clean frozen workspace installation, package imports, builds, tests, and export checks include Creation, Library, and Studio.

**Non-Goals:**

- Adding or renaming any public MCP tool or public Routego operation.
- Implementing network transport, provider adapters, filesystem persistence, ZIP processing, deletion, or browser resource streaming.
- Implementing React pages, components, routing, mask editing, or browser journeys.
- Reading, migrating, or modifying real configuration, API keys, user images, the legacy plugin, or the legacy library.
- Adding dependencies other than the approved Studio React/Vite packages and existing workspace packages.

## Decisions

### 1. Keep the public service frozen and compose internal subinterfaces

`RoutegoService` continues to contain exactly the seven public operations. New `StudioSettingsService` and `StudioLibraryService` interfaces are introduced, and `LocalRoutegoService` composes all three. Separate `studioOperationNames`/definitions describe local HTTP routes and schemas; they are never appended to `routegoOperationNames` and are never assigned MCP tool names.

This preserves the Foundation requirement of one business layer: an MCP adapter can depend on `RoutegoService`, while the loopback HTTP/Studio adapter can depend on `LocalRoutegoService`, with one implementation object satisfying both. A single enlarged public operation registry was rejected because it would blur internal HTTP operations with the frozen MCP surface. Independent Studio business logic was rejected because it would duplicate validation and state transitions.

### 2. Separate settings contracts from provider runtime contracts

`packages/contracts/src/settings.ts` owns browser-safe profile descriptors, settings reads, profile upsert/removal/activation, model refresh, and capability probe contracts. Provider endpoint and capability records continue to come from `provider.ts`.

Profile writes use a discriminated API-key mutation:

- `unchanged` carries no secret and preserves the stored value;
- `replace` requires a non-empty secret only in the input value;
- `clear` carries no secret and removes the stored value.

No output schema has an API-key field. Profile and settings results expose only `hasApiKey` and an optional short `apiKeyPreview`. This was chosen over nullable `apiKey` fields because null/undefined cannot distinguish preservation from deletion and would invite accidental secret echoing.

Model refresh and capability probing are separate operations. Refresh is contractually non-billable and may use only configured model metadata or a configured models endpoint. A capability probe requires `confirmBillableProbe: true`, identifies the requested capability/request shape, and reports `mayHaveBilled`. Automatic or implicit probes are not represented.

### 3. Define Library detail and browser-resource contracts without local paths

`packages/contracts/src/library.ts` owns folder, asset detail, relationship, allowed-action, browser-resource, preflight, and mutation-result schemas. Search and public `routego_manage_library` contracts remain in `tools.ts` for compatibility.

Asset detail includes prompt/model/status/timestamps, requested and effective image parameters, execution metadata, structured errors, folder membership/state, and ordered relationships using explicit `source`, `target`, `reference`, `supporting`, `mask`, and `output` roles. It identifies assets and artifacts by stable IDs and metadata, not arbitrary filesystem paths.

Browser image access is a separate `getBrowserResource` operation that returns a session-protected relative URL/resource ID, MIME type, dimensions, byte length, expiry, and cache validator. It never returns a local path, provider URL with credentials, or raw authorization. This separates metadata from byte delivery and lets the future loopback adapter revalidate the session on every request.

### 4. Require preflight and per-item outcomes for risky mutations

Studio Library mutations use two phases:

1. `preflightLibraryMutation` validates selected IDs, action eligibility, confirmation requirements, ZIP/import resource identifiers, and expected item-level effects without mutating data.
2. `executeLibraryMutation` requires the unexpired preflight ID and explicit confirmations, then returns an overall `succeeded | partial | failed` status plus an ordered result for every requested item.

ZIP export returns a protected browser-resource descriptor; ZIP import refers to a session-scoped upload resource ID. Neither uses an arbitrary browser-supplied local path. Structured errors are preserved at item and top-level scope. This was chosen over a single optimistic mutation call because permanent deletion and ZIP processing need a reviewable boundary and honest partial failure.

### 5. Extend one deterministic in-memory mock service

`MockRoutegoService` will implement `LocalRoutegoService`. Synthetic profiles, folders, assets, relationships, and resource descriptors are constants derived from fixture inputs and deterministic hashes. The mock never reads environment variables, user home directories, config files, credentials, image files, or network resources.

Existing `success`, `failure`, `partial`, `degraded`, and `invalid-output` fixtures remain available. Internal operations use the same fixture selection mechanism. Partial mutation fixtures return at least one success and one structured failure; degraded fixtures preserve four-state capability semantics and use only synthetic evidence.

### 6. Add importer-only downstream packages

Each downstream package receives a private package manifest, TypeScript project, build config, and a minimal `src/index.ts` export/import probe. These files prove workspace resolution and package exports but contain no product implementation.

- Creation depends only on approved workspace packages.
- Library depends only on approved workspace packages.
- Studio depends on approved workspace packages plus `react`, `react-dom`, `vite`, `@vitejs/plugin-react`, `@types/react`, and `@types/react-dom` at exact locked versions.

Root TypeScript references and the committed lockfile include all three importers. No additional third-party dependency is permitted without a planning deviation.

The repository's generic `library/` ignore and safety rules protect local user data, but they collide with the required source package name `packages/library`. The Foundation Extension therefore owns one exact exception: `.gitignore` unignores only `/packages/library/` and its contents, and the safety checker exempts only the `library` segment at `segments[0] === "packages" && segments[1] === "library"`. Any other `library` path remains ignored/rejected, and any other forbidden segment nested below `packages/library` remains rejected. Force-adding ignored files is not an accepted workaround.

### 7. Verification and error handling

All new operation definitions carry input and output Zod schemas. Boundary parsers fail closed on invalid mock or service output using the existing `internal_contract` model. Tests cover redaction, invalid secret/result fields, confirmation rules, relative resource URLs, relationship completeness, partial results, fixture determinism, public-operation freeze, package exports, and browser-safe build output without Node built-in imports.

The final gate runs a clean frozen install, strict OpenSpec validation, safety, typecheck, build, tests, export checks, native-runtime dependency inspection, diff-scope audit, and Git cleanliness check.

## Risks / Trade-offs

- [Risk] The internal service surface is larger than the seven public operations. → Mitigation: keep separate registries and types, test that `routegoOperationNames` and MCP tool names are unchanged, and compose one implementation object rather than adding another business layer.
- [Risk] A browser resource relative URL could later be treated as a durable public URL. → Mitigation: require session protection, expiry, relative identifiers, and revalidation; forbid local paths and credential-bearing URLs in the schema.
- [Risk] Preflight state can become stale before execution. → Mitigation: require an expiring preflight ID and allow execution to return per-item conflicts/partial failure instead of false success.
- [Risk] Synthetic mock data could accidentally resemble real secrets or user images. → Mitigation: use explicit mock identifiers, a fixed one-pixel synthetic data URL only where existing image-operation fixtures require it, and repository safety/redaction tests.
- [Risk] React/Vite dependencies expand the lockfile and include platform-specific optional build artifacts. → Mitigation: keep them development/build-time for Studio where appropriate, audit runtime dependency paths, and require no native addon on the target plugin runtime.
- [Risk] Importer scaffolds could be mistaken for feature completion. → Mitigation: expose only package/version/type import probes, include no page, transport, storage, or mutation implementation, and keep all downstream product tasks paused.
- [Risk] Exempting the package name `library` could accidentally weaken user-data protection. → Mitigation: unignore and safety logic match only the exact repository source prefix `packages/library`; staged synthetic probes verify that root and unrelated `library` paths remain blocked and are removed immediately after the test.

## Migration Plan

1. Commit and strictly validate all OpenSpec artifacts before implementation.
2. Add and verify shared contracts, then commit the atomic contract task before marking it complete.
3. Extend and verify deterministic mocks, then commit the mock task before marking it complete.
4. Add importer scaffolds and regenerate the lockfile with a clean frozen-install verification, then commit the packaging task before marking it complete.
5. Run the complete final gate, audit scope and cleanliness, mark remaining tasks, and send the immutable completion SHA to the Program Controller.
6. The Program Controller merges this branch and sends the new frozen baseline to Creation, Library, and Studio. Rollback uses `git revert`; no shared history is rewritten.

## Open Questions

None. PD-002 and the product plan already fix the public surface, dependency allowance, ownership, and non-goals. Any discovered need outside those decisions is a `[PLAN_DEVIATION]` and pauses implementation.
