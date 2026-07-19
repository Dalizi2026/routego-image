# PD-012: Task 4.3 Creation MCP public-success projection

Status: accepted by Controller G6; Integration task 4.3 WIP checkpoint preserved; owner-only OpenSpec update authorized before the Creation correction

Date: 2026-07-19

## Finding

Task 4.3 reproduced a common-root defect in Creation's existing `RoutegoMcpServer`. The server validates each service result against the frozen operation output schema, but `successToolResult()` then passes the whole validated public result through `redactDiagnostic()` before serializing the MCP text content.

That diagnostic redactor intentionally replaces every URL query with `?[REDACTED]`. A valid `routego_open_studio` result is different from a diagnostic: its public URL must contain the fresh one-time `token` query required by `routegoOpenStudioResultSchema` and by the loopback bootstrap contract. Post-validation diagnostic redaction therefore turns a valid result into an invalid, unusable result.

Evidence:

- `packages/creation/src/runtime/mcp/server.ts`: `successToolResult()` applies `redactDiagnostic(output)` after output-schema validation.
- `packages/foundation/src/security/redaction.ts` and `endpoints.ts`: diagnostic URL sanitization removes every query string.
- `packages/contracts/src/tools.ts`: `routegoOpenStudioResultSchema` requires `url.searchParams.has("token")`.
- `packages/integration/test/mcp-process.test.ts`: the task-4.3 regression rejects the projected result after `?token=synthetic-session` becomes `?[REDACTED]`.
- Independent Controller reproduction: Integration test run produced exactly one failure and 181 passes.
- Preserved non-completion task-4.3 WIP checkpoint: `4f9cce26f6608c25679cd4b3639c72b52d65b59c`, parent `3ca84ef0868cf6e6e33a32686b76cd300547224e`.

## Decision

The deviation is accepted as a Creation-owned public-success projection defect discovered during Integration task 4.3. A validated public success result is not a diagnostic log or error payload. Its schema-defined public fields, including the current-call Studio launch token and public result paths, must remain intact in structured MCP text.

This does not authorize broad redaction removal. Structured success text must still omit or replace image data URLs and bytes, while final images continue through MCP image content. Error results, caught exceptions, framing failures, logger output, Authorization values, credentials, arbitrary diagnostic URLs, and binary data remain recursively redacted.

Integration G6 remains the sole apply-owner. Before any Creation edit, G6 must update only the existing OpenSpec artifacts needed to make the plan coherent:

1. `openspec/changes/integrate-routego-image-plugin/design.md`: distinguish schema-validated public success projection from diagnostic/error redaction; preserve public fields and remove image payloads only from structured text.
2. `openspec/changes/integrate-routego-image-plugin/specs/codex-plugin-runtime/spec.md`: require a schema-valid, immediately consumable `routego_open_studio` URL with its fresh one-time token, image-data-free structured text, final MCP image content, and unchanged diagnostic/error secrecy.
3. `openspec/changes/integrate-routego-image-plugin/tasks.md`: insert a separately committed and accepted Creation common-root corrective phase limited exactly to `packages/creation/src/runtime/mcp/server.ts` and `packages/creation/test/mcp.test.ts` before task 4.3 resumes.

The proposal and all other delta/main specs retain their current intent and require no edit.

## Implementation sequence

1. G6 incorporates the Controller PD-012 governance commit into clean WIP checkpoint `4f9cce26f6608c25679cd4b3639c72b52d65b59c` and validates the capsule. No product or OpenSpec conflict is allowed.
2. G6 commits the exact three-file owner-only OpenSpec update and reports it to Controller G6 with read-back. No Creation or Integration product file may change before planning acceptance.
3. After Controller acceptance and an explicit corrective-scope governance update, G6 creates one common-root correction commit containing exactly:
   - `packages/creation/src/runtime/mcp/server.ts`
   - `packages/creation/test/mcp.test.ts`
4. The correction must serialize schema-validated public success fields without diagnostic URL/path redaction, remove image data from structured text, retain final image content, and leave all error/logger redaction unchanged.
5. Creation MCP tests must cover `routego_open_studio`, generate/edit/batch image projection, public paths, invalid outputs, thrown errors, diagnostics, credentials, Authorization values, URL queries, image data, exact seven tools, and continued serving.
6. Run Creation MCP/package verification, the task-4.3 regression, Integration typecheck/tests/build, root gates, strict OpenSpec, repository safety, diff checks, and exact scopes. Report the corrective checkpoint and wait for Controller acceptance.
7. Only then resume the preserved four-file task-4.3 WIP, complete its remaining tests and implementation, and create the separate final implementation checkpoint. Task 4.3 remains unchecked until that checkpoint is accepted.

## Boundaries

- WIP checkpoint `4f9cce26f6608c25679cd4b3639c72b52d65b59c` is preservation only, not a completed or accepted task-4.3 implementation.
- No Integration wrapper, fake URL, duplicate MCP server, token side channel, schema weakening, broad redaction removal, Studio/Contracts change, swallowed failure, or task 5.1+ work is authorized.
- No public contract change: the seven MCP tools and public `ImageArtifact.phase=partial|final` remain frozen.
- No real credentials, Authorization values, user images, real Library/relay data, network or billable requests/probes, installation, marketplace, deployment, publishing, migration, deletion, or release.
