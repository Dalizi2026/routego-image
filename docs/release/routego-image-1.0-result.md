# Routego Image 1.0 release result

## Scope

- Task: 8.2 local release and rollback gate.
- Scope: local installation only; no marketplace publication, deployment, migration, deletion, network request, paid request, or real credential use.
- Cachebuster: `1.0.0+codex.local-20260720-g11`.
- Accepted `artifact-manifest.json` SHA-256: `0d83bb8967511cdcb21cd90f23ffe5dbe06dbf44ddbea328ff82221e32e671b3`.
- Package contains 13 allowlisted files and passed strict package validation and plugin-creator validation.

## Installation

- Local source target: `home/plugins/routego-image`.
- Personal marketplace action: created the default local `personal` marketplace entry through `plugin-creator`; no remote marketplace was contacted.
- Codex cache: installed by `codex plugin add routego-image@personal` and enabled.
- Atomic switch: same-filesystem staged copy was verified, the generated scaffold was archived, and the accepted candidate was renamed into the target.
- Previous Routego Image plugin: absent before installation; no prior plugin archive could be created. The generated bootstrap scaffold is preserved in the release archive.
- Configuration backup: the pre-install Codex configuration is preserved in the dated local backup area.
- The two invalid local marketplace source strings were corrected to the existing local openai-curated root so the CLI could load; no marketplace was added or removed.

## Verification

- `codex plugin list --json`: Routego Image discovered, enabled, and sourced from the local personal marketplace.
- Source and installed cache trees: byte-for-byte identical; both manifest hashes match the accepted value.
- Fresh isolated process smoke: passed with a new `HOME` and `CODEX_HOME`, loopback-only proxy isolation, no credentials, and no external relay.
- Skill: bilingual and names the exact seven public tools.
- MCP: exactly seven tools; offline status ready and unconfigured; public artifact phases are `partial` and `final`.
- Studio/API/resource/stream: bootstrap, hashed static assets, upload/resource behavior, missing-resource rejection, terminal stream, and shared Library identity all passed.
- Regression tests after the cachebuster contract fixes: 49 focused tests passed.
- Release workflow simulation and rollback-preservation tests remain green: 11/11.

## Rollback

No failure occurred, so live rollback was not invoked. The accepted release workflow's automatic archive/restore and failed-candidate preservation simulations passed. A failed installation must preserve the candidate, restore the archived prior target when one exists, and restore the backed-up Codex configuration; this installation had no prior Routego Image target to restore.

## Residual risk

- Task 9.1 final conformance gate remains pending and was not started.
- No real relay request was executed as part of this release smoke.
- The local marketplace source correction is retained because the prior escaped path prevented CLI discovery; the original configuration is backed up for reversal.
