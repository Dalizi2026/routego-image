## Context

The installed plugin already exposes a validated `routego_status` result, a fresh-session `routego_open_studio` tool, and a complete secret-safe Settings workspace. The missing behavior is orchestration: the Skill only opens Studio when explicitly asked, the Studio reducer always starts on Workbench, and the Settings form does not distinguish a first run from routine profile maintenance.

The change crosses the Skill and Studio UI but does not require a schema, service, storage, provider-adapter, or dependency change. Existing session-token, redacted settings, write-only key, and billable-probe boundaries remain frozen.

## Goals / Non-Goals

**Goals:**

- Turn an unconfigured generation/edit request into a fresh, actionable Studio setup session.
- Route an unconfigured Studio boot directly to Settings.
- Show the minimum readiness conditions and transition to a clear ready state after validated settings updates.
- Keep configured users on the existing Workbench entry path.
- Verify bilingual, responsive, no-automatic-request, and secret-redaction behavior offline.

**Non-Goals:**

- Add a new MCP tool, endpoint, configuration schema, provider preset, automatic endpoint derivation, credential migration, or browser storage.
- Ask for or process credentials in Codex chat.
- Refresh models, probe capabilities, generate images, install the plugin, publish, or contact a real provider automatically.

## Decisions

### 1. Keep setup transport in the existing Studio tool and settings operations

The Skill will branch immediately after the required status check. An unconfigured result calls `routego_open_studio` and presents only that current-call URL. This reuses the one-time loopback session and avoids adding a credential-bearing chat tool or configuration arguments to MCP.

Alternative considered: add a `routego_configure` MCP tool. Rejected because it would expand the frozen seven-tool surface and encourage credentials in chat.

### 2. Derive readiness from validated redacted settings

A pure Studio helper will consider setup incomplete unless one profile is active, that active descriptor has `hasApiKey=true`, and an effective model exists in either settings defaults or the active profile. The helper receives no secret and can be covered by unit tests. The initial reducer state uses this result once at boot; later settings updates change the onboarding status but do not force navigation.

Alternative considered: trust only the boot-time `service.configured` flag. Rejected because the service result is not refreshed after a profile mutation and would keep the UI stale.

### 3. Embed a compact setup state above the existing form

Settings will render one first-run band only while readiness is incomplete or while the session began incomplete. The band exposes connection, key, model, and active-selection state, links focus to the real profile form, and changes to a completion action after a validated save. It does not duplicate form fields or create a second persistence path.

Alternative considered: a blocking modal wizard. Rejected because it would duplicate validation/state, obscure optional advanced endpoints, and make recovery from service errors harder.

### 4. Preserve all external-action gates

Rendering onboarding performs no network/provider action beyond the existing local bootstrap reads. Model refresh, capability probes, and image operations remain explicit user commands. Password fields remain write-only and cleared at submission as before.

## Risks / Trade-offs

- [Risk] A profile with a key but an unusable endpoint can appear setup-complete because endpoint validity is provider-dependent. -> Mitigation: readiness relies on the strict persisted descriptor; actual support remains governed by capability evidence and transient errors.
- [Risk] Users may confuse exact endpoint and legacy base modes. -> Mitigation: first-run copy names both modes and keeps exact endpoint selected by default without deriving paths.
- [Risk] A dense Settings page can still feel complex. -> Mitigation: the first-run band lists only required readiness conditions and focuses the existing form; optional endpoints and probes remain visually secondary.

## Migration Plan

Build and verify the plugin artifact offline. A later explicitly authorized local replacement can stage the new artifact, back up the current installed plugin, atomically switch, run a fresh-process smoke, and roll back on failure. No config or Library migration is required.

## Open Questions

None. The existing exact-endpoint and legacy-base product rules determine all required first-run fields.
