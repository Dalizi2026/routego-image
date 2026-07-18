# Routego Image Integration Generation 3 Handoff

## Handoff identity

- lane: `integration`
- change: `integrate-routego-image-plugin`
- source generation: `2`
- source task/thread: `019f743d-a9e1-7752-b797-c0af436183ab`
- source worktree: `C:\Users\MLTZ\.codex\worktrees\83b9\生图插件`
- source branch: `codex/routego-integration-g2`
- clean accepted source HEAD: `d974cb0d16b7e14ca0766392c7d52356b4967d3c`
- source Git state before handoff preparation: clean
- current Controller: generation 4, task/thread `019f73d0-1bf4-73c2-8ca9-e28370d34595`
- Controller task-3.1 acceptance governance commit: `01186e733b7ec6f63785ddd4e9b6aa1128f03462`
- planned successor generation: `3`
- planned successor branch: `codex/routego-integration-g3`
- successorThreadId: `pending`
- successorWorktree: `pending`

## Accepted OpenSpec state and task 3.1 correction chain

- OpenSpec progress: `11/29`
- completed tasks: `1.1`, `1.2`, `1.3`, `1.4`, `1.5`, `2.1`, `2.2`, `2.3`, `2.4`, `2.5`, `3.1`
- task 3.1 original implementation: `d952c533be007ea54a6f836ea0e8bcfb6f9be510`
- task 3.1 original task-state: `30f0b101e4f01f51a0d41b5c5ab0242b63619f70`
- task 3.1 original thread-state: `5963a2a2c4fc18b7d0a0b2c219d336efb9b0c36f`
- exact capability request/response proof implementation: `69fbc5b1c2c3ccecdf853971f4c86c84383f5362`
- exact-proof task-state: `c6b68f3e59d2a6ec977d7ec0605728bbdc2770e1`
- exact-proof thread-state: `2020b6e012242132f2214097d32ca4b9ff45d003`
- PNG IHDR/dimension/pixel/RGBA pre-decode bound implementation: `0e3764d92e47cb1df31d07a5ff7c0821ae709b3b`
- PNG-bound task-state: `c24ca544eb2c57cd0d19e1bf708c8a16dcb11e4e`
- PNG-bound thread-state: `627a7078863abc36a0962277f737ed90bf44cb69`
- 8-bit non-interlaced decoder-profile implementation: `f7196e3f77a7aaed59e9ea4390e4655066b3e584`
- decoder-profile task-state: `9e8ec8463196e5f34b07b4372ed61787ffa44c39`
- final accepted thread-state/HEAD: `d974cb0d16b7e14ca0766392c7d52356b4967d3c`
- accepted result: every allowed capability probe materially exercises and conclusively proves its exact provider/model/capability/transport/request-shape pair; unprovable pairs fail closed before network or persistence. Provider-controlled PNG proof data is bounded before `PNG.sync.read`, accepts only the bounded 8-bit non-interlaced decoder profile, and cannot use oversized dimensions, 16-bit intermediate allocation, or interlaced unbounded inflate paths.
- verification accepted by Controller: Integration tests `72/72`; Integration typecheck; dependency-order build; repository safety `405`; strict OpenSpec `19/19`; diff, ancestry, exact two-file correction scope, and Git-clean checks passed; `externalStateTouched=false`.

## Next task authority summary: 3.2 remains locked

Task `3.2` depends on task `3.1`. This summary is only for successor handoff; it is not implementation activation.

- allowed files:
  - `packages/integration/src/image/materialize.ts`
  - `packages/integration/src/image/chromakey.ts`
  - `packages/integration/src/runtime/ephemeral-resources.ts`
  - `packages/integration/test/image.test.ts`
- required behavior: implement bounded output data-URL materialization, metadata/hash validation, exclusive request staging, session-owned ephemeral browser resources expiring at `min(registration + 5 minutes, owning session expiry)`, and PNG chromakey that keeps provider-original bytes only transaction-locally, atomically uses processed bytes under the existing output identity on success, and falls back to the validated original under that same identity on processing failure without transparent success, a second rendition, or a new relationship role.
- verification: fresh apply instructions; Integration typecheck/tests/build; PNG/JPEG/WebP decode, claims and limits; multi-output partial preservation; transaction cleanup and exclusive collisions; normal full-five-minute and near-expiry descriptors; immutable expiry and ETag; fetch immediately before expiry and rejection at/after descriptor or session expiry; immediate shutdown revocation; chromakey alpha with one artifact identity and one persisted byte stream; exact `17+12+4=33` worst-case bound; complex-content refusal; processing-failure original fallback without transparent success; synthetic-only/no-native audit; repository safety; `git diff --check`; exact four-file scope.
- forbidden: Library persistence, service composition, HTTP host, Creation response-parser edits, native dependencies, real images, any non-frozen relationship role, or any task after 3.2.

## Successor and Controller ordering

Generation 2 is frozen after the handoff-preparation commit and must not inspect task 3.2 for implementation, edit product/OpenSpec files, stage task 3.2 work, or create/activate generation 3.

Controller generation 5 must first accept the Controller generation-4 handoff and become the authoritative Program Controller. Only the authoritative Controller G5 may then create and register Integration generation 3. Generation 3 must start from the clean handoff commit on planned branch `codex/routego-integration-g3`, verify its real task/worktree/branch and Git state, accept this handoff through a real direct message, and wait for explicit sole-owner activation before any task 3.2 edit. Generation 2 remains the frozen sole apply owner until that governed transition completes; no second apply owner may exist.

## Context, reporting, and safety

PD-006 remains active. Generation 2 reached observable compaction 5 and may perform only this already-authorized small governance handoff before stopping.

The primary reporting path is a real direct `send_message_to_thread` to the authoritative Controller followed by `read_thread` confirmation after every task, group, checkpoint, blocker, deviation, handoff, activation, or delivery. `routego-program-continuity` is an active 15-minute missed-message fallback only, deduplicated by `integrationReadiness.lastDirectCheckpoint`; it does not replace direct reporting. Controller G5 and Integration G3 creation, registration, acceptance, and activation must repeat and explicitly acknowledge this contract. Heartbeat inheritance is never assumed.

`externalStateAuthorized=false`. No real credentials, Authorization headers, user images, real Library/relay/network, billable request or probe, installation, marketplace mutation, deployment, publication, migration, deletion, or release is authorized. The seven public MCP tools and public `ImageArtifact.phase=partial|final` remain frozen.
