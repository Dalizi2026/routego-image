# Studio Application Shell Specification

## Purpose

Defines the secure boot, navigation, localization, responsive layout, accessibility, global-state, and protected-resource requirements for Routego Studio.

## Requirements

### Requirement: Secure local Studio boot
Routego Studio SHALL require a launch session token, retain it only in application memory, remove it from the visible address bar after initialization, and attach it only to protected loopback requests. It MUST NOT store or log the token.

#### Scenario: Valid launch token
- **WHEN** Studio opens with a session token and the service accepts the initial status/settings requests
- **THEN** the application SHALL enter the ready shell and remove the token from the visible URL without writing it to browser storage

#### Scenario: Missing or rejected session
- **WHEN** the launch token is absent, expired, or rejected
- **THEN** Studio SHALL show a blocking session error with a reopen instruction and SHALL NOT issue unprotected retries

### Requirement: Bilingual accessible navigation
Studio SHALL provide Chinese and English interface text, semantic landmarks, keyboard navigation, visible focus, accessible names, and a persistent language toggle without requiring a network font or translation service.

#### Scenario: Language is switched
- **WHEN** the user changes the interface language
- **THEN** navigation, headings, actions, state messages, dialogs, and form labels SHALL update consistently without losing current work

#### Scenario: Keyboard-only navigation
- **WHEN** a user operates Studio without a pointer
- **THEN** every primary destination, form control, dialog, comparison control, and mask tool SHALL be reachable and visibly focused

### Requirement: Responsive darkroom workspace
Studio SHALL provide a cohesive darkroom/contact-sheet visual system and responsive layouts for desktop, tablet, and mobile without hiding required functionality.

#### Scenario: Desktop layout
- **WHEN** the viewport is wide
- **THEN** Studio SHALL show persistent navigation and the available primary/secondary work panels without overlapping controls

#### Scenario: Mobile layout
- **WHEN** the viewport is narrow
- **THEN** Studio SHALL use mobile navigation and drawers/full-screen panels while preserving creation, Library, mask, trash, and settings actions with touch-sized controls

### Requirement: Global async and boundary states
Every Studio route and data surface SHALL provide loading, empty, success, partial, failure, degraded, offline/service-unavailable, and retry states as applicable. Invalid contract output MUST fail closed and MUST NOT be rendered as success.

#### Scenario: Service result is invalid
- **WHEN** a response violates the frozen output schema
- **THEN** Studio SHALL show a safe internal-contract failure and SHALL NOT use unvalidated fields

#### Scenario: Empty collection
- **WHEN** a valid search or folder request returns no items
- **THEN** Studio SHALL show an intentional empty state with relevant next actions rather than a blank panel or fabricated content

### Requirement: Protected browser resources
Studio SHALL load images and downloadable resources only from protected relative resource descriptors using the current session, convert image responses to revocable browser object URLs, and reject arbitrary external or local-path sources.

#### Scenario: Protected image is displayed
- **WHEN** a valid image resource descriptor is received
- **THEN** Studio SHALL fetch it with the session boundary, display the resulting object URL, and revoke that URL when it is no longer used

#### Scenario: Unsafe resource is encountered
- **WHEN** a resource value is absolute, path-like, credential-bearing, or otherwise outside the frozen descriptor schema
- **THEN** Studio SHALL reject it and show a safe resource error

