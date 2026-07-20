## Why

Routego Image correctly detects an unconfigured installation, but the Codex response stops without opening a usable configuration surface and Studio initially lands on the creation workbench. A first-time user therefore has to guess where settings live and which values are required before any image can be generated.

## What Changes

- Add a secret-safe Codex first-run flow that opens a fresh Studio session when status reports `configured=false`, instead of asking for credentials in chat or returning a vague instruction.
- Make an unconfigured Studio session enter Settings automatically and present a concise setup state beside the existing real provider form.
- Identify the minimum required profile values: a name, the exact generation endpoint or explicitly selected legacy base mode, a default model, a write-only API key, and active-profile selection.
- Show a clear ready state after a usable active profile with a key exists, with a direct return to the workbench.
- Preserve existing configured-user routing, provider contracts, credential storage, capability probes, and seven-tool public surface.
- Add focused Skill/package and browser regression coverage for unconfigured, configured, bilingual, responsive, and secret-redaction paths.
- Add a permanent configuration starter action to the Codex plugin details page and make its description and all three starter actions bilingual with Chinese and English on separate lines.
- Make the short-lived Studio bootstrap URL tolerate Codex link-preview access before the user opens it, while keeping API authorization on the distinct in-memory session token.

## Capabilities

### New Capabilities

- `routego-first-run-onboarding`: Discoverable, bilingual, secret-safe first-run routing and completion guidance across Codex and Routego Studio.

### Modified Capabilities

None.

## Impact

- Affected code: plugin interface metadata, `skills/routego-image/SKILL.md`, Studio application/settings components and styles, loopback session/bootstrap handling, Studio/browser/runtime tests, and package verification assertions.
- Public APIs and schemas remain unchanged; the plugin still exposes exactly seven MCP tools.
- No new dependency, network request, automatic capability probe, credential migration, marketplace publication, or provider call is introduced.
