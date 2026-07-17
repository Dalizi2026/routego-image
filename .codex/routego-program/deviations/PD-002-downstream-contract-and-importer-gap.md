# PD-002：Downstream contract and workspace importer gap

- Status: accepted; corrective change dispatching
- Affected changes: `add-routego-image-creation`, `add-routego-image-library`, `add-routego-studio`
- Corrective change: `extend-routego-image-foundation-contracts`
- Reported before: proposal freeze or product implementation

## Finding

Independent Studio and Library startup audits confirmed that the archived Foundation baseline does not yet expose enough browser-safe shared contracts to implement the approved settings and library experiences, and does not provide downstream workspace package importers or the Studio React/Vite dependency baseline.

The missing shared boundary includes:

- provider profile read/upsert/remove/select-active operations with write-only secret replacement semantics;
- non-billable model refresh versus explicitly confirmed billable capability probes;
- library folder listing and ordering, asset detail and relationship queries, and browser-safe protected image resource descriptors;
- per-item/partial results for destructive and ZIP library mutations;
- `packages/creation`, `packages/library`, and `packages/studio` workspace importers, plus explicit React/ReactDOM/Vite dependencies for Studio.

## Decision

Do not authorize Creation, Library, or Studio to modify shared contracts or the root lockfile independently. Dispatch a fresh Foundation Extension top-level task and OpenSpec change that owns the shared contract, deterministic mock, package importer, and root dependency correction as one integration gate.

The seven public MCP tools remain unchanged. Studio-only settings, detail, and protected resource operations may be modeled as browser-safe local HTTP/Studio service subinterfaces sharing the same contract package.

## Downstream gate

Creation, Library, and Studio may preserve clearly non-frozen proposal drafts, but they must not freeze planning artifacts, apply tasks, install dependencies, or write product code until the corrective change is merged and a structured dependency-complete message supplies the new baseline commit.

## Required verification

- Strict OpenSpec validation for the corrective change and all main specs.
- Frozen clean installation with all three downstream importers.
- Browser-safe contract package build with no Node built-in imports.
- Deterministic mock tests without credentials, user images, or local data.
- Root safety, typecheck, build, test, package export, and Git cleanliness checks.
