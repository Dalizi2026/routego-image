## ADDED Requirements

### Requirement: Active defaults are available for public-operation resolution
The system SHALL expose the active profile's durable generation defaults to Integration for resolving omitted public generation controls, without exposing credentials, unrestricted output paths, or requiring a provider request.

#### Scenario: Active defaults are read for a public operation
- **WHEN** Integration prepares a public generation operation with one or more omitted controls
- **THEN** it SHALL obtain the active profile defaults from the local settings owner and SHALL not include an API key or full output path in the resolved request or result

#### Scenario: Settings cannot be read
- **WHEN** the active settings document cannot be read or validated
- **THEN** public generation SHALL stop before provider submission with a sanitized configuration error and SHALL not substitute unrelated defaults
