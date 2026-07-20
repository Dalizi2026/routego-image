---
name: routego-image
description: Use Routego Image for safe local image generation, editing, independent batches, Library operations, and current-session Studio work. 使用 Routego Image 安全完成本地生图、编辑、独立批处理、图库管理和当前会话 Studio 操作。
---

# Routego Image

Use only the seven tools below. 仅使用以下七个工具：

- `routego_status`: inspect configuration, service health, models, defaults, and capability evidence. 检查配置、服务状态、模型、默认值与能力证据。
- `routego_generate`: run one generation request, including 1-4 variants of the same task. 执行一个生成任务，可包含同一任务的 1-4 个变体。
- `routego_edit`: edit one explicit target with required invariants and optional references, supporting images, or mask. 按明确约束编辑一个指定目标，可附参考图、辅助图或遮罩。
- `routego_batch`: run 1-20 independent generation or edit tasks with unique IDs. 执行 1-20 个具有唯一 ID 的独立生成或编辑任务。
- `routego_search_library`: search saved assets with bounded filters and pagination. 使用有界筛选与分页搜索图库。
- `routego_manage_library`: create or rename folders, assign assets, delete or restore, and import or export ZIP files. 管理文件夹、资产归类、删除恢复及 ZIP 导入导出。
- `routego_open_studio`: open the loopback Studio for this call and session. 为本次调用和当前会话打开本地 Studio。

Do not invent another `routego_*` tool or use Studio-only/internal operations.
不要虚构其他 `routego_*` 工具，也不要调用仅供 Studio 或内部使用的操作。

## Operating Flow / 操作流程

1. Clarify only missing creative or file-selection details. Never ask for a complete API key or authorization value in chat. 只补充询问缺失的创作或文件选择信息；绝不在对话中索取完整密钥或认证值。
2. Before generation, editing, batch work, or capability-dependent advice, call `routego_status` with `refreshCapabilities: false`. Inspect `configured`, service health, the selected model, and the relevant capability evidence. 在生成、编辑、批处理或依赖能力的建议之前，先读取状态并核对配置、服务、模型及对应能力证据。
3. If status returns `configured: false`, do not ask for an API key, endpoint, or authorization value in chat. Call `routego_open_studio` once for the current request, present its exact fresh URL as the configuration action, explain that the existing creative request can continue after setup, and stop before any provider or potentially billable operation. If Studio launch fails, report only that current safe failure; never construct or reuse a URL. 若状态返回 `configured: false`，不得在对话中索取 API Key、端点或认证值。应为当前请求调用一次 `routego_open_studio`，把本次返回的新 URL 作为配置入口，说明配置后可继续原创作请求，并在任何提供方或潜在计费操作前停止。若 Studio 打开失败，只报告本次安全错误，不得拼接或复用旧 URL。
4. Do not refresh capabilities or confirm a potentially billable probe unless the user explicitly approves that exact action in the current conversation. 未获得用户对本次操作的明确批准，不得刷新能力或确认可能计费的探测。
5. If the required capability is unknown, unsupported, or degraded, state the verified limitation and stop that dependent operation. Do not imply support or fabricate success. 能力未知、不支持或降级时，说明已验证的限制并停止依赖操作，不得假装支持或伪造成功。
6. Call the single matching public tool, then report its actual status, partial/final facts, failures, and billing/output-risk facts without hiding them. 调用唯一匹配的公共工具，并如实报告状态、部分/最终结果、失败及计费或输出风险。

## Variants and Batch / 变体与批处理

- Multiple outputs for one prompt or one edit are variants: use one `routego_generate` or `routego_edit` call with `count` from 1 to 4. 同一提示词或同一编辑任务的多张输出属于变体，应在一次生成或编辑调用中设置 1-4 的 `count`。
- Different prompts, targets, invariants, or output policies are independent tasks: use `routego_batch` with stable unique task IDs and one complete operation per item. 不同提示词、目标、约束或输出策略属于独立任务，应使用批处理并为每项提供稳定且唯一的 ID。
- Never split variants into unrelated batch items merely to increase output count, and never merge independent work into one variant request. 不得为增加数量而把变体拆成无关批任务，也不得把独立任务伪装成变体。

## Generation and Editing / 生成与编辑

- For generation, use `kind: "generate"`; include only explicit references and requested output options. 生成时使用 `kind: "generate"`，只传入用户明确选择的参考图与输出选项。
- For editing, use `kind: "edit"`, exactly one explicit `targetImage`, and the required `invariants`. Add a mask only for that target. 编辑时使用 `kind: "edit"`，必须包含一个明确目标和编辑约束；遮罩只能属于该目标。
- Use only paths or identifiers explicitly selected by the user or returned as validated values by the current tool flow. Never search folders to guess an input or output. 只使用用户明确选择或当前工具流程验证返回的路径与标识；不得扫描目录猜测输入或输出。
- When `saveToLibrary` is false, require an explicit approved `outputDir`; do not choose or scan one automatically. 不保存到图库时，必须使用用户明确批准的输出目录，不得自动选择或扫描目录。

## Library / 图库

- Search before managing when asset or folder identity is not already explicit. 资产或文件夹标识不明确时，先搜索再管理。
- Use only IDs returned by the current search or explicitly supplied by the user. 只使用本次搜索返回或用户明确提供的 ID。
- Require explicit confirmation immediately before permanent deletion. 永久删除前必须再次获得明确确认。
- For ZIP import or export, use only the exact user-selected path and report only the validated result returned by the current call. ZIP 导入导出只使用用户选择的精确路径，并仅报告本次调用验证返回的结果。

## Current-Call Results / 本次调用结果

- Present only validated paths and image content returned by the current call. Do not reuse an older path, image, token, or success statement. 只展示本次调用返回的已验证路径和图片内容，不得复用旧路径、旧图片、旧令牌或旧成功结论。
- Prefer final images. Mention partial images only when they are relevant to a partial or failed result; do not flood ordinary context with intermediates. 优先展示最终图片；仅在部分成功或失败相关时说明部分图片，不要用中间图淹没普通上下文。
- Never print image data URLs, Base64, raw bytes, credentials, authorization values, or diagnostic local paths. 不得输出图片 data URL、Base64、原始字节、凭证、认证值或诊断本地路径。
- Do not scan output folders, invoke legacy scripts or CLIs, or claim that a file, Library mutation, Studio launch, or image exists unless the current validated result says so. 不得扫描输出目录、调用旧脚本或旧 CLI；除非本次验证结果明确确认，否则不得声称文件、图库变更、Studio 或图片已存在。

## Studio / 工作台

- When the user asks for Studio, call `routego_open_studio` for the current request. Use the exact fresh URL from that call immediately. 用户要求打开 Studio 时，必须为当前请求调用工具，并立即使用本次返回的新 URL。
- An unconfigured generation, edit, batch, or capability-dependent request also requires a fresh `routego_open_studio` call under Operating Flow step 3, even when the user did not explicitly name Studio. 未配置时，即使用户没有明确提到 Studio，生成、编辑、批处理或能力相关请求也必须按操作流程第 3 步打开一次新的 Studio。
- Never reuse a Studio URL or token from an earlier call, persist it, expose it as a general credential, or construct one manually. 不得复用、持久化、当作通用凭证暴露或手工拼接旧的 Studio URL 或令牌。
- A Studio launch result is success only when the current call validates it; otherwise report the current failure without substitution. 只有本次调用验证通过才算打开成功，否则如实报告当前失败，不得替换为旧结果。
