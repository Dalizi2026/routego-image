## ADDED Requirements

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

