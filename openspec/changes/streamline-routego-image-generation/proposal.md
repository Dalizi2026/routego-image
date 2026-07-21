## Why

Routego Image currently exposes image-editing, mask, capability, and Library mutation workflows that exceed the product's intended role and make ordinary generation harder to understand. The plugin must be narrowed to reliable generation through the Codex conversation, with Studio acting only as a lightweight parameter, batch, provider-switching, and history companion.

## What Changes

- **BREAKING** Remove the public `routego_edit` operation, all image-editing contracts, edit execution, Studio edit/reference/mask UI, and edit-only Library actions.
- Keep `routego_generate` for text generation plus one to five generation reference images; reject larger reference sets before any provider request.
- Restrict `routego_batch` to generation, with fixed concurrency two and per-item prompt, size, aspect ratio, and count.
- Simplify Studio generation controls to size, aspect ratio, format, count, and transparency while retaining hidden defaults in Settings.
- Add a Header provider switch whose changes affect only future submissions and preserve the same model when available.
- Narrow Library UI to search, filters, folders, scoped multi-select, ZIP portability, download, comparison, preview, and generation history.
- **BREAKING** Remove Trash, soft-delete, restore, permanent-delete UI, Studio generation retry, and all edit records and actions.
- Add safe regeneration handoff through Library actions and the read-only `routego_prepare_regeneration` public tool; keep the public tool count at seven.
- Add a guarded upgrade migration that permanently removes legacy Trash generation entries and legacy edit entries only after dependency checks and explicit user approval for real data.
- Add local transparent-background post-processing with U-2-Netp ONNX when native transparency is unavailable, unknown, or returns an opaque PNG; never regenerate automatically.
- Reverify the 60-second reusable Studio launch token in a package-built offline installation artifact.

## Capabilities

### New Capabilities

- `regeneration-preparation`: Persistent single-image marking and secret-safe, path-free generation recipe preparation without generation or network access.
- `local-background-removal`: Portable, bounded local PNG background removal with worker isolation, quality gates, and original-image preservation.
- `library-simplification-migration`: Preflighted and recoverable removal of legacy Trash and edit data with dependency conflict reporting.

### Modified Capabilities

- `shared-image-contracts`: Replace edit contracts with regeneration preparation, limit references to five, and narrow Studio and batch schemas.
- `image-job-execution`: Remove edit lifecycle semantics, snapshot provider selection, fix batch concurrency at two, and route transparency without automatic replay.
- `provider-capability-model`: Define native-versus-local transparency routing while retaining explicit billable-probe consent.
- `durable-image-library`: Remove ordinary recycle/delete operations and support a persistent current mark plus guarded legacy cleanup.
- `studio-application-shell`: Add future-request-only provider switching with honest status behavior.
- `studio-creation-workbench`: Remove editing and capability UI, simplify controls and batch behavior, and enforce parameter interactions.
- `studio-library-experience`: Remove Trash/edit/retry actions and constrain browsing, selection, comparison, export, download, preview, and regeneration handoff.
- `studio-mask-editor`: Remove the mask editor capability from the shipped Studio.

## Impact

- Public MCP/HTTP schemas, tool registration, route handlers, generation executor, provider routing, and capability behavior change.
- Studio workbench, Header, Library, Settings integration, browser API client, state handling, and browser tests change.
- Library schema/migration code gains an explicit destructive upgrade plan, but the development workflow will use fixtures only and will not mutate real user data.
- Packaging gains approximately 18-22 MB from an Apache-2.0 U-2-Netp model and MIT ONNX Runtime Web/WASM assets after dependency installation is separately authorized.
- Existing integrations that call `routego_edit`, edit batch items, Trash mutations, or Studio edit endpoints must stop using those interfaces.
- Phase 2 visual redesign, provider deployment, real generation, CI triggering, publication, current-install replacement, and real Library migration are out of scope for automatic execution.
