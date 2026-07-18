## Why

Routego Image 1.0 needs a complete local visual workspace so users can generate, edit, organize, compare, and configure image workflows without relying on command-line parameters. The Foundation Browser Boundary now provides the final path-free Studio contracts and deterministic mock service required to build that interface safely and independently.

## What Changes

- Build a production React/Vite Routego Studio with a distinctive darkroom workspace, Chinese/English interface, keyboard-accessible navigation, responsive desktop/tablet/mobile layouts, and complete loading, empty, success, partial, failure, and capability-unavailable states.
- Build the generation/editing workbench with prompt and output controls, path-free reference/target/supporting-image uploads, ordered batch tasks, result inspection, retry/edit handoff, and explicit capability gating. Unconfirmed image-input, edit, mask, or Responses features show “当前中转未确认支持” and cannot fabricate success.
- Build a full-screen mask editor with zoom, pan, brush, eraser, undo/redo, brush-size control, overlay preview, target-slot-zero binding, and PNG upload submission through the frozen upload lifecycle.
- Build the Library experience with path-free search, waterfall gallery, filtering/sorting/pagination, folders, multi-folder assignment, batch selection, trash/restore/permanent-delete confirmation, ZIP import/export, detail inspection, source/result comparison, download, retry, and edit handoff.
- Build the settings experience for provider profiles, write-only API-key replacement/clear semantics, active provider selection, non-billable model refresh, explicitly confirmed billable capability probes, generation defaults, and redacted output-directory updates.
- Add a browser-side contract-validating service client and a development/Playwright bridge backed by the deterministic `MockRoutegoService`; binary fixtures remain synthetic and are never logged or stored as user data.
- Add Vitest coverage for Studio-owned pure interaction logic and Playwright journeys for creation, upload, mask editing, Library/folders/trash/batch workflows, settings, capability-unavailable behavior, errors/partial results, localization, and responsive layouts.
- Do not implement provider transport, real upload or Library persistence, real HTTP/session/origin enforcement, MCP tools, plugin manifest/packaging/release, or any shared contract/root dependency change.

## Capabilities

### New Capabilities

- `studio-application-shell`: Local Studio bootstrapping, navigation, localization, responsive layout, accessibility, session-token handling, service health, and global UI states.
- `studio-creation-workbench`: Path-free generation, editing, uploads, batch controls, capability gating, results, partial failures, retry, and edit continuation workflows.
- `studio-mask-editor`: Full-screen target-bound mask creation with zoom, pan, brush, eraser, history, brush sizing, and overlay preview.
- `studio-library-experience`: Gallery search, folders, detail and comparison, multi-selection, trash, mutation preflight/execution, ZIP flows, download, retry, and edit handoff.
- `studio-settings-experience`: Provider profile management, secret-safe updates, model refresh, confirmed capability probes, defaults, and output-directory settings.

### Modified Capabilities

None. This change consumes the frozen Foundation and Browser Boundary contracts without changing their requirements.

## Impact

- Affected code: `packages/studio/**` and Studio-owned `tests/browser/**` only.
- Consumed interfaces: frozen `LocalRoutegoService`, Studio operation definitions, upload lifecycle, path-free creation/results/events, path-free Library search/detail/resources/mutations, settings, provider capability records, and deterministic mock service.
- Dependency impact: uses the already locked React, ReactDOM, Vite, React Vite plugin, TypeScript, Vitest, and Playwright baseline; no dependency or lockfile changes.
- Integration impact: Integration later supplies the real local HTTP/session/resource implementation behind the same client interface. Creation and Library retain provider execution and persistence ownership respectively.
- Security impact: browser flows use only asset/artifact/upload IDs and protected relative resources; no arbitrary local image paths, provider credentials, Base64, user images, or complete secrets enter logs, fixtures, or repository files.
