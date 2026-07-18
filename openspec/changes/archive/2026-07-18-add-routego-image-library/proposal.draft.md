> **UNFROZEN DRAFT:** Blocked by the 2026-07-17 shared-contract dependency gate. Reconcile provider-setting writes, library detail/folder/resource contracts, partial management results, and the workspace lockfile importer before restoring this file as `proposal.md`.

## Why

Routego Image 1.0 needs a durable local data layer before Creation and Studio can safely share provider settings, generated assets, favorites, recycle-bin state, and portable exports. The Library lane must provide that layer without exposing credentials, corrupting concurrent writes, overwriting project assets, or touching the legacy plugin's configuration and images.

## What Changes

- Add secure local persistence for multiple OpenAI-compatible provider profiles, keeping API keys in a restricted-permission credential file separated from exportable non-sensitive settings and capability evidence.
- Add a versioned JSON image-library index with deterministic validation, search and filtering metadata, SHA-256 deduplication, asset-level many-to-many favorite folders, file locking, temporary files, atomic replacement, and crash recovery.
- Add non-destructive asset placement with MIME and checksum verification, versioned exclusive filenames, and explicit handling for partial operations so successful files do not become unreported orphans.
- Add recycle-bin behavior with soft delete, restore, a 30-day retention policy, and confirmation-gated permanent deletion that never targets legacy paths.
- Add ZIP import and export with a versioned portable manifest, exclusion of credentials, limits on archive size and entry count, path-containment checks, MIME/magic-byte and SHA-256 validation, collision-safe asset placement, and atomic index integration.
- Preserve old `~/.codex/routego-image-config.json`, old pictures, and `C:\Users\MLTZ\plugins\routego-image` without migration, overwrite, or deletion.
- Keep public `routego_status`, `routego_search_library`, and `routego_manage_library` request/result shapes frozen; this change supplies Library-owned application services for later transport integration.
- Do not add SQLite, native addons, provider transport, Studio UI, plugin manifest, release workflow, or new root dependencies.

## Capabilities

### New Capabilities

- `local-provider-configuration`: Versioned provider settings, separately protected credentials, safe endpoint/capability persistence, redacted reads, permissions, validation, and recovery.
- `durable-image-library`: Versioned JSON index, asset ingestion and deduplication, search metadata, favorites, concurrent atomic mutation, crash recovery, recycle bin, restore, and permanent-delete policy.
- `library-portability`: Credential-free ZIP export and defensive ZIP import with manifest, checksum, file-type, resource-limit, traversal, collision, and atomic-integration guarantees.

### Modified Capabilities

None. Foundation public contracts and security requirements remain frozen dependencies.

## Impact

- Adds a Library-owned Node package and tests under `packages/library/**`.
- Consumes existing `@routego-image/contracts` schemas and `@routego-image/foundation` security/provider helpers; no shared Schema changes are planned.
- Uses Node.js built-ins and existing workspace tooling only; no SQLite, native addon, new third-party runtime package, root dependency, or lockfile change is planned.
- Writes new user data only beneath the Routego Image 1.0 configuration and library roots selected by the caller; test data remains in isolated temporary directories.
- Provides service objects that Creation/Integration can call later, but does not implement MCP/HTTP transport or Studio presentation.
