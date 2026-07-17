# PD-003：`packages/library` safety-rule collision

- Status: resolved; minimal OpenSpec clarification authorized
- Change: `extend-routego-image-foundation-contracts`
- Task: 3.1 downstream workspace importers
- Reported branch: `codex/routego-foundation-extension`
- Reported head: `d222e0be9a12a315d6173a329eef2ab03f7b1852`

## Finding

PD-002 requires an exact workspace importer at `packages/library`, but the Foundation baseline contains two generic protections intended for local user image libraries:

- root `.gitignore` ignores every directory segment named `library`;
- `scripts/check-repository-safety.mjs` rejects every tracked path containing a `library` segment.

Those protections incorrectly classify the repository source package as user data, so task 3.1 cannot normally stage or pass safety verification.

## Decision

Authorize the Foundation Extension apply-owner to use `openspec-update-change` and make only these planning clarifications:

- add `.gitignore` and `scripts/check-repository-safety.mjs` to task 3.1 allowed files;
- document that the exception applies only to the exact repository package root `packages/library/**`;
- retain all protections for root/local libraries, nested unrelated `library` directories, generated outputs, user images, configuration, caches, and reports.

The implementation may unignore only `/packages/library/` and its contents. The safety scanner may exempt only the `library` segment at the exact `packages/library` package position; any other forbidden segment or library path remains rejected.

## Required verification

- The OpenSpec planning commit modifies only the corrective change's `design.md` and `tasks.md`.
- `git check-ignore` confirms `packages/library/package.json` is not ignored while a root or unrelated `library/` path remains ignored.
- The safety scanner accepts tracked source files under `packages/library/**` but still rejects a synthetic tracked probe under any other protected library path.
- `openspec validate --all --strict --no-interactive`, `pnpm safety`, task 3.1 full verification, `git diff --check`, and final Git cleanliness pass.

No product feature, public MCP operation, dependency set, architecture, persistence behavior, Studio UI, plugin manifest, installation, or release scope changes are authorized.
