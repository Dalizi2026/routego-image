# PD-013: Library canonical filesystem identity correction

Status: accepted for isolated Library correction planning; product correction remains locked until generation 3 completes a zero-compaction handoff and separate activation

Date: 2026-07-19

## Finding

Integration task 5.2 completed its authorized package implementation, but the required full-workspace test gate exposed eight Library failures and one derived unhandled rejection on macOS. The failures share one filesystem-identity root: temporary paths are requested under `/var/folders/...`, while `realpath()` reports the same objects under `/private/var/folders/...`.

The current Library code mixes requested path identity and canonical filesystem identity across four boundaries:

- output-directory validation walks lexical components and rejects the operating-system `/var` alias as if it were an unsafe user symlink;
- source-rendition and mutation protected-root checks compare canonical candidates with lexical protected roots, so aliases of protected legacy data can be accepted;
- public ZIP placement validates a canonical directory and returns that canonical spelling instead of the truthful requested path spelling;
- related tests do not explicitly freeze the distinction between a benign operating-system alias and an alias into protected data.

The failures are not evidence that containment, final symlink/junction rejection, ownership, protected legacy roots, exclusive publication, source validation, or ZIP integrity should be weakened.

## Decision

Create an isolated Library generation 3 correction owner from the clean task-5.2 implementation checkpoint `fbd254f07bff1bc61a8fa4c15f53e3a419af7bd9`. Integration generation 8 remains the sole owner of the Integration OpenSpec change and its package-verifier correction; Library generation 3 receives authority only over the exact Library path-identity correction files after a separate handoff acceptance and activation.

The correction shall establish one coherent rule:

1. lexical/requested paths are retained only where the public contract must truthfully return the user's selected spelling;
2. security decisions compare canonical filesystem identities, including canonical protected roots;
3. a benign platform alias may resolve to the same approved directory without being treated as a user-controlled final symlink;
4. an alias into protected legacy data, a containment escape, a final symlink/junction, unsafe ownership, or a redirected approval remains rejected;
5. ZIP bytes are written through the validated canonical directory while the returned public path preserves the requested directory spelling and the actual exclusive filename.

## Exact correction scope

Source:

- `packages/library/src/fs/paths.ts`
- `packages/library/src/config/output-directory.ts`
- `packages/library/src/service.ts`
- `packages/library/src/gallery/assets.ts`
- `packages/library/src/gallery/mutations.ts`

Tests:

- `packages/library/test/fs/paths.test.ts`
- `packages/library/test/config/output-directory.test.ts`
- `packages/library/test/conformance/service.test.ts`
- `packages/library/test/gallery/assets.test.ts`
- `packages/library/test/gallery/source-renditions.test.ts`
- `packages/library/test/gallery/mutations.test.ts`

No Foundation, Integration, OpenSpec, dependency, manifest, package, Studio, Creation, mock-relay, governance, generated artifact, or external-state file is in product authority.

## Required verification

- Add focused red regressions for a requested `/var` alias, canonical `/private/var` identity, protected-root aliases, source renditions, mutation roots, and truthful ZIP return paths before the implementation edit.
- Run every previously failing focused case, all six affected test files, the complete Library suite, Library typecheck and direct build.
- After Integration incorporates the accepted Library correction, rerun the full workspace tests and every task-5.2 packaging/security/reproducibility gate.
- Preserve exact seven public tools, public `ImageArtifact.phase=partial|final`, path-free Studio boundaries, no-overwrite ZIP behavior, symlink/junction rejection, protected legacy rejection, and no external-state access.

## Boundaries

- Task 5.2 remains unchecked and task 5.3 remains locked.
- The user-authorized workspace dependency installation may run only as `pnpm install --offline --frozen-lockfile`; it must reuse the local store, download zero packages and stop if anything is missing. Network, marketplace, target plugin installation, credentials, real images, real relay/Library data, paid request, deployment, publication, migration, deletion, cleanup, and release remain unauthorized.
- Existing ignored build outputs remain uncommitted and are not trusted inputs.
