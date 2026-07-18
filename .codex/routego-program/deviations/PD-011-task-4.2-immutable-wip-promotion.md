# PD-011: Task 4.2 immutable WIP promotion

Status: accepted by Controller G6; option A selected; existing exact four-file commit promoted after post-host verification

Date: 2026-07-19

## Finding

Task 4.2 Phase B was preserved before PD-010 as non-completion WIP commit `60df6b9a6fdb7587171b893e2a658d25ade17bdd`, with parent `12e84ae7600ef6d12a03b0cc5a8a25bbe3b2ec7d` and exactly four files:

- `packages/integration/src/runtime/routes.ts`
- `packages/integration/src/runtime/stream-route.ts`
- `packages/integration/test/routes.test.ts`
- `packages/integration/test/stream-route.test.ts`

The WIP was not accepted because its real-host backpressure regression exposed the task-4.1 common-root defect repaired by PD-010. After the accepted host correction `3e04958f145f2207cc6bdf369af6198eedfb71b2`, the preserved four Phase B blobs require no further content change. The exact four-file diff from `60df6b9a6fdb7587171b893e2a658d25ade17bdd` through safe checkpoint `c879e78cb1a5f73ca4f0800146105b5107c29dc0` is empty, and the complete post-host verification now passes.

Git cannot truthfully create a new non-empty exact-four-file implementation commit when none of those files changed. An empty commit would have zero-file scope. Artificial edits, revert/reapply, or history rewriting would create meaningless evidence and violate repository rules.

## Decision

Option A is selected. The existing immutable exact-four-file commit `60df6b9a6fdb7587171b893e2a658d25ade17bdd` is promoted from non-completion WIP to the task 4.2 Phase B implementation commit based on the accepted PD-010 host correction and the new post-host verification.

Promotion changes governance status only. It does not alter the commit, its tree, its parent, product behavior, OpenSpec requirements, public contracts, or history. No empty promotion commit is authorized.

The promotion is truthful because:

1. `60df6b9a6fdb7587171b893e2a658d25ade17bdd` already is a separate commit with the exact four-file Phase B scope.
2. Its initial non-completion status was caused solely by the proven external common-root host defect, not by a known defect in the four Phase B blobs.
3. The host correction is separately committed and accepted.
4. The current product tree contains the same four Phase B blobs.
5. Focused and full post-host verification passes, including the formerly failing real-host regression.

## Accepted evidence

- Focused routes/stream/http-host: 32/32 passed.
- Integration typecheck, 181/181 tests, and build passed.
- Studio gateway/SSE/mock bridge: 39/39 passed.
- Root typecheck, build, 747/747 tests, and seven-package exports passed.
- Strict OpenSpec: 19/19 passed.
- Repository safety: 453 tracked files passed.
- `git diff --check` and exact four-file scope passed.
- A transient Library test timeout occurred only under three concurrently launched heavyweight root gates; the isolated file passed 13/13 and the full root suite rerun alone passed 747/747. No product defect or edit resulted.

## Sequence

1. Integration G5 incorporates the PD-011 governance commit at its clean compaction-3 safe checkpoint.
2. The validator and topology checks must pass with task 4.2 still unchecked.
3. After Controller accepts incorporation, G5 may update only task 4.2 state in `tasks.md`, recording `60df6b9a6fdb7587171b893e2a658d25ade17bdd` as the Phase B implementation commit and the accepted PD-010 host correction reference.
4. The separate task-state commit and lane checkpoint remain required before task 4.3 can be considered.

## Boundaries

- No artificial product/test edit, empty commit, revert/reapply, reset, destructive checkout, or history rewrite.
- No further host, route, OpenSpec planning, other-lane, task 4.3+, or external-state work before the applicable Controller gate.
- The seven MCP tools and public `ImageArtifact.phase=partial|final` remain frozen.
- No credentials, Authorization values, user images, real Library/relay, network or billable requests/probes, installation, marketplace, deployment, publishing, migration, deletion, or release.
