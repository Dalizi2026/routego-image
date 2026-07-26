# PD-016：Task 7.1 已批准的 WASM 资源尺寸例外

- Status: approved scoped verification exception
- Change: `streamline-routego-image-generation`
- Tasks: 6.2 resource packaging, 7.1 dead-surface and safety scan
- Decision owner: Program Controller G14
- Decision date: 2026-07-26

## Finding

Task 7.1 implementation and all in-scope regressions pass, but `pnpm safety` rejects two tracked ONNX Runtime Web 1.20.1 WASM resources because the generic repository scanner rejects every tracked file larger than 5 MiB. The files are required by completed Task 6.2 and are intentionally binary package resources:

- `packages/integration/resources/background-removal/ort-wasm-simd-threaded.jsep.wasm` (21,663,894 bytes)
- `packages/integration/resources/background-removal/ort-wasm-simd-threaded.wasm` (11,246,032 bytes)

The Task 6.2 resource manifest and package verifier independently pin the exact byte sizes and SHA-256 values, and the focused resource/package tests passed. The files are outside Task 7.1's allowed paths, so Task 7.1 cannot change or remove them.

## Decision

Authorize a narrow verification exception for the two exact paths above. The exception does not weaken any other repository safety rule, permit arbitrary large files, or authorize changes to the scanner, resource bytes, package manifest, licenses, dependencies, providers, credentials, real data, installation, deployment, release, or plugin replacement.

Task 7.1 may complete its safety scan by recording this exception and verifying the exact resource manifest/package hashes and focused package/resource tests. A future packaging task may separately decide whether the generic scanner needs a permanent path-aware rule; that is not part of Task 7.1.

## Evidence

- Task 6.2 implementation: `e3a2524ec5968032bc9311136d284430985e348c`
- Task 6.2 task-state: `a319e5bb1880225d2b12b717e55021b587bae0b6`
- Resource/package verification: 35/35 focused tests passed; Integration typecheck passed.
- Task 7.1 implementation: `f027b05ec905609e050c83be711dbe0878df8f2f`
- Task 7.1 in-scope verification: Contracts 31/31, Integration 27/27, Mock Relay typecheck, smoke syntax, diff check, and lane doctor passed.

## Residual risk

The generic `pnpm safety` command remains red only for these two explicitly approved binary resources. The exact-path exception must be carried into final packaging/release evidence; no release or installed-plugin replacement is authorized by this decision.
