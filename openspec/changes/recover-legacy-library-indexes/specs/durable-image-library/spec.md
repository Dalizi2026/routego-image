## MODIFIED Requirements

### Requirement: Versioned validated JSON Library index
The system SHALL store a schema-versioned UTF-8 JSON index with monotonic revision and explicit corruption/version failure. Missing MAY initialize; invalid existing MUST NOT be reset. A recognized version-1 index SHALL be inspected read-only as a potential legacy migration state instead of being misclassified as missing configuration; it SHALL remain unchanged until an explicit confirmed migration successfully promotes a validated version-2 replacement.

#### Scenario: Index is missing
- **WHEN** a new approved Library root is opened
- **THEN** a valid empty version-1 index SHALL be created without scanning legacy images

#### Scenario: Index is corrupt
- **WHEN** JSON or structural validation fails
- **THEN** the original SHALL be preserved and operations SHALL stop with a sanitized error

#### Scenario: Recognized version-1 index requires migration
- **WHEN** an existing index identifies itself as version 1
- **THEN** the Library SHALL retain it unchanged, provide only a sanitized path-free migration state, and SHALL NOT initialize a replacement index or treat it as corrupt configuration

