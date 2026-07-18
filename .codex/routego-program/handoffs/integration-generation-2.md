# Routego Image Integration Generation 2 Handoff

## Handoff identity

- lane: `integration`
- change: `integrate-routego-image-plugin`
- source generation: `1`
- source task/thread: `019f737f-80f3-7cd2-a6c7-aaec1f017d8d`
- source worktree: `C:\Users\MLTZ\.codex\worktrees\5b94\生图插件`
- source branch: `codex/routego-integration-g1`
- source checkpoint: `8de8eab3d0b433440c7a29142d76f2d5117b0a84`
- source Git state: clean
- Controller: generation 4, task/thread `019f73d0-1bf4-73c2-8ca9-e28370d34595`
- Controller governance acceptance: `e7f4b5e266356a54a9dc374154cb35b2dfcd9939`
- planned successor generation: `2`
- planned successor branch: `codex/routego-integration-g2`
- successorThreadId: `pending`
- successorWorktree: `pending`

## OpenSpec and completed work

- change progress: `7/29`
- completed tasks: `1.1`, `1.2`, `1.3`, `1.4`, `1.5`, `2.1`, `2.2`
- task 2.2 corrective implementation: `acc4a4cb56ce99ed1a854a95c1286daecba3be33`
- task 2.2 corrective task-state: `63bd63543410b6794c3691d82082001f431efa39`
- task 2.2 correction accepted by Controller; original implementation `4de57379940fd4b93250d46642b56acb8b9894eb` is superseded for task-state purposes
- task 2.2 correction scope: `packages/studio/src/api/sse.ts`, `packages/studio/test/sse.test.ts`
- correction result: event accounting includes the complete raw UTF-8 CRLF delimiter while preserving LF, logical line, body, framing, schema, state, cancellation, and redaction rules
- next task: `2.3`

## Successor task activation boundary

Generation 2 must not begin implementation until Controller G4 creates and activates the new task/worktree. The only planned next task is `2.3`:

- files: `packages/studio/src/dev/mock-handler.ts`, `packages/studio/src/dev/vite-mock-bridge.ts`, `packages/studio/test/mock-bridge.test.ts`
- behavior: genuinely chunked valid and invalid `POST /api/v1/studio/creation/stream` fixtures through the production parser
- verification: fresh apply instructions; Studio typecheck/tests/build; valid started/partial/completed and started/partial/failed chunking; invalid started/request-ID/sequence/schema/terminal/post-terminal/EOF/sentinel/oversize/disconnect/abort cases; normal and near-expiry descriptor fixtures; deterministic repeat; no token/key/path/Base64/log leakage; safety; diff check; exact three-file scope
- forbidden: alternate stream routes, workbench UI/state, Foundation mock/contracts, gateway parser changes, root files, real network/images/credentials

## Context and safety

This handoff is required by PD-006 observable compaction 4: generation 1 is in pre-handoff state after completing the current atomic correction. Generation 1 must remain frozen after this handoff preparation; it must not start, edit, stage, or commit task 2.3.

No real credentials, Authorization headers, user images, real Library/relay, billable requests, installation replacement, marketplace mutation, deployment, publication, migration, deletion, or release were performed or authorized. `externalStateAuthorized=false` remains in force.

## Reporting contract inheritance

The primary completion and governance path is a real direct `send_message_to_thread` to the authoritative Controller followed by `read_thread` confirmation after every task, checkpoint, blocker, deviation, handoff, activation, or delivery. `routego-program-continuity` is only a 10-minute missed-message fallback and never replaces direct reporting. Generation 2 creation, registration, acceptance, and sole-owner activation must repeat and explicitly acknowledge this contract. Generation 1 cannot be archived and Generation 2 cannot become apply owner until that acknowledgement and activation are confirmed.
