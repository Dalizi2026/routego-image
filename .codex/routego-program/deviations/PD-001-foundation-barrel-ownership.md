# PD-001：Foundation package barrel ownership

- Status: resolved
- Change: `establish-routego-image-foundation`
- Reported branch: `codex/routego-foundation`
- Reported head: `9fb6c79`
- Affected tasks: 3.1, 3.2, 4.1, 4.2

## Finding

The implementation requires the package root barrel files `packages/foundation/src/index.ts` and `packages/mock-relay/src/index.ts`, while the original task file metadata listed only the owned provider/security/service/relay subdirectories.

## Decision

Update only the existing `tasks.md` file-scope metadata:

- 3.1 adds `packages/foundation/src/index.ts` for provider exports.
- 3.2 adds `packages/foundation/src/index.ts` for security exports.
- 4.1 adds `packages/mock-relay/src/index.ts` for service exports.
- 4.2 adds `packages/mock-relay/src/index.ts` for relay exports.

Do not add a separate export task and do not rewrite validated source commits. Proposal, design, and workspace specs already require stable package root exports, and all four tasks have the same sequential runtime-subagent owner.

## Guardrail

The barrel changes may only export the module owned by the corresponding task. Any unrelated public API change requires a new `PLAN_DEVIATION` report.

## Required verification

- `openspec validate --all --strict --no-interactive`
- `git diff --check`
- The planning correction commit modifies only `tasks.md`.
- Existing implementation commits are rechecked for barrel-only scope before tasks 3.1-4.2 are marked complete.
