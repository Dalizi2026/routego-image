# Routego Image Current Handoff

## Baseline

- Workspace: `/Users/dalizi/Documents/Routego Image 1.0/controller-g12`
- Branch: `codex/routego-controller-g12`
- Verified HEAD: `c5d4af9f9883cbd803fa42477e95dd72de38739c`
- Git: clean when this record was prepared
- OpenSpec change: `streamline-routego-image-generation`
- Progress: 22 of 33 tasks complete

## Completed Work

- Contracts 1.1-1.4, Creation/Foundation 2.1-2.4, Library 3.1-3.5, and Integration 4.1-4.5 are complete.
- Studio 5.1 simplified the generation workbench to generation-only controls.
- Studio 5.2 simplified batches to per-item prompt/size/aspect/count and fixed runtime concurrency two.
- Studio 5.3 added the Studio-only Header provider switch. Existing submitted requests retain their immutable provider/model snapshots; the switch applies only to future submissions.
- Studio 5.4 narrowed Library browsing/actions and uses only browser-safe copy-generation-information and mark routes.

## Latest Evidence

- Task 5.4 implementation: `2a3517986597854561d06636373e0fcb4b615fac`
- Task 5.4 state: `c5d4af9f9883cbd803fa42477e95dd72de38739c`
- Task 5.4 verification: Studio Library query/detail/handoff/mutation tests passed, 4 files and 13 tests; `git diff --check` passed.
- Task 5.3 implementation: `e658dfabe8dfaa1f9e92b2c7ee6b2577b415f552`
- Task 5.3 state: `7305a360a7315f5b7c5e74821fd3da5ccb61d00d`
- Task 5.2 implementation/state: `0afe30e2651f6b5674cf742266190c4957e8af8a` / `fbe5bb45c47940863431c0b644b8bff128f8bdba`

## Current Boundary

- Seven public operations remain fixed: status, generate, batch, search-library, manage-library, open-studio, and prepare-regeneration.
- Image artifact phases remain `partial` and `final`.
- No network, provider, credential, real-data, migration, install, deployment, or publishing action is authorized.
- Copy-generation-information must use only returned browser-safe clipboard text.
- Mark uses the browser-safe same-origin mark endpoint and may set, replace, or clear the current mark; failed responses must not change local state.

## Next Task

- Task 5.5 is next: remove remaining Studio mask editor, image upload/edit modes, Trash route, capability UI, edit/retry actions, dead exports/styles/tests, and inaccessible navigation.
- Do not start 5.5 until a current task capsule, ownership state, and direct-return candidate activation have been reconciled with this HEAD.

## Residual Verification

- Full Studio typecheck/build/browser coverage is reserved for Task 5.6.
- The package-level Studio test command expands preserved later-owned edit/mask/capability/mock/SSE assertions; these were not deleted or weakened by tasks 5.1-5.4.

## Governance Repair Needed

- `program.json`, `threads/controller.json`, and `threads/studio.json` still describe Task 5.3 despite Task 5.4 completion.
- Existing historical handoff files cannot be deleted until references in compact state, task capsules, and validator/history inputs are reconciled. The safe cleanup set must be computed from those references, then committed together with the current-state repair.
