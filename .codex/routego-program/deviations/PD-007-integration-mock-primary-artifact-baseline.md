# PD-007：Integration 任务 2.1 冻结 mock-relay 基线修订

- Status: accepted for OpenSpec planning revision only
- Scope: integrate-routego-image-plugin task 2.1 prerequisite gate
- Decision date: 2026-07-18

## Finding

Integration task 2.1 correctly exposes the frozen Library asset-detail contract through the existing workspace. That contract requires `primaryArtifactId`, but the deterministic `packages/mock-relay/src/service/mock-service.ts` detail fixture still emits only `renditions` and `relationships`. The unchanged fixture therefore fails `@routego-image/mock-relay` typecheck at the return boundary and propagates the same failure through Creation and the root typecheck. The current Integration implementation has not modified `packages/mock-relay`.

## Decision

Authorize a narrow planning amendment inside `integrate-routego-image-plugin`:

1. Add a separate prerequisite task `1.5` after task 1.4 and before task 2.1.
2. Task 1.5 may modify only `packages/mock-relay/src/service/mock-service.ts` and `packages/mock-relay/test/service.test.ts`.
3. The deterministic detail fixture shall set `primaryArtifactId` to its existing output rendition identity (`seed.artifactId`) and add a focused schema-valid regression assertion. No new mock behavior, public tool, public phase, or product rule is authorized.
4. Task 2.1 shall depend on `1.5` in addition to `1.1` through `1.4`.
5. Integration must revise proposal/design, the existing verification delta spec(s), and tasks coherently using `openspec-update-change`, then send `[INTEGRATION_PLAN_UPDATE_READY]` with the planning-only commit before any mock code or task-state edit. Controller review and a fresh apply-instructions read are required before task 1.5 is unlocked.

## Verification gate

Task 1.5 must run mock-relay typecheck/tests/build, Creation typecheck regression, root typecheck, repository safety, `git diff --check`, and exact two-file scope review. The existing 2.1 focused stream tests remain evidence for 2.1 but do not satisfy this prerequisite.

## Non-goals and safety

This decision does not authorize Integration 2.1 completion, task 2.2, any later task, public contract changes, real credentials, user images, real Library/relay access, billable requests, installation, marketplace changes, deployment, publication, migration, deletion, release, or any external state.
