## ADDED Requirements

### Requirement: Omitted public generation controls resolve from active defaults
Before public single or batch generation is submitted, Integration SHALL merge only omitted generation controls with the active durable defaults and SHALL validate the resulting complete operation request before Creation executes it.

#### Scenario: Square default is omitted by the caller
- **WHEN** a public generation caller omits size and aspect ratio and the active defaults are 2048x2048 and 1:1
- **THEN** Creation SHALL receive 2048x2048 and 1:1 rather than auto values, and requested/effective parameters SHALL record the resolved request

#### Scenario: Explicit caller control overrides a default
- **WHEN** a public generation caller explicitly supplies a supported size, aspect ratio, format, count, quality, transparency, moderation, or save policy
- **THEN** the explicit value SHALL be preserved and SHALL not be replaced by the active default

#### Scenario: Batch items omit different controls
- **WHEN** a public batch contains items with different subsets of omitted generation controls
- **THEN** each item SHALL resolve independently against the same active default snapshot and retain its own explicit values
