## Why

Routego Image currently accepts text generation and reference-image generation, but it no longer exposes a trustworthy way to edit a user-selected image from the Codex conversation. This prevents ordinary tasks such as a controlled wardrobe change and leaves the existing safe image-input pipeline unable to reach the compatible provider edit request shape.

## What Changes

- Add the public `routego_edit` MCP/HTTP operation for a single target image, an edit prompt, optional ordered supporting/reference images, and explicit preservation constraints.
- Restore strict edit request validation and durable Library recording while keeping batch operations generation-only.
- Add provider routing and request serialization for compatible image edits: standard OpenAI Images multipart edits, the configured single-endpoint JSON image extension, and OpenAI Responses image inputs where already supported.
- Preserve the current no-replay billing guard: a request never silently switches transport after a provider attempt.
- Keep Routego Studio generation-only. No Studio edit page, route, upload control, or mask editor is added by this change; the existing Provider settings form may record an optional, explicit Edits endpoint.

## Capabilities

### New Capabilities
- `codex-image-editing`: Safe, main-conversation image editing with a required target image, bounded supporting inputs, explicit edit invariants, durable results, and transparent billing/error reporting.

### Modified Capabilities
- `shared-image-contracts`: Restore the public edit operation schema alongside generation and regeneration preparation without weakening generation-only batch validation.
- `provider-operation-adapters`: Select and serialize an image-edit request through verified compatible provider routes, including multipart OpenAI Images edits.
- `image-job-execution`: Execute, persist, and report edit operations through the same bounded lifecycle used for generation.
- `provider-capability-model`: Treat an explicit user-requested edit as the first capability-establishing request for a route while keeping unverified image-input routes blocked for automatic work.

## Impact

- Affected public interfaces: `routego_edit` is added to the Codex MCP and local HTTP operation registry; the current seven-tool set becomes eight tools.
- Affected packages: contracts, foundation routing, Creation request serializers and runtime registration, Integration composition, Library result projection, and focused unit/integration tests.
- No new dependency, Studio page, Studio route, browser upload endpoint, or automatic capability probe is introduced. The existing Provider settings form gains only an optional explicit Edits endpoint field.
- The user-approved wardrobe-change request is the post-implementation real-provider acceptance request and may incur one provider charge.
