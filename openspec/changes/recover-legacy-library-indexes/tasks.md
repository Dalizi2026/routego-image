## 1. Contracts and Library Upgrade Core

- [x] 1.1 Add strict, browser-safe legacy-migration state and confirmation contracts, exports, and contract tests without changing the seven MCP tools.
- [x] 1.2 Implement a validated v1 generation-only decoder and deterministic version-2 projection; reject unsupported legacy shapes without mutating data.
- [x] 1.3 Implement locked preflight/confirmation execution with stale-fingerprint protection, backup, journaled atomic promotion, verification, and recovery tests using synthetic roots only.

## 2. Runtime Recovery and Studio Boundary

- [x] 2.1 Make Library and composition recovery preserve provider configuration while reporting an actionable migration-required state and gate Library-dependent work safely.
- [x] 2.2 Register authenticated Studio-only migration state and confirmation routes with input/output validation, session tests, and redaction checks.
- [x] 2.3 Add Studio boot recovery UI and client behavior for ready, blocked, failed, success, and retry states; verify provider setup is not reset by the migration state.

## 3. Regression and Packaging Verification

- [x] 3.1 Add integration and Studio regression coverage for a saved profile plus legacy v1 Library, successful confirmation, stale confirmation, and unsupported data.
- [x] 3.2 Update the packaged-plugin install smoke to exercise compatible legacy recovery without provider execution and confirm public MCP tools remain unchanged.
- [x] 3.3 Run OpenSpec validation, focused package tests, typecheck, build, package verification, and installation smoke; review the diff, commit, and mark completed tasks.
