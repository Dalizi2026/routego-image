## Context

The three Foundation gates now freeze public path-based MCP contracts, path-free Studio contracts, upload lifecycle metadata, settings mutation, deterministic mocks, and the `@routego-image/library` importer. This change owns the real Node-side persistence and resource resolution behind those schemas. It must remain safe across Windows/macOS/Linux, multiple local processes, interruption during multi-file mutations, and untrusted ZIP/image input.

Exclusive ownership is `packages/library/**` and this change directory. Shared contracts, Foundation helpers, mock relay, root dependencies/lockfile, Creation/Studio code, transports, manifest, and release files are read-only.

## Goals / Non-Goals

**Goals:**

- Durable provider settings, separate protected credentials, defaults, capability cache, and safe output-directory configuration.
- Real upload reservation/staging/finalization/status/discard/expiry/consumption with contained server paths and verified integrity metadata.
- Versioned JSON Library index, validated assets, deduplicated blobs, search/detail/folders/resources, recycle bin, and crash-safe mutations.
- Defensive portable ZIP import/export with credential exclusion, strict limits, collision handling, and honest partial outcomes.
- Resolver APIs that return contained internal resources to Integration without executing provider operations.

**Non-Goals:**

- Provider network calls, Studio creation execution, HTTP/session/origin/SSE adapters, UI, MCP dispatch, or release behavior.
- Shared Schema/root dependency/lockfile changes, SQLite, native addons, keychains, cloud storage, or legacy-data migration.

## Decisions

### 1. Separate roots and secrets

The default data root is `~/.codex/routego-image`. `config.json` stores versioned non-sensitive profiles/defaults/capability cache; `credentials.json` stores only profile API keys; `uploads/` stores short-lived staged bytes and its versioned registry. The default image root is `~/Pictures/routego-image/library`, containing `index.json`, date-partitioned assets, locks, temporary files, and transaction journals. Tests inject temporary roots.

Credentials are separate because export/redaction must not depend on stripping fields from a mixed document. POSIX uses mode `0600`; Windows applies and verifies a current-user SID ACL with `icacls` invoked without a shell. Secret writes fail closed if protection fails.

### 2. Shared contracts at boundaries, Library-owned storage formats internally

Frozen Zod schemas validate every service input/result. Internal config, upload-registry, index, journal, and ZIP-manifest records are separate versioned formats containing relative paths and recovery state that never cross Studio boundaries. Explicit parsers reject malformed or future versions; an existing corrupt file is never replaced by empty defaults.

### 3. Tokenized locks and atomic documents

Each mutable document uses an exclusive `wx` lock containing random token, PID, resource, and timestamp. Contenders use bounded backoff. Stale recovery requires age plus a dead local PID/invalid owner and rechecks before removal. Unlock removes only the matching token.

JSON writes use a unique same-directory temporary file, flush, validated backup, atomic rename, and directory flush where supported. Readers recover only from a validated backup/journal. Multi-file operations use journals; the index/registry replacement is the commit point.

### 4. Strict output-directory replacement

`updateSettings` distinguishes unchanged/default/clear/replace. Replace canonicalizes an absolute local path server-side, rejects roots, NUL/traversal, URLs/UNC where unsafe, protected legacy roots, any existing symlink component, non-directory targets, unsafe POSIX ownership, and non-creatable destinations. A contained exclusive probe verifies writability. Results/logs expose only a redacted display label, never the submitted full path.

### 5. Provider persistence without provider execution

Profiles preserve explicit endpoint inputs and use Foundation normalization/redaction; no sibling endpoint is inferred. Capability records preserve provider/model/endpoint/transport/request-shape scope and all four states. Library stores model/capability results supplied by Creation/Integration but performs no refresh or billable probe.

### 6. Upload registry and binary staging

Reservations choose policy by purpose: image/reference/target/supporting/mask are reusable until expiry; ZIP import is single-consume. The registry stores stable ID, declaration, policy, lifecycle, contained staging path, timestamps, and finalized integrity metadata. Integration receives a writable contained target/stream method after enforcing session/origin; Library independently enforces maximum bytes while writing.

Finalize sniffs PNG/JPEG/WebP/ZIP, verifies allowed purpose/MIME, byte length, SHA-256, expected checksum, and image dimensions. Failure deletes incomplete bytes and records a structured upload failure. Status lazily expires resources; discard removes bytes; ZIP consumption occurs only after a successful committed import. Resolver methods return an internal path/metadata object, never a provider result.

### 7. Logical assets and deduplicated blobs

The Library index separates logical assets from physical blobs keyed by SHA-256. Logical assets retain prompt/model/kind/status, requested/effective parameters, execution/error state, renditions, ordered relationships, folder memberships, and deletion lifecycle. Identical bytes can back several logical assets; a blob is deleted only after the final reference is removed.

Image ingestion verifies magic bytes, structure, dimensions, size, optional declared metadata, and SHA-256. New files use detected extensions and exclusive `name`, `name-2`, ... placement under `YYYY/MM`; project copies use the same non-overwriting helper.

### 8. One index snapshot for public and Studio projections

Public search returns the frozen path-based summary for Codex. Studio search uses the same filters/cursor but projects asset/artifact IDs and protected thumbnails. Detail, relationships, folders, allowed actions, resources, and both searches derive from one committed snapshot so IDs cannot drift.

Opaque base64url keyset cursors encode sort mode, last sort key, and asset ID. Folder membership is many-to-many; active names are unique after Unicode case folding; reorder requires every active folder exactly once.

### 9. Lifecycle deletion and protected resources

Soft delete records prior status, `deletedAt`, and purge eligibility 30 days later without deleting bytes. Restore reverses it. Permanent deletion revalidates preflight and confirmation per target, commits index removal first, and deletes unreferenced contained blobs afterward through a journal.

Browser resources are short-lived in-memory registrations mapping random IDs to contained files, metadata, ETag, and expiry. Studio receives only the frozen relative descriptor. Integration owns session/origin enforcement and byte streaming.

### 10. Small audited ZIP subset

No dependency is approved, so ZIP support uses Node buffers/streams, `node:zlib`, and an internal CRC-32 implementation. Export writes UTF-8 regular-file entries, central directory, and EOCD using store/deflate. Import parses the central directory before allocation and accepts only unencrypted single-disk regular files using methods 0/8.

Hard limits cover archive bytes, entries, name length, per-entry/total uncompressed bytes, and expansion ratio. Canonical names reject absolute/drive/UNC/backslash/NUL/dot traversal/duplicates/symlink or special-file attributes. CRC-32, manifest SHA-256, detected MIME/dimensions, and declared sizes must agree.

The manifest records selected logical assets/folders/relationships and blob entries, never credentials, tokens, absolute paths, or provider bodies. Import validates fully before mutation, reuses blobs, consistently remaps conflicting IDs, and journals placement/index integration. ZIP uploads are marked consumed only after commit.

### 11. Service composition

Library implements `StudioUploadService`, `StudioLibraryService`, settings read/upsert/remove/set-active/update, and public search/manage storage behavior. Refresh/probe and Studio generate/edit/batch remain Creation/Integration. Internal `ResourceResolver` resolves asset/artifact/upload IDs to contained resources for Integration.

### 12. Verification

Vitest uses only temporary roots and synthetic PNG/JPEG/WebP/ZIP bytes. Tests cover locks, stale recovery, atomic interruption, permissions, corruption, all upload states, output-path validation, four capability states, deduplication, collisions, search/cursors, folders, details/relationships, resources, recycle/restore/delete, ZIP traversal/bomb/CRC/SHA/MIME/ID collision, partial outcomes, and transaction recovery. Final gates include Library and root safety/typecheck/build/test/export checks, strict OpenSpec, dependency/native audit, scope/diff checks, and clean Git.

## Risks / Trade-offs

- [Risk] JSON rewrites scale linearly. → Mitigation: normalized compact records, short lock-held commit phase, and a future explicit migration if needed.
- [Risk] Crashes span several files. → Mitigation: journal-owned paths, atomic document commit points, and recovery that never scans/deletes unknown files.
- [Risk] ZIP parsing is security-sensitive. → Mitigation: deliberately small subset, central-directory-first limits, integrity/type checks, and adversarial fixtures.
- [Risk] Windows ACL/ownership checks vary. → Mitigation: SID-based command arguments, exit-code verification, injectable adapters, and fail-closed secret writes.
- [Risk] Browser resource registrations disappear on restart. → Mitigation: descriptors are intentionally short-lived and can be regenerated from durable IDs.

## Migration Plan

1. Initialize only missing Routego Image 1.0 files; never inspect or migrate legacy roots.
2. Land filesystem primitives, then configuration, uploads, index/assets, queries/recycle/resources, ZIP, and service composition in dependency order.
3. Existing corrupt/unsupported files stop with recovery guidance; no silent downgrade or deletion occurs.
4. Rollback uses `git revert`; durable formats remain explicitly versioned.

## Open Questions

None. Any need to change shared contracts, ownership, dependencies, or product scope is a `[PLAN_DEVIATION]`.
