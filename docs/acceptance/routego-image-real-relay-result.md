# Routego Image real-relay acceptance result

## Result

Task 7.2 is incomplete and release readiness remains blocked. The first approved text-generation request reached the exact configured endpoint, but the endpoint returned HTTP 405 and no image output. Execution stopped immediately without retrying or calling a derived path.

## Approved binding

- Provider: `lnm生图`
- Profile: `lnm`
- Model: `gpt-image-2`
- Endpoint fingerprint: `76f483c773fa695425c5db75ebe57faf45334dadc48f9f83b284720d1ca98655`
- Approval expiry: `2026-07-20T18:00:00+08:00`
- Planned request ceiling: 8
- Cost-risk ceiling: USD 10
- Automatic retries: disabled

The private form retained mode `0600` and SHA-256 `42a5f32876acb5d22f3acd9e4c6afad56b0dcf4824b48903097748156d20c3c6`. Raw evidence remained in the approved mode-`0700` private evidence root identified by fingerprint `948853647f9cd7ed2be9d399eaedae946b85caf12d19022e846b41fadefcf740`.

## Observed case

| Case | Requests | Outcome | Capability state | HTTP | Duration | Output |
| --- | ---: | --- | --- | ---: | ---: | --- |
| Text generation | 1 | transient failure | unknown | 405 | 747 ms | none |

The response body was non-JSON, 154 bytes, with SHA-256 `4a327e30d348f9975e50913c72d1bdb067f31f726722326c17c6af8d7f04b3a6`. These bounded facts do not expose the body or endpoint.

The request reserved USD 1.25 of the approval as a conservative cost-risk envelope. The provider did not supply an invoice amount, so actual cost is unknown and `mayHaveBilled` remains true. No claim of unsupported image generation was made because one method rejection does not prove model capability.

## Cases not executed

The following approved cases were not started:

1. Two ordered references.
2. Direct edit.
3. Mask edit at target slot zero.
4. Three-request partial batch.
5. Transparency degradation.

No sibling endpoint, `/models`, `/images/edits`, `/responses`, or other inferred route was probed. There was no automatic replay.

## Evidence and safety

- The sanitized evidence passed `validateAcceptanceEvidence` and `assertEvidenceSafe`.
- The exact configured endpoint alone received one POST request.
- No credential, authorization header, full endpoint, raw provider body, image bytes, data URL, or local path is stored in repository evidence.
- No real user Library, HOME, CODEX_HOME, plugin installation, marketplace, deployment, publication, or release state was read or mutated.

Task 7.2 must remain pending. A corrected complete image-generation endpoint changes the endpoint fingerprint and therefore requires a fresh form identity, capsule binding, and explicit user approval before another real request.
