# Routego Image real-relay acceptance result

## Result

Task 7.2 is incomplete and release readiness remains blocked. Two approved text-generation attempts were made under the same provider/profile/model and USD 10 ceiling:

1. The original user-confirmed API Base was treated as an exact endpoint and returned HTTP 405.
2. The audited legacy normalization was then bound to the complete generation endpoint. That endpoint accepted the POST route but returned HTTP 502 with no image output.

Both attempts stopped immediately without automatic retry. No other matrix case was started.

## Approved binding

- Provider: `lnm生图`
- Profile: `lnm`
- Model: `gpt-image-2`
- Corrected endpoint fingerprint: `20f9071f870fd7bf6a3a024dc04cb1996e0c5f1e96d2c17a30f5d8c1b2d11a8d`
- Approval expiry: `2026-07-20T18:00:00+08:00`
- Approved maximum per class: `3,3,3,3,3,3`
- Combined cost-risk ceiling: USD 10
- Automatic retries: disabled

The corrected private form retained mode `0600` and SHA-256 `00ec5c9101b838c67da354606a8cf4ca4a82dbb6141f2696ae3a98a23811f4d0`. Raw evidence remained in the approved mode-`0700` private evidence root identified by fingerprint `948853647f9cd7ed2be9d399eaedae946b85caf12d19022e846b41fadefcf740`.

## Observed attempts

| Attempt | Endpoint binding | Requests | Outcome | Capability state | HTTP | Duration | Output |
| --- | --- | ---: | --- | --- | ---: | ---: | --- |
| 1 | Original exact root | 1 | transient failure | unknown | 405 | 747 ms | none |
| 2 | Corrected complete generation endpoint | 1 | transient failure | unknown | 502 | 3,183 ms | none |

The second response body was JSON, 71 bytes, with top-level `error` and SHA-256 `cdbe892a5c08e23afe6238edd233cb294646288c1001a9c1c73ad10591bb60d3`. These bounded facts do not expose the body or endpoint.

The combined requests reserve USD 2.34 of the approval as a conservative cost-risk envelope. The provider did not supply invoice amounts, so actual cost remains unknown and `mayHaveBilled` is true. HTTP 502 is a transient upstream/server failure and does not prove that `gpt-image-2` or any image-input capability is unsupported.

## Cases not executed

The following approved cases were not started:

1. Two ordered references.
2. Direct edit.
3. Mask edit at target slot zero.
4. Three-request partial batch.
5. Transparency degradation.

No `/models`, `/images/edits`, `/responses`, or other sibling endpoint was called. The first root endpoint was not replayed after its 405 response, and the corrected generation endpoint was not replayed after its 502 response.

## Evidence and safety

- Both sanitized records passed `validateAcceptanceEvidence` and `assertEvidenceSafe`.
- The corrected run counted the earlier request and cost risk before sending its request.
- No credential, authorization header, full endpoint, raw provider body, image bytes, data URL, or local path is stored in repository evidence.
- No real user Library, HOME, CODEX_HOME, plugin installation, marketplace, deployment, publication, or release state was read or mutated.

Task 7.2 remains pending. Another real request requires a new current user instruction because the corrected endpoint has now produced a transient 502 and automatic retries are forbidden.
