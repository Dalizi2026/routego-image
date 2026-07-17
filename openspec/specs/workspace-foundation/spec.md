# Workspace Foundation Specification

## Purpose

Defines the portable workspace, package boundaries, and shared build configuration for Routego Image.

## Requirements
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
The project SHALL expose root commands for safety checking, type checking, building, and unit/contract testing, SHALL provide shared Playwright configuration for the Studio lane, and SHALL commit the workspace lockfile.

#### Scenario: Clean checkout verification
- **WHEN** CI installs dependencies with the frozen lockfile and invokes the documented root commands
- **THEN** every Foundation package and Foundation-owned test suite SHALL be included without undocumented manual setup

### Requirement: Lane-owned shared configuration
Foundation SHALL own root dependency, lockfile, workspace, shared TypeScript, build, test, and CI configuration until the integration baseline freezes them.

#### Scenario: Downstream lane needs a root dependency change
- **WHEN** Creation, Library, or Studio requires a change to Foundation-owned root configuration
- **THEN** the change SHALL be coordinated through the Program Controller and the applicable OpenSpec artifact before editing the shared file

### Requirement: Downstream workspace importer scaffolds
The workspace SHALL contain buildable private package importers for `@routego-image/creation`, `@routego-image/library`, and `@routego-image/studio`, each with an exported minimal package entry and no downstream product implementation.

#### Scenario: Clean workspace resolves downstream packages
- **WHEN** dependencies are installed from a clean checkout with the frozen lockfile
- **THEN** all three packages SHALL resolve their approved imports, typecheck, build, and expose valid package exports without manual setup

#### Scenario: Importer is inspected for product behavior
- **WHEN** the Foundation Extension diff is reviewed
- **THEN** the downstream packages SHALL contain only importer/scaffold code and SHALL NOT contain provider transport, Library persistence, Studio pages/components, or plugin release behavior

### Requirement: Controlled downstream dependency baselines
Creation and Library package manifests SHALL declare only workspace dependencies. Studio SHALL declare only approved workspace dependencies plus exact locked versions of React, ReactDOM, Vite, `@vitejs/plugin-react`, `@types/react`, and `@types/react-dom`.

#### Scenario: Unapproved dependency appears
- **WHEN** an importer manifest or lockfile adds another third-party package outside the approved Studio baseline
- **THEN** the change SHALL fail scope review and require a planning deviation before implementation continues

### Requirement: Root graph and lockfile include every importer
Root TypeScript project references, workspace discovery, package-export checks, and the committed `pnpm-lock.yaml` SHALL include Creation, Library, and Studio importers.

#### Scenario: Frozen install is repeated
- **WHEN** `pnpm install --frozen-lockfile` runs after removing installation artifacts in a clean verification copy
- **THEN** it SHALL complete without changing the lockfile and every importer SHALL be present in the lockfile importer section

### Requirement: No native runtime dependency
The downstream importer dependency graph SHALL NOT introduce a native addon required by the shipped Routego Image runtime on the target machine.

#### Scenario: Runtime dependencies are audited
- **WHEN** the resolved production/runtime dependency paths for all workspace packages are inspected
- **THEN** no package SHALL require node-gyp, prebuild installation, or a native addon compilation step on the target plugin runtime
