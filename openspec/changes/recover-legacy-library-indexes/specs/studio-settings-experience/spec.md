## ADDED Requirements

### Requirement: Provider completion remains truthful during Library recovery
Studio SHALL retain and render a successfully saved provider profile and selected model even when a separate legacy Library migration is required. A pending or blocked Library migration MUST NOT reset the provider form, clear a saved API-key indicator, or be represented as an incomplete provider configuration.

#### Scenario: Provider setup precedes legacy Library recovery
- **WHEN** the user saves a valid provider profile while the Library reports a migration requirement
- **THEN** Settings SHALL acknowledge the saved provider configuration and direct the user to the distinct Library recovery state without claiming that configuration was not completed
