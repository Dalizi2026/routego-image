> 非权威草稿：等待两份审计最终报告后重新核对。不得用于 OpenSpec apply。

## ADDED Requirements

### Requirement: Portable strict TypeScript workspace
The project SHALL provide a pnpm workspace that requires Node.js 20.19 or newer, compiles all Foundation packages in TypeScript strict mode, and uses only cross-platform pure-JavaScript build dependencies.

#### Scenario: Supported development environment
- **WHEN** a developer installs the locked dependencies on Windows, macOS, or Linux with Node.js 20.19 or newer
- **THEN** the root typecheck and build commands SHALL complete without a native addon build step

#### Scenario: Unsupported Node version
- **WHEN** package tooling evaluates a Node.js version older than 20.19
- **THEN** the workspace SHALL declare that runtime unsupported rather than silently building against it

### Requirement: Explicit package boundaries
The workspace SHALL separate browser-safe shared contracts, Node-side foundation utilities, and mock relay behavior into independently exported packages with declared dependency directions.

#### Scenario: Studio consumes contracts
- **WHEN** browser code imports the shared contracts package
- **THEN** that package SHALL not transitively import Node built-in modules

#### Scenario: Foundation consumes contracts
- **WHEN** Node-side foundation or mock code uses shared request and result types
- **THEN** it SHALL import them from the shared contracts package instead of copying their definitions

### Requirement: Reproducible root commands
The project SHALL expose root commands for safety checking, type checking, building, unit/contract testing, and browser-stack smoke testing, and SHALL commit the workspace lockfile.

#### Scenario: Clean checkout verification
- **WHEN** CI installs dependencies with the frozen lockfile and invokes the documented root commands
- **THEN** every Foundation package and test suite SHALL be included without undocumented manual setup

### Requirement: Lane-owned shared configuration
Foundation SHALL own root dependency, lockfile, workspace, shared TypeScript, build, test, and CI configuration until the integration baseline freezes them.

#### Scenario: Downstream lane needs a root dependency change
- **WHEN** Creation, Library, or Studio requires a change to Foundation-owned root configuration
- **THEN** the change SHALL be coordinated through the Program Controller and the applicable OpenSpec artifact before editing the shared file
