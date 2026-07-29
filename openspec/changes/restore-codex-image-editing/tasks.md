## 1. Public Contract and Entrypoints

- [ ] 1.1 Restore the discriminated generate/edit request contract, direct `routego_edit` input, operation registry, service method, and generation-only batch validation in `packages/contracts`.
- [ ] 1.2 Register the direct edit operation in MCP and loopback HTTP, including final image content projection, without changing Studio routes or components.
- [ ] 1.3 Add contract, MCP, and HTTP regression coverage for valid edits, invalid edit inputs, tool listing, and batch rejection.

## 2. Prepared Inputs and Provider Requests

- [ ] 2.1 Restore validated target-first image preparation for direct edits and preserve bounded reference order in `packages/creation/src/provider/image-inputs.ts`.
- [ ] 2.2 Add selected-route request serialization for legacy JSON image input and explicitly configured OpenAI Images Edits multipart fields in `packages/creation/src/provider`.
- [ ] 2.3 Add Creation tests proving target/reference ordering, multipart field shape, legacy JSON compatibility, and no generation-shape regression.

## 3. Routing and Evidence

- [ ] 3.1 Extend Foundation routing to distinguish generate and edit candidates, explicit Edits endpoints, and the one-request capability-establishing direct-edit exception without derived endpoints or cross-transport replay.
- [ ] 3.2 Persist sanitized successful direct-edit capability evidence scoped to the selected provider route, and retain failure evidence without claiming support.
- [ ] 3.3 Add routing and provider integration tests for unknown direct edit, unsupported routes, selected multipart routes, and generation regressions.

## 4. Integration and Persistence

- [ ] 4.1 Extend public input graph preparation and staged path replacement to include edit targets and ordered references through the existing transaction lifecycle.
- [ ] 4.2 Route `RoutegoService.edit()` through the existing execution/materialization/Library result path and prevent global generation defaults from changing default edit dimensions.
- [ ] 4.3 Add Integration tests for persisted target/reference relationships, edit result projection, and truthful failed-edit behavior.

## 5. Verification and Local Plugin Refresh

- [ ] 5.1 Run focused package tests, workspace type checks, build/package validation, and strict OpenSpec validation; fix any root-cause regressions within this change.
- [ ] 5.2 Refresh the locally installed Routego plugin only after tests pass, confirm its public tool registry includes `routego_edit`, and preserve existing generation/Studio behavior.
- [ ] 5.3 Submit the user-approved wardrobe edit exactly once through the refreshed `routego_edit` tool, report the actual result and billing/output state, and record whether scoped capability evidence was established.
- [ ] 5.4 Expose an optional explicit Edits endpoint in the existing Provider settings form, preserve redaction/re-entry safeguards, and add focused Studio state and markup regression coverage without adding a Studio editing workflow.
