## ADDED Requirements

### Requirement: Validated provider image facts remain authoritative
The system SHALL preserve the detected MIME type, dimensions, byte length, and checksum of a valid provider image artifact even when they differ from a requested output-format preference.

#### Scenario: Provider returns JPEG for a PNG request
- **WHEN** a provider response contains valid JPEG bytes after a request whose effective format is PNG
- **THEN** the final artifact SHALL report image/jpeg and its detected dimensions and checksum, and SHALL not be mislabeled as PNG or rejected solely for that discrepancy
