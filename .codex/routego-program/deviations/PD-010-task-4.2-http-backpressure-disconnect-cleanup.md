# PD-010: Task 4.2 HTTP backpressure disconnect cleanup

Status: accepted by Controller G6; Integration Phase B WIP checkpoint preserved; owner-only OpenSpec update authorized before host correction

Date: 2026-07-19

## Finding

Task 4.2 reproduced a common-root disconnect defect in the already-completed task 4.1 loopback HTTP host. `IntegrationLoopbackHttpHost.writeResponse()` iterates a response body and, when `target.write()` applies backpressure, awaits `once(target, "drain")` without racing response close, socket abort, or the request `AbortSignal`. It also does not explicitly return the active response-body iterator when the client disconnects.

The real-host regression uses a protected 2 MiB ephemeral PNG. After the client receives the first response chunk and disconnects while the host is waiting for drain, the route body's `finally` does not run within the required cleanup boundary and the ephemeral lease remains open. The four-file route implementation cannot truthfully guarantee disconnect cancellation, reader/channel cleanup, or prompt lease closure while the host owns the stalled iterator.

Evidence:

- `packages/integration/src/runtime/http-host.ts` lines 92-100: body iteration and unbounded drain wait
- `packages/integration/src/runtime/http-host.ts` lines 310-315: request/response cleanup occurs only after `writeResponse()` returns
- `packages/integration/test/routes.test.ts`: real `IntegrationLoopbackHttpHost` large-resource disconnect regression, preserved in WIP checkpoint `60df6b9a6fdb7587171b893e2a658d25ade17bdd`
- WIP checkpoint parent: `12e84ae7600ef6d12a03b0cc5a8a25bbe3b2ec7d`

## Decision

The deviation is accepted as a proven task-4.1 common-root host defect discovered during task 4.2 Phase B. Route-local error synthesis, swallowed disconnects, shortened resource expiry, buffered whole-body responses, or duplicated lease cleanup are forbidden because they hide the owner of the stalled iterator or change immutable descriptor semantics.

Integration G5 remains the sole apply-owner. Before editing the host, G5 must update only the existing OpenSpec artifacts needed to make the plan coherent:

1. `openspec/changes/integrate-routego-image-plugin/design.md`: state that HTTP backpressure waits race drain against response close/request abort and that the host returns the active response-body iterator so producer `finally` cleanup runs promptly.
2. `openspec/changes/integrate-routego-image-plugin/specs/codex-plugin-runtime/spec.md`: add a real loopback-host scenario for a large protected resource whose client disconnects while drain is pending, requiring prompt iterator return, reader/channel and lease cleanup, no expiry shortening, no replay, and no sensitive leakage.
3. `openspec/changes/integrate-routego-image-plugin/tasks.md`: insert a separately committed and accepted task-4.1 common-root host correction limited to `packages/integration/src/runtime/http-host.ts` and `packages/integration/test/http-host.test.ts`, after the preserved Phase B WIP checkpoint and before Phase B completion resumes.

The proposal and all other delta/main specs retain their current intent and require no edit.

## Implementation sequence

1. G5 incorporates the Controller PD-010 governance commit into its clean WIP-checkpoint head and validates the handoff capsule. No product or OpenSpec conflict is allowed.
2. G5 commits the exact three-file owner-only OpenSpec update and reports it to Controller G6 with read-back. No host or route file may be edited before planning acceptance.
3. After Controller acceptance and an explicit corrective-scope governance update, G5 creates one common-root correction commit containing exactly:
   - `packages/integration/src/runtime/http-host.ts`
   - `packages/integration/test/http-host.test.ts`
4. The correction must race drain against response close and request abort/error, stop writing after disconnect, and explicitly return/close the active response-body iterator in `finally`. The route body `finally` must run and close its file/ephemeral lease promptly.
5. Focused host regression must cover a real loopback connection, a large protected streaming response, actual backpressure, client disconnect, prompt iterator/lease cleanup, stable immutable descriptor expiry, and no duplicate cleanup or leakage.
6. Run focused task 4.1/4.2 tests plus full Integration and repository verification. Report the corrective checkpoint and wait for Controller acceptance.
7. Only then resume the already-preserved four-file Phase B WIP, rerun its focused/full verification, and create the separate task 4.2 implementation commit. Task 4.2 remains unchecked until that implementation is accepted.

## Boundaries

- The WIP checkpoint is a safety checkpoint, not a completed or accepted task 4.2 implementation; its known backpressure regression is intentionally failing.
- No public contract change: the seven MCP tools and public `ImageArtifact.phase=partial|final` remain frozen.
- No session, static, lifecycle, composition, Contracts, Studio, Creation, Library, manifest, dependency, task 4.3+, or external-state edit is authorized.
- No real credentials, Authorization values, user images, real Library/relay data, network or billable requests/probes, installation, marketplace, deployment, publishing, migration, deletion, or release.
