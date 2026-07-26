## ADDED Requirements

### Requirement: Blocking legacy Library recovery state
Studio SHALL request the authenticated legacy Library migration state during boot. When migration is ready or blocked, it SHALL show a blocking, accessible recovery state with a retry action and, when ready, an explicit confirmation action. It SHALL not present the condition as a missing API key and SHALL not allow Library-dependent creation actions until normal recovery succeeds.

#### Scenario: Compatible migration is awaiting confirmation
- **WHEN** Studio receives a ready legacy migration state
- **THEN** it SHALL identify the saved provider configuration independently, explain that Library data needs confirmation, and require an explicit user action before sending the confirmation request

#### Scenario: Migration cannot be completed
- **WHEN** Studio receives a blocked or failed migration state
- **THEN** it SHALL show a safe failure and retry state without rendering paths, credentials, or raw legacy data as success

