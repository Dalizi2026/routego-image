## Why

Routego Studio stores valid default generation settings, but conversational generation currently passes `auto` values to the provider instead of resolving those saved defaults. Providers can therefore return a different aspect ratio and format than the user selected, and the resulting valid image can then fail during Library persistence.

## What Changes

- Resolve every omitted conversational generation option from the active profile defaults before provider submission, preserving `auto` only when it is the configured default.
- Preserve provider-detected image MIME and dimensions as the authoritative result metadata when they differ from the requested output format.
- Make Library persistence ingest the validated provider result by its detected MIME and extension, so a valid PNG, JPEG, or WebP result is committed atomically even when the provider ignores a requested format.
- Return a truthful structured persistence failure only when the Library transaction itself cannot commit, while retaining the generated result for the caller.
- Add regression coverage for 1:1 default resolution, provider JPEG output from a PNG request, successful Library persistence, and genuine persistence failure.

## Capabilities

### New Capabilities

<!-- None. -->

### Modified Capabilities

- `local-provider-configuration`: Active profile defaults must be available to conversational generation resolution.
- `image-job-execution`: Omitted generation controls must resolve to the active profile defaults before route submission.
- `provider-response-processing`: Detected provider image format must remain authoritative when it differs from the requested format.
- `durable-image-library`: Valid normalized PNG, JPEG, and WebP provider results must be persisted using their detected type and extension.

## Impact

This change affects the Integration boundary that composes profile defaults, Creation request resolution and response artifacts, and Library ingestion/persistence. It does not add public MCP tools, alter provider routes, change Studio settings UI, or modify user API credentials, existing Library records, or marketplace configuration.
