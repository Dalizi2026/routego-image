# Program Controller generation 1 交接清单

## 身份与交接原因

- 来源任务：`019f6f8c-a875-78a2-8332-a85d84d122d2`
- 继任任务：`pending`；创建后以 `.codex/routego-program/threads/controller.json` 的登记为准
- 来源角色：Program Controller generation 0
- 继任角色：Program Controller generation 1
- 可观测上下文压缩次数：`3`
- 本次事件指纹：`2026-07-18-browser-boundary-complete-controller-handoff-summary`
- 健康审计：通过；能够确认当前基线、交付分支、依赖、所有权和下一步，但第 3 次压缩强制要求新任务与新 worktree 接管

## 仓库与安全边界

- 来源 worktree：`C:\Users\MLTZ\Documents\生图插件`
- 来源分支：`main`
- 来源安全 HEAD：`93300173a7f658a16c5dc0a10c115cd72f1ec0c7`
- 来源 Git 状态：干净
- 当前程序状态：`browser-boundary-active`
- 当前主线没有 Browser Boundary 代码；不得在旧 Controller 中开始验证、合并、规格同步、归档或下游唤醒
- 本交接只修改 Controller 治理状态和本清单，不修改产品代码、共享契约、OpenSpec change、依赖或锁文件

## 当前 OpenSpec change

- Change：`complete-routego-browser-boundaries`
- Lane：`foundation-browser-boundary`
- Apply owner 任务：`019f70fa-6768-72f3-8350-5a95ea02d4e8`
- Worktree：`C:\Users\MLTZ\.codex\worktrees\f862\生图插件`
- 分支：`codex/routego-browser-boundary`
- 完整交付 SHA：`e1a6d84169ce6a0fb6d000f407ef03d0f6a77a01`
- OpenSpec 任务：`1.1`、`2.1`、`3.1`、`4.1`、`5.1`，交付分支上为 `5/5`
- 交付状态：已完成、尚未合入主线、尚未同步 delta specs、尚未归档

## 已完成

- Foundation 已合并并归档。
- Foundation Extension 已合并、同步规格并归档。
- Creation、Library、Studio 顶层任务和独立 worktree 已创建；它们仅保留 NON-FROZEN 工件并等待 Browser Boundary 基线。
- Browser Boundary 已交付浏览器上传生命周期、path-free Studio 生成/编辑/批量契约、path-free 图库搜索、设置默认值/输出目录变更和非空 deterministic mock。
- 交付方报告七个公共 MCP 操作保持冻结，没有真实上传存储、provider 调用、Studio UI 或发布实现。

## 进行中

- 无正在执行的产品实现。Controller 已停在 Browser Boundary 合并前的安全原子边界。

## 继任任务必须按顺序完成

1. 依次重读 `routego-image-1.0-plan.md`、`AGENTS.md`、`program.json`、`controller.json`、`browser-boundary.json`、PD-004 和 Browser Boundary proposal/design/specs/tasks。
2. 验证继任 worktree 的起点包含本交接文件，并核对来源安全 HEAD 与交付 SHA。
3. 在任何修改前运行 `openspec status --change complete-routego-browser-boundaries --json` 和 `openspec instructions apply --change complete-routego-browser-boundaries --json`；change 尚未出现在主线时，应在只读交付 worktree 中执行并记录结果。
4. 独立核验交付分支 HEAD、工作区干净、5/5 任务、提交顺序和差异范围。
5. 在交付分支或隔离验证 worktree 重跑 frozen install、OpenSpec strict、安全检查、typecheck、build、183 项测试、七包 exports、公共操作冻结、browser-safe source/declaration/emitted、mock deterministic 和依赖/native-runtime 审计。
6. 使用非快进治理合并把 `codex/routego-browser-boundary` 合入新 Controller 基线；不得覆盖现有 Program Controller、PD 或线程登记。
7. 按 OpenSpec sync 工作流把 delta specs 智能同步到六份主规格，随后按 archive 工作流归档 `complete-routego-browser-boundaries`。
8. 在主线再次运行完整验证，形成不可变 Browser Boundary 冻结基线提交。
9. 更新 `program.json`、`controller.json` 和 `browser-boundary.json` 的准确状态、完整 SHA、代次与继任任务信息。
10. 向 Creation、Library、Studio 三个现有任务发送结构化 `DEPENDENCY_COMPLETE` follow-up，要求它们从同一完整冻结基线重新读取权威文件、重建 OpenSpec 工件后才能 apply。
11. 三条泳道全部完成后，才创建新的 Integration & Acceptance 顶层任务。

## 不可变契约与产品决策

- 首版公开 MCP 工具固定为七个，不增加 Studio 专用 MCP 工具。
- 浏览器只使用 `assetId`、`artifactId`、`uploadResourceId` 和受会话保护的相对资源 URL，不接收或返回任意本地图片路径、凭证、Base64 或不受控外部 URL。
- 用户默认只有一个生图端点和 API Key；不得假设 `/images/edits` 或 `/responses` 存在，不得猜测接口或自动发起可能计费的能力探测。
- Library 负责上传暂存、MIME/大小/校验/尺寸/过期和持久资源；Creation 负责 provider 执行；Integration 负责 HTTP session/origin/binary streaming 及 resolver/executor 组合；Studio 只消费 path-free 边界。
- 输出目录 `replace` 是唯一允许由 Studio 明确提交本地配置路径的边界，后续服务必须做严格的服务端规范化、安全路径和所有权校验，响应和日志不得回显完整路径。
- OpenSpec 任务 ID 是实现前置条件；共享 Schema、根依赖、锁文件、workspace、manifest 和发布流程仍由 Foundation/Integration 独占。

## 文件所有权

- Browser Boundary 已交付范围：`packages/contracts/**`、`packages/mock-relay/**`、其聚焦测试和 `openspec/changes/complete-routego-browser-boundaries/**`。
- Creation 独占 provider 适配、执行、transport、MCP/HTTP runtime 实现。
- Library 独占配置、图库、收藏夹、上传/文件安全、回收站和 ZIP。
- Studio 独占 React 页面、组件、遮罩编辑器和浏览器测试。
- 继任 Controller 只负责集成治理、规格同步/归档、冻结基线和依赖唤醒，不应代替三条泳道写产品实现。

## 验证记录

- 来源主线交接前：`openspec validate --all --strict --no-interactive` 通过，主线 `6/6` 规格有效。
- 来源主线交接前：`pnpm safety` 通过，检查 `140` 个已跟踪文件。
- 来源主线交接前：`git diff --check` 通过，Git 干净。
- Browser Boundary 交付方报告：OpenSpec `7/7`、typecheck、build、contracts `92`、foundation `48`、mock-relay `43`、七包 exports、浏览器安全审计、公共操作冻结、deterministic mock、依赖/native-runtime 和 Git 清洁均通过。
- 上述 Browser Boundary 结果尚未由继任 Controller 独立复跑，因此不能直接视为主线验收完成。

## 阻塞与残余风险

- 阻塞项：无外部阻塞；唯一门禁是完成强制 Controller 接管并独立验证。
- 残余风险：真实上传存储与校验尚未实现；真实 HTTP session/origin/binary streaming 尚未实现；provider 执行尚未实现；Studio UI 尚未实现；macOS/Linux 与 Node 20.19+ 仍待 CI/Integration 验收。
- 未部署、未安装、未调用真实中转、未写入真实配置或图库、未产生费用。

## 接管确认

继任任务确认起始 commit、OpenSpec 状态、交付 SHA、下一步和文件所有权后，应更新 Controller 状态并向来源任务发送结构化 `[CONTROLLER_HANDOFF_ACCEPTED]`。来源任务收到确认后才能归档。
