# Routego Image real-relay acceptance result

## Result

Task 7.2 is incomplete and release readiness remains blocked. Three raw text-generation requests have been made, but failed requests consume no successful capability quota under the user's latest amendment:

1. The original API Base treated as an exact endpoint returned HTTP 405.
2. The corrected complete generation endpoint returned HTTP 502 with the primary credential.
3. The same corrected endpoint returned HTTP 502 with the distinct backup credential.

No request produced an image. The successful text-generation quota remains zero, and no other matrix case was started.

## Approved binding

- Provider: `lnm生图`
- Profile: `lnm`
- Model: `gpt-image-2`
- Corrected endpoint fingerprint: `20f9071f870fd7bf6a3a024dc04cb1996e0c5f1e96d2c17a30f5d8c1b2d11a8d`
- Credential slots: distinct primary and backup credentials, values never persisted or logged
- Approval expiry: `2026-07-20T18:00:00+08:00`
- Successful quota maximum per class: `3,3,3,3,3,3`
- Combined cost-risk ceiling: USD 10
- Failed requests consume successful quota: no

The corrected private form retained mode `0600` and SHA-256 `00ec5c9101b838c67da354606a8cf4ca4a82dbb6141f2696ae3a98a23811f4d0`. Raw evidence remained in the approved mode-`0700` private evidence root identified by fingerprint `948853647f9cd7ed2be9d399eaedae946b85caf12d19022e846b41fadefcf740`.

## Observed attempts

| Attempt | Endpoint binding | Credential slot | Raw requests | Successful quota | Outcome | HTTP | Duration | Output |
| --- | --- | --- | ---: | ---: | --- | ---: | ---: | --- |
| 1 | Original root | primary | 1 | 0 | transient failure | 405 | 747 ms | none |
| 2 | Complete generation endpoint | primary | 1 | 0 | transient failure | 502 | 3,183 ms | none |
| 3 | Complete generation endpoint | backup | 1 | 0 | transient failure | 502 | 2,150 ms | none |

Both corrected-endpoint 502 responses were JSON, 71 bytes, with top-level `error` and identical SHA-256 `cdbe892a5c08e23afe6238edd233cb294646288c1001a9c1c73ad10591bb60d3`. The identical bounded response fingerprint across distinct credentials is evidence of a relay/upstream failure rather than an isolated credential failure.

The three raw requests reserve USD 3.29 as a conservative cost-risk envelope. The provider supplied no invoice amount, so actual cost remains unknown and `mayHaveBilled` is true. HTTP 502 remains transient and does not prove any model capability unsupported.

## Cases not executed

The following approved cases were not started:

1. Two ordered references.
2. Direct edit.
3. Mask edit at target slot zero.
4. Three-request partial batch.
5. Transparency degradation.

No `/models`, `/images/edits`, `/responses`, or other sibling endpoint was called. No request that produced output or partial work was replayed.

## Evidence and safety

- All sanitized records passed `validateAcceptanceEvidence` and `assertEvidenceSafe`.
- Credential values were read only inside the mode-`0600` runner; only `primary` and `backup` slot labels appear in evidence.
- Failed raw requests consume no successful quota but remain recorded in raw request, `mayHaveBilled`, and cost-risk totals.
- No credential, authorization header, full endpoint, raw provider body, image bytes, data URL, or local path is stored in repository evidence.
- No real user Library, HOME, CODEX_HOME, plugin installation, marketplace, deployment, publication, or release state was read or mutated.

Task 7.2 remains pending. Both credentials have now produced the same transient 502 at the corrected endpoint, so this rotation cycle is stopped pending relay recovery or another current user instruction.
