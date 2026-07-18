## ADDED Requirements

### Requirement: Canonical Routego Image 1.0.0 plugin structure
The distributable SHALL use the plugin name `routego-image`, version `1.0.0`, a valid `.codex-plugin/plugin.json`, a plugin-relative Routego Image Skill, relative runtime launchers, bundled Studio assets, and required notices/licenses. Manifest and marketplace metadata SHALL be created/updated through the approved plugin-creator workflow.

#### Scenario: Package structure is inspected
- **WHEN** the staged plugin is validated
- **THEN** every declared Skill/runtime/resource path SHALL resolve inside the plugin root and no path SHALL depend on a developer home or source checkout

#### Scenario: Public tool declaration is inspected
- **WHEN** manifest/runtime metadata is compared with the shared registry
- **THEN** it SHALL expose exactly the seven frozen tools and no Studio-only operation

### Requirement: Runtime artifact is self contained and pure JavaScript
The package build SHALL bundle Integration and approved runtime dependencies for Node.js 20.19+, include the built Studio application, and SHALL require no target-machine `pnpm install`, `node_modules`, node-gyp, native addon, source checkout, or build step.

#### Scenario: Artifact runs in an empty temporary home
- **WHEN** a machine has only Node.js 20.19+ and the staged plugin
- **THEN** MCP initialization, status, and Studio launch SHALL run without resolving repository packages or installing dependencies

#### Scenario: Native or undeclared dependency is present
- **WHEN** dependency/package inspection finds a native binary, install script, unresolved external package, or undeclared runtime import
- **THEN** packaging SHALL fail before installation

### Requirement: Package contents are reproducible and allowlisted
Packaging SHALL build in a temporary staging directory, normalize deterministic metadata where practical, hash every delivered file, and validate an explicit allowlist/denylist. It MUST exclude source maps containing local paths, caches, reports, build directories, credentials, configuration, user images, Library data, legacy data, and unrelated source files.

#### Scenario: Identical source is packaged twice
- **WHEN** two clean package builds use the same commit, lockfile, Node/tool versions, and platform-normalized inputs
- **THEN** the content manifest SHALL be equivalent and every non-deterministic difference SHALL be explained or rejected

#### Scenario: Sensitive or generated residue enters staging
- **WHEN** a denied path, key-like value, local configuration, raster user data, report, cache, or absolute source path is found
- **THEN** package verification SHALL fail without printing the sensitive value

### Requirement: Third-party provenance travels with the artifact
The package SHALL contain `THIRD_PARTY_NOTICES.md`, the complete audited upstream MIT license, and release-time notices for Routego Image runtime dependencies, including the approved pure-JavaScript PNG codec.

#### Scenario: Delivered notices are inspected
- **WHEN** the package dependency graph and notices are compared
- **THEN** every delivered third-party runtime dependency SHALL have accurate license evidence and the pinned upstream provenance SHALL remain present

### Requirement: Temporary CODEX_HOME installation is isolated and complete
Before any real replacement, the staged plugin SHALL be installed into a newly created temporary `CODEX_HOME` with isolated data/output roots and synthetic fixtures. Smoke verification SHALL start a fresh Codex task/process and verify Skill discovery, exact-seven MCP listing/calls, Studio bootstrap/static/API/resource/stream behavior, and shared Library visibility.

#### Scenario: Clean installation smoke passes
- **WHEN** the self-contained package is installed into an empty temporary home
- **THEN** a fresh client SHALL discover the Skill, initialize MCP, call offline-safe tools, open Studio, and observe the same synthetic Library state through Codex and Studio

#### Scenario: Smoke detects source-checkout dependency
- **WHEN** the installed runtime attempts to read the repository, developer plugin path, workspace `node_modules`, or a legacy path
- **THEN** smoke verification SHALL fail and the installed temporary copy SHALL be removed safely

### Requirement: Legacy plugin and data remain untouched during package smoke
Packaging and temporary installation MUST NOT overwrite, import, migrate, delete, rename, or read the existing installed plugin, old configuration, old images, or real Routego Image 1.0 data.

#### Scenario: Legacy data exists on the machine
- **WHEN** package and temporary-`CODEX_HOME` smoke run
- **THEN** their results SHALL be independent of that data and file hashes/timestamps SHALL remain unchanged
