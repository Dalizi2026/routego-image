## ADDED Requirements

### Requirement: Release requires a separate explicit approval
Installation replacement, marketplace modification, deployment, publication, and final release SHALL remain prohibited until the user explicitly approves the exact staged artifact, target installation, marketplace action, downtime/atomic switch, and rollback plan after offline and real-relay acceptance have passed.

#### Scenario: Apply or real-relay acceptance completes
- **WHEN** no final release approval has been given
- **THEN** the current installed plugin and marketplace SHALL remain unchanged

#### Scenario: Only local replacement is approved
- **WHEN** the user does not approve publication or deployment
- **THEN** release SHALL perform only the local action and SHALL not infer broader authority

### Requirement: Release uses plugin-creator cachebuster and staged atomic replacement
The release workflow SHALL use the approved plugin-creator cachebuster/reinstall process, build and verify the artifact in a temporary directory, hash its contents, archive the existing plugin source, and switch directories atomically where supported. It MUST NOT overwrite the only recoverable old copy before post-install acceptance.

#### Scenario: Staged artifact differs from the accepted hash
- **WHEN** any file changes after acceptance evidence is recorded
- **THEN** release SHALL stop and require the rebuilt artifact to repeat the applicable gates

#### Scenario: Atomic switch succeeds
- **WHEN** the verified staged package replaces the installed plugin
- **THEN** the old plugin SHALL remain in a dated rollback archive and old configuration/images SHALL remain untouched

### Requirement: A fresh Codex task verifies the installed plugin
Post-install acceptance SHALL run in a newly created Codex task/process so cached Skill/MCP state cannot mask packaging errors. It SHALL verify plugin discovery/version, Skill content, exact-seven tool listing, offline-safe status, Studio bootstrap/static/API/resource/stream behavior, new data-root isolation, and package hashes.

#### Scenario: Fresh-task verification passes
- **WHEN** every installed component matches the accepted artifact and smoke behavior
- **THEN** the local release MAY be marked successful for the explicitly approved scope

#### Scenario: Old task works but fresh task fails
- **WHEN** only a cached pre-release task can use the plugin
- **THEN** release SHALL be considered failed and rollback SHALL begin

### Requirement: Failed release restores the prior plugin
If installation, initialization, smoke, Studio, Skill, MCP, package-hash, or accepted real-relay verification fails after the switch, the workflow SHALL stop new use, restore the archived prior plugin atomically, and verify that rollback in a fresh task. It MUST NOT rewrite shared history or delete diagnostic evidence needed for review.

#### Scenario: New MCP runtime does not initialize
- **WHEN** the installed 1.0.0 runtime fails fresh-task initialization
- **THEN** the prior plugin SHALL be restored and verified before the release attempt is reported failed

#### Scenario: Rollback also fails
- **WHEN** the prior plugin cannot be restored automatically
- **THEN** the workflow SHALL stop, preserve both staged/archive directories, report the exact non-secret blocker, and require user direction without destructive cleanup

### Requirement: Legacy data is preserved permanently
Release and rollback MUST NOT migrate, import, delete, overwrite, or reinterpret `~/.codex/routego-image-config.json`, legacy image directories, or unrelated Library data. The new plugin SHALL continue using only the approved Routego Image 1.0 roots.

#### Scenario: Legacy files exist during release
- **WHEN** source archival, replacement, verification, or rollback runs
- **THEN** legacy file content, hashes, and timestamps SHALL remain unchanged

### Requirement: Release evidence is complete and redacted
The final release record SHALL include source commit, artifact/content hashes, plugin/cachebuster version, approved scope, platform/runtime, offline/real acceptance summaries, install/fresh-task/rollback results, remaining risks, and user approvals without credentials, auth headers, session tokens, user images, or unrestricted local paths.

#### Scenario: Evidence is incomplete or secret-bearing
- **WHEN** a required result is missing or a sensitive value is present
- **THEN** release SHALL not be declared complete and the record SHALL be corrected without publishing the secret
