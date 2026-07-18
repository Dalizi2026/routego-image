# PD-009: Task 4.2 proven common-root terminal projection fix

Status: accepted by Controller G6; Integration implementation paused pending owner-only OpenSpec update

Date: 2026-07-19

## Finding

Completed task 3.5 permits a `StudioImageOperationResult` to retain up to 12 partial artifacts, but `studioError()` in `packages/integration/src/composition/service.ts` passes that complete list into `studioServiceErrorSchema`, whose nested `partialArtifacts` maximum is 4. A fifth-or-later partial followed by provider failure, cancellation, materialization failure, or another catch path therefore throws while projecting the error. The producer closes without emitting the required `failed` terminal event, and task 4.2 correctly observes EOF before terminal.

Evidence:

- `packages/integration/src/composition/service.ts` lines 422-447 and 1244-1254
- `packages/contracts/src/studio-creation.ts`: nested service error maximum 4; result partial maximum 12
- `packages/integration/src/composition/results.ts` lines 1145-1163 already use the correct independent `slice(0, 4)` projection

## Decision

The deviation is accepted as a proven task-3.5 common-root defect. A route-layer synthetic terminal is forbidden because it would duplicate producer business/error projection and hide the source failure.

Integration G5 remains the sole apply-owner. Before any implementation edit, G5 must update only the existing OpenSpec artifacts needed to make the plan coherent:

1. `design.md`: state that a failed Studio result may preserve all schema-valid result partials up to 12 while each nested `StudioServiceError.partialArtifacts` projection is independently bounded to the first 4, and projection must not prevent the unique terminal event.
2. `specs/integrated-local-routego-service/spec.md`: add a focused scenario for 5-12 partials followed by failure or cancellation, requiring one schema-valid failed terminal before EOF, all result partials retained, nested error partials bounded to 4, truthful output/billing flags, and no leakage.
3. `tasks.md`: extend task 4.2 with a proven common-root corrective phase limited to `packages/integration/src/composition/service.ts` and `packages/integration/test/service.test.ts`, followed by the original exact four-file task 4.2 phase.

The proposal and all other delta specs retain their current intent and require no edit.

## Implementation sequence

1. G5 commits the owner-only OpenSpec update and reports it to Controller G6 with read-back. No product file may be edited before acceptance.
2. After Controller acceptance, G5 creates one corrective implementation commit containing exactly:
   - `packages/integration/src/composition/service.ts`
   - `packages/integration/test/service.test.ts`
3. The correction must bound only the nested error projection to `partialArtifacts.slice(0, 4)`. The containing `StudioImageOperationResult.partialArtifacts` must retain the complete schema-valid list up to 12.
4. Focused regressions must cover 5-12 partials followed by failure and cancellation, exactly one failed terminal before EOF, complete result partial preservation, nested error maximum 4, truthful flags, no extra events, and no path/credential/image-byte leakage.
5. Run focused task 3.5 and 4.2 tests plus full Integration typecheck/tests/build. Report the corrective checkpoint and wait for Controller acceptance.
6. Only then continue the original task 4.2 implementation in its exact four runtime/test files.

## Boundaries

- No public contract change: the seven MCP tools and public `ImageArtifact.phase=partial|final` remain frozen.
- No Contracts, Studio, Creation, Library, lifecycle, static, session, manifest, dependency, or later-task edit is authorized.
- No real credentials, Authorization values, user images, Library/relay data, network, billable requests, installation, marketplace, deployment, publishing, migration, deletion, or release.
