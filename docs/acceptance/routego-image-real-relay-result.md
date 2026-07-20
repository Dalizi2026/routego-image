# Routego Image real-relay acceptance result

## Result

Task 7.2 is complete. The approved `zayuapi-test` profile produced accepted results for the full six-case matrix through the exact bound image-generation endpoint. Release readiness for the real-relay gate is true.

The earlier `lnm生图` attempts remain part of the cumulative request and cost-risk record, but their transient HTTP 405/502 results did not consume successful capability quota.

## Approved binding

- Provider: `zayuapi`
- Profile: `zayuapi-test`
- Model: `gpt-image-2`
- Endpoint fingerprint: `3435fd43c547a9947b36fe2842b67bbd1b583f86df3f2421cd916126ceef961d`
- Credential slot: one test-only credential, value never stored in the repository or evidence
- Approval expiry: `2026-07-20T18:00:00+08:00`
- Successful quota maximum per class: `3,3,3,3,3,3`
- Combined cost-risk ceiling: USD 10
- Failed requests consume successful quota: no

The private form retained mode `0600` and SHA-256 `dc37b985621394b3f570f7ea19560607dbae62190550b97f8129c2be6d2c3e1d`. Raw evidence remained in the approved mode-`0700` private evidence root identified by fingerprint `948853647f9cd7ed2be9d399eaedae946b85caf12d19022e846b41fadefcf740`.

## Observed matrix

| Case | Raw requests | Successful quota | Outcome | HTTP order | Duration |
| --- | ---: | ---: | --- | --- | --- |
| Text generation | 1 | 1 | success | 200 | 24,909 ms |
| Two ordered references | 1 | 1 | success | 200 | 34,425 ms |
| Direct edit | 1 | 1 | success | 200 | 24,835 ms |
| Mask edit at slot zero | 1 | 1 | success | 200 | 32,966 ms |
| Partial batch | 3 | 1 | partial | 200, 400, 504 | 33,638 ms, 6,152 ms, 60,190 ms |
| Transparency | 1 | 1 | success with chromakey degradation | 200 | 30,200 ms |

The partial batch preserved the ordered outcomes `success, failed, failed`. The expected invalid middle item was rejected with HTTP 400; the final item returned transient HTTP 504 and was not retried. The completed output remained available under one shared Codex/Studio Library identity.

The transparency case retained the provider original and created one chromakey rendition under the same output identity. Its artifact graph contains two renditions, no extra relationship role, and remains below the 33-rendition bound.

## Totals and cost risk

- New `zayuapi` requests: 8
- New successful quota count: 6
- New reserved cost risk: USD 6.40
- Earlier provider requests: 3
- Combined raw requests: 11
- Combined reserved cost risk: USD 9.69 of the USD 10 hard ceiling
- Actual provider charges: unknown
- `mayHaveBilled`: true for every raw request

No request was replayed. No `/models`, `/images/edits`, `/responses`, or other sibling endpoint was called.

## Evidence and safety

- The merged sanitized record passed `validateAcceptanceEvidence` and `assertEvidenceSafe` for all six ordered cases.
- Every returned image was bounded, decoded, and verified as PNG before evidence projection.
- Credential values were read only inside the mode-`0600` private runner; only the `test` slot label appears in evidence.
- Failed raw requests consumed no successful quota but remain recorded in raw request, `mayHaveBilled`, and cost-risk totals.
- No credential, authorization header, full endpoint, raw provider body, image bytes, data URL, or local evidence path is stored in repository evidence.
- No real user Library, HOME, CODEX_HOME, plugin installation, marketplace, deployment, publication, or release state was read or mutated.
