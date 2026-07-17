## Why

Routego Image 1.0 needs one crash-safe local data layer so Codex and Studio observe the same provider settings, uploads, generated assets, favorites, recycle-bin state, and portable archives. Foundation, Foundation Extension, and Browser Boundary have now frozen the complete shared contracts and package baseline, so the Library lane can implement real persistence and resource ownership without changing shared schemas or executing provider operations.

## What Changes

- Persist multiple OpenAI-compatible provider profiles, active selection, cached models/capabilities, generation defaults, and output-directory selection under the new Routego Image configuration root.
- Keep API keys in a separate restricted-permission credential file; settings reads, exports, errors, and logs expose only `hasApiKey` and a short preview.
- Implement settings read, profile upsert/removal/selection, and `updateSettings` defaults/output-directory mutations. Replacement output paths receive strict server-side canonicalization, legacy/symlink/root/ownership/creatability checks, and redacted results.
- Implement the real Studio upload control plane behind the frozen reserve/finalize/status/discard contracts, including contained temporary staging, binary-write handles for Integration, MIME/size/checksum/dimension verification, expiry/discard cleanup, reusable image policy, and single-consume ZIP policy.
- Resolve `uploadResourceId`, `assetId`, and `artifactId` to contained server resources for Integration/Creation without executing generation, editing, batching, provider transport, or cross-lane filesystem discovery.
- Implement a versioned JSON image-library index with validation, file locking, temporary files, atomic replacement, transaction recovery, search/filter metadata, path-free Studio search, public path-based MCP search, complete details, ordered relationships, folders, and asset-level many-to-many favorites.
- Validate and ingest PNG, JPEG, and WebP assets, calculate SHA-256, reuse duplicate content, and place new files with exclusive versioned names so existing project or Library assets are never overwritten.
- Implement protected browser-resource registrations for thumbnails, previews, originals, and ZIP exports without exposing arbitrary local paths through browser-facing results.
- Implement soft deletion, 30-day retention metadata, restoration, confirmation/preflight-gated permanent deletion, per-item partial outcomes, and cleanup of unreferenced files without touching protected legacy roots.
- Implement ZIP import/export and a versioned portable manifest with credential exclusion, archive/entry/expansion limits, safe entry names, supported compression checks, MIME/magic-byte/dimension validation, CRC-32/SHA-256 verification, collision-safe ID/path handling, deduplication, upload consumption, and atomic index integration.
- Preserve `C:\Users\MLTZ\plugins\routego-image`, `~/.codex/routego-image-config.json`, and all legacy images without migration, overwrite, or deletion.
- Do not add SQLite, native addons, provider transport, model/capability network calls, Studio UI, HTTP/session/origin/SSE adapters, MCP adapters, plugin manifest, installation, or release behavior.

## Capabilities

### New Capabilities

- `local-provider-configuration`: Versioned non-sensitive provider settings, separately protected credentials, active/default state, capability-cache persistence, safe output-directory mutation, redacted reads, file permissions, concurrent mutation, and corruption recovery.
- `durable-image-library`: Versioned JSON index, real upload staging/registry and locator resolution, validated asset ingestion, SHA-256 deduplication, public and path-free search, folders/favorites, complete details and relationships, protected browser resources, concurrent atomic mutation, crash recovery, recycle bin, restoration, and permanent deletion.
- `library-portability`: Credential-free portable ZIP manifests, defensive ZIP parsing/writing, upload-backed import, protected export resources, collision handling, checksum/type/resource validation, deduplication, partial outcomes, single consumption, and atomic integration.

### Modified Capabilities

None. The six Foundation specifications and their frozen public/Studio contracts remain read-only dependencies.

## Impact

- Product implementation and tests are confined to `packages/library/**` plus this change's OpenSpec artifacts.
- The existing `@routego-image/library` importer, workspace dependencies, root lockfile, shared contracts, Foundation helpers, mock service, and package export wiring are consumed read-only.
- Library implements `StudioUploadService`, the persistence-owned portions of `StudioSettingsService`, every `StudioLibraryService` method, and public `routego_search_library`/`routego_manage_library` storage behavior. Integration composes these with Creation's `StudioCreationService` and provider execution.
- Library exposes internal resolver/staging APIs to Integration but never turns a Studio request into a provider call and never reads Creation-owned state.
- No third-party or native dependency is added. ZIP, hashing, file locking, permissions, atomic persistence, and image-header inspection use Node.js 20.19+ built-ins.
- Tests use isolated temporary directories and synthetic byte fixtures only; they never access real credentials, user images, local configuration, or the legacy plugin/library.
