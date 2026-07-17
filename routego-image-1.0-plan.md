# Routego Image 1.0：Codex 原生生图插件重构计划

> 文档状态：默认决策已确认、进入执行阶段  
> 最后更新：2026-07-17  
> 权威性：本文件是产品目标、技术边界、开发流程和验收标准的主文档。后续 Codex 任务必须先读取本文件、根目录 `AGENTS.md`、对应 OpenSpec change 和线程交接清单，不得仅依赖对话记忆。

## 1. 项目目标

将现有个人插件 `routego-image` 原地重构为 1.0 版本，达到 Codex 官方 ImageGen 的核心使用体验，同时支持用户自己的 OpenAI 兼容中转。

必须具备的能力：

- 文生图、图生图、单图直接编辑、多参考图生成和编辑。
- 遮罩编辑、尺寸与质量控制、输出格式、透明背景和批量任务。
- Codex 对话内直接返回生成结果、绝对文件路径和可视化图片内容。
- 本地 Routego Studio：生成/编辑工作台、图库、收藏夹、遮罩编辑器、批量管理、回收站、导入导出和设置。
- 本地持久化配置和图库；API Key、完整请求头和用户图片不得进入项目源码、对话记录或普通日志。
- Windows、macOS、Linux 可构建和运行，运行时要求 Node.js 20+。

同名替换现有插件，但首版不迁移旧配置和旧图库。旧文件保留并归档，不执行破坏性删除。

## 2. 输入来源与重构原则

### 2.1 当前插件

- 开发参考源码：`C:\Users\MLTZ\plugins\routego-image`
- 当前已安装版本：`0.1.0+codex.20260702174547`
- 当前实现主要由 `generate.mjs`、`setup.mjs` 和一个大型 Skill 构成。
- 已知限制：没有完整 Studio、图库与遮罩编辑器；参考图能力受限；大量流程依赖 Skill 文本和 CLI 参数；中英文内容存在编码问题。

现有 marketplace 已指向上述个人插件源码。开发阶段不得手工改写 marketplace；正式发布时使用 `plugin-creator` 的 cachebuster 和 reinstall 流程。

### 2.2 开源项目

- 上游项目：`CookSleep/gpt_image_playground`
- 许可证：MIT；执行阶段必须固定复用基线 commit，并保留第三方声明。
- 复用方向：Images/Responses API 请求构造、multipart 编辑、多参考图、尺寸与透明背景处理、SSE 解析、图库交互与遮罩相关成熟逻辑。
- 不移植：其 Agent 聊天界面、Web 搜索、fal.ai、自定义云供应商、赞助页、云部署页及与 Codex 重复的多轮 Agent 能力。
- 采用“理解后抽取和重构”，不得把整个独立网站直接塞入插件。

## 3. 目标架构

采用三层结构：

1. **Codex Skill**
   - 识别生成、编辑、参考图、图库和设置意图。
   - 整理最小必要提示词和参数。
   - 调用 MCP 工具，检查结果并按需复制到项目资产目录。

2. **本地 MCP/HTTP 服务**
   - 单一服务承载中转适配、图像任务、图库、本地 HTTP API 和 Studio 静态资源。
   - Codex 通过 STDIO MCP 调用；Studio 通过回环 HTTP/SSE 调用同一业务层。
   - MCP、HTTP 和 Studio 必须共享运行时校验 Schema，禁止各自复制接口类型。

3. **Routego Studio**
   - React/Vite 本地页面，默认暗房工作台风格，支持中英文和响应式布局。
   - 只监听 `127.0.0.1`/`::1`，使用随机会话令牌保护 API。
   - 可通过 Codex 内置浏览器或系统浏览器打开，不依赖公网网站。

构建产物应是自包含插件包；目标机器只需 Node.js 20+，不要求手动安装项目 `node_modules`。

### 3.1 默认技术栈

- pnpm workspace 管理 TypeScript monorepo，Node.js 最低版本为 20.19。
- TypeScript 开启 strict；共享请求/响应契约使用 Zod，同时导出运行时校验和静态类型。
- MCP/HTTP 服务优先使用 Node Web API、`fetch`、`FormData` 和轻量路由层，避免原生扩展。
- Studio 使用 React、Vite 和浏览器安全的共享契约包。
- 单元/契约测试使用 Vitest，浏览器端到端测试使用 Playwright。
- 构建采用 Vite 与 esbuild/tsup 类纯 JavaScript 工具，发布包不得要求目标机器重新编译 native addon。

## 4. 公共 MCP 工具

首版公开七个工具：

1. `routego_status`
   - 返回脱敏配置、模型、端点能力、默认参数和本地服务状态。
   - 支持显式刷新能力探测，但不得返回完整 API Key。

2. `routego_generate`
   - 文生图或参考图生成。
   - 最多 16 张参考图；每张带 `role` 和可选标签。
   - 支持 1～4 个同提示词变体。

3. `routego_edit`
   - 编辑单张目标图，可附加支持图和遮罩。
   - 遮罩始终对应第一张目标图，不允许产生含糊映射。

4. `routego_batch`
   - 最多 20 个独立生成/编辑任务，并发范围 1～10。
   - 允许部分成功，必须报告每个任务的结果和错误。

5. `routego_search_library`
   - 按提示词、模型、日期、类型、尺寸、状态和收藏夹检索。

6. `routego_manage_library`
   - 收藏、移动收藏夹、软删除、恢复、永久删除以及 ZIP 导入导出。

7. `routego_open_studio`
   - 启动或复用本地 Studio，返回带短期会话令牌的 URL。

统一请求契约至少包含：

- `kind: generate | edit`
- `prompt`
- `references[]: { path, role, label? }`
- `targetImage`、`supportingImages[]`、`maskPath`
- `size`、`quality`、`format`、`compression`
- `count`、`partialImages`、`transparentMode`
- `outputDir`、`saveToLibrary`

统一结果包含请求 ID、实际参数、状态、全部文件路径、输入输出关系、部分成功信息和可供 Codex 展示的图片内容。

官方 ImageGen 对齐要求：

- 区分“同一提示词的多个变体”和“多个不同资产任务”；前者使用 `count/n`，后者进入 batch 队列。
- Responses 路径支持 `action: auto | generate | edit`、`previous_response_id` 或图像 ID 的多轮连续编辑；供应商不支持时，使用上一张结果作为新输入重新调用可用端点，并在结果中标记 `degradedContinuation: true`。
- 编辑请求必须记录不变量：允许修改的区域、必须保留的主体/布局/文字，以及不得改变的内容。
- 遮罩必须与第一张目标图同尺寸、同格式、小于 50MB 并具有 alpha；不合格时在本地转换或拒绝，不把无效请求发给中转。
- 生成完成后检查主体、构图、文字、透明边缘和编辑不变量；项目资产复制进入工作区，默认使用版本化文件名。
- 支持 `moderation: auto | low`，默认 `auto`；保留结构化 `moderation_blocked`、阶段和粗粒度分类，但面向用户的提示保持简洁。

## 5. 中转兼容与执行规则

用户的实际条件是：只有一个中转站生图调用端点和 API Key，无法确认是否存在标准 `/images/edits` 或 `/responses`。插件必须以这个条件作为默认场景，不得猜测或强行派生未提供的接口。

当前旧插件的已验证行为是：配置保存一个 API Base，实际调用 `<base>/v1/images/generations`；文生图发送标准 JSON，编辑/参考图也调用同一个端点，并额外发送 `image: data:image/...;base64,...`。因此新版本必须提供以下能力分级：

1. **Tier A：单端点扩展协议（默认）**
   - 使用用户提供的唯一端点或由现有兼容规则得到的 generations URL。
   - 先验证纯文本生成。
   - 图片输入能力通过显式测试任务验证；若端点接受 `image`/`images` data URL，则在同一端点启用图生图和编辑。
   - 不支持图片输入时只提供文生图；Studio 中相关控制显示“当前中转未确认支持”，不得伪装编辑成功。

2. **Tier B：标准 OpenAI Images API**
   - 只有能力探测、供应商文档或用户显式配置确认后，才启用 `/images/edits` multipart。
   - 无输入图使用 generations；目标图、参考图或遮罩使用 edits。

3. **Tier C：Responses image generation tool**
   - 只有确认支持后启用多轮 image ID/response ID、`action` 和流式事件。
   - 不支持时使用 Tier A/B 的“上一结果重新作为输入”降级连续编辑。

能力状态使用 `unknown | supported | unsupported | degraded` 四态，不把网络错误、鉴权错误或单次模型失败误判为永久不支持。默认只自动执行无副作用或用户已请求的调用；任何可能产生费用的能力测试都要在界面中说明。

- Responses API 不得在超时、限流或收到部分结果后静默切换接口重试。
- 支持 Base64、图片 URL、同步 JSON 和 SSE 流式响应解析。
- Studio 可以展示中间图；Codex MCP 默认只返回最终结果，避免将大量中间图灌入上下文。
- 超时不得静默降低质量。只对明确的预生成 429/5xx 做最多两次退避重试，其他重试由用户确认。
- 项目资产复制不得覆盖同名文件，必须生成版本化文件名。
- `gpt-image-2` 不支持原生透明背景。简单不透明主体默认使用纯色色键生成和本地去背；头发、毛发、玻璃、烟雾、液体等复杂透明内容只有在中转确认支持可用透明模型/参数并获得用户确认后才切换。

## 6. Routego Studio 与本地数据

Studio 页面包括：

- 生成/编辑工作台：提示词、参考图拖放、尺寸、质量、格式、透明背景和批量参数。
- 全屏遮罩编辑器：缩放、平移、画笔、橡皮擦、撤销/重做、笔刷大小和覆盖预览。
- 图库：瀑布流、搜索、筛选、排序、详情、源图/结果对比、再次编辑和重试。
- 收藏夹：创建、重命名、排序和单图多收藏夹归类。
- 批量管理：多选、收藏、删除、恢复、下载和 ZIP 导出。
- 回收站：默认软删除并保留 30 天；永久删除必须二次确认。
- 设置：多个 OpenAI 兼容中转配置、模型刷新、能力探测、默认参数和输出目录。

数据规则：

- 新配置默认写入 `~/.codex/routego-image/config.json`。
- API Key 首版保存在该本地文件中，并在 Windows 使用当前用户 ACL、在 POSIX 使用 `0600`；不在首版引入原生系统钥匙串依赖。
- 图片默认保存到 `~/Pictures/routego-image/library/YYYY/MM/`。
- 图库元数据首版使用版本化 JSON 索引；写入使用文件锁、临时文件和原子替换。选择 JSON 是为了避免 SQLite/native addon 的跨平台打包风险；后续升级数据库时必须提供显式迁移和备份。
- 图片使用 SHA-256 去重；任务保存提示词、模型、参数、关系、状态和错误，但不保存完整密钥或认证头。
- ZIP 导入必须验证大小、文件类型、校验值和路径穿越。
- 旧 `~/.codex/routego-image-config.json` 和旧图片不导入、不删除。

## 7. OpenSpec 工作流

本机 OpenSpec CLI 为 1.6.0。仓库使用：

```text
proposal -> specs/design -> tasks -> apply -> strict validation -> archive
```

执行阶段初始化命令：

```powershell
openspec init --tools codex --profile core
```

生成并使用六个 Skills：`openspec-explore`、`openspec-propose`、`openspec-update-change`、`openspec-apply-change`、`openspec-sync-specs`、`openspec-archive-change`。

采用互相隔离的核心 changes，并在启动审计发现共享边界遗漏时插入有界 corrective gates：

```text
establish-routego-image-foundation
                |
                v
extend-routego-image-foundation-contracts
                |
                v
complete-routego-browser-boundaries
                |
       +--------+--------+
       |        |        |
       v        v        v
add-routego-image-creation
add-routego-image-library
add-routego-studio
       |        |        |
       +--------+--------+
                |
                v
integrate-routego-image-plugin
```

### 7.1 Foundation

- 建立工程骨架、共享 Schema、服务边界、安全规则、mock relay 和测试框架。
- 固定上游 commit、许可证和现有插件兼容清单。
- Foundation 合入主线并冻结契约后，才允许三条功能泳道开始 apply。

### 7.1.1 Foundation Extension gate

- Foundation 完成后的下游启动审计若发现已确认范围缺少共享契约、mock 边界、workspace importer 或根锁文件依赖，必须由独立 Foundation Extension change 集中修复，不得授权各功能泳道并发修改共享 Schema 或锁文件。
- `extend-routego-image-foundation-contracts` 负责补齐 Studio/Library 所需的 browser-safe 设置、图库详情、收藏夹排序、受控图片资源和批量部分失败契约，扩展 deterministic mock service，并预建 Creation、Library、Studio package importer。
- 保持首版七个公开 MCP 工具不变；Studio 专用设置与资源操作使用共享 Schema 的本地 HTTP/Studio service 子接口，不扩大公开 MCP 工具数量。
- Foundation Extension 合入主线并重新冻结契约前，Creation、Library、Studio 可以保存非冻结提案草稿，但不得进入 apply 或写产品代码。

### 7.1.2 Browser Boundary gate

- `complete-routego-browser-boundaries` 负责补齐浏览器到本地服务的反向资源流：会话上传资源、path-free Studio generate/edit/batch 请求与结果/SSE、path-free 图库搜索、设置默认值/输出目录写入，以及可驱动完整浏览器旅程的 deterministic mock 数据。
- 浏览器只持有 `assetId`、`artifactId`、`uploadResourceId` 和受会话保护的相对资源 URL；不得提交或接收任意本地文件路径、provider 凭证或未受控外部图片 URL。
- 二进制上传由受 session/origin/大小/MIME/过期策略保护的本地 HTTP 资源路由承载，JSON 契约只传递预留、完成状态和稳定资源 ID，日志不得包含字节或 Base64。
- Creation 只执行解析后的内部图像任务；Library/上传存储只负责资源解析；Integration 负责把两者组合成一个 `LocalRoutegoService`。任何单一功能泳道不得猜测或直接读取其他泳道的文件路径。
- 保持七个公开 MCP 工具不变。该 gate 合入前，三条功能泳道可以保留非冻结工件，但不得冻结受影响的 design/specs/tasks 或进入 apply。

### 7.2 Creation

- Images/Edits/Responses 适配、流式解析、重试、MCP 和 HTTP transport。
- 文生图、图生图、编辑、多参考图和批量任务。

### 7.3 Library

- 配置、图库、收藏夹、并发文件安全、回收站、去重和 ZIP。

### 7.4 Studio

- React UI、遮罩编辑器、图库和设置界面；使用 Foundation mock contract 独立开发。

### 7.5 Integration

- 七个 MCP 工具、Skill、构建、安装、真实中转、跨平台验收和最终发布。

同一 change 只能有一个 OpenSpec apply-owner。子代理和审查代理不得修改 OpenSpec 工件或 `tasks.md`。

### 7.6 规划一致性控制

- 每个实现步骤必须对应一个已解锁的 OpenSpec 任务 ID；没有任务 ID 不写产品代码。
- 任务开始前核对依赖、文件所有权和验收命令，任务结束后先验证并提交，再勾选完成。
- 子代理只能处理任务中明确标记给其 owner 的文件，主代理负责审查和集成。
- 任何公共契约、技术栈、目录所有权、依赖顺序、功能范围或验收标准变化都视为规划偏离，必须发送 `[PLAN_DEVIATION]` 并通过 OpenSpec update 修订后才能继续。
- 禁止为了赶进度跳过任务、合并验收步骤、降低测试标准或在当前 change 提前实现后续 change 的功能。

## 8. Codex 多任务与 Git worktree

- 当前任务是 Program Controller，负责基线、依赖关卡、线程登记和集成调度。
- Foundation 是首个顶层 Codex 新任务；旧插件审计、上游复用审计、契约核对和测试拆分原则上由 Foundation 线程内部的子代理完成。
- 本次启动时已提前创建的 Legacy Audit 与 Upstream Audit 顶层任务作为一次性例外：允许完成当前文档后立即归档，不再复制这种拓扑。
- Foundation 在两份审计最终报告可用前只能创建 proposal 初稿，不得冻结 design/specs，也不得进入 apply。
- Foundation 完成并合入后，自动派发 Creation、Library、Studio 三个独立 Codex 任务和 worktree；若启动审计触发 Foundation Extension 或 Browser Boundary gate，则三条任务保持已创建但暂停 apply，待修复基线完成后由结构化依赖消息统一唤醒。
- 三条实现泳道完成后，再创建一个完全新的 Integration & Acceptance 任务。
- 每个用户任务的主代理可以启动子代理，但默认最多两个；子代理必须拥有互不重叠的文件范围。
- 线程交付格式固定为：OpenSpec 任务 ID、commit SHA、测试结果、阻塞项、残余风险和推荐下一步。
- 不允许多个代理同时修改根锁文件、共享 Schema、插件 manifest 或同一个 `tasks.md`。
- 主线始终保持可验证；失败合并通过 `git revert` 回滚，禁止破坏性 reset。

顶层任务创建协议：

1. Program Controller 先创建包含 `threadId: pending`、lane、角色、起始 commit 和计划分支的线程状态文件并提交。
2. 再调用 Codex `create_thread`，使用已提交的主线状态创建新 worktree。
3. 获得真实 thread ID 后更新中央登记；新任务不得因 ID 暂为 `pending` 停止启动审计。
4. 为顶层任务设置清晰标题并置顶，确保它在 Codex 任务列表中可见。
5. 任务内部的审计、模块实现和测试使用子代理，不再由 Program Controller 创建额外顶层任务。
6. 子任务只在真实阻塞或最终里程碑时向 Program Controller 回传；常规进度保留在自己的线程和状态文件中，避免污染控制线程上下文。
7. Codex 线程完成一轮并进入 `idle` 后不会自行轮询其他独立线程；任何“等待其他任务后自动继续”都必须配置显式唤醒。
8. 前置任务完成后必须使用 `send_message_to_thread` 向依赖方发送结构化 `AUDIT_COMPLETE`/`DEPENDENCY_COMPLETE` follow-up；该消息负责触发依赖线程的新一轮。
9. 关键依赖门禁可以附加临时 heartbeat 作为漏发兜底，但不得用高频轮询代替直接完成事件；门禁满足后必须删除或暂停 heartbeat。

## 9. 上下文压缩检测与自动交接

Codex 没有公开精确的 `compactionCount`，因此使用“可观测压缩计数 + 健康审计”。本控制任务当前已观测到一次压缩，计数从 1 开始。

### 9.1 检测

- 对话出现明确的压缩、checkpoint 或历史摘要标记时，记录事件指纹并加一；同一指纹不得重复计数。
- 每次压缩后、开始新 OpenSpec 任务前、完成一个原子任务后，都执行上下文健康审计。
- 审计必须重新读取本计划、`AGENTS.md`、线程状态、change 工件和 `tasks.md`，不得依靠记忆回答。

审计至少确认：当前 change/分支/worktree/HEAD、完成和待办任务 ID、共享契约、目录所有权、禁止修改范围、最近测试和残余风险。

### 9.2 阈值

- 第 1 次：记录并审计。
- 第 2 次：强制建立 Git 检查点，不再启动新的大型原子任务。
- 第 3 次：只要仍有未完成工作，必须创建全新继任任务。
- 未达到三次但健康审计在重新读取权威文件后仍失败，也提前交接。

### 9.3 交接

1. 停在最近的安全原子边界；未完成任务保持未勾选。
2. 运行相关测试、OpenSpec strict validation 和 Git 状态检查。
3. 提交合法工作，生成不可变交接清单。
4. 清单记录 change、线程、worktree、分支、HEAD、已完成/待办任务、决策、测试、阻塞、风险和压缩次数。
5. 使用 `create_thread` 从最新 commit 创建全新 Codex 任务和新 worktree；禁止使用继承完整历史的普通 fork。
6. 继任任务在写代码前验证 commit，并运行 `openspec status --change <id> --json` 和 `openspec instructions apply --change <id> --json`。
7. 继任任务确认接管后更新线程状态，旧任务才归档。
8. 创建失败时旧任务保持只读并通知 Program Controller，不继续高风险开发，也不循环创建多个继任任务。

此协议同样适用于 Program Controller 和最终集成任务。

线程在 final answer 后视为停止执行。没有新的用户消息、线程 follow-up、子代理结果回传或 heartbeat 唤醒时，线程不得声称会继续监控或自动恢复工作。

## 10. 测试与验收

自动测试必须覆盖：

- Images JSON、Edits multipart、多参考图顺序、遮罩和 Responses 请求。
- Base64、图片 URL、同步响应和 SSE 流式响应解析。
- 尺寸规整、格式、压缩、透明背景、重试、超时和部分成功。
- 配置脱敏、文件权限、原子写入、去重、收藏夹、回收站和 ZIP 安全。
- MCP 初始化、工具 Schema、结构化结果和图片内容返回。
- 本地令牌、回环监听、CORS/CSRF、路径穿越和非法文件访问防护。
- Studio 的生成、编辑、遮罩、图库、批量、设置和响应式布局。
- 单端点纯文本、单端点 `image` data URL、标准 Edits multipart 和 Responses 四类 provider contract fixtures。
- `unknown/supported/unsupported/degraded` 能力状态、收费探测确认以及端点不存在时的禁用行为。
- 临时 `CODEX_HOME` 中的插件安装和全新 Codex 任务 smoke test。
- Windows、Ubuntu、macOS 的 Node 20.19+ CI。
- 模拟三次压缩、提前健康审计失败、重复指纹去重和继任任务接管。

真实中转验收必须执行：文生图、双参考图、直接编辑、遮罩编辑、批量部分失败和透明背景，并确认 Codex 与 Studio 进入同一图库。

## 11. 发布与回滚

- 正式发布前在临时 `CODEX_HOME` 验证自包含插件包。
- 使用 `plugin-creator` 的 `update_plugin_cachebuster.py` 更新版本后，从 personal marketplace 重新安装。
- 新版本验证通过前不得覆盖现有插件源码；旧源码重命名归档。
- 正式替换采用临时目录构建和原子目录切换，失败时恢复旧插件。
- 新任务用于验证新 Skill、MCP 和 Studio，避免旧线程继续使用缓存能力。

## 12. 工作量

- OpenSpec 初始化、基线和上下文控制：3～5 人日
- Foundation 与共享契约：4～6 人日
- Creation：7～10 人日
- Library：5～8 人日
- Studio：8～12 人日
- 插件集成、打包和安装：4～6 人日
- 真实中转、跨平台和发布加固：4～6 人日

总等价工作量约 35～53 人日。三条主泳道并行后，预计日历周期为 18～28 个工作日，现实加速约 1.7～2.2 倍。中转兼容差异或 macOS/Linux 实机验收可能增加 3～5 个日历日。

## 13. 不可擅自改变的默认决策

- 保持插件名 `routego-image`，首个正式重构版本为 `1.0.0`。
- 首版只支持 OpenAI 兼容中转。
- 唯一生图端点是默认兼容目标；不得假定 Edits/Responses 存在，不得通过猜测 URL 自动发送图片或产生费用。
- 首版图库使用版本化 JSON；API Key 使用受限权限本地文件。
- 默认技术栈为 pnpm workspace、TypeScript strict、Zod、React/Vite、Vitest 和 Playwright；不得无 OpenSpec 设计变更替换核心技术栈。
- 1.0 包含多轮连续编辑和 Studio 外绘/扩图；没有专用 API 时允许使用上一结果重新输入的明确降级路径。
- 透明背景默认采用色键和本地去背；复杂透明模型切换必须由用户确认。
- 不迁移、不删除旧配置和旧图库。
- 不移植上游 Agent UI、Web 搜索、fal.ai 和云部署功能。
- 先冻结共享契约，再并行开发，最后使用全新任务做独立集成验收。
- OpenSpec 是规格和任务状态的唯一权威；Git worktree 是代码隔离机制。
- 同一 change 永远只有一个 apply-owner。
- 第 2 次上下文压缩建立强制检查点，第 3 次或健康审计失败时自动交接。

任何需要改变以上决定的实现线程，必须暂停相关工作并向 Program Controller 提交 OpenSpec 变更请求。
