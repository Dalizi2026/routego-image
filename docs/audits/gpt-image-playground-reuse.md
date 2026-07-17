# gpt_image_playground 上游复用审计

> 审计类型：Routego Image 1.0 pre-change audit
>
> 审计日期：2026-07-17
>
> 上游仓库：https://github.com/CookSleep/gpt_image_playground
>
> 固定基线：`a10477581b3d43ac98d39777e4445625a9db113d`
>
> 适用范围：本报告仅适用于上述固定提交；Foundation 后续负责把结论映射到正式 OpenSpec specs/tasks。

## 1. 结论

上游可以作为请求序列化、SSE 流式事件、遮罩纯逻辑、画布手势、透明色键去背和图库交互的成熟参考，但不能整体移植，也不能让它的 `apiMode`、URL 拼接、浏览器 IndexedDB 或单体 Zustand store 反向决定 Routego 架构。

最关键的兼容结论是：上游没有 Routego 默认需要的 Tier A“唯一生图端点 JSON + 可选 `image`/`images` data URL”适配器。上游一旦收到输入图就直接选择标准 `/images/edits`，选择 Responses 模式就直接拼接 `/responses`。这与“只有一个生图端点和 Key，Edits/Responses 未知”的真实条件冲突。

建议采取“理解后抽取和重构”：

- 优先复用纯函数、事件 fixture 和交互规则。
- 重新实现端点能力路由、请求执行、结构化错误、文件持久化和共享 Schema。
- 不移植 Agent UI、Web 搜索、fal.ai、自定义云供应商、赞助、PWA 和云部署。
- 不复制上游完整仓库、`package-lock.json`、构建配置或构建产物。

## 2. 审计基线与检查方式

| 项目 | 固定结果 |
|---|---|
| 上游 HEAD | `a10477581b3d43ac98d39777e4445625a9db113d` |
| 上游提交时间 | `2026-07-15T20:14:15+08:00` |
| 上游提交标题 | `Update README.md` |
| 上游版本 | `0.7.0` |
| 上游许可证 | MIT |
| 版权所有者 | `Copyright (c) 2026 CookSleep` |
| 上游树状态 | detached HEAD，跟踪文件 clean |
| Routego 审计分支 | `codex/routego-upstream-audit` |
| OpenSpec | 无；Controller 已确认这是 Foundation proposal 前的证据输入 |

检查方式：

1. 使用 `git ls-remote` 固定远端 `main`/HEAD SHA，并在临时目录 detached checkout。
2. 使用 `git show`、`git rev-parse`、`git status` 核对提交、树和工作区状态。
3. 逐行审查请求、SSE、遮罩、透明、尺寸、图库、ZIP、组件、状态管理和测试文件。
4. 在临时上游副本执行 `npm ci`、Vitest、生产构建和依赖安全审计。
5. 未调用真实供应商端点，未使用真实 API Key，未把上游依赖或 `dist` 带入 Routego 仓库。

动态验证结果：

- 环境：Node.js `v24.15.0`，npm `11.12.1`。
- `npm test`：18 个测试文件、241 个测试全部通过。
- `npm run build`：TypeScript 与 Vite 构建通过；主 chunk 约 908 KB，出现大于 500 KB 的代码分割警告。
- `npm audit`：完整依赖树为 8 项漏洞（2 low、1 moderate、5 high）；生产依赖为 1 项 moderate，来自 `streamdown -> mermaid -> dompurify`。这组 Markdown/Agent 展示依赖不属于 Routego 复用范围。
- 上游没有 React 组件测试、Testing Library 或 Playwright 端到端测试；现有覆盖主要是纯函数、API 和 store 单元测试。

## 3. 许可证、归属和第三方声明

### 3.1 上游许可证要求

上游根 `LICENSE` 是标准 MIT 文本，要求在软件副本或实质性部分中保留版权声明和许可声明。仓库没有独立 `NOTICE`、`COPYING` 或第三方声明文件。

只要 Routego 复制或实质性改写上游代码，发布包至少应包含：

- 上游仓库 URL。
- 固定复用 SHA `a10477581b3d43ac98d39777e4445625a9db113d`。
- `Copyright (c) 2026 CookSleep`。
- 完整 MIT 许可证文本。
- 被复用的文件/函数与 Routego 修改说明。

建议 Foundation/Integration 后续建立：

- `THIRD_PARTY_NOTICES.md`：列出上游来源、SHA、许可证、复用范围。
- `licenses/gpt_image_playground-MIT.txt`：保存上游完整 MIT 文本。
- 对实质性派生文件增加简短来源注释，指向固定 SHA 和第三方声明。

### 3.2 依赖许可证边界

上游依赖树不是 Routego 的许可清单。不能复制上游 `package-lock.json` 后把其依赖视为已批准。

- 如果复用纯 TypeScript 算法且不引入上游依赖，主要新增义务是上游 MIT 归属。
- 如果选择 `fflate`、Zustand 或其他包，应基于 Routego 自己的锁文件重新核对并生成第三方声明。
- `@fal-ai/client`、`streamdown`、Mermaid、Cloudflare/Wrangler 等依赖属于明确排除范围，不应因复制上游依赖树被间接带入。
- 正式发布前应从实际发布锁文件生成依赖许可证/NOTICE，而不是依赖本审计时的上游统计。

## 4. 上游架构概览

上游是 React 19 + Vite + TypeScript + Zustand + Tailwind 的浏览器单页应用，不是 Next.js。高层结构为：

- `src/App.tsx`：画廊/Agent 两种模式和所有全局弹窗的根壳层。
- `src/store.ts`：5658 行，混合 UI 状态、API 调用、任务执行、Agent、图库、ZIP、透明处理和数据迁移。
- `src/lib/openaiCompatibleImageApi.ts`：Images、Responses、自定义 provider、SSE 和轮询的混合适配器。
- `src/lib/db.ts`：IndexedDB 图片/任务/缩略图存储。
- `src/components/*`：工作台、任务卡、详情、Lightbox、遮罩编辑器、收藏夹和设置。

这套应用能证明许多交互已被真实使用和测试，但其职责边界不适合作为 Routego 的正式三层架构。Routego 应保持：共享 Schema和业务层在本地服务，Studio 只做客户端状态与展示，文件系统/JSON 索引是数据事实来源。

## 5. Images、Edits 与 multipart

### 5.1 上游实际行为

`src/lib/openaiCompatibleImageApi.ts`：

- `createOpenAICompatiblePaths` 固定 `images/generations` 和 `images/edits`（36-40）。
- 无输入图时，`callImagesApiSingle` 向 generations 发送 JSON（553-680）。
- 有任何输入图时，立即向 edits 发送 multipart，没有能力四态或端点确认（558、571-631）。
- multipart 按输入数组顺序追加重复的 `image[]` 字段，文件名为 `input-1.*`、`input-2.*`（597-619）。
- 遮罩单独追加为 `mask.png`（621-623）。
- 有遮罩时把第 1 张目标图和遮罩转换为 PNG，并分别限制 50 MiB（600-613）。
- 多图总 payload 上限硬编码为 512 MiB（`imageApiShared.ts:10-11,73-85`）。

上游 multipart 的顺序逻辑值得复用，但不能把字段名、端点和 512 MiB 上限视为所有中转的通用事实。上游测试没有直接断言 Edits multipart 字段形状、文件顺序和遮罩绑定，Routego 必须新增无网络 contract fixtures。

### 5.2 多参考图

- UI 在 `InputBar.tsx:327-328,1104-1128` 硬编码最多 16 张。
- 请求层接受任意长度数组，没有第二层 16 张校验。
- `mask.ts:5-14` 会把遮罩目标移动到第 1 位，并保持其他参考图相对顺序；对应单元测试已通过。
- 遮罩目标在 UI 中禁止被拖离第 1 位，这个交互不变量可以保留。

Routego 应由共享 Schema 和服务端再次校验最大数量；Studio 只展示能力矩阵下发的限制，不能成为唯一防线。

### 5.3 同提示词多结果与批量

上游在 Images 流式或 Codex CLI 模式下，会把 `n > 1` 拆成多个并发单图请求，并用 `Promise.allSettled` 汇总部分成功（499-550）。Responses 的 `n > 1` 始终拆成多个请求（988-1035）。

这段汇总思路可以复用，但 Routego 契约必须区分：

- `variantCount`：同一提示词的 1～4 个变体。
- `batch`：最多 20 个独立资产任务。
- `providerRequestCount`：实际产生的供应商请求数。
- `failedSlots`：每个输出槽位的错误。

否则一次 `n=4` 被拆成 4 次可能收费的调用后，用户无法知道真实请求数。

## 6. Responses image_generation

### 6.1 可复用部分

`openaiCompatibleImageApi.ts` 中可参考：

- `createResponsesImageTool`：构造 `image_generation` 工具、action、尺寸、格式、质量、压缩、moderation、partial images 和 mask（188-220）。
- `createResponsesInput`：按稳定顺序发送 prompt 与多张内联 data URL 图片（223-239）。
- `parseResponsesImageResults`：解析常见 base64 result 形状（241-293）。
- `parseResponsesApiStreamResponse`：处理 partial、`output_item.done` 和 completed 回退（428-477）。

### 6.2 不能作为已实现证据的部分

画廊路径没有实现：

- `previous_response_id`。
- file ID 或 image ID 输入。
- provider response ID/image ID 的结构化返回。
- 原生连续编辑状态。

其 action 只根据“是否有输入 data URL”决定 generate/edit。Agent 模块虽包含更复杂的 Responses 循环和 `action:auto`，但它属于明确不移植的 Agent 能力，且仍不能证明 Routego 所需的 ID 连续编辑完整契约已经可直接复用。

Foundation 应单独定义 Tier C 请求/结果 union，并要求真实 provider 确认后才启用。没有 Tier C 时，用上一张输出重新作为输入，并明确返回 `degradedContinuation=true`。

## 7. SSE 与响应归一化

### 7.1 推荐抽取

`openaiCompatibleImageApi.ts:113-186` 的 SSE reader 支持：

- LF/CRLF 分隔。
- 注释行。
- 多行 `data:`。
- `[DONE]`。
- JSON 解析失败提示。
- `event.error` 和 `.failed` 事件。

Images 流式解析支持 generation/edit partial、completed 和 result 事件（357-414）；Responses 支持 partial、output item 和 completed 回退（428-477）。对应 fixture 测试已通过。

### 7.2 必须重构的缺口

- 流失败后只抛出普通 Error，没有把已收到的中间图带入结构化失败。
- 错误丢失 HTTP 状态、provider code、阶段、是否可能收费和重试安全性。
- 裸 base64 的 MIME 依赖请求格式推断；中转返回格式不同时可能标错 data URL。
- partial 回调没有统一 event sequence、request index 和 artifact identity。

Routego 应把 SSE codec 与业务事件归一化分开，输出统一事件：`started`、`partial`、`completed`、`failed`。失败结果应保留 `partialArtifacts`、`receivedAnyOutput` 和 `mayHaveBilled`。

## 8. 尺寸、质量、格式和透明背景

### 8.1 参数模型

上游 `TaskParams` 支持 size、`auto/low/medium/high`、PNG/JPEG/WebP、compression、moderation、n 和透明后处理。该字段集合可作为输入，但每项是否发送必须由 provider/model/endpoint 能力决定。

`size.ts` 包含尺寸解析、16 倍数规整、比例预设和像素预算算法。其最长边 3840、宽高比不超过 3、像素范围等是上游策略，不是所有 OpenAI 兼容中转的统一限制。建议只复用解析/计算方法，并由 capability policy 提供限制。

### 8.2 透明背景

上游没有发送原生 `background` 参数。其透明流程是：

1. 在提示词中要求纯绿色或纯洋红背景。
2. 强制 PNG。
3. 检测画布边缘键色。
4. 对连通背景、内部色块、边缘 alpha 和色溢进行本地处理。

`transparentImage.ts:17-400` 的像素核心和小型合成测试值得抽取。这与 Routego 对 `gpt-image-2` 的默认降级方向一致，但必须报告 `transparentMode=chromakey`，不得称为原生透明。

风险：

- 当前算法在主线程多次扫描整图，4K 图片可能阻塞 Studio。
- 测试只覆盖小型合成像素，不能证明头发、玻璃、烟雾、液体、反射和阴影质量。
- 后处理失败时上游回退原始不透明图并把任务视为完成；Routego 应返回结构化后处理失败或部分成功，避免误报透明成功。

建议把像素核心放入 Worker 或独立图像处理边界，设置像素/内存/耗时上限，并补真实图片金样回归。

## 9. 遮罩编辑

### 9.1 可复用逻辑

- `mask.ts`：目标存在性、目标置于第 1 位、alpha 覆盖分类和空遮罩拒绝。
- `canvasImage.ts:46-101`：遮罩与目标同尺寸校验、覆盖预览。
- `viewportTransform.ts:24-110`：缩放约束、定点缩放、双指缩放和平移、坐标映射；纯函数测试完整。
- `MaskEditorModal.tsx`：画笔、橡皮、撤销/重做、笔刷大小、鼠标/触摸、双指缩放、Alt 平移和保存流程。
- 全透明遮罩提交前二次确认，避免意外重绘整图。

遮罩 alpha 语义为：白色/不透明区域保留，透明区域允许编辑。Foundation 应把这一语义写入共享契约和 fixture。

### 9.2 不可直接复制的问题

- `MaskEditorModal.tsx` 1025 行，直接耦合 Zustand、IndexedDB 和 data URL。
- `maskPreprocess.ts` 会把最长边超过 1920 的目标缩小，并在保存时用工作图替换原目标。Routego 不应无提示改变原资产；工作画布尺寸、目标原图和最终导出尺寸必须分离。
- 撤销栈最多保存 40 份整张 `ImageData`。1920×1920 时理论内存接近 590 MB。
- 组件缺少正式对话框语义、焦点捕获和关闭后焦点恢复。

建议拆成：

- 纯画布/坐标核心。
- pointer/pinch/pan 手势 Hook。
- 受内存字节上限约束的历史管理。
- Mask DTO 与导出校验。
- 可访问的全屏 Dialog UI。

## 10. 图库、收藏夹、删除和 ZIP

### 10.1 可参考的交互

- 任务卡的 running、partial preview、done、error、部分失败、耗时和参数差异展示。
- 搜索、状态筛选、详情、Lightbox、快捷下载和再次编辑。
- 框选、Ctrl/Command 连选、自动滚动和批量操作。
- 多收藏夹、默认收藏夹、重命名、排序和批量归类。
- 内容寻址图片、缩略图版本和引用清理的总体思路。

### 10.2 数据模型不兼容

上游收藏夹绑定 `TaskRecord.favoriteCollectionIds`，不是单张资产。一个任务有多张输出时无法分别归类。Routego 必须采用资产与收藏夹多对多关系。

上游 `StoredImage` 只有 data URL、来源和宽高，缺少 MIME、字节数、文件名、文件路径、软删除时间、资产关系和版本。去重对完整 data URL 字符串做 SHA-256；在无 Web Crypto 时还会降级为非密码散列。Routego 应只对规范化图片字节计算 SHA-256。

上游图库是普通三列 CSS grid，全部任务一次渲染，不是正式瀑布流，也没有分页/虚拟化。搜索只匹配 prompt、参数 JSON 和错误文本。

### 10.3 删除语义不兼容

`store.ts:5195-5243` 删除任务后立即删除无引用图片；启动时也会清理孤立图片。上游没有：

- 软删除。
- 回收站。
- 恢复。
- 30 天保留。
- 永久删除二次确认的服务端事务。

因此只可参考“计算仍被引用的图片”这一思路，不能复用删除实现。

### 10.4 ZIP 安全不足

`exportZip.ts` 的导入校验主要确认 manifest 引用的文件存在。它没有满足 Routego 要求的：

- 版本化运行时 Schema 校验。
- 规范化路径和路径穿越拒绝。
- ZIP entry 数量、单项解压大小和总解压大小限制。
- MIME/魔数/允许扩展名策略。
- 每个文件 SHA-256。
- supplied ID 与实际内容哈希一致性。
- ZIP bomb 防护。

完整配置导出还会把 `settings` 直接放入 manifest，其中包含 API Key。Routego 不得复用这一行为；凭证不应进入 Studio 状态、localStorage、IndexedDB 或导出包。

## 11. 前端架构与可访问性

### 11.1 可保留的高层分区

建议 Routego Studio 拆为：

- `workbench`：提示词、参考图、参数、能力提示和提交状态。
- `mask-editor`：画布、手势、历史和导出校验。
- `library`：资产网格、筛选、详情、收藏夹、批量工具和回收站。
- `api-client`：HTTP/SSE DTO、事件订阅和缓存。
- `ui`：Dialog、Toast、Lightbox、IconButton、SelectableCard、SortableList。

Zustand 如继续使用，只保存短期 UI/草稿状态。任务、资产、收藏夹和回收站的唯一事实来源必须是本地服务和版本化 JSON 索引。

### 11.2 不能照搬的架构

- `store.ts` 5658 行，职责严重混合。
- `InputBar.tsx` 2358 行。
- `SettingsModal.tsx` 2304 行。
- `DetailModal.tsx` 1217 行。
- `MaskEditorModal.tsx` 1025 行。
- 所有弹窗常驻根组件。
- `main.tsx` 注册 PWA Service Worker；Routego 不需要。
- `vite.config.ts` 使用 `server.host: true`；Routego 必须只监听 `127.0.0.1`/`::1`。

### 11.3 可访问性缺口

上游部分按钮有 `aria-label`，也支持 Escape 关闭，但主要弹窗缺少完整的 `role=dialog`、`aria-modal`、焦点捕获和焦点恢复。任务卡、收藏夹卡和参考图缩略图大量依赖可点击 div/span，键盘替代不足；状态更新也缺少 `aria-live`。

Routego 应先建立统一的可访问 UI 原语，再迁移视觉和手势交互。

## 12. 明确不得移植的功能和文件

| 排除范围 | 代表文件/目录 | 原因 |
|---|---|---|
| Agent UI | `AgentWorkspace.tsx`、`HistoryModal.tsx`、`MarkdownRenderer.tsx` | 与 Codex 对话能力重复 |
| Agent/多工具循环 | `agentApi.ts`、`agentImageReferences.ts` | 不作为 Studio 业务层 |
| Web 搜索 | `agentWebSearch.ts`、Agent settings | 明确排除 |
| fal.ai | `falAiImageApi.ts`、`@fal-ai/client`、store/provider 分支 | 首版只支持 OpenAI 兼容中转 |
| 自定义云供应商 | `openaiCompatibleImageApi.ts` 的 custom provider/轮询、`customProviderConfigUrl.ts`、相关 docs | 超出已确认范围 |
| 赞助 | `SupportPromptModal.tsx`、support-prompt 状态 | 产品无关 |
| 云/PWA 部署 | `deploy/`、`vercel.json`、`wrangler.jsonc`、`public/sw.js`、`manifest.webmanifest` | Routego 是本地回环服务 |
| 整体应用骨架 | 完整 `App.tsx`、`store.ts`、`db.ts`、锁文件和构建配置 | 架构、安全和持久化边界不兼容 |

## 13. 模块/文件级复用映射

| 上游文件/区域 | 复用级别 | 建议落点 | 结论 |
|---|---|---|---|
| `src/lib/viewportTransform.ts` + tests | 可优先抽取 | Studio mask editor | 纯函数、测试完整；按 Routego UI 尺寸策略调整常量 |
| `src/lib/mask.ts` + tests | 可优先抽取 | shared/mask contract | 目标置首、alpha 分类、空遮罩拒绝与目标契约一致 |
| `src/lib/canvasImage.ts` | 抽取后重构 | Studio/Node image boundary | 保留同尺寸、PNG 和预览语义；从 data URL/DOM 包装中解耦 |
| `src/lib/maskPreprocess.ts` | 仅参考 | Studio working canvas | 不允许工作图替换原目标资产 |
| `src/components/MaskEditorModal.tsx` | 拆分重构 | Studio mask editor | 保留交互，拒绝整文件复制 |
| `src/lib/transparentImage.ts` + tests | 抽取像素核心 | image postprocess | 加 Worker、资源上限和真实金样测试 |
| `src/lib/size.ts` + tests | 抽取解析/计算 | shared parameter policy | 所有限制必须受 model/capability gate 控制 |
| `src/lib/imageApiShared.ts` | 选择性抽取 | creation shared utilities | base64、错误体、actual params 可用；类型与浏览器 CORS 逻辑需重写 |
| `src/lib/openaiCompatibleImageApi.ts:113-477` | 抽取 codec/normalizer | creation transport | SSE 和 Images/Responses 解析最有价值 |
| `callImagesApiSingle` | 参考后重写 | Tier B serializer/executor | 不保留 URL 派生和直接路由 |
| `callResponsesImageApiSingle` | 参考后重写 | Tier C serializer/executor | 扩展 IDs、previous response 和结构化结果 |
| `devProxy.ts` URL 逻辑 | 不复用 | Foundation endpoint model | 会截断/补 `/v1` 并拼派生路径，违背唯一端点规则 |
| `apiProfiles.ts` custom provider | 不复用 | 无 | 自定义云供应商明确排除 |
| `db.ts` | 不复用实现 | Library service | IndexedDB/data URL 模型不符合文件 JSON 索引 |
| `TaskCard.tsx`、`DetailModal.tsx` | 重构复用状态表达 | Studio library | 改接 Foundation DTO，补源图/结果对比 |
| `Lightbox.tsx` | 重构复用手势 | Studio UI | 补 Dialog、焦点和按钮可访问名称 |
| `useDragSelect.ts` | 交互参考 | Studio library | 作用域化 DOM 查询，增加键盘多选 |
| 收藏夹组件和 store 逻辑 | 只复用产品语义 | Library/Studio | 改为资产级多对多关系 |
| `exportZip.ts` | 仅参考分片导出 | Library ZIP | 导入安全实现必须重新设计 |
| `App.tsx`、`store.ts` | 禁止整体移植 | 无 | 防止单体状态和浏览器存储污染三层架构 |

## 14. 与 Routego 三层 provider 条件的兼容设计

### Tier A：single-endpoint-json

上游没有该实现。Routego 必须新建 serializer：

- 保存用户给出的完整 generation endpoint，不猜测兄弟路径。
- 文生图先可用。
- 图片输入能力独立记录 `image` 或 `images` 字段、data URL 形状、最大数量。
- 只有用户发起图生图/编辑或明确确认付费探测后才验证。
- 未确认时返回 `capability_unavailable`，不伪造编辑。

### Tier B：openai-images

可以复用上游 generations JSON、edits multipart、输入顺序和解析思路，但 `editsEndpoint` 必须来自供应商文档、用户配置或稳定成功验证，不能从 generation URL 自动派生。

### Tier C：openai-responses

可以复用 tool/input/SSE 形状，但必须扩展 action、previous response、file/image IDs、provider response/image IDs 和连续编辑结果。只有 capability 为 supported/degraded 时才路由。

### 共同路由原则

- 端点、provider、model 组合分别记录能力。
- `unknown | supported | unsupported | degraded` 不得由单次网络失败直接改变为 unsupported。
- timeout、401/403、429、5xx、moderation block 不证明协议不支持。
- timeout、partial 或 final 后不得切换 Tier 重放同一请求。
- 最多两次自动退避只允许明确处于预生成阶段的 429/5xx。

## 15. Foundation 契约建议

### 15.1 端点与能力

建议字段：

- `configuredGenerationEndpoint`：用户提供的完整 URL。
- `editsEndpoint?`、`responsesEndpoint?`：只保存显式确认的 URL。
- `transport`：`single-endpoint-json | openai-images | openai-responses`。
- `capabilityState`：四态、验证来源、验证时间、模型、限制和降级说明。
- Tier A 图片字段：`image | images`、最大数量、是否接受 data URL。

### 15.2 请求与输入关系

- 明确 `targetImage`、`supportingImages[]`、`references[]` 和 `mask`。
- 序列化不变量：target 永远 slot 0，其余顺序稳定，mask 只绑定 slot 0。
- 服务端校验最多 16 张、mask 与目标同宽高/同格式/PNG、小于 50 MiB并具有可编辑 alpha。
- `variantCount` 1～4 与 batch 任务分离。
- 保存 `requestedParams`、`effectiveParams` 和 `providerRequestCount`。
- 编辑请求保存允许修改区域和必须保持的不变量。

### 15.3 结果、事件和错误

建议结果包含：

- `finalArtifacts`、`partialArtifacts`、`failedSlots`。
- `actualParamsByArtifact`、revised prompt、raw URL 的脱敏表示。
- `providerResponseId`、`providerImageIds`。
- `degradedContinuation` 和 `transparentMode`。
- `receivedAnyOutput`、`mayHaveBilled`。

建议 typed error 至少包含：

- category：auth、rate_limit、timeout、moderation、unsupported、protocol、provider、download、postprocess。
- `httpStatus`、`providerCode`。
- stage：submit、stream、download、postprocess、persist。
- `retryDisposition`。
- partial artifacts 和收费风险。

### 15.4 Library/Studio

`AssetRecord` 至少包含：字节 SHA-256、路径、MIME、字节数、宽高、创建时间、来源、软删除时间和版本。

资产关系应独立建模：target、reference、supporting、mask、output、transparent-original、stream-partial，并保留顺序。

收藏夹使用 asset-folder 多对多关系。查询契约支持提示词、模型、日期、类型、尺寸/比例、状态、收藏夹、软删除、排序和分页游标。

Studio 只能获取脱敏配置和能力状态；API Key 仅由本地服务读取受限权限文件。

ZIP 导入必须校验 Schema、总/单项大小、条目数量、规范化路径、允许类型、SHA-256、重复 ID 和解压膨胀比例。

## 16. 建议抽取顺序

1. Foundation 固定上游 SHA、MIT 归属、端点/能力/错误/事件/结果契约和四类 mock fixtures。
2. 抽取纯逻辑：`mask.ts`、`viewportTransform.ts`、base64/actual params、尺寸解析、透明像素核心及测试。
3. 抽取 SSE block reader，再分别实现 Images/Responses event normalizer。
4. 编写无网络 serializers：Tier A single endpoint JSON、Tier B generations/edits、Tier C Responses；fixture 验证字段、顺序、端点不派生和脱敏。
5. 接入 fetch executor、超时和受控重试；能力 router 放在 executor 外。
6. 建立 Node 图像转换/去背边界，并把 Studio partial 订阅接到共享事件。
7. 拆分遮罩编辑器，解决工作图替换原图、撤销内存和可访问性问题。
8. 依据资产级 Schema 重新实现图库、收藏夹、瀑布流、批量操作、回收站和安全 ZIP。
9. 最后做真实中转付费验收和跨平台验证。

## 17. 风险登记

| 风险 | 等级 | 处置 |
|---|---|---|
| 自动派生 `/images/edits`/`/responses` 导致无效调用或收费 | 高 | 精确端点模型 + capability gate |
| Tier A 在上游缺失 | 高 | 基于旧插件行为新建 serializer 和 fixture |
| multipart 字段方言与顺序兼容 | 高 | mock relay + 用户确认的真实测试 |
| Responses 原生 ID 连续编辑未覆盖 | 高 | 独立 Tier C contract，不以 Agent 模块代替 |
| timeout/partial 后重复收费 | 高 | typed error + 禁止跨 Tier 自动重放 |
| 浏览器 API Key 持久化/导出 | 高 | Key 仅在本地服务受限文件 |
| ZIP 路径穿越、zip bomb、伪造 ID | 高 | 全量安全校验后再写磁盘 |
| 硬删除与孤立清理绕过回收站 | 高 | 服务端软删除事务和 30 天策略 |
| 遮罩撤销栈内存过大 | 中高 | 字节预算、增量笔划或稀疏检查点 |
| 4K 色键主线程阻塞 | 中高 | Worker/处理层和资源上限 |
| 上游尺寸常量被误当通用协议 | 中 | model/capability policy |
| 上游无组件/E2E 测试 | 中 | Studio 使用 Playwright 覆盖关键流程 |
| 上游依赖树存在已知漏洞 | 中 | 不复制锁文件，选择已修复版本并重新审计 |
| 大组件/单体 store 导致跨泳道冲突 | 中 | 按 workbench/mask/library/api/ui 拆分 |

## 18. 阻塞项与残余风险

当前没有阻塞 Foundation 使用本报告作为 proposal/design 输入。

仍需后续验证：

- 未对真实中转发送请求；Edits multipart、SSE 方言和 Tier A `image/images` 只完成静态与 fixture 级分析。
- 未验证 Responses `previous_response_id`、file ID、image ID 的真实兼容性。
- 未对复杂透明素材做金样质量验收。
- 未测量真实浏览器下遮罩撤销内存、4K 去背耗时和大图库渲染性能。
- 上游后续提交可能改变结论；升级复用基线必须重新审计许可证、代码和依赖。

## 19. 交付摘要

- OpenSpec 任务 ID：无，pre-change audit。
- 上游复用基线：`a10477581b3d43ac98d39777e4445625a9db113d`。
- 许可证：MIT，`Copyright (c) 2026 CookSleep`。
- 验证：241 个上游测试通过，生产构建通过，依赖审计已记录。
- 阻塞项：无。
- 推荐下一步：Foundation 将第 14～17 节映射进正式 proposal/design/specs/tasks；Creation、Library、Studio 不应在契约冻结前自行复制上游实现。
