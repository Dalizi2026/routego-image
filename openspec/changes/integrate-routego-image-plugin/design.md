## Context

The frozen mainline contains working Creation, Library, and Studio packages, but no production object implements the complete `LocalRoutegoService`, no plugin process starts MCP and Studio together, no self-contained distributable exists, and no cross-platform or real-relay release gate has been defined. Creation already exports resolved-request execution, exact-seven-tool MCP support, HTTP dispatch primitives, and validated event codecs. Library exports provider settings/credentials, uploads, resource resolution, asset ingestion, project copying, browser resources, mutations, and ZIP portability. Studio exports the browser application and an HTTP gateway, but its production build is not served by a real local runtime.

PD-005 identified two prerequisite gaps that must be corrected before composition. Library can store only `partial | final` renditions and relationships to existing assets, so upload-origin target/reference/supporting/mask inputs cannot be retained honestly. Studio has no authenticated fetch-stream consumer, so Creation's validated partial events cannot reach the workbench. Controller G3 authorized both corrections inside this change for planning only, with the seven public MCP tools and public `ImageArtifact.phase` frozen.

After task 1.1 made `primaryArtifactId` mandatory on browser-safe Library detail, verification exposed one frozen-baseline mismatch: the deterministic mock detail still returns the correct output rendition and relationship but omits the required primary identifier. That single source breaks mock-relay, Creation, and root typecheck. It must be corrected before task 2.1 without changing runtime product behavior or widening the public contract.

Integration owns the final shared-schema correction, exact PD-005 Library/Studio seams, root workspace/dependency/CI changes, new Integration package, plugin manifest/Skill, packaging, installation, acceptance, and release workflow. Creation provider/executor internals, unrelated Library/Studio behavior, Foundation security/provider policy, and all other frozen requirements remain read-only.

The default provider assumption remains one explicitly configured generation endpoint and one API key. Image input, multiple images, Edits, Responses, streaming, variants, controls, and transparency remain scoped `unknown | supported | unsupported | degraded`; endpoint strings never prove capability. No real credential, billable request, installation replacement, deployment, publication, marketplace change, migration, deletion, or release is authorized by this planning change.

## Goals / Non-Goals

**Goals:**

- Complete PD-005 source-rendition and Studio streaming gates before any cross-lane composition.
- Restore the deterministic mock baseline to the frozen Library detail contract before Integration package verification.
- Implement one production `LocalRoutegoService` that composes Library-owned settings/resources with Creation-owned execution and preserves truthful public and browser-safe results.
- Materialize, validate, optionally post-process, persist, copy, and project outputs without overwrite, orphan files, fabricated relationships, or hidden billing risk.
- Expose exactly the seven frozen MCP tools and a thin Routego Image Skill from a long-running, relocatable plugin runtime.
- Serve Studio and protected API/upload/resource/stream routes on loopback with bounded short-lived sessions, exact origins, redacted diagnostics, and complete shutdown.
- Produce a reproducible self-contained Routego Image 1.0.0 plugin artifact that runs on Node.js 20.19+ without target-machine workspace installation or native compilation.
- Verify the plugin offline on Windows, Ubuntu, and macOS, then define separate explicit user-approval gates for real relay acceptance and release/replacement.

**Non-Goals:**

- Adding, removing, or renaming an MCP tool; changing public tool schemas or adding `source` to public `ImageArtifact.phase`.
- Rewriting Creation routing, request/response parsing, retry, batch, MCP, or HTTP business behavior.
- Changing Library or Studio outside the exact PD-005 files enumerated by tasks.
- Guessing provider endpoints, silently probing billable capabilities, changing unsupported evidence rules, or fabricating edit/stream/transparency success.
- Migrating or deleting legacy configuration, images, plugin source, or marketplace entries.
- Executing real-relay, install-replacement, deployment, publication, or release tasks before their explicit external approvals.

## Decisions

### 1. Treat prerequisite corrections as blocking gates inside the Integration change

Tasks are ordered `contracts -> Library source/ZIP -> Studio retry -> deterministic mock primary repair -> Studio stream -> Integration composition -> runtime -> packaging`. No Integration package verification, composition, manifest, packaging, or smoke task may pass while its preceding corrective gate is incomplete. The apply owner remains this Integration thread; no second top-level change or concurrent Library/Studio owner is introduced.

The deterministic mock repair is intentionally separate task 1.5. It may only set `primaryArtifactId` to the output identity already represented by `seed.artifactId` and assert that the returned detail remains valid under `getAssetDetailResultSchema`. It may not create another artifact, change primary-selection rules, alter public schemas/tools, or revise mock product behavior. Task 2.1 depends on this repair so its required mock-relay, Creation, and root typechecks start from a valid frozen baseline.

Alternative considered: implement partial workarounds only inside Integration. Rejected because transient upload inputs would disappear from durable detail/retry, and a server-only SSE route would remain unused by Studio.

### 2. Add a Library-only `source` rendition phase while freezing public image artifacts

`packages/contracts/src/library.ts` will define a Library-specific rendition phase `source | partial | final`. Public `imageArtifactPhaseSchema` remains `partial | final`. Library detail may contain at most 33 renditions: 16 target/reference/supporting inputs, one mask, four final outputs, and twelve partial outputs.

One operation asset ID is allocated before ingestion. Upload-origin inputs are materialized as `source` renditions on that asset; existing Library inputs retain their original asset/artifact ownership. Relationships identify the exact related asset and artifact. A source rendition can never be primary. A succeeded asset must have a final output; partial assets select an output rendition, never a source. MIME matching against the effective output format applies only to partial/final renditions, so PNG masks and JPEG/WebP references may coexist with a PNG/JPEG/WebP output.

Alternative considered: create fake generated assets for uploads. Rejected because it fabricates prompt, model, and execution facts. Alternative considered: store upload IDs in durable relationships. Rejected because uploads expire and are not durable resource identities.

### 3. Preserve source renditions through one versioned ZIP graph

The existing portability manifest will include rendition phase and preserve source artifacts, exact relationships, checksums, IDs, Unicode names, and collision remapping. Manifest and per-asset rendition limits are raised only to the PD-005 bound of 33; existing archive byte, entry, expansion, CRC, SHA, MIME, path, symlink, and atomicity limits remain. Import must reject a source primary, an output relationship pointing to the wrong artifact owner, or a succeeded asset without a final output.

Alternative considered: omit sources from exports. Rejected because imported assets would lose comparison/retry fidelity and no longer represent the exported operation.

### 4. Reconstruct Library retry from ordered relationship artifact IDs

Studio retry will ignore the old asset-level parameter fallback for physical inputs. It will rebuild target, references, supporting images, and mask from ordered detail relationships and exact `artifactId` locators. It requires one target for edit, at most one mask bound to slot zero, preserved ordering and labels, and artifacts whose ownership matches `relatedAssetId`. Missing, duplicated, ambiguous, or inconsistent required relationships produce a safe failure; the primary output is never substituted for a missing source.

Edit-again remains a deliberate operation using the selected output asset/artifact as the new target. Only retry reconstruction changes.

### 5. Use authenticated fetch-stream SSE rather than browser `EventSource`

The Studio gateway will add a typed streaming method implemented with `fetch`, because `EventSource` cannot attach the in-memory session header. Integration, the Studio gateway, the deterministic mock/Vite bridge, and the production HTTP host will use exactly one protected relative route: `POST /api/v1/studio/creation/stream`. Its body is the frozen Studio generate-or-edit input discriminated by `kind`; batch remains on its existing final-result route. The route requires the in-memory `x-routego-session` header and exact loopback origin and responds only as `text/event-stream; charset=utf-8`.

The only accepted event language is the frozen JSON `StudioImageOperationEvent` serialized as SSE data records. The state machine is exactly: one `started` event first; zero or more `partial` events; exactly one `completed | failed` terminal event; then EOF. `started` establishes the authoritative `requestId`; every later event must carry the same ID. Sequence numbers must be strictly increasing. EOF before terminal, a missing/duplicate/late `started`, missing/duplicate terminal, post-terminal data, `[DONE]`, comments or any other non-schema sentinel, invalid UTF-8/content type/framing/JSON/schema, request-ID drift, or a line/event/body limit breach fails closed. The parser aborts the fetch, cancels/releases its reader, and accepts no later event.

The workbench shows protected partial artifacts as they arrive. `completed` promotes the validated result. `failed` after partial output retains those artifacts and matching `receivedAnyOutput=true` and `mayHaveBilled=true`; it never offers automatic safe replay. Invalid framing/schema/sequence fails closed without rendering unvalidated data. Reader/channel cleanup is separate from resource lifetime. At registration, each ephemeral descriptor receives one immutable `expiresAt = min(registeredAt + 5 minutes, owningSession.expiresAt)`. A session with at least five minutes remaining receives the full five-minute window; a near-expiry session receives the shorter remainder. Terminal failure, disconnect, cancel, or unmount does not shorten that original expiry. Studio may revoke browser object URLs when UI references disappear, but that local cleanup does not revoke the server descriptor. A protected fetch succeeds only before both descriptor and session expiry. Descriptor/session expiry rejects later fetches, and process shutdown revokes all ephemeral resources immediately.

Failed-result projection is deliberately two-layered. The `StudioImageOperationResult` retains every schema-valid ordered partial artifact up to its bound of twelve, while the nested `StudioServiceError.partialArtifacts` independently retains only the first four as bounded error context. Building that nested error MUST NOT throw, suppress, duplicate, or replace the stream's unique schema-valid `failed` terminal; the terminal still precedes EOF and preserves truthful output and billing flags.

Alternative considered: poll final JSON. Rejected because it cannot satisfy ordered partial delivery or failure-after-partial evidence. Alternative considered: query-token EventSource. Rejected because it leaks tokens into URLs and history.

### 6. Make deterministic mock transport genuinely stream

The Studio mock handler and Vite bridge will serve `POST /api/v1/studio/creation/stream` and emit multiple SSE chunks through the production parser rather than returning one buffered fake result. Fixtures cover the valid state machine plus missing/duplicate/late started, request-ID drift, invalid or duplicate sequence, missing/duplicate terminal, `[DONE]`/non-schema sentinels, post-terminal data, invalid schema, oversize frame, EOF before terminal, disconnect, abort, a normal session that permits the full five-minute descriptor lifetime, a near-expiry session that shortens `expiresAt`, fetch immediately before exact expiry, rejection at/after descriptor or session expiry, browser object-URL revocation, and immediate shutdown revocation. Synthetic image bytes remain protected-resource responses and never enter JSON/logs.

### 7. Add one `@routego-image/integration` package as the composition owner

The new package depends on contracts, Foundation, Creation, and Library. It owns provider-context loading, model refresh/probe orchestration, stable-locator resolution, request projection, runtime staging, source/output ingestion, browser projection, transparent-output processing, local-service method delegation, sessions, HTTP host routing, MCP process lifecycle, and package-safe entrypoints.

The root workspace, TypeScript references, lockfile, export checker, safety rules, and build/test scripts will add this package. No Integration code is placed in Creation, Library, or Studio.

### 8. Build provider runtime context only from Library-owned state

For each operation, Integration reads the selected `RuntimeProviderProfile`, requires its write-only credential in memory, chooses the requested/default model, and supplies exact normalized endpoints, scoped capability records, global `fetch`, and fixed bounded deadline/retry policy to Creation. It does not cache or log the API key and never reads environment/legacy configuration implicitly.

`routego_status` composes redacted settings/capability state with actual MCP/HTTP/Studio lifecycle health. Non-billable model refresh calls only an explicitly configured models endpoint and parses bounded documented-compatible JSON shapes. A capability probe requires literal confirmation, one exact provider/model/transport/request shape, explicit configured endpoint, deterministic synthetic PNG inputs when required, and at most the authorized billable request. Probe execution uses ephemeral authorization evidence only for the selected shape; success/protocol rejection/degradation/transient failure is persisted through Library's existing evidence rules.

Alternative considered: let Creation load configuration or mutate capability evidence. Rejected because it violates frozen ownership and duplicates the secret/data source.

### 9. Resolve inputs, then commit sources and outputs as one operation graph

Studio locators resolve only through `RoutegoLibraryService.resolveImageResource`. Integration preserves ordered locator/role/label metadata and constructs a path-based `ImageOperationRequest` for Creation. For upload inputs, it preallocates source artifact IDs and the operation asset ID. Creation never sees or resolves browser locators.

Creation output data URLs are decoded into an Integration-owned per-request transaction directory, revalidated for MIME, size, dimensions, and SHA, and never logged. When `saveToLibrary=true`, Integration ingests source, partial, and final renditions plus exact relationships in one Library transaction, then resolves/registers protected resources. Existing Library inputs remain relationships to their original assets. When Studio does not save, final/partial resources remain in a bounded Integration ephemeral registry until the immutable descriptor expiry computed as `min(registeredAt + 5 minutes, owningSession.expiresAt)` and are not added to the Library. Stream termination and browser object-URL revocation do not revoke the server resource before that expiry; process shutdown does. A public operation with `saveToLibrary=false` must provide an approved output directory; otherwise it fails before provider submission so an unindexed durable file is not silently invented.

Public results receive absolute non-overwriting paths and final display data. If a project/output copy is requested after Library ingestion, Library's existing exclusive copy API is used. Failed materialization or ingestion preserves honest partial/billing state and cleans only transaction-owned temporary files.

### 10. Use a pinned pure-JavaScript PNG codec for chromakey and probes

Integration adds `pngjs@7.0.0` and `@types/pngjs@6.0.5`, both MIT and free of native compilation. It generates deterministic synthetic probe inputs and implements bounded PNG chromakey processing. `native` is used only with supported native transparency. `chromakey` adds a recorded effective key-background instruction and removes only the configured key range. `auto` may select chromakey only for a simple subject request; complex hair, fur, glass, smoke, liquid, or uncertain edges require explicit user/model confirmation and otherwise fail or return a non-transparent result with a structured warning.

Chromakey never creates a second rendition or a new relationship role. Each provider output is assigned its existing output artifact identity before processing. Provider-original bytes remain only in the request transaction while the processed PNG is decoded, encoded, and revalidated. On success, the processed bytes replace the transaction payload atomically and are the sole persisted/projected bytes for that output identity; effective/degraded chromakey parameters and warnings record the transformation. On processing failure, the validated provider original is persisted/projected under that same output identity with a structured post-processing failure and no transparent-success claim. The transaction copy is then cleaned. The worst-case durable graph therefore remains exactly 17 source inputs + 12 partial outputs + 4 final outputs = 33, with only the frozen `source | target | reference | supporting | mask | output` relationship roles.

Alternative considered: Sharp or another native codec. Rejected by the self-contained cross-platform runtime constraint. Alternative considered: implement a broad image codec internally. Rejected as unnecessary and higher security risk.

### 11. Host Studio with a small Integration-owned loopback server

Integration will use Creation's validated JSON dispatcher and event serializer, but own the Node HTTP host so it can distinguish bootstrap/static routes from protected API routes. It binds only `127.0.0.1` or `::1`.

- `GET /?token=...` validates one short-lived launch token and returns no-store HTML; the browser removes the token immediately.
- Hashed Studio JS/CSS assets are read-only public loopback assets with strict MIME, size, containment, ETag, and no directory listing.
- JSON, upload, browser-resource, ZIP-resource, and the exact `POST /api/v1/studio/creation/stream` route require an active session header and exact loopback origin; cookies and wildcard CORS are rejected.
- Multiple bounded active sessions may share one listener. `routego_open_studio` reuses the listener when requested, issues a fresh token without invalidating other unexpired sessions, and returns the exact expiry.
- Upload routes compare reservation ID, purpose, expiry, MIME, declared/actual bytes, and content length before/during `stageUpload`. Resource routes resolve through Library or the Integration ephemeral registry and revalidate MIME/size/ETag before streaming.

Readers, fetch bodies, event channels, and operation abort controllers close on terminal, disconnect, cancel, invalid input, or shutdown. Validated ephemeral image resources have an independent immutable expiry no later than the earlier of registration plus five minutes or owning-session expiry; they are not revoked merely because the stream closes or Studio revokes a browser object URL. Server resources are removed only on descriptor/session expiry or process shutdown. Sessions, listeners, transaction-owned temporary files, and all remaining resources close on their own expiry or shutdown boundaries.

HTTP response backpressure is an HTTP-host lifecycle boundary, not a route-owned lease policy. Every wait after `target.write()` returns `false` races `drain` against response `close`/`error` and the request `AbortSignal`. The host owns the active response-body iterator while writing, so `writeResponse()` MUST explicitly return it from a `finally` path on normal completion, disconnect, abort, or error. This makes the producer route's `finally` run promptly and close its reader, event channel, file, or ephemeral lease exactly once; it does not buffer whole bodies, replay the request, duplicate route cleanup, or shorten immutable resource expiry.

### 12. Keep the Skill thin and the MCP surface exact

The Skill reads status, maps user intent to the existing seven tools, supplies only necessary validated fields, distinguishes variants from batch, uses current-call paths/content only, explains unavailable/degraded capability, and never asks for or prints a complete key. It does not run provider scripts or hardcode a personal plugin path.

The MCP entrypoint wraps the composed service with Creation's `RoutegoMcpServer`; exact-name tests prove no Studio operation becomes a tool. Stdout remains protocol-only and diagnostics are redacted on stderr.

### 13. Build a relocatable self-contained plugin artifact

Implementation will use `plugin-creator` for the canonical `.codex-plugin/plugin.json` and personal-marketplace/cachebuster workflow. A tracked relative launcher resolves the bundled runtime from the plugin root. The package build runs all workspace builds, bundles Integration plus workspace/runtime dependencies into Node 20 ESM, builds Studio with hashed assets, copies the Skill, manifest, notices, upstream MIT license, and runtime assets into an ignored temporary staging directory, and verifies an allowlist/denylist manifest. The artifact contains no `node_modules`, source maps with local paths, caches, reports, credentials, configuration, user images, or Library data.

Alternative considered: ship workspace packages plus `node_modules`. Rejected because target machines must not install or compile dependencies.

### 14. Separate offline apply verification, real-relay acceptance, and release

Offline apply tasks use temporary roots, synthetic fixtures, deterministic mock relay, temporary `CODEX_HOME`, and no external network. CI runs frozen install, safety, strict OpenSpec, typecheck, build, all tests, exports, browser journeys, packaging, and smoke on Windows/Ubuntu/macOS with Node.js 20.19+.

Real-relay acceptance is a later explicit user gate. It requires an approved endpoint/configuration, credential handling outside repository/logs, a cost warning and per-request approval matrix, synthetic acceptance inputs, and text/two-reference/direct-edit/mask/partial-batch/transparency tests. It verifies Codex and Studio see the same new Library records and records only redacted evidence.

Release execution is a separate explicit gate after real-relay acceptance. The offline release/rollback scripts, checklist, and dry-run tests may be prepared after the offline acceptance harness is complete, without credentials or external changes. Actual cachebuster/reinstall, staged replacement, fresh-task verification, or rollback against the installed plugin still requires both completed real-relay acceptance and a fresh explicit release approval. Legacy config/images remain untouched and old plugin source is archived, not deleted.

## Risks / Trade-offs

- [Risk] Source renditions increase asset and ZIP graph complexity. → Mitigation: one Library-only phase, exact 33 bound, output-only primary rules, ownership validation, atomic ingestion, and adversarial round-trip tests.
- [Risk] A streamed partial resource intentionally outlives a failed or disconnected stream but cannot outlive its owning session. → Mitigation: immutable `min(registration + 5 minutes, session expiry)` descriptors, session/origin-protected fetch, independent reader/channel and browser object-URL cleanup, immediate shutdown revocation, and normal-session/near-expiry/exact-boundary/disconnect/cancel regression tests.
- [Risk] Provider probing can generate charges or misleading evidence. → Mitigation: literal confirmation, exact shape/endpoint, one authorized request, ephemeral probe evidence, persisted four-state rules, and no automatic probing.
- [Risk] Chromakey can damage complex edges or obscure the provider original. → Mitigation: restrict it to PNG/simple subjects, retain original bytes transaction-locally until processed validation succeeds, fall back to that original under the same output identity on processing failure, record degradation/warnings, and require confirmation for complex transparency.
- [Risk] One process owns MCP, HTTP, files, and streams. → Mitigation: isolate lifecycle managers, inject clocks/IDs/fetch, bound every queue/resource, and test repeated start/reuse/stop and signal cleanup.
- [Risk] Bundling can hide undeclared/native dependencies or licenses. → Mitigation: exact lockfile, production dependency audit, package content allowlist, license/notice generation, clean-room smoke, and three-platform CI.
- [Risk] Real relay dialects remain unknown until paid acceptance. → Mitigation: keep evidence unknown, use frozen offline fixtures, require user approval, and do not claim release readiness before the real matrix passes.

## Migration Plan

1. Complete and verify PD-005 contracts, Library ingestion/detail/ZIP behavior, Studio retry, the deterministic mock primary-artifact baseline repair, and Studio streaming in isolated commits before composition.
2. Add the Integration package and offline production composition/runtime tests without reading real user state.
3. Add Skill, canonical manifest, self-contained packaging, temporary-`CODEX_HOME` installation, and fresh-task smoke verification.
4. Add and pass Windows/Ubuntu/macOS Node.js 20.19+ CI and the final offline conformance gate.
5. Prepare and dry-run the real-relay harness and release/rollback workflow entirely offline, then stop for explicit user approval and credentials/cost acknowledgement before real-relay execution.
6. After real-relay acceptance, stop again for explicit install/release/marketplace approval. Stage and hash the 1.0.0 artifact, archive the old plugin source, perform atomic replacement, verify in a fresh task, and restore the backup automatically on failure.
7. Sync and archive the Integration specs only after all approved tasks, including external gates, are actually complete. Rollback uses `git revert` for repository changes and the staged plugin backup for installation changes; no legacy data is migrated or deleted.

## Open Questions

None for planning. Real endpoint details, credential entry, acceptable billable budget, final installation replacement, marketplace action, deployment/publication, and release timing are explicit execution approvals that remain unresolved until the user authorizes each gate.
