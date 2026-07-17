> **PROPOSAL-BOUNDARY CHECKPOINT:** This proposal requires recalibration after the shared browser-upload, path-free Studio operation/search, settings-default mutation, and deterministic gallery contracts are corrected. It is not apply-ready.

## Why

Routego Image 1.0 needs one crash-safe local data layer so Codex and Studio observe the same provider settings, generated assets, favorites, recycle-bin state, and portable archives. The Foundation Extension has now frozen the required browser-safe contracts and package importer, allowing the Library lane to implement durable behavior without changing shared schemas or the root dependency graph.

## What Changes

- Persist multiple OpenAI-compatible provider profiles, active selection, model/capability cache, defaults, and output-directory settings under the new Routego Image data root.
- Keep API keys in a separate restricted-permission credential file; settings reads, exports, errors, and logs expose only `hasApiKey` and a short preview.
- Implement the frozen Studio settings persistence operations for read, profile upsert/removal, and active-profile selection. Network model refresh and billable capability probes remain Creation/Integration responsibilities, while Library provides safe persistence for their results.
- Implement a versioned JSON image-library index with validation, file locking, temporary files, atomic replacement, transaction recovery, search/filter metadata, complete asset details, ordered relationships, folders, and asset-level many-to-many favorites.
- Validate and ingest PNG, JPEG, and WebP assets, calculate SHA-256, reuse duplicate content, and place new files with exclusive versioned names so existing project or library assets are never overwritten.
- Implement soft deletion, 30-day retention metadata, restoration, confirmation/preflight-gated permanent deletion, per-item partial outcomes, and cleanup of unreferenced files without touching protected legacy roots.
- Implement session-scoped browser-resource registrations backed by contained local files, without exposing arbitrary paths through browser-facing results.
- Implement ZIP import/export and a versioned portable manifest with credential exclusion, archive/entry/expansion limits, safe entry names, supported compression checks, MIME/magic-byte/dimension validation, SHA-256 verification, collision-safe ID/path handling, deduplication, and atomic index integration.
- Preserve `C:\Users\MLTZ\plugins\routego-image`, `~/.codex/routego-image-config.json`, and all legacy images without migration, overwrite, or deletion.
- Do not add SQLite, native addons, provider transport, model/capability network calls, Studio UI, MCP/HTTP adapters, plugin manifest, installation, or release behavior.

## Capabilities

### New Capabilities

- `local-provider-configuration`: Versioned non-sensitive provider settings, separately protected credentials, active/default state, capability-cache persistence, redacted reads, file permissions, concurrent mutation, and corruption recovery.
- `durable-image-library`: Versioned JSON index, validated asset ingestion, SHA-256 deduplication, metadata search, folders/favorites, complete details and relationships, browser-resource registration, concurrent atomic mutation, crash recovery, recycle bin, restoration, and permanent deletion.
- `library-portability`: Credential-free portable ZIP manifests, defensive ZIP parsing/writing, safe import/export, collision handling, checksum/type/resource validation, deduplication, partial outcomes, and atomic integration.

### Modified Capabilities

None. The six Foundation specifications and their shared settings/Library contracts remain frozen dependencies.

## Impact

- Product implementation and tests are confined to `packages/library/**` plus this change's OpenSpec artifacts.
- The existing `@routego-image/library` importer, workspace dependencies, root lockfile, shared contracts, Foundation helpers, mock service, and package export wiring are consumed read-only.
- Public `routego_search_library` and `routego_manage_library` behavior is backed by the Library implementation; frozen Studio-only settings and Library subinterfaces are implemented for later HTTP/Studio composition without adding an MCP tool.
- No third-party or native dependency is added. ZIP, hashing, file locking, permissions, atomic persistence, and image-header inspection use Node.js 20.19+ built-ins.
- Tests use isolated temporary directories and synthetic byte fixtures only; they never access real credentials, user images, local configuration, or the legacy plugin/library.
