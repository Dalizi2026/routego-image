## Why

Routego Image 1.0 needs a frozen, portable foundation before the Creation, Library, and Studio lanes can develop in parallel without duplicating contracts or assuming unsupported relay APIs. This change establishes that shared baseline while preserving the user's verified single-endpoint image workflow and preventing secrets or user content from entering the repository.

## What Changes

- Establish a pnpm/TypeScript strict monorepo that targets Node.js 20.19+ and uses pure-JavaScript build and test tooling.
- Introduce browser-safe Zod schemas and inferred TypeScript types for shared image requests, results, provider capabilities, transport-neutral errors, and service health.
- Define the three provider tiers and four-state capability model, with an exact configured generation endpoint as the default and an explicitly selected `legacy-api-base` normalization mode for the old `/v1/images/generations` behavior.
- Define transport-neutral application boundaries shared by future STDIO MCP and loopback HTTP adapters, plus a deterministic mock relay for contract development.
- Establish security rules for secret redaction, safe diagnostics, loopback-only HTTP exposure, session-token validation, CORS/CSRF rejection, non-destructive file handling, and image URL downloads that do not forward provider authorization by default.
- Establish Vitest contract/security fixtures and Playwright-ready browser testing configuration for downstream lanes.
- Record upstream reuse baseline `a10477581b3d43ac98d39777e4445625a9db113d`, its MIT attribution, and the evidence-backed legacy compatibility checklist without modifying or migrating the existing plugin.
- Add root dependency and workspace configuration required by all later lanes.

### Non-goals

- No real provider calls, paid capability probes, production retry orchestration, image persistence, library management, Studio pages, plugin packaging, marketplace updates, or deployment.
- No assumption or derivation that `/images/edits`, `/responses`, `/models`, or any other endpoint exists.
- No migration, deletion, or modification of the legacy configuration, image library, or `C:\Users\MLTZ\plugins\routego-image` source tree.

## Capabilities

### New Capabilities

- `workspace-foundation`: Portable pnpm/TypeScript workspace, package boundaries, build targets, and shared development commands.
- `shared-image-contracts`: Runtime-validated and browser-safe request, result, error, health, and service-boundary contracts shared by MCP, HTTP, and Studio.
- `provider-capability-model`: Provider tiers, four-state capabilities, evidence rules, safe routing decisions, and legacy single-endpoint compatibility.
- `local-service-boundaries`: Transport-neutral service interfaces, loopback HTTP/MCP boundary contracts, and deterministic mock relay behavior.
- `foundation-security`: Secret redaction, safe diagnostics, local session and origin protections, non-destructive path rules, and repository safety checks.
- `foundation-verification`: Contract, mock relay, security, portability, provenance, and downstream test-harness requirements.

### Modified Capabilities

None. The repository has no existing main capability specs.

## Impact

- Adds root pnpm, TypeScript, Vitest, and Playwright-ready configuration and the initial package structure.
- Adds public shared package exports that downstream Creation, Library, Studio, MCP, and HTTP code must consume instead of copying types.
- Adds mock relay and boundary fixtures used by downstream implementation and browser tests.
- Adds development documentation for provider compatibility, upstream provenance, third-party notices, and legacy behavior preservation.
- Freezes the initial cross-lane contract surface; future requirement changes must update OpenSpec before implementation.
