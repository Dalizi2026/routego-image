## ADDED Requirements

### Requirement: Full-screen target-bound mask workspace
Studio SHALL provide a full-screen mask editor for exactly one edit target, SHALL bind the saved mask to target slot zero, and SHALL refuse mask submission without a valid target or confirmed mask capability.

#### Scenario: Mask editor opens
- **WHEN** an eligible edit target and mask capability are available
- **THEN** Studio SHALL open the protected target image in a full-screen canvas workspace with the mask bound to target slot zero

#### Scenario: Mask capability is unavailable
- **WHEN** mask editing is unknown or unsupported
- **THEN** the editor action SHALL display “当前中转未确认支持” and SHALL NOT create or submit a mask

### Requirement: Zoom and pan controls
The mask editor SHALL support fit/reset, zoom in/out, pointer-wheel zoom around the cursor, explicit pan mode, and bounded viewport transforms across mouse, pen, touch, and keyboard-accessible controls.

#### Scenario: User zooms and pans
- **WHEN** the user changes zoom or drags in pan mode
- **THEN** the target and mask overlay SHALL remain spatially aligned and drawing coordinates SHALL map to the correct image pixels

### Requirement: Brush and eraser drawing
The mask editor SHALL provide brush and eraser tools, pointer capture, adjustable brush size, continuous strokes, clear-mask action, and a visible cursor/size preview without modifying the source image.

#### Scenario: Brush stroke is drawn
- **WHEN** the user draws with the brush
- **THEN** the alpha mask SHALL update continuously at image coordinates while the target image remains unchanged

#### Scenario: Eraser is used
- **WHEN** the user draws with the eraser
- **THEN** the affected mask alpha SHALL be removed without altering unrelated mask pixels

### Requirement: Bounded undo and redo history
The mask editor SHALL support undo and redo for drawing and clear actions using bounded mask history, SHALL disable unavailable history actions, and SHALL discard redo history after a new edit.

#### Scenario: User undoes and redraws
- **WHEN** the user undoes a stroke and then creates a new stroke
- **THEN** the canvas SHALL restore the prior mask, record the new state, and clear the obsolete redo branch

### Requirement: Overlay preview controls
The mask editor SHALL provide mask visibility and opacity controls plus a clear visual distinction between editable mask coverage and untouched target content.

#### Scenario: Overlay preview changes
- **WHEN** the user toggles visibility or adjusts opacity
- **THEN** only the presentation of the mask overlay SHALL change and the stored mask pixels SHALL remain unchanged

### Requirement: PNG mask upload and safe close
Saving SHALL encode the mask as a PNG blob, upload/finalize it with purpose `mask`, and return only its `uploadResourceId`. Empty masks, encoding failures, upload failures, or unsafe close with unsaved work SHALL require explicit resolution.

#### Scenario: Mask is saved
- **WHEN** a non-empty valid mask is saved
- **THEN** Studio SHALL finalize a PNG mask upload and attach its locator with literal target slot zero to the edit draft

#### Scenario: Unsaved editor is closed
- **WHEN** the user attempts to close after mask changes
- **THEN** Studio SHALL require discard confirmation or successful save and SHALL NOT silently lose work
