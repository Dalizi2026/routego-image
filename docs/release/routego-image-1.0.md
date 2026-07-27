# Routego Image 1.0 release and rollback checklist

## Current gate

Task 8.1 prepares and verifies the workflow only. It does not authorize cachebuster changes, marketplace writes, plugin reinstall, installed-plugin replacement, deployment, publication, migration, deletion, or release. The scripts refuse real execution until Task 8.2 binds an exact staged artifact, target identity, local marketplace action, downtime window, archive identity, atomic switch, rollback, and publication scope.

All Task 8.1 simulations use synthetic files in an ownership-marked temporary root. They do not read real credentials, `HOME`, `CODEX_HOME`, installed plugins, marketplace files, legacy configuration, image directories, or the real Routego Library.

## Accepted inputs

Before requesting Task 8.2 approval, record all of the following without secrets or unrestricted paths:

1. Source commit and the completed Task 7.2 acceptance commit.
2. Reproducibly built Routego Image package and exact `artifact-manifest.json` SHA-256.
3. Full package verification and content-tree hash.
4. Target plugin identity fingerprint and same-filesystem staging result.
5. Dated archive identity fingerprint that will retain the previous plugin.
6. Confirmed local marketplace name and exact reinstall action.
7. Plugin-creator-normalized cachebuster token, expected plugin version, and rebuilt artifact hash. The normalized token replaces non-lowercase-alphanumeric separators with a single `-` and is the value bound by approval.
8. Downtime/atomic-switch scope and rollback authorization.
9. Fresh-task verification command and expected seven MCP tools.
10. Explicit statement that deployment and publication are approved or remain excluded.

Any artifact change after acceptance invalidates the accepted hash and returns the workflow to build, package verification, offline gates, and user approval. A cachebuster update therefore happens before the final artifact is accepted, never after hashing.

## Plugin-creator cachebuster plan

Use the installed `plugin-creator` helpers. Do not edit `marketplace.json` or Codex configuration by hand.

```bash
python3 <plugin-creator-root>/scripts/update_plugin_cachebuster.py \
  <task-owned-plugin-source> \
  --cachebuster <approved-cachebuster>

python3 <plugin-creator-root>/scripts/read_marketplace_name.py
```

After the cachebuster is applied to a task-owned source, rebuild the package and repeat package verification. Only the newly accepted package hash may be staged. For the default personal marketplace, use the helper-reported marketplace name and the future approved command:

```bash
codex plugin add routego-image@<confirmed-local-marketplace>
```

Do not run `codex plugin marketplace add` for the default personal marketplace. If the plugin is surfaced by a different marketplace, first confirm it is local and already points at the approved source. A remote or mismatched marketplace stops the release.

### Desktop-safe local update rule

The desktop app can keep the currently registered plugin MCP process alive while a package update
is being installed. Therefore an update **MUST NOT** run `codex plugin remove routego-image@personal`
as part of the normal cachebuster/reinstall path: removing the versioned cache beneath a running
desktop process can leave a new chat with the Skill loaded but without the seven MCP tools.

Routego Image's personal-marketplace source is the stable local source directory
`~/plugins/routego-image`; update that source atomically from the verified package, then run only
`codex plugin add routego-image@personal`. The versioned Codex cache is an installation output, not
an update target.

Keep the one-time global `routego-image-runtime` MCP configuration enabled. It launches the same
stable source directory and provides the seven Routego tools even while the plugin marketplace is
refreshing its per-version cache. Create or inspect it through Codex commands only:

```bash
codex mcp get routego-image-runtime --json
codex mcp add routego-image-runtime -- node ~/plugins/routego-image/scripts/start-routego-image.mjs
```

The isolated install smoke must also receive the exact SHA-256 produced by
the package verification; it deliberately does not fall back to a stale
hard-coded hash:

```bash
node scripts/smoke-plugin-install.mjs <routego-image-package> --artifact-sha256 <verified-sha256>
```

After every local update, verify both the packaged plugin and the configured fallback in a fresh
Codex process. The acceptance result must list exactly these seven tools:

```text
routego_status, routego_generate, routego_prepare_regeneration,
routego_batch, routego_search_library, routego_manage_library, routego_open_studio
```

If a desktop chat was already open during the update, it cannot gain newly registered tools in
place. Close that failed chat and start one new chat; do not remove/reinstall the plugin again.

## Stage and atomic switch

1. Create an identity-marked staging root on the same filesystem as the approved target.
2. Verify the source package against the exact accepted artifact-manifest SHA-256.
3. Copy it to `staged/routego-image`, reverify every allowlisted file and compare the complete package.
4. Fingerprint synthetic or approved legacy sentinels before staging.
5. Record only SHA-256 path identities in evidence; do not record unrestricted paths.
6. Rename the current target to the dated archive.
7. Rename the verified staged directory to the target.
8. If either rename fails, restore the previous target immediately and preserve the staged candidate.
9. Never overwrite or delete the only recoverable previous plugin.

The Task 8.1 command is plan-only:

```bash
node scripts/stage-routego-release.mjs --print-plan
```

It prints the helper/reinstall plan and performs no marketplace or installation mutation.

## Fresh-task acceptance

The post-switch gate must use a newly created Codex task/process. A task that was already running before reinstall is not acceptance evidence. Verify:

- plugin discovery and the accepted cachebuster version;
- bilingual Routego Image Skill;
- exactly seven public MCP tools;
- offline-safe status and service startup;
- Studio bootstrap, hashed static assets, API, upload, resource and terminal stream behavior;
- shared Codex/Studio Library identity in the new data root;
- source-checkout and `node_modules` independence;
- package and artifact-manifest hashes;
- legacy configuration, images, Library sentinels, SHA-256 and mtimes unchanged.

No real relay request is part of this release smoke unless a later approval explicitly adds its provider, credential, count, budget, and evidence location.

## Automatic rollback

If installation, startup, Skill, MCP, Studio, package hash, or fresh-task verification fails:

1. Stop using the failed candidate.
2. Rename it into a preserved incident directory whose plugin leaf remains `routego-image`, so package identity and later diagnostics remain verifiable.
3. Atomically rename the dated archive back to the target.
4. Verify the restored plugin in another fresh task/process.
5. Preserve the failed candidate, logs, hashes, archive evidence, and legacy fingerprints.
6. Report release failure without deleting diagnostic evidence.

If rollback itself fails, stop immediately. Preserve both candidates and request user direction; do not retry destructive renames, delete either directory, or rewrite shared history.

Direct execution of `scripts/rollback-routego-release.mjs` remains locked until Task 8.2 supplies the exact approved paths and release record.

## Redacted release record

The final record must include source commit, artifact/content hashes, cachebuster version, approved scope, platform/runtime, offline and real-relay summaries, stage/switch/fresh-task/rollback results, remaining risks, and approval timestamps. It must exclude credentials, authorization headers, session tokens, user images, raw provider responses, real HOME/CODEX_HOME values, and unrestricted local paths.

Task 8.1 is complete only when temporary stage, wrong-hash, partial-switch, successful-switch, fresh-task failure, rollback success, rollback failure-preservation, redaction, legacy immutability, and owned-root cleanup tests all pass. Completing Task 8.1 does not complete or authorize Task 8.2.
