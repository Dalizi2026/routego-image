## Context

The generation-only release introduced Library index schema version 2. Production startup currently calls the version-2 parser before the provider status reader; a real version-1 index therefore throws `unsupported_version`, makes the whole application recover as degraded, and causes the public status result to claim that no provider or API key is configured. The provider profile itself remains valid, but Studio has no supported way to recover the Library.

The affected data is local user content. The migration must work on macOS, Windows, and Linux without a native dependency, must not access a provider, and must not expose Library paths, credentials, or image bytes to Studio.

## Goals / Non-Goals

**Goals:**

- Recognize a version-1 Library separately from corruption and retain its exact source document until a user makes a decision.
- Support a bounded, deterministic conversion only for the documented version-1 generation-only record shape that can become a valid version-2 index without deleting bytes or logical records.
- Make preflight and confirmation Studio-only, session-authenticated, schema-validated operations; keep the seven public MCP tools unchanged.
- Preserve saved provider configuration in status results while a Library migration is pending, and give Studio a clear route to complete or safely stop migration.
- Create a backup before changing an index, use the existing lock/atomic-write/journal primitives, and leave unsupported data untouched.

**Non-Goals:**

- Automatic migration on plugin installation, process startup, or a previously saved provider configuration.
- Migration of legacy edit records, trash records, unknown fields, malformed references, or external legacy folders.
- Deleting legacy blobs, making provider requests, changing API keys, or migrating data from a different plugin/data root.
- Adding an MCP tool or browser-visible local paths.

## Decisions

### 1. Classify legacy index state before normal Library recovery

`ImageLibraryIndexStore` will inspect the raw index's schema version before normal version-2 parsing. It will return one of `not-required`, `ready`, or `blocked` legacy migration states to the Library service. Corrupt JSON and future/unknown versions remain normal sanitized errors; a known version-1 index is not converted by a read operation.

Alternative considered: accept version-1 as a version-2 index by ignoring obsolete fields. Rejected because read behavior would silently change persistent data semantics and would fail late in mutation paths.

### 2. Convert only an exact supported v1 generation subset

The converter validates every blob, folder, relationship, rendition, execution record, and active generation asset. It projects only known obsolete version-1 parameter fields (`supportingImages`, `action`, `imageIds`, and `fileIds`) away, preserves all supported fields and records, changes the schema version to 2, and validates the complete projected index with the existing version-2 parser. Any edit/trash/unknown/invalid record produces a blocked preflight with a stable, path-free reason and no mutation.

Alternative considered: reuse the old destructive legacy-cleanup executor. Rejected because that executor is intentionally fixture-only and removes legacy records; an upgrade must preserve supported user data.

### 3. Require exact confirmation and make the replacement recoverable

Studio reads a path-free migration state and receives a deterministic fingerprint for a ready plan. Confirmation must echo that fingerprint. Under the existing Library lock, the executor rereads and revalidates the source, verifies the fingerprint, writes a timestamped recovery copy beside the index, records a journal intent, atomically writes the version-2 index, validates the promoted document, and marks the journal committed. A failure leaves the old index in place or restores it from the recovery copy; blobs are never touched.

Alternative considered: migrate during `recover()`. Rejected because application startup is not meaningful consent for a user-data write.

### 4. Separate provider configuration from Library availability

Composition recovery will retain a recognized migration-required condition instead of treating it as a provider-settings exception. `routego_status` will still project real provider configuration and models, while service health remains degraded until the migration completes or is blocked. Studio boot calls a new internal migration-state route and renders a blocking recovery panel before Library or creation actions can depend on the index.

Alternative considered: report the service as ready before the Library is usable. Rejected because generation could incur a provider request and only then fail while persisting the image.

### 5. Keep the migration private to Studio

Two authenticated loopback routes expose preflight/state and confirmed execution. They use new shared path-free contracts and never appear in `routegoOperationNames`, MCP tool registration, or plugin skill instructions. The Studio client receives counts, stable IDs only where needed, a fingerprint, and safe messages; it never receives an index path, backup path, image byte data, or credential.

## Risks / Trade-offs

- [A past v1 variation cannot be converted] -> Block before mutation, preserve the original index, report a safe recovery requirement, and retain the recovery copy only after a confirmed supported migration.
- [A crash occurs during promotion] -> Use the existing transaction journal, atomically replace the index, revalidate after promotion, and restore from the backup when a post-write check fails.
- [A stale confirmation is replayed] -> Fingerprint the exact raw document and recheck it while holding the Library lock.
- [Users confuse a pending migration with bad API configuration] -> Provider status remains truthful and Studio renders a dedicated migration-required state.
- [A new route leaks local data] -> Contracts contain only state, counts, safe reasons, and fingerprints; route tests reject paths, bytes, credentials, and unauthenticated calls.

## Migration Plan

1. Ship the reader, contracts, Studio UI, and regression/package tests in the plugin artifact.
2. On first launch, compatible version-1 Libraries show a review-and-confirm action; no data changes occur before confirmation.
3. On confirmation, the plugin writes a local recovery copy, promotes and verifies version 2, then continues normal recovery in the same process.
4. If a migration is blocked or fails, the original index remains available for future compatible releases or manual support; the plugin never resets it.
5. Existing installations can be refreshed with the newly built local package for validation. This is not a marketplace deployment.

## Open Questions

None. Unsupported v1 record shapes are deliberately blocked rather than inferred.
