## ADDED Requirements

### Requirement: Legacy cleanup is explicitly authorized and preflighted
The upgrade migration SHALL run a read-only preflight before destructive work. Preflight SHALL identify legacy Trash generation records, legacy edit records, their owned files, shared references, conflicts, projected counts, and a migration fingerprint. Real user data MUST NOT be modified without a separate explicit confirmation bound to that fingerprint.

#### Scenario: Development or installation reaches migration code
- **WHEN** no explicit real-data confirmation has been provided
- **THEN** the system SHALL return the preflight report and SHALL NOT alter the index or delete files

#### Scenario: Preflight changes before execution
- **WHEN** the Library state no longer matches the confirmed fingerprint
- **THEN** execution SHALL stop and require a fresh preflight and confirmation

### Requirement: Generation dependencies block edit cleanup
Before deleting any legacy edit record or file, the migration SHALL build a complete reverse dependency graph. If an ordinary generation record references an edit image or edit-owned file, the migration MUST stop before all mutations and return a safe conflict list.

#### Scenario: Generation references an edit result
- **WHEN** preflight discovers a generation relationship to a legacy edit record or owned file
- **THEN** the migration SHALL report the dependent and dependency IDs and SHALL NOT modify any record or file

#### Scenario: No blocked dependencies exist
- **WHEN** every edit-owned file is unreferenced outside the removable legacy set
- **THEN** preflight SHALL mark the cleanup eligible without performing it

### Requirement: Confirmed cleanup is atomic and recoverable
After valid confirmation, migration SHALL remove legacy Trash generation records, legacy edit records, and only files with no surviving references. It SHALL journal intent, create a recoverable backup of affected index metadata and bytes before deletion, atomically replace the index, verify the result, and clean the journal only after success.

#### Scenario: Confirmed migration succeeds
- **WHEN** eligible preflight state still matches and all staged operations complete
- **THEN** legacy records and unreferenced owned files SHALL be permanently removed, surviving generation data SHALL remain valid, and verification SHALL close the journal

#### Scenario: File or index operation fails
- **WHEN** any staged copy, delete, index replacement, or verification fails
- **THEN** recovery SHALL restore the prior consistent index and affected bytes, report failure, and SHALL NOT claim migration success

#### Scenario: Shared file has a surviving reference
- **WHEN** a candidate file is still referenced by a surviving record
- **THEN** the record cleanup MAY proceed only if the surviving reference remains valid and the physical file SHALL NOT be deleted

### Requirement: Removed mutations cannot bypass migration
After schema upgrade, public and Studio services SHALL NOT expose soft delete, restore, permanent delete, Trash browsing, or edit-record creation. Legacy destructive cleanup SHALL be callable only through the versioned migration confirmation flow.

#### Scenario: Removed mutation is requested
- **WHEN** a stale client calls a removed Trash, delete, restore, or edit mutation
- **THEN** the service SHALL reject it without index mutation, file deletion, or provider access
