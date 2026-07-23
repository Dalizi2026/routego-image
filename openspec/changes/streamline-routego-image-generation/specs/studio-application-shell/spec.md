## ADDED Requirements

### Requirement: Header provider switching affects future submissions only
The Studio Header SHALL list configured provider profiles, identify the active profile, and activate a selected profile with explicit loading, success, and failure states. Activation SHALL preserve the current model when the target profile contains the same model and otherwise SHALL select the target profile's default model. Header state SHALL change only from the validated browser-safe activation response.

#### Scenario: Target provider supports the same model
- **WHEN** the user switches providers and the target model catalog includes the current model
- **THEN** Studio SHALL activate the new provider with the same model for future submissions

#### Scenario: Target provider lacks the current model
- **WHEN** the user switches providers and the current model is absent
- **THEN** Studio SHALL activate the target provider's valid default model for future submissions and report the selected model

#### Scenario: Switch occurs during generation
- **WHEN** one or more single or batch requests are already submitted
- **THEN** those requests SHALL retain their provider/model snapshots and only later submissions SHALL use the new selection

#### Scenario: Activation fails
- **WHEN** profile activation or model fallback fails validation or persistence
- **THEN** Studio SHALL retain the prior active selection and SHALL show failure rather than a false switched state
