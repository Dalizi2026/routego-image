## Context

Foundation, Foundation Extension, and Browser Boundary have frozen a browser-safe `LocalRoutegoService`, protected upload lifecycle, path-free Studio creation/search/results, settings mutations, Library detail/mutations, and a deterministic stateful `MockRoutegoService`. The Studio package currently contains only an importer scaffold. This change owns the complete React/Vite user interface and browser verification while Creation, Library, Integration, shared contracts, root configuration, and release files remain outside its ownership.

Frozen dependencies and constraints:

- Browser code uses only `assetId`, `artifactId`, `uploadResourceId`, protected relative resource URLs, and the Studio schemas exported by `@routego-image/contracts`.
- `routegoOperationNames`, the seven public MCP tools, shared schemas, `pnpm-lock.yaml`, root dependencies, Foundation, Creation, Library, mock implementation, plugin manifest, and release workflow are read-only.
- Real provider execution, upload persistence, Library persistence, HTTP/session/origin enforcement, binary streaming, SSE transport, and service composition are implemented by downstream lanes. Studio supplies a browser client and UI against the frozen boundary.
- No real key, authorization header, user image, local configuration, Library content, Base64 image JSON, or arbitrary local image path may enter repository files, tests, browser logs, or diagnostics.
- Existing approved dependencies are React 19, ReactDOM 19, Vite 8, the React Vite plugin, TypeScript, Vitest, and Playwright. No dependency change is allowed.

Exclusive file ownership:

- `packages/studio/**`
- `tests/browser/**`
- `openspec/changes/add-routego-studio/**`

## Goals / Non-Goals

**Goals:**

- Deliver a production-grade bilingual local Studio covering creation, editing, uploads, masks, batch work, Library/folders/trash, comparison, settings, capability gating, and responsive layouts.
- Validate every browser request and response with the frozen Zod contracts and keep the session token only in memory.
- Present honest queued/loading/empty/success/partial/failure/degraded/capability-unavailable states without fake provider success.
- Use the deterministic Foundation mock through a development/Playwright bridge so every major browser journey is executable without credentials, network access, user images, or persistent local data.
- Keep the UI ready for Integration to replace the mock bridge with the real loopback HTTP service without changing components or product rules.

**Non-Goals:**

- Implementing provider adapters, request routing, resource resolution, persistence, ZIP processing, deletion, HTTP security enforcement, SSE server transport, MCP tools, packaging, installation, deployment, or release.
- Changing shared contracts, root scripts/configuration, the lockfile, public MCP behavior, or another lane's source files.
- Claiming image input, edit, mask, Responses state, native transparency, or any other provider feature is supported before capability evidence says so.

## Decisions

### 1. Use an injected contract-validating Studio gateway

React features depend on a Studio-owned `StudioGateway` rather than calling `fetch` directly. `HttpStudioGateway` maps frozen public/local operation definitions to loopback requests, validates inputs before sending, validates outputs before state updates, attaches the in-memory session token, uploads binary `File`/`Blob` bodies only to reserved relative `PUT` routes, and retrieves protected resources as object URLs that are revoked after use.

The token is read once from the launch URL, retained only in React memory, and removed from the address bar with `history.replaceState`. It is never stored in local/session storage, printed, or embedded in application diagnostics. Missing or rejected sessions produce a blocking recovery screen rather than silent unauthenticated calls.

A loose unvalidated fetch layer was rejected because it could drift from shared schemas and leak path-based public results into Studio. Passing `LocalRoutegoService` directly into browser code was rejected because the real service is reached over loopback HTTP and the deterministic mock contains Node-only implementation details.

### 2. Provide a development-only Vite mock bridge

The Studio Vite configuration activates a development/test middleware only when an explicit mock environment flag is set. The middleware owns one isolated `MockRoutegoService`, dispatches the frozen operation definitions, accepts synthetic binary upload bodies without logging or persisting them, and serves fixed synthetic image/ZIP bytes for protected relative resources. Test-only reset/fixture controls are not included in the production bundle.

Playwright uses the Foundation-owned root configuration and starts the Studio Vite server from a serial test harness on the existing `127.0.0.1:4173` base URL. This avoids modifying root Playwright or dependency files and exercises the same browser client used by production components. Browser route stubs with handwritten JSON were rejected because they would duplicate contracts and bypass the required mock service.

### 3. Organize the application around one shell and feature stores

The app uses a small React context/reducer layer with separate creation, Library, settings, capability, notification, and session state slices. It does not add a state-management dependency. Each feature exposes explicit async states and aborts/replaces stale searches where appropriate.

The shell has four destinations: Workbench, Library, Trash, and Settings. Desktop uses a narrow vertical navigation rail and multi-column workspace; tablet collapses secondary panels; mobile uses a bottom navigation and full-screen drawers. Chinese is the default language with an English toggle; translations are local source dictionaries and all critical controls have accessible names.

### 4. Commit to an industrial darkroom visual system

The interface uses an intentional darkroom/contact-sheet direction: near-black ink surfaces, warm amber safelight accents, cool cyan status light, thin technical rules, serif display typography, dense but readable metadata, and subtle grain/grid atmosphere created in CSS. CSS variables define color, spacing, radii, focus rings, elevation, and motion. No external font or image dependency is added.

Motion is restrained to route reveals, progress transitions, panel/drawer movement, selection feedback, and mask-tool state. `prefers-reduced-motion`, visible keyboard focus, semantic landmarks, minimum touch targets, contrast, and responsive text wrapping are required. Generic purple gradients, decorative dashboards, and placeholder panels were rejected because they do not match an image-production workspace.

### 5. Drive workbench capability gates from evidence

Text-only generation is available when the service is configured. Reference upload, multi-image input, target editing, mask editing, Responses continuation, output controls, and native transparency are enabled only when the relevant scoped capability is `supported` or when a `degraded` route is explicitly usable. `unknown` and `unsupported` keep affected controls disabled and show “当前中转未确认支持” with an explanation. Degraded routes display their loss of semantics before submission.

The settings capability probe requires a confirmation dialog explaining potential charges. Probe results update an in-memory capability view and subsequent controls. Authentication, rate-limit, timeout, moderation, and provider failures remain transient errors and are never converted by the UI into unsupported evidence.

### 6. Implement upload and creation as explicit state machines

Each dropped file passes client-side purpose/MIME/basic-size checks, then reserve → binary PUT → finalize. Progress, failure, retry, discard, expiry, and finalized states remain visible. JSON never contains file bytes, Base64, or a local path. Removing an upload calls discard when a resource exists.

Generate/edit forms create strict path-free contract inputs. Edit always has one target, supporting/reference inputs remain ordered, mask uses literal target slot zero, and invariants must be non-empty. Batch keeps stable task IDs/order and shows per-item outcomes. Results render protected resources, effective parameters, billing/output flags, degraded continuation, failed slots, and partial artifacts. Retry and edit handoff reuse stable asset/artifact/upload locators rather than paths.

### 7. Build the mask editor as a dedicated full-screen canvas workspace

The mask editor owns pure coordinate, viewport, brush-stroke, and bounded-history helpers plus a React canvas controller. The source image is displayed through a protected resource object URL. A same-size transparent mask canvas supports brush and eraser compositing, pointer capture, zoom around the cursor, explicit pan mode, fit/reset, undo/redo, brush sizing, overlay opacity/visibility, and keyboard shortcuts.

Saving converts the mask canvas to a PNG `Blob`, uploads it with purpose `mask`, finalizes it, and returns an `uploadResourceId` bound to target slot zero. Empty-mask submission, missing target, unsupported mask capability, failed upload, and dimension/setup failures remain blocking errors. No local filter is presented as a model edit.

### 8. Keep Library operations preflighted and identifier based

The Library uses `searchStudioLibrary` for path-free gallery pages and protected thumbnails, then loads detail/resources on demand. Folder create/rename uses the frozen public manage action and refreshes folder state; ordering uses the Studio reorder operation. Multi-folder assignment and all risky mutations use the preflight/execute pair.

Permanent delete, ZIP export, and ZIP import require the exact contract confirmation. ZIP import uses the upload lifecycle before preflight. Partial outcomes remain visible per item. The detail drawer renders parameters, errors, folders, relationships, and source/target/reference/supporting/mask/output resources; source/result comparison uses an accessible draggable divider with keyboard alternatives. Retry/edit handoff populates the workbench with identifiers and never uses a filesystem path.

### 9. Keep settings secret-safe and stateful

Provider forms show only redacted endpoint/profile data, `hasApiKey`, and the preview. The existing secret is never loaded into an input. The API-key control expresses unchanged, replace, or clear; replacement uses a password input held only until submission and cleared immediately afterward. Model refresh is labeled non-billable. Capability probes are separately confirmed and report may-have-billed/evidence state.

Defaults are submitted as one complete validated object. Output-directory unchanged/default/clear/replace are distinct; replace requires explicit local-path confirmation, while the response shows only the redacted display. No secret or submitted path appears in toast text, errors, DOM diagnostics, or test snapshots.

### 10. Verify behavior at three levels

Vitest covers Studio-owned pure helpers such as capability decisions, upload state transitions, comparison bounds, mask coordinate mapping/history, and request construction. Package typecheck/build verifies strict TSX and both the library export plus Vite application output.

Playwright covers secure boot, localization, responsive navigation, capability-disabled controls, explicit probes, text generation, upload/reference generation, edit/mask flow, partial and failed results, batch order, Library filtering/detail/comparison/folders/trash/mutations/ZIP, settings/profile/default/output-directory updates, keyboard focus, and mobile layouts. Tests assert no local path, Base64, key, token, or authorization value appears in rendered text or captured requests.

## Risks / Trade-offs

- [Risk] The development middleware could be mistaken for production HTTP implementation. → Mitigation: activate it only with an explicit mock flag, keep it inside Studio development tooling, label synthetic responses, and exclude provider/persistence/session enforcement claims.
- [Risk] Protected image object URLs can leak memory. → Mitigation: centralize resource fetching and revoke every object URL on replacement/unmount.
- [Risk] A capability probe can enable controls only for the current session until real persistence is integrated. → Mitigation: show evidence/source in UI and refresh from the real status/settings service when Integration is present.
- [Risk] Canvas history can consume memory for large images. → Mitigation: bound history length, store only mask snapshots, coalesce pointer moves, and release discarded image data.
- [Risk] Mock mutations do not persist a fully mutable gallery graph. → Mitigation: browser tests verify honest returned outcomes and UI refresh behavior without claiming Library persistence, which remains Library/Integration ownership.
- [Risk] The one deliberate output-directory local-path input is sensitive. → Mitigation: render it only in the confirmed settings form, never reuse it for images, clear it after submission, and never echo it in results or logs.

## Migration Plan

1. Create and strictly validate Studio proposal, design, five capability specs, and atomic tasks.
2. Implement and commit the application shell/gateway/mock bridge before marking its task complete.
3. Implement and commit workbench, mask editor, Library, and settings features in dependency order with focused verification.
4. Add and commit Studio-owned Vitest and Playwright coverage, then run the complete repository and browser gates.
5. Send the immutable Studio delivery SHA to the generation-1 Program Controller. Integration later merges the branch and connects the real service; rollback is a normal `git revert` with no data migration.

## Open Questions

None. The final Browser Boundary, ownership, product scope, dependency set, and Controller routing are frozen. Any new shared contract, dependency, root configuration, or backend requirement is a `[PLAN_DEVIATION]` to Controller generation 1.
