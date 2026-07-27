## 1. Public default resolution — Integration owner

- [x] 1.1 Retain public generation-control omission at the Integration boundary, then add a validated resolver that merges only omitted values from one active settings-default snapshot.
- [x] 1.2 Apply the resolver to public single and batch execution before preflight/Creation, preserving explicit caller values and recording resolved requested/effective parameters.
- [x] 1.3 Add Integration and contract regressions for omitted 1:1/2048 defaults, explicit overrides, per-item batch resolution, and sanitized configuration failure before provider submission.

## 2. Provider-result persistence — Library owner

- [x] 2.1 Remove the false Library output MIME-versus-effective-format equality gate while retaining detected-byte, dimensions, checksum, lock, journal, and atomic commit validation.
- [x] 2.2 Add Library and end-to-end regressions proving a valid JPEG provider output from a PNG preference persists with JPEG metadata/extension, while inconsistent bytes still fail without committing.

## 3. Distribution verification — Integration owner

- [x] 3.1 Run affected contract, Creation, Library, Integration, build, package integrity, and OpenSpec strict validation; inspect the final diff for credentials, images, generated artifacts, and scope violations.
- [x] 3.2 Update the existing local plugin cachebuster, validate the plugin, reinstall it from its existing personal marketplace entry, and confirm the installed version advertises the updated package without changing user configuration.
