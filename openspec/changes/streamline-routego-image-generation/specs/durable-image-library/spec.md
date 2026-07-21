## MODIFIED Requirements

### Requirement: Metadata, relationships, and locator resolution are complete
Generation assets SHALL retain frozen detail metadata, zero through five ordered reference relationships, folder state, stable asset/artifact locators, and optional current-mark identity. Library SHALL resolve locators to contained internal resources for Integration but SHALL NOT execute provider operations or expose filesystem paths.

#### Scenario: Referenced generation detail is read
- **WHEN** a generation uses ordered reference inputs and produces one or more outputs
- **THEN** detail SHALL preserve reference/output roles and requested/effective/execution/error state

#### Scenario: Integration resolves a locator
- **WHEN** a valid asset, artifact, or upload ID is requested internally
- **THEN** Library SHALL return a contained path and verified metadata, never a provider result or browser-visible path

#### Scenario: Current mark is read
- **WHEN** a valid generation record is the current mark
- **THEN** Library SHALL return only its stable record identity through browser/public contracts and keep path resolution internal

## ADDED Requirements

### Requirement: One persistent current generation mark
Library SHALL persist zero or one current mark referencing an active generation record. Setting a new mark SHALL atomically replace the previous mark; setting the current mark again SHALL cancel it. Generation completion SHALL NOT clear the mark.

#### Scenario: A different image is marked
- **WHEN** a valid active generation record is marked while another mark exists
- **THEN** the index SHALL atomically replace the old identity with the new identity

#### Scenario: The current image is marked again
- **WHEN** the currently marked record is toggled
- **THEN** the mark SHALL be cleared without changing the generation record or image bytes

#### Scenario: Generation succeeds after marking
- **WHEN** a new generation record is ingested
- **THEN** the existing current mark SHALL remain unchanged

#### Scenario: Mark target is missing or ineligible
- **WHEN** a caller tries to mark a missing, legacy edit, or otherwise ineligible record
- **THEN** Library SHALL return a structured failure without changing the existing mark

## REMOVED Requirements

### Requirement: Recycle, restore, and permanent deletion are honest
**Reason**: Ordinary Library deletion and Trash workflows are removed from the product.
**Migration**: Remove their public/browser operations; legacy cleanup is handled only by the versioned, preflighted upgrade migration and requires explicit approval on real user data.
