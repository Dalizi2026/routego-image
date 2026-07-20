## ADDED Requirements

### Requirement: Codex routes unconfigured requests to a fresh setup session
When `routego_status` reports that Routego Image is not configured for a requested generation, edit, batch, or capability-dependent operation, the Skill SHALL call `routego_open_studio`, present the fresh current-call Studio URL as the configuration action, and SHALL NOT request an API key or authorization value in chat.

#### Scenario: Generation is requested before configuration
- **WHEN** a user requests image generation and `routego_status` returns `configured=false`
- **THEN** Codex SHALL open a fresh Studio session, explain that setup must be completed there, preserve the user's creative request for continuation, and stop before any billable provider operation

#### Scenario: Studio launch fails during first run
- **WHEN** an unconfigured request triggers `routego_open_studio` but the current launch fails
- **THEN** Codex SHALL report the safe launch failure without constructing or reusing an older Studio URL and without asking for credentials in chat

### Requirement: Unconfigured Studio opens the setup destination
Studio SHALL derive first-run readiness from the validated settings state. If there is no active profile, the active profile lacks a write-only API key, or neither the active profile nor defaults identify a model, Studio SHALL initially select Settings while preserving normal initial routing for configured users.

#### Scenario: Fresh installation opens Settings
- **WHEN** Studio boots with no provider profiles
- **THEN** the Settings destination SHALL be selected automatically and the creation workbench SHALL remain available through normal navigation

#### Scenario: Configured installation opens Workbench
- **WHEN** Studio boots with an active profile that has a key and an effective model
- **THEN** the Workbench destination SHALL remain the initial route and no first-run setup panel SHALL be shown

### Requirement: First-run setup is explicit and completion-aware
The first-run Settings state SHALL identify the required connection, credential, model, and active-profile conditions; use the existing strict provider form; distinguish exact generation endpoint mode from explicitly selected legacy base mode; and provide a direct Workbench action only after the validated settings response satisfies readiness.

#### Scenario: Required setup values are visible
- **WHEN** an unconfigured user reaches Settings
- **THEN** Studio SHALL present bilingual setup status and the existing profile form with provider name, endpoint mode, generation endpoint, default model, write-only API-key replacement, and active-profile selection available without navigating elsewhere

#### Scenario: Setup becomes ready after a valid save
- **WHEN** the service returns a validated active profile with a configured key and effective model
- **THEN** the setup state SHALL become complete and offer a direct action to the Workbench without exposing the submitted key or full endpoint

### Requirement: First-run guidance preserves security and external-action gates
The onboarding flow MUST NOT store credentials in browser storage, render a complete key, echo a full sensitive endpoint, automatically refresh models, run a capability probe, generate an image, or contact a provider merely because first-run guidance was displayed.

#### Scenario: First-run screen is opened and language is switched
- **WHEN** a user opens the unconfigured setup screen and switches between Chinese and English
- **THEN** all setup labels SHALL update while no provider, model-refresh, capability-probe, or generation request is issued and no secret appears in rendered text, URL, storage, console, or diagnostics

### Requirement: Plugin details expose bilingual ongoing configuration
The Codex plugin details metadata SHALL use its three supported starter actions for configuration, image creation/editing, and Studio opening. The subtitle, long description, and every starter action SHALL contain Chinese and English on separate lines, and the configuration action SHALL open a fresh Studio Settings session for both first-time and later profile changes.

#### Scenario: Existing user wants to change configuration
- **WHEN** a user selects the configuration starter action after a profile already exists
- **THEN** the Skill SHALL call `routego_open_studio` for the current request, direct the user to Settings, and SHALL NOT ask for or print a key in chat

#### Scenario: Plugin details are displayed
- **WHEN** Codex renders the plugin details page
- **THEN** the visible description and each of the three supported starter actions SHALL provide a Chinese line followed by an English line, including one explicit configuration action

### Requirement: Studio bootstrap tolerates safe link previews
The loopback runtime SHALL allow the same valid launch token to retrieve the no-store bootstrap document more than once before the short launch-token expiry so that a Codex link preview cannot consume the user's launch. Every successful retrieval MUST return the same owning API session, and the launch token MUST remain invalid for API authorization and after its exact expiry.

#### Scenario: Preview loads before the user opens Studio
- **WHEN** a preview request retrieves a fresh Studio launch URL and the user opens the same URL before launch expiry
- **THEN** both requests SHALL receive valid no-store bootstrap HTML for the same in-memory API session and the user-facing Studio SHALL load normally

#### Scenario: Replayed launch is expired
- **WHEN** the same launch URL is requested at or after its short launch-token expiry
- **THEN** the runtime SHALL return `session_invalid` without issuing a new session, extending expiry, or exposing either token

#### Scenario: Packaged Studio consumes the injected session
- **WHEN** the no-store bootstrap document injects a valid `__ROUTEGO_STUDIO_SESSION__` object before loading the Studio entry module
- **THEN** the Studio entrypoint SHALL create its in-memory API session from that object, remove any launch query from the visible URL, and SHALL NOT require the launch token to remain in the address bar
- **AND** a malformed or expired injected object SHALL fail closed without making API requests

#### Scenario: Same-origin browser read omits Origin
- **WHEN** a Studio API read omits `Origin` but presents the exact listener `Host`, same-origin Fetch Metadata with an empty destination, no cookie, and the valid owning API session token
- **THEN** the loopback host SHALL authorize it as its exact own origin
- **AND** an explicit foreign origin, cross-site or missing Fetch Metadata, mismatched host, cookie, or invalid token SHALL remain rejected
