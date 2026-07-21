## REMOVED Requirements

### Requirement: Full-screen target-bound mask workspace
**Reason**: Image editing and masking are removed from Routego Image.
**Migration**: Remove the mask route, components, styles, state, uploads, tests, and saved mask drafts; no replacement is provided.

### Requirement: Zoom and pan controls
**Reason**: These controls exist only inside the removed mask editor.
**Migration**: No migration; Library preview and comparison retain their own independent zoom/display behavior.

### Requirement: Brush and eraser drawing
**Reason**: Mask drawing is outside the generation-only product scope.
**Migration**: No replacement is provided.

### Requirement: Bounded undo and redo history
**Reason**: Mask edit history is removed with the mask editor.
**Migration**: Remove transient mask history; it is not Library generation history.

### Requirement: Overlay preview controls
**Reason**: Mask overlay preview is removed with image editing.
**Migration**: No replacement is provided.

### Requirement: PNG mask upload and safe close
**Reason**: Studio no longer accepts mask uploads or edit drafts.
**Migration**: Discard unfinished local mask uploads during upgrade without touching generation assets.
